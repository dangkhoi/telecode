import type { SessionStore, SessionRow } from '../session/store.js';
import type { SessionManager } from '../session/manager.js';
import type { ApprovalBroker } from '../approval/broker.js';
import { badgeFor } from './reply-builders.js';

/**
 * Snapshot of daemon state rendered as plain text for the `/dashboard`
 * command (plan P0.5). The renderer is pure — no I/O, no timers — so the
 * scheduler in {@link DashboardLoop} can drive it on whatever cadence the
 * config dictates (default 2s).
 */
export interface DashboardSnapshot {
  /** All sessions for the chat, ordered newest-first. */
  sessions: ReadonlyArray<SessionRow>;
  /** Active session id for this chat (or null). */
  activeId: string | null;
  /** Pending approval count for this chat. */
  pendingApprovals: number;
  /** Number of active wizards/conversations for the chat (any kind). */
  activeWizards: number;
  /** Buffer byte usage per session id (only sessions with non-zero usage). */
  bufferBytes: Map<string, number>;
  /** Last-event ms timestamp per session id (sessions.updated_at). */
  lastEventMs: Map<string, number>;
  /** Now ms (overridable for tests). */
  now: number;
}

function relTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0 || diff < 1_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Escape Telegram legacy-Markdown meta characters inside user-controlled text
 * (session labels). `LABEL_PATTERN` permits `_` which would otherwise pair
 * with the dashboard footer's italic `_…_` and corrupt the rendered output.
 * Also defensively handles `*`, `[`, `` ` ``, and `\` so future label-pattern
 * relaxations stay safe.
 */
function escapeMarkdownLabel(s: string): string {
  return s.replace(/([_*[\]`\\])/g, '\\$1');
}

/**
 * Render a {@link DashboardSnapshot} as a single Telegram-safe message body.
 * Capped well under the 4096-char limit; if the session list overflows we
 * truncate with a `…` line so the message stays editable.
 */
export function renderDashboard(snap: DashboardSnapshot): string {
  const lines: string[] = [];
  lines.push('📊 *Telecode dashboard*');
  lines.push(`Sessions: ${snap.sessions.length}`);
  lines.push(`Pending approvals: ${snap.pendingApprovals}`);
  lines.push(`Active wizards: ${snap.activeWizards}`);
  lines.push('');
  if (snap.sessions.length === 0) {
    lines.push('(no sessions — /new để tạo)');
  } else {
    // Cap at 12 rows in dashboard view so we never blow past the edit cap
    // even with very long labels.
    const slice = snap.sessions.slice(0, 12);
    for (const s of slice) {
      const marker = s.id === snap.activeId ? '●' : '○';
      const bufBytes = snap.bufferBytes.get(s.id) ?? 0;
      const lastMs = snap.lastEventMs.get(s.id) ?? s.updated_at;
      const bufTag = bufBytes > 0 ? ` · buf=${formatBytes(bufBytes)}` : '';
      // Plan P1.1: badge comes from the registry-fed metadata so new adapters
      // (codex, cursor, …) render with their own icon without a dashboard edit.
      const agentTag = badgeFor(s.agent);
      lines.push(
        `${marker} ${escapeMarkdownLabel(s.label)} · ${agentTag} · ${s.status} · ${relTime(lastMs, snap.now)}${bufTag}`,
      );
    }
    if (snap.sessions.length > slice.length) {
      lines.push(`… (+${snap.sessions.length - slice.length} more)`);
    }
  }
  lines.push('');
  lines.push(`_updated ${new Date(snap.now).toISOString().slice(11, 19)} UTC · /dashboard stop để tắt_`);
  return lines.join('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Dashboard loop runtime — abstracted so tests can drive ticks manually.
// ---------------------------------------------------------------------------

export interface DashboardEditor {
  /** Edit the existing dashboard message in place. */
  editMessage(text: string): Promise<{ ok: true } | { ok: false; reason: 'deleted' | 'throttled' | 'error'; err?: unknown }>;
  /** Send the initial dashboard message; returns its id. */
  sendInitial(text: string): Promise<number>;
}

export interface DashboardLoopOpts {
  store: Pick<SessionStore, 'listSessions' | 'getChatState'>;
  manager: Pick<SessionManager, 'hasBuffered'> & {
    /** Bytes used per session for the dashboard view. Optional — return 0 when unknown. */
    bufferBytesFor?(sessionId: string): number;
  };
  broker: Pick<ApprovalBroker, 'hasPendingFor'> & {
    /** Number of pending approvals for this chat. Computed from public API. */
    countPendingFor?(chatId: number): number;
  };
  /** Active wizards count getter — usually the wizard-state singleton's pendingCount. */
  activeWizardsFor: (chatId: number) => number;
  /** Editor surface — abstraction over bot.api. */
  editor: DashboardEditor;
  /** Chat id this dashboard targets. */
  chatId: number;
  /** Refresh interval in ms. Default 2000 (plan D6). */
  intervalMs?: number;
  /** Idle timeout: stop after this many ms with no user input (default 5min). */
  idleTimeoutMs?: number;
  /** Clock injector for tests. */
  now?: () => number;
}

/**
 * Long-running interval loop that owns one dashboard message per chat.
 *
 * Lifecycle:
 *   - `start()` → sends the initial message + arms the tick interval.
 *   - `stop()`  → clears interval; safe to call multiple times.
 *   - `markUserActivity()` → resets the idle timer; caller invokes from
 *     any incoming user message handler (the dashboard is "active" while the
 *     user is interacting with the bot).
 *
 * Stop conditions encoded in {@link tick}:
 *   - editor reports `deleted` → the user deleted the dashboard message;
 *     we stop the loop so we don't keep editing a ghost.
 *   - idle > idleTimeoutMs → stop and announce.
 *   - editor reports `throttled` → we skip the tick (don't stop); the next
 *     tick retries naturally.
 *   - editor reports `error` → log + continue; transient API hiccups
 *     shouldn't kill the dashboard.
 */
export class DashboardLoop {
  private timer: NodeJS.Timeout | null = null;
  private messageId: number | null = null;
  private lastActivityAt: number;
  private readonly intervalMs: number;
  private readonly idleTimeoutMs: number;
  private stopped = false;
  private onStopped: ((reason: 'manual' | 'deleted' | 'idle') => void) | null = null;

  constructor(private readonly opts: DashboardLoopOpts) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.lastActivityAt = (opts.now ?? Date.now)();
  }

  private buildSnapshot(): DashboardSnapshot {
    const o = this.opts;
    const sessions = o.store.listSessions(o.chatId);
    const activeId = o.store.getChatState(o.chatId).active_session_id ?? null;
    const bufferBytes = new Map<string, number>();
    const lastEventMs = new Map<string, number>();
    for (const s of sessions) {
      if (o.manager.bufferBytesFor) {
        const b = o.manager.bufferBytesFor(s.id);
        if (b > 0) bufferBytes.set(s.id, b);
      }
      lastEventMs.set(s.id, s.updated_at);
    }
    const pendingApprovals = o.broker.countPendingFor
      ? o.broker.countPendingFor(o.chatId)
      : 0;
    return {
      sessions,
      activeId,
      pendingApprovals,
      activeWizards: o.activeWizardsFor(o.chatId),
      bufferBytes,
      lastEventMs,
      now: (o.now ?? Date.now)(),
    };
  }

  async start(onStopped?: (reason: 'manual' | 'deleted' | 'idle') => void): Promise<void> {
    if (this.timer !== null || this.messageId !== null) {
      throw new Error('DashboardLoop already started');
    }
    this.onStopped = onStopped ?? null;
    this.messageId = await this.opts.editor.sendInitial(renderDashboard(this.buildSnapshot()));
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Unref so the loop doesn't keep the node event loop alive if everything
    // else exits — matches launchd-managed daemon behavior.
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** Reset idle clock. Call from any user-message middleware. */
  markUserActivity(): void {
    this.lastActivityAt = (this.opts.now ?? Date.now)();
  }

  /** Internal — one tick of the refresh loop. Public for tests. */
  async tick(): Promise<void> {
    if (this.stopped || this.messageId === null) return;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastActivityAt >= this.idleTimeoutMs) {
      await this.stop('idle');
      return;
    }
    const text = renderDashboard(this.buildSnapshot());
    const result = await this.opts.editor.editMessage(text);
    if (result.ok) return;
    if (result.reason === 'deleted') {
      await this.stop('deleted');
      return;
    }
    // `throttled` and `error` are non-fatal — silently retry next tick.
  }

  async stop(reason: 'manual' | 'deleted' | 'idle' = 'manual'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onStopped?.(reason);
  }

  /** True iff the loop is still running. Test introspection. */
  isRunning(): boolean {
    return !this.stopped && this.timer !== null;
  }
}
