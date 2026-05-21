import type { Bot } from 'grammy';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path, { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputFile, InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { buildSuggestions } from '../suggestions.js';
import { downloadTelegramAttachment, buildPromptWithAttachment } from '../attachments.js';
import { renderToolUse, friendlyToolLabel, extractToolItem } from '../tool-render.js';
import { PendingTools } from '../pending-tools.js';
import { toolCollapseMgr, progressMgr } from '../runtime-state.js';
import { renderStatusEvent, type AgentEventStatus } from '../progress.js';
import { diffCache } from '../diff-cache.js';
import { summaryCache } from '../summary-cache.js';
import { maybeWrapCodeBlock, detectCodeBlock } from '../code-fence.js';
import { escapeMd } from '../markdown.js';
import { summarizeWithSession, discardSummarizeMutex } from '../../agents/summarize.js';
import type { TelecodeConfig } from '../../config.js';
import type { SessionStore, SessionRow, AgentKind } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { ApprovalBroker } from '../../approval/broker.js';
import type { PolicyEngine } from '../../approval/policy.js';
import type { AgentRegistry } from '../../agents/registry.js';
import type { Notifier } from '../notifier.js';
import {
  MODE_METADATA,
  VERBOSITY_MODES,
  isVerbosityMode,
  resolveMode,
  shouldEmit,
  type VerbosityMode,
} from '../../session/verbosity.js';
import { verbosityModeKeyboard } from '../keyboards.js';
import { expandHome } from '../../util/paths.js';
import { scrubSecrets } from '../../util/scrub.js';
import { sessionPickKeyboard } from '../keyboards.js';
import {
  buildSessionList,
  buildProjectList,
  buildPersistentKeyboard,
  splitCatchUp,
  type SessionListItem,
  type ProjectListItem,
} from '../reply-builders.js';
import { DashboardLoop, type DashboardEditor } from '../dashboard.js';
import { wizardState } from '../wizard-state.js';
import { logger } from '../../util/logger.js';

export interface CommandDeps {
  config: TelecodeConfig;
  store: SessionStore;
  manager: SessionManager;
  broker: ApprovalBroker;
  policy: PolicyEngine;
  /**
   * Adapter registry (plan P1.1). Used by `/session new` to validate the
   * `<agent>` arg against the live set of registered adapters instead of the
   * old hardcoded `claude | kiro` check.
   */
  registry: AgentRegistry;
  notifierFor: (chatId: number) => Notifier;
}

/**
 * Phase B (v1.1) — per-session resolved-mode cache shared across the module
 * so:
 *   - the dispatch handler doesn't re-hit SQLite on every event (one read at
 *     dispatch start; cached value drives `shouldEmit` for the rest of the
 *     turn);
 *   - the `/mode` and `/settings` callbacks can invalidate the cache so the
 *     next event respects the new preference without restarting the session.
 *
 * Key = session id (sessions are 1:1 with adapter turns; chat-level changes
 * invalidate every entry for that chat via {@link invalidateChatModeCache}).
 *
 * Exported for tests + the router callbacks that mutate preferences.
 */
const sessionModeCache = new Map<string, VerbosityMode>();

export function getCachedSessionMode(sessionId: string): VerbosityMode | undefined {
  return sessionModeCache.get(sessionId);
}

export function setCachedSessionMode(sessionId: string, mode: VerbosityMode): void {
  sessionModeCache.set(sessionId, mode);
}

export function invalidateSessionModeCache(sessionId: string): void {
  sessionModeCache.delete(sessionId);
}

/**
 * Invalidate every cached entry for sessions belonging to `chatId`. Used by
 * `/settings mode <name>` so the new chat default takes effect immediately
 * across all running dispatches in the same chat (per plan §B.4 race rule).
 *
 * We require a {@link SessionStore} so we can resolve session→chat without
 * keeping a redundant chat-id map alongside the cache (mode cache is small;
 * iterating sessions is cheap and avoids a second source of truth).
 */
export function invalidateChatModeCache(chatId: number, store: SessionStore): void {
  for (const id of Array.from(sessionModeCache.keys())) {
    const row = store.getSession(id);
    if (row && row.chat_id === chatId) sessionModeCache.delete(id);
  }
}

/**
 * Phase D.2 — char threshold beyond which a `tool_result.preview` triggers
 * auto-summarize. Configurable via `TELECODE_AUTO_SUMMARIZE_THRESHOLD` env
 * var so power users can tune cost vs verbosity without a redeploy.
 *
 * Default 500: short enough to catch real long-output cases (test runs,
 * file dumps, grep results) without firing on tiny "ok" / 5-line responses
 * that don't need an AI pass to be readable.
 */
function autoSummarizeThreshold(): number {
  const raw = process.env.TELECODE_AUTO_SUMMARIZE_THRESHOLD;
  if (!raw) return 500;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 500;
  return n;
}

/**
 * Phase D.2 — instruction injected at the head of the auto-summarize prompt
 * for long `tool_result` previews. Vietnamese to match the user's locale
 * (plan §13 lists multi-language as out of scope for v1.1).
 */
const AUTO_TOOL_RESULT_SUMMARIZE_INSTRUCTION =
  'Tóm tắt output dưới đây trong 1-2 dòng tiếng Việt ngắn gọn, ' +
  'tập trung vào kết quả chính (pass/fail, số lượng, lỗi cụ thể). ' +
  'Không cần giải thích, không markdown nặng — chỉ summary thuần text.';

/**
 * Phase D.4 — instruction for auto done-summary. Asks the agent to summarize
 * what it just did across the entire turn. 1-2 câu giữ ngắn để fit phone glance.
 */
const AUTO_DONE_SUMMARIZE_INSTRUCTION =
  'Tóm tắt công việc vừa làm trong 1-2 câu tiếng Việt, ngắn gọn. ' +
  'Tập trung vào: đã làm gì xong, file/feature/test nào đã đụng, ' +
  'kết quả cuối (pass/fail/blocked). Không giải thích, không markdown — chỉ summary.';

/**
 * Phase D.2 helper — render a byte count as a compact human-readable hint
 * ("450B", "1.2KB", "12KB", "1.5MB"). Used in the "⏳ Summarizing N output…"
 * placeholder so the user knows roughly how much content is being condensed.
 *
 * Exported for tests.
 */
export function formatBytesShort(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    return kb >= 10 ? `${Math.round(kb)}KB` : `${kb.toFixed(1)}KB`;
  }
  const mb = n / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)}MB` : `${mb.toFixed(1)}MB`;
}

/**
 * Best-effort extraction of a file path from a tool_use input. Mirrors the
 * heuristics in `renderInputForMatch` (src/approval/policy.ts) but returns
 * `null` when the tool isn't path-shaped — avoids tagging suggestions like
 * [Xem file] when there's nothing meaningful to view.
 *
 * Exported for unit-testing — the production caller is the plain-text
 * dispatcher's tool_use branch below.
 */
export function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  if (typeof o.file_path === 'string' && o.file_path.length > 0) return o.file_path;
  if (typeof o.path === 'string' && o.path.length > 0) return o.path;
  const ops = (o as { operations?: unknown }).operations;
  if (Array.isArray(ops) && ops.length > 0) {
    const first = ops[0] as Record<string, unknown> | undefined;
    if (first && typeof first.path === 'string') return first.path;
  }
  return null;
}

/**
 * Result of a platform-gated screen capture (plan P1.3).
 *
 *   ok=true        → file written to disk; size is checked separately by the
 *                    caller to surface "empty image / permission missing"
 *                    hints consistently across OSes.
 *   ok=false       → no file produced. `message` is user-facing (Vietnamese
 *                    optional) and includes the install hint for Linux when
 *                    no screenshot tool is available.
 */
export interface CaptureResult {
  ok: boolean;
  message: string;
  parseMode?: 'Markdown';
}

/**
 * Capture the screen to `outPath` using the right tool for the host OS.
 *
 *   darwin → `screencapture -x` (silent, no shutter sound).
 *   linux  → first available of `grim` (Wayland) → `gnome-screenshot -f` →
 *            `scrot`. Probed via `--version` so we don't waste time spawning
 *            a tool that will exit 127. If none are available, returns a
 *            helpful `apt install gnome-screenshot` hint.
 *   win32  → PowerShell snippet using System.Drawing.Bitmap +
 *            Screen.PrimaryScreen.Bounds. Saves directly to PNG.
 *
 * Exported for unit tests — the production caller is the `/screenshot`
 * command above.
 */
export async function captureScreen(
  outPath: string,
  // Injection points for unit tests — defaults wire through the real execa.
  exec: typeof execa = execa,
  platform: NodeJS.Platform = process.platform,
): Promise<CaptureResult> {
  if (platform === 'darwin') {
    const r = await exec('screencapture', ['-x', outPath], { timeout: 10_000, reject: false });
    if (r.exitCode !== 0) {
      return {
        ok: false,
        message:
          '📸 screencapture failed.\n' +
          'Most often this means *Screen Recording* permission is missing.\n' +
          'System Settings → Privacy & Security → Screen & System Audio Recording → enable the binary running the daemon (Terminal / node / launchd) → restart daemon.',
        parseMode: 'Markdown',
      };
    }
    return { ok: true, message: '' };
  }

  if (platform === 'linux') {
    // Probe tools in priority order. We use `--version` (universally supported,
    // exits 0 quickly) instead of `--help` to keep timing tight.
    const candidates = [
      { tool: 'grim', args: [outPath] },
      { tool: 'gnome-screenshot', args: ['-f', outPath] },
      { tool: 'scrot', args: [outPath] },
    ];
    for (const c of candidates) {
      try {
        const probe = await exec(c.tool, ['--version'], { timeout: 3_000, reject: false });
        if (probe.exitCode !== 0) continue;
      } catch {
        continue;
      }
      const r = await exec(c.tool, c.args, { timeout: 10_000, reject: false });
      if (r.exitCode === 0) {
        return { ok: true, message: '' };
      }
      // First available tool failed — surface that specific error instead of
      // silently falling through; tool-specific failure modes (Wayland w/o
      // permission, scrot DISPLAY missing) are clearer to debug than "no
      // tool found".
      return {
        ok: false,
        message: `📸 ${c.tool} exit ${r.exitCode ?? '?'} — chạy thử thủ công để xem stderr.`,
      };
    }
    return {
      ok: false,
      message:
        '📸 Không tìm thấy công cụ chụp màn hình.\n' +
        'Linux cần một trong các tool sau:\n' +
        '  • `grim` (Wayland)\n' +
        '  • `gnome-screenshot` (`sudo apt install gnome-screenshot`)\n' +
        '  • `scrot` (`sudo apt install scrot`)',
      parseMode: 'Markdown',
    };
  }

  if (platform === 'win32') {
    // PowerShell snippet — uses System.Drawing.Bitmap directly so we don't
    // depend on screen-capture freeware. The output path is single-quoted to
    // survive backslashes; we double any literal single quote inside it (PS
    // escape rule). Single backslashes in paths are fine inside single quotes.
    const safe = outPath.replace(/'/g, "''");
    const cmd = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
      "$g = [System.Drawing.Graphics]::FromImage($bmp);",
      "$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);",
      `$bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      "$g.Dispose(); $bmp.Dispose();",
    ].join(' ');
    const r = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { timeout: 10_000, reject: false },
    );
    if (r.exitCode !== 0) {
      return {
        ok: false,
        message: `📸 PowerShell capture exit ${r.exitCode ?? '?'} — kiểm tra session khả năng truy cập desktop.`,
      };
    }
    return { ok: true, message: '' };
  }

  return {
    ok: false,
    message: `📸 Platform '${platform}' chưa được hỗ trợ cho /screenshot.`,
  };
}

// Loosely-typed ctx so callers from Bot<any> (with conversation flavor) pass
// through without casting; we only read `ctx.chat?.id`.
function activeSession(
  ctx: { chat?: { id?: number } },
  store: SessionStore,
): SessionRow | null {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const st = store.getChatState(chatId);
  if (!st.active_session_id) return null;
  return store.getSession(st.active_session_id) ?? null;
}

/**
 * Synthetic prompt the agent receives when the user runs `/handoff` (or taps
 * the [🤝] button in `/sessions`). Designed so the response is a compact
 * note suitable as preamble for a fresh context window.
 *
 * Exported so the callback handler in router.ts shares the exact wording.
 */
export const HANDOFF_PROMPT =
  'Tóm tắt context của session hiện tại (5–15 dòng): chúng ta đang làm gì, ' +
  'đã đi đến đâu, các file/module/lệnh quan trọng đã đụng vào, và bước tiếp ' +
  'theo. Mục đích: dùng làm starting context cho 1 instance mới (sau khi ' +
  'clear context window). Output thuần text, không markdown nặng, không list ' +
  'dài; viết như note ngắn cho chính mình.';

export interface HandoffDeps {
  store: SessionStore;
  manager: SessionManager;
  notifier: Notifier;
}

/**
 * Shared core of `/handoff`: validate → dispatch summarize prompt → on done,
 * save summary + wipe context. Fires async (returns immediately after sync
 * pre-flight checks). Caller is responsible for replying with `message`.
 *
 * Used by both `bot.command('handoff')` (acts on active session) and the
 * `session:handoff:<id>` callback (acts on the tapped session, regardless of
 * which is currently active).
 *
 * Returns sync pre-flight outcome. The async summarize work happens via
 * manager.dispatch in the background; the notifier handles user-visible
 * progress + final result.
 */
export function executeHandoff(
  sessionId: string,
  chatId: number,
  deps: HandoffDeps,
): { ok: boolean; message: string } {
  const { store, manager, notifier } = deps;
  const cur = store.getSession(sessionId);
  if (!cur || cur.chat_id !== chatId) {
    return { ok: false, message: 'session not found' };
  }
  if (cur.status === 'closed') {
    return { ok: false, message: `[${cur.label}] session đã closed — không handoff được.` };
  }
  if (manager.isBusy(sessionId)) {
    return {
      ok: false,
      message: `[${cur.label}] session đang busy — /stop xong rồi /handoff lại.`,
    };
  }
  if (!cur.sdk_session_id) {
    return {
      ok: false,
      message: `[${cur.label}] chưa có resume id (session fresh, chưa chạy prompt nào) — không có context để handoff.`,
    };
  }

  // Resolve cwd same way the plain-text dispatcher does — uses the session's
  // project_id (defaults to process.cwd() if project somehow vanished).
  const proj = cur.project_id
    ? (store.db.prepare(`SELECT path FROM projects WHERE id = ?`).get(cur.project_id) as
        | { path: string }
        | undefined)
    : undefined;
  const cwd = proj?.path ?? process.cwd();

  const labelPrefix = `[${cur.label}] `;
  const summaryChunks: string[] = [];

  // Fire-and-forget; manager.dispatch handles per-session mutex internally.
  void manager
    .dispatch({
      sessionId,
      sessionLabel: cur.label,
      chatId,
      cwd,
      agent: cur.agent,
      resumeId: cur.sdk_session_id,
      prompt: HANDOFF_PROMPT,
      onEvent: (e) => {
        // Re-read active id each event — session can flip mid-summarize.
        const activeId = store.getChatState(chatId).active_session_id;
        const isActive = sessionId === activeId;

        if (e.type === 'text') {
          summaryChunks.push(e.text);
          if (isActive) {
            notifier.appendStream(`s:${sessionId}`, e.text, {
              prefix: labelPrefix,
              silent: true,
            });
          }
          // Deliberately skip appendTranscript — we're about to wipe it.
        } else if (e.type === 'tool_use') {
          // Summarize prompt shouldn't tool-use; if it does, ignore.
        } else if (e.type === 'error') {
          void notifier.sendPlain(
            `${labelPrefix}❌ handoff failed: ${e.error}\nContext KHÔNG bị clear (an toàn).`,
          );
        } else if (e.type === 'done') {
          const summary = summaryChunks.join('').trim();
          if (!summary) {
            void notifier.sendPlain(
              `${labelPrefix}⚠️ handoff: agent trả về empty summary, không clear context.`,
            );
            return;
          }
          // Save summary + wipe sdk_session_id + transcript_tail in one update
          // so a half-handoff state is impossible (atomic from caller POV).
          store.updateSession(sessionId, {
            handoff_context: summary,
            sdk_session_id: null,
            transcript_tail: '',
          });
          void notifier.closeStream(`s:${sessionId}`).then(() =>
            notifier.sendPlain(
              `${labelPrefix}🤝 handoff complete — ${summary.length} chars saved.\n` +
                `Context window đã clear. Gõ prompt tiếp theo, summary sẽ inject làm preamble (1-shot).`,
            ),
          );
        }
      },
    })
    .catch((err: unknown) => {
      logger.error({ err: String(err), sessionId }, 'handoff dispatch crash');
    });

  return {
    ok: true,
    message:
      `🤝 [${cur.label}] requesting handoff summary từ agent…\n` +
      `Khi xong, context sẽ clear + summary lưu cho prompt kế tiếp.`,
  };
}

/**
 * v1.2 Bug 1 — build the SINGLE end-of-turn suggestion row.
 *
 * Behavior change vs v1.0:
 *   - v1.0 attached `buildSuggestions(...)` row to EVERY `tool_result`
 *     message, so a long agent turn produced 8 messages × 1 button row
 *     each = noisy wall of "▶️ Tiếp tục" buttons while the user wasn't
 *     even able to act (agent was still mid-stream).
 *   - v1.2 attaches the suggestion row EXACTLY ONCE per turn — on the
 *     `done` summary card, or on the `error` message if the turn failed.
 *
 * Input: the LAST tool that resolved during the turn (or null for
 *   text-only turns / turns that never invoked a tool).
 * Output: an `InlineKeyboardButton[]` row to add to the final message via
 *   `editReplyMarkup`. Empty array means "don't attach a keyboard".
 *
 * Fallback path: when `lastResolvedTool` is null, we still emit a default
 *   row (currently `[▶️ Tiếp tục]`) because the user is most often going to
 *   want to continue the conversation — that one button is high-value, low
 *   noise. The `ok` flag is forwarded so the failure-path heuristics
 *   (currently no different from success in `buildSuggestions`, but kept as
 *   a hook for future refinement) can shape the row.
 */
export function buildEndOfTurnSuggestions(
  lastResolvedTool: { toolName: string; filePath: string | null; ok: boolean } | null,
  sessionId: string,
  ok: boolean,
): InlineKeyboardButton[] {
  if (lastResolvedTool == null) {
    // No tool ever ran (pure text reply). Default to a minimal continuation
    // affordance. `buildSuggestions` returns `[▶️ Tiếp tục]` for any unknown
    // tool name → reuse that path so the heuristic stays single-source.
    return buildSuggestions({
      toolName: '__no_tool__',
      exitCode: ok ? 0 : 1,
      sessionId,
    });
  }
  return buildSuggestions({
    toolName: lastResolvedTool.toolName,
    exitCode: lastResolvedTool.ok ? 0 : 1,
    filePath: lastResolvedTool.filePath,
    sessionId,
  });
}

function projectPathOf(session: SessionRow, store: SessionStore, fallback: string): string {
  if (session.project_id) {
    const p = store.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(session.project_id) as { path: string } | undefined;
    if (p?.path) return p.path;
  }
  return fallback;
}

// `bot` is typed loosely as `Bot<any>` because router.ts upgrades the context
// flavor to `BotContext = ConversationFlavor<Context>` once the @grammyjs/
// conversations plugin is installed. `Bot<C>` is invariant in `C` in grammY,
// so this is the simplest way to keep `registerCommands` agnostic to the
// outside flavor while still using the bare Context APIs inside.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCommands(bot: Bot<any>, deps: CommandDeps): void {
  const { store, manager, policy, config, notifierFor, broker } = deps;

  // Per-chat dashboard registry (plan P0.5). Only one /dashboard message per
  // chat — re-running /dashboard while one is live no-ops with a hint. The
  // map is kept private to this scope; cleanup happens automatically when
  // the loop stops (manual / deleted / idle).
  const dashboards = new Map<number, DashboardLoop>();

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat!.id;
    const sessions = store.listSessions(chatId);
    const active = activeSession(ctx, store);
    const lines = [
      '👋 *Telecode* online',
      '',
      `Active: ${active ? '`' + active.label + '`' : '(none — `/session new`)'}`,
      `Sessions: ${sessions.length}`,
      '',
      'Commands: `/session`, `/projects`, `/cd`, `/stop`, `/status`, `/allow`, `/deny`, `/screenshot`',
    ];
    // Send the persistent reply keyboard alongside the welcome text. Telegram
    // keeps the keyboard visible across subsequent messages until explicitly
    // removed — re-issuing on every `/start` is idempotent and gives users a
    // reliable way to restore the keyboard if a client briefly cleared it.
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: buildPersistentKeyboard(),
    });
  });

  // ----- /sessions (B1) — enhanced list with active marker + switch buttons -----
  // Additive to the legacy `/session list` subcommand below; surfaces the new
  // reply-builders payload so users get inline switch buttons + a
  // [➕ New session] entry point. See plan §5.3 / SDD §B1.
  bot.command('sessions', async (ctx) => {
    const chatId = ctx.chat!.id;
    // listSessions(chatId) already filters out status='closed' by default —
    // matches the §5.3 spec ("only open sessions in the picker").
    const rows = store.listSessions(chatId);
    const activeId = store.getChatState(chatId).active_session_id;
    const items: SessionListItem[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      agent: r.agent,
      updatedAt: r.updated_at,
      status: r.status,
    }));
    const payload = buildSessionList(items, activeId);
    await ctx.reply(payload.text, {
      reply_markup: payload.reply_markup,
      ...(payload.parse_mode ? { parse_mode: payload.parse_mode } : {}),
    });
  });

  // ----- /session ... -----
  bot.command('session', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] ?? '').toLowerCase();
    switch (sub) {
      case 'new': {
        const agent: AgentKind = args[1] || config.defaults.agent;
        const label = args[2];
        const pathArg = args[3];
        if (!label) return ctx.reply('Usage: /session new <agent> <label> [path]');
        // Plan P1.1: validate against the live registry instead of hardcoded
        // 'claude | kiro'. Gives users a helpful list of valid kinds.
        if (!deps.registry.has(agent)) {
          const known = deps.registry.kinds().join(', ') || '(none registered)';
          return ctx.reply(`agent '${agent}' chưa được đăng ký. Available: ${known}`);
        }
        if (store.findSessionByLabel(chatId, label)) return ctx.reply(`session "${label}" already exists`);

        let projectId: number | null = null;
        if (pathArg) {
          const p = expandHome(pathArg);
          if (!existsSync(p)) return ctx.reply(`path not found: ${p}`);
          const row = store.upsertProject(basename(p), p);
          projectId = row.id;
        } else {
          const st = store.getChatState(chatId);
          projectId = st.active_project_id;
        }
        const row = manager.createSession({ chatId, agent, label, projectId });
        store.setActiveSession(chatId, row.id);
        await ctx.reply(`📍 [${label}] — agent=\`${agent}\``, { parse_mode: 'Markdown' });
        break;
      }
      case 'list': {
        const rows = store.listSessions(chatId);
        if (!rows.length) return ctx.reply('no sessions');
        const lines = rows.map(
          (r) => `• \`${r.label}\` — ${r.agent} · ${r.status}${r.sdk_session_id ? ' · resumable' : ''}`,
        );
        await ctx.reply(lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: sessionPickKeyboard(rows.map((r) => ({ id: r.id, label: r.label }))),
        });
        break;
      }
      case 'switch': {
        // Senior-review (Opus 4.7) [P1] scope-completeness — mirror the
        // inline-button switchSessionHandler in router.ts so the CLI path
        // gets the same fixes:
        //   (a) flush outgoing session's debounced stream + buffered events
        //       before activation switches (no orphan "last reply"),
        //   (b) chunked preview send so long transcript tails don't get
        //       silently truncated past 4096 chars,
        //   (c) catch-up of incoming session's buffered background events.
        const label = args[1];
        if (!label) return ctx.reply('Usage: /session switch <label>');
        const row = store.findSessionByLabel(chatId, label);
        if (!row) return ctx.reply(`unknown: ${label}`);
        const notifier = notifierFor(chatId);
        // (a1) Drain the outgoing session's debounced text stream so the last
        // partial reply lands BEFORE focus moves. closeStream is a no-op if
        // there's no active stream for the key.
        const prevActiveId = store.getChatState(chatId).active_session_id;
        if (prevActiveId && prevActiveId !== row.id) {
          await notifier.closeStream(`s:${prevActiveId}`);
          // (a2) Drain any buffered background events the outgoing session
          // accumulated during a prior background spell (rare but possible
          // when the user toggles between sessions quickly).
          if (manager.hasBuffered(prevActiveId)) {
            const prevRow = store.getSession(prevActiveId);
            if (prevRow) {
              const events = manager.drainBuffer(prevActiveId);
              const lines = events.map((e) => e.data);
              const header =
                `[${prevRow.label}] 📤 flushing on session switch (${events.length} pending):`;
              const contHeader = `[${prevRow.label}] 📤 flushing (cont.):`;
              const parts = splitCatchUp(header, contHeader, lines);
              for (const part of parts) {
                try {
                  await notifier.sendPlain(part, { silent: true });
                } catch (err) {
                  logger.warn(
                    { err: String(err), sessionId: prevActiveId },
                    '/session switch outgoing flush failed (continuing)',
                  );
                }
              }
            }
          }
        }
        store.setActiveSession(chatId, row.id);
        // (b) chunked send so a long transcript_tail isn't truncated.
        const tail = (row.transcript_tail ?? '')
          .split('\n')
          .slice(-config.session_switch_preview_lines)
          .join('\n');
        await notifier.sendChunked(
          `📍 [${row.label}]\n${tail || '(no transcript yet)'}`,
        );
        // (c) catch-up of incoming session's buffered background events.
        if (manager.hasBuffered(row.id)) {
          const events = manager.drainBuffer(row.id);
          const lines = events.map((e) => e.data);
          const header =
            `[${row.label}] 📥 catch-up (${events.length} events from background):`;
          const contHeader = `[${row.label}] 📥 catch-up (cont.):`;
          const parts = splitCatchUp(header, contHeader, lines);
          for (const part of parts) {
            try {
              await notifier.sendPlain(part, { silent: true });
            } catch (err) {
              logger.warn(
                { err: String(err), sessionId: row.id },
                '/session switch catch-up flush failed (continuing)',
              );
            }
          }
        }
        break;
      }
      case 'rename': {
        const newLabel = args[1];
        const cur = activeSession(ctx, store);
        if (!newLabel || !cur) return ctx.reply('Usage: /session rename <new-label>');
        if (store.findSessionByLabel(chatId, newLabel)) return ctx.reply('label taken');
        store.updateSession(cur.id, { label: newLabel });
        await ctx.reply(`✏️ ${cur.label} → ${newLabel}`);
        break;
      }
      case 'close': {
        const label = args[1];
        const target = label ? store.findSessionByLabel(chatId, label) : activeSession(ctx, store);
        if (!target) return ctx.reply('no session');
        manager.interrupt(target.id);
        store.updateSession(target.id, { status: 'closed' });
        // v0.8 P2: drop the per-session output buffer so a long-lived daemon
        // doesn't accumulate buffers for sessions the user has dismissed.
        manager.discardBuffer(target.id);
        // Phase C.4/C.3 — drop collapse + diff state for this session
        // (mirrors the inline [🗑] button path in router.ts).
        toolCollapseMgr.clearSession(target.id);
        diffCache.clearSession(target.id);
        // Phase D — drop summary cache + summarize mutex for this session.
        summaryCache.clearSession(target.id);
        discardSummarizeMutex(target.id);
        // Senior-review (Opus 4.7) [P3] — also evict the per-session mode
        // cache so a long-lived daemon doesn't accumulate stale entries
        // tied to closed sessions.
        invalidateSessionModeCache(target.id);
        // Phase E — drop the rolling progress message state (sync, no
        // Telegram call).
        progressMgr?.clear(target.id);
        const st = store.getChatState(chatId);
        if (st.active_session_id === target.id) store.setActiveSession(chatId, null);
        await ctx.reply(`🗑 closed [${target.label}]`);
        break;
      }
      // `clear` is the AI-agentic terminology — wipes the agent's context
      // (sdk resume id + transcript tail) so the next prompt starts fresh
      // while keeping the session row + label intact. `reset` is kept as a
      // legacy alias (Telecode v0.4–v0.8 used that name).
      case 'clear':
      case 'reset': {
        const cur = activeSession(ctx, store);
        if (!cur) return ctx.reply('no active session');
        store.updateSession(cur.id, { sdk_session_id: null, transcript_tail: '' });
        await ctx.reply(`🧹 cleared [${cur.label}] — context wiped, gõ prompt mới`);
        break;
      }
      default:
        await ctx.reply(
          'session subcommands: new <agent> <label> [path] | list | switch <label> | rename <label> | close [label] | clear',
        );
    }
  });

  // Top-level `/clear` — shortcut for `/session clear` on the active session.
  // AI-agentic muscle memory: most LLM CLIs use "/clear" to drop context.
  bot.command('clear', async (ctx) => {
    const cur = activeSession(ctx, store);
    if (!cur) return ctx.reply('no active session');
    store.updateSession(cur.id, { sdk_session_id: null, transcript_tail: '' });
    await ctx.reply(`🧹 cleared [${cur.label}] — context wiped, gõ prompt mới`);
  });

  // ----- /handoff — AI-agentic context handoff -----
  // 1. Ask the agent to self-summarize current context (5–15 lines).
  // 2. Capture the summary text via the dispatch's `done` event.
  // 3. Store summary in sessions.handoff_context, wipe sdk_session_id +
  //    transcript_tail (clear context).
  // 4. The NEXT plain-text dispatch detects handoff_context, prepends it as
  //    preamble to the user prompt, then clears it (1-shot).
  //
  // Net effect: session continues with fresh context window but carries
  // forward a compact AI-curated summary instead of full transcript.
  bot.command('handoff', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) return ctx.reply('no active session — /new để tạo');
    const result = executeHandoff(cur.id, chatId, {
      store,
      manager,
      notifier: notifierFor(chatId),
    });
    if (result.ok) {
      await ctx.reply(result.message, { disable_notification: true });
    } else {
      await ctx.reply(result.message);
    }
  });

  // ----- /mode (Phase B / plan §B.3) — per-session verbosity toggle -----
  //
  // No-arg form: show the current effective mode (session override or chat
  // default), the resolution chain (so power users understand fallbacks), and
  // a 4-button inline keyboard for one-tap switching.
  //
  // /mode <name>: validate against VERBOSITY_MODES, persist via
  // store.setSessionMode. Invalid names get the canonical list as a hint.
  bot.command('mode', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply(
        'Chưa có session active — /new tạo session rồi mới đổi mode được.',
      );
      return;
    }
    const arg = (ctx.match || '').trim().toLowerCase();
    if (arg) {
      if (!isVerbosityMode(arg)) {
        const known = VERBOSITY_MODES.join(' | ');
        await ctx.reply(
          `❓ Mode '${arg}' không hợp lệ. Chọn: ${known}`,
        );
        return;
      }
      store.setSessionMode(cur.id, arg);
      const meta = MODE_METADATA[arg];
      await ctx.reply(
        `${meta.icon} [${cur.label}] mode → *${meta.displayName}* (${meta.description})`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    // No-arg → show status + 4-button picker.
    const sessionMode = store.getSessionMode(cur.id);
    const chatDefault = store.getChatDefaultMode(chatId);
    const effective = resolveMode(sessionMode, chatDefault);
    const meta = MODE_METADATA[effective];
    const sourceLabel = sessionMode
      ? 'session override'
      : `chat default → ${MODE_METADATA[chatDefault].displayName}`;
    const lines = [
      `*Mode hiện tại của [${cur.label}]:* ${meta.icon} ${meta.displayName}`,
      `_${meta.description}_`,
      ``,
      `Source: ${sourceLabel}`,
      `Tap để đổi mode (chỉ áp dụng cho session này):`,
    ];
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: verbosityModeKeyboard('mode:set', effective),
    });
  });

  // ----- /settings (Phase B / plan §B.3) — chat-level defaults -----
  //
  // Today: only `mode` is exposed (default for new sessions in this chat).
  // Future fields go here too (theme, language, summary cost cap, …). We
  // keep the surface minimal — no-arg = pretty status + picker; subcommand
  // `mode <name>` flips the default without UI roundtrip.
  bot.command('settings', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'mode') {
      const name = (args[1] ?? '').toLowerCase();
      if (!name) {
        await ctx.reply('Usage: /settings mode <summary|normal|thinking|verbose>');
        return;
      }
      if (!isVerbosityMode(name)) {
        const known = VERBOSITY_MODES.join(' | ');
        await ctx.reply(`❓ Mode '${name}' không hợp lệ. Chọn: ${known}`);
        return;
      }
      store.setChatDefaultMode(chatId, name);
      const meta = MODE_METADATA[name];
      await ctx.reply(
        `${meta.icon} Chat default → *${meta.displayName}* (${meta.description})\n` +
          `Áp dụng cho session mới + session chưa set override.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    if (sub && sub !== 'mode') {
      await ctx.reply(
        'Usage: /settings | /settings mode <summary|normal|thinking|verbose>',
      );
      return;
    }
    // No-arg → show chat defaults + picker.
    const chatDefault = store.getChatDefaultMode(chatId);
    const meta = MODE_METADATA[chatDefault];
    const lines = [
      `*Chat settings*`,
      ``,
      `*Default mode:* ${meta.icon} ${meta.displayName} — _${meta.description}_`,
      ``,
      `Tap để đổi default cho cả chat (session mới sẽ dùng):`,
    ];
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: verbosityModeKeyboard('settings:mode', chatDefault),
    });
  });

  // ----- /projects — inline picker with pagination -----
  // Uses buildProjectList (reply-builders) which emits 1 button per project
  // labeled with the project name. The currently active project gets a `●`
  // prefix. Tap → `project:cd:<id>` callback switches the chat's active
  // project. Pagination row `[← Prev] [page x/y] [Next →]` when total > 8.
  // Callback handlers are wired in src/bot/router.ts. See plan §5.2 / SDD §B2
  // (the original two-button [Switch][New] layout was simplified post-v0.8
  // because users couldn't identify which row belonged to which project).
  bot.command('projects', async (ctx) => {
    const chatId = ctx.chat!.id;
    const rows = store.listProjects();
    const items: ProjectListItem[] = rows.map((p) => ({ id: p.id, name: p.name, path: p.path }));
    const activeId = store.getChatState(chatId).active_project_id;
    const payload = buildProjectList(items, { page: 1, activeId });
    await ctx.reply(payload.text, {
      reply_markup: payload.reply_markup,
      ...(payload.parse_mode ? { parse_mode: payload.parse_mode } : {}),
    });
  });

  bot.command('add', async (ctx) => {
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!args[0]) return ctx.reply('Usage: /add <path> [name]');
    const p = expandHome(args[0]);
    if (!existsSync(p)) return ctx.reply(`path not found: ${p}`);
    const name = args[1] ?? basename(p);
    const row = store.upsertProject(name, p);
    await ctx.reply(`📁 ${row.name} → ${row.path}`);
  });

  bot.command('cd', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = ctx.match.trim();
    if (!arg) return ctx.reply('Usage: /cd <name|path>');
    let proj = store.findProject(arg);
    if (!proj) {
      const p = expandHome(arg);
      if (existsSync(p)) proj = store.upsertProject(basename(p), p);
    }
    if (!proj) return ctx.reply('not found');
    store.setActiveProject(chatId, proj.id);
    const cur = activeSession(ctx, store);
    if (cur) store.updateSession(cur.id, { project_id: proj.id });
    await ctx.reply(`📁 cwd → ${proj.path}`);
  });

  // ----- control -----
  bot.command('stop', async (ctx) => {
    const cur = activeSession(ctx, store);
    if (!cur) return ctx.reply('no active session');
    const ok = manager.interrupt(cur.id);
    await ctx.reply(ok ? `🛑 stopping [${cur.label}]` : 'nothing to stop');
  });

  bot.command('status', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (args[0] === 'logs') {
      const n = Math.min(200, Math.max(1, Number(args[1] ?? 20)));
      const cur = activeSession(ctx, store);
      if (!cur) return ctx.reply('no active session');
      const rows = store.tailToolLog(cur.id, n);
      if (!rows.length) return ctx.reply('no logs');
      const txt = rows
        .map(
          (r) =>
            `${new Date(r.created_at).toISOString().slice(11, 19)} ${r.tool_name} ${r.decision ?? ''} ${(r.input_preview ?? '').slice(0, 60)}`,
        )
        .join('\n');
      await ctx.reply('```\n' + scrubSecrets(txt) + '\n```', { parse_mode: 'Markdown' });
      return;
    }
    const cur = activeSession(ctx, store);
    const all = store.listSessions(chatId);
    const lines = [
      `Active: ${cur ? '[' + cur.label + '] ' + cur.agent + ' · ' + cur.status : '(none)'}`,
      `Resume id: ${cur?.sdk_session_id ?? '—'}`,
      `Sessions: ${all.length}`,
    ];
    if (cur) {
      const tools = store.tailToolLog(cur.id, 5);
      if (tools.length) {
        lines.push('Last tools:');
        for (const t of tools) lines.push(`  - ${t.tool_name} ${t.decision ?? ''}`);
      }
    }
    await ctx.reply(lines.join('\n'));
  });

  // ----- /dashboard (plan P0.5) — live status dashboard ------------------
  // Single editable message refreshed every 2s with daemon state. Stops on:
  //   - `/dashboard stop`        (or the bare command while one is running)
  //   - message deleted          (editor returns `deleted`)
  //   - 5 min idle               (no user messages observed)
  bot.command('dashboard', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match || '').trim().toLowerCase();

    const existing = dashboards.get(chatId);
    if (arg === 'stop') {
      if (!existing) {
        await ctx.reply('Không có dashboard nào đang chạy.');
        return;
      }
      await existing.stop('manual');
      dashboards.delete(chatId);
      await ctx.reply('🛑 Đã tắt dashboard.');
      return;
    }
    if (existing?.isRunning()) {
      await ctx.reply('Dashboard đã chạy — gõ `/dashboard stop` để tắt trước khi mở mới.', {
        parse_mode: 'Markdown',
      });
      return;
    }
    // Lightweight editor that wraps bot.api. editMessage errors are decoded
    // into the union surface that DashboardLoop expects.
    const editor: DashboardEditor = {
      async sendInitial(text) {
        const msg = await ctx.reply(text, { parse_mode: 'Markdown' });
        return msg.message_id;
      },
      async editMessage(text) {
        const messageId = (ctx as unknown as { _dashboardMsgId?: number })._dashboardMsgId;
        if (!messageId) return { ok: false, reason: 'error' };
        try {
          await ctx.api.editMessageText(chatId, messageId, text, { parse_mode: 'Markdown' });
          return { ok: true };
        } catch (err) {
          const description = (err as { description?: string }).description ?? '';
          // Telegram returns 400 "message to edit not found" once the user
          // deletes the message; treat as a stop signal.
          if (/message to edit not found|message can't be edited/i.test(description)) {
            return { ok: false, reason: 'deleted' as const };
          }
          if (/Too Many Requests|retry after/i.test(description)) {
            return { ok: false, reason: 'throttled' as const };
          }
          // Suppress "message is not modified" 400s — render same content
          // back-to-back is fine.
          if (/message is not modified/i.test(description)) {
            return { ok: true };
          }
          logger.warn({ err: String(err) }, 'dashboard editMessageText failed');
          return { ok: false, reason: 'error' as const, err };
        }
      },
    };
    const loop = new DashboardLoop({
      store,
      manager: {
        hasBuffered: (id) => manager.hasBuffered(id),
        bufferBytesFor: (id) => manager.bufferBytesFor(id),
      },
      broker: {
        hasPendingFor: (cid, ex) => broker.hasPendingFor(cid, ex),
        countPendingFor: (cid) => broker.countPendingFor(cid),
      },
      activeWizardsFor: (cid) => (wizardState.isActive(cid) ? 1 : 0),
      editor: {
        async sendInitial(text) {
          const id = await editor.sendInitial(text);
          (ctx as unknown as { _dashboardMsgId?: number })._dashboardMsgId = id;
          return id;
        },
        editMessage: editor.editMessage.bind(editor),
      },
      chatId,
    });
    dashboards.set(chatId, loop);
    try {
      await loop.start((reason) => {
        dashboards.delete(chatId);
        if (reason === 'idle') {
          void ctx.reply('💤 Dashboard auto-tắt sau 5 phút idle.').catch(() => undefined);
        } else if (reason === 'deleted') {
          // Message gone — no follow-up reply (would only spam).
        }
      });
    } catch (err) {
      // sendInitial failed (e.g. Telegram 4xx). Drop the registry entry so a
      // retry can create a fresh loop, then surface a short reply.
      dashboards.delete(chatId);
      logger.warn({ err: String(err), chatId }, 'dashboard start failed');
      try {
        await ctx.reply('⚠️ Không mở được dashboard — thử lại sau.');
      } catch {
        /* best-effort */
      }
    }
  });

  bot.command('allow', async (ctx) => {
    const pat = ctx.match.trim();
    if (!pat) return ctx.reply('Usage: /allow <pattern>');
    policy.appendAllow(pat);
    await ctx.reply(`✅ allow += \`${pat}\``, { parse_mode: 'Markdown' });
  });
  bot.command('deny', async (ctx) => {
    const pat = ctx.match.trim();
    if (!pat) return ctx.reply('Usage: /deny <pattern>');
    policy.appendDeny(pat);
    await ctx.reply(`🚫 deny += \`${pat}\``, { parse_mode: 'Markdown' });
  });

  bot.command('screenshot', async (ctx) => {
    // Plan P1.3: platform-gated capture. Output path uses `os.tmpdir()` so
    // Windows resolves it to `%TEMP%`, Linux/macOS to `/tmp` (or `$TMPDIR` on
    // macOS) — never the hardcoded POSIX `/tmp` literal.
    const tmp = path.join(os.tmpdir(), `telecode-screen-${Date.now()}.png`);
    try {
      const r = await captureScreen(tmp);
      if (!r.ok) {
        await ctx.reply(r.message, r.parseMode ? { parse_mode: r.parseMode } : {});
        return;
      }
      // Re-check the produced file via the same heuristic the old macOS branch
      // used — even successful capture tools can produce an empty/0-byte file
      // when permissions are partially granted.
      const { statSync } = await import('node:fs');
      let size = 0;
      try {
        size = statSync(tmp).size;
      } catch {
        size = 0;
      }
      if (size < 1024) {
        await ctx.reply(
          process.platform === 'darwin'
            ? '📸 screencapture failed or returned empty image.\n' +
                'Most often this means *Screen Recording* permission is missing.\n' +
                'System Settings → Privacy & Security → Screen & System Audio Recording → enable the binary running the daemon (Terminal / node / launchd) → restart daemon.'
            : '📸 capture returned empty image — check daemon permissions or X server access.',
          { parse_mode: 'Markdown' },
        );
        return;
      }
      await ctx.replyWithPhoto(new InputFile(tmp));
    } catch (err) {
      await ctx.reply(`screenshot error: ${String(err).slice(0, 200)}`);
    }
  });

  // ---- shared dispatcher for plain text + attachment captions ----
  // v1.2 Feature 2/3 — extracted from `bot.on('message:text', ...)` so the
  // new photo + document handlers can reuse the entire onEvent pipeline
  // (verbosity routing, suggestion deferral, auto-summarize, etc.) by simply
  // supplying a synthetic prompt string. The handlers below are now thin
  // shims: they validate / download / build a prompt, then delegate here.
  //
  // `ctx` is loosely typed as `any` because the call sites are different
  // filter contexts (`message:text` vs `message:photo` vs `message:document`)
  // and we only read `ctx.chat!.id` + reply via `ctx.reply` — both exist on
  // every Filter<Context, 'message:*'> shape. Pulling in the heavy generic
  // Filter type here would force every consumer to import grammy types
  // unnecessarily.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function dispatchPromptToActiveSession(ctx: any, text: string): Promise<void> {
    const chatId = ctx.chat!.id;
    // P0.5: any user message resets the dashboard's idle clock so an active
    // viewer doesn't get auto-stopped while they're actively chatting.
    const dashLoop = dashboards.get(chatId);
    if (dashLoop) dashLoop.markUserActivity();
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply('no active session — /session new <agent> <label> [path]');
      return;
    }
    const projPath = projectPathOf(cur, store, process.cwd());
    const notifier = notifierFor(chatId);
    const streamKey = `s:${cur.id}`;
    const labelPrefix = `[${cur.label}] `;

    // `/handoff` may have written a self-summary into the session; we inject
    // it ONCE as a preamble to the next user prompt, then clear it. This is
    // the "start tiếp session bằng summary context vừa handoff" half of the
    // handoff loop — the summarize+clear half lives in the `/handoff` command
    // handler below.
    let effectivePrompt = text;
    if (cur.handoff_context) {
      effectivePrompt =
        `Context từ session trước (handoff summary):\n${cur.handoff_context}\n\n` +
        `User prompt mới:\n${text}`;
      store.updateSession(cur.id, { handoff_context: null });
      await ctx.reply(
        `📥 [${cur.label}] inject handoff context (${cur.handoff_context.length} chars) vào prompt — sẽ chỉ chạy 1 lần.`,
        { disable_notification: true },
      );
    }

    store.appendTranscript(cur.id, `> ${text.slice(0, 200)}`);
    await ctx.reply(`[${cur.label}] dispatching…`);

    // Phase B — resolve the effective verbosity mode ONCE per dispatch turn
    // and cache it (per plan §B.4 — avoid hitting SQLite per event). The
    // /mode + /settings callbacks invalidate this cache so subsequent events
    // pick up the new preference. Lifetime: until the next /mode change OR
    // until the next dispatch starts (we resolve afresh each turn).
    const sessionMode = store.getSessionMode(cur.id);
    const chatDefault = store.getChatDefaultMode(chatId);
    const effectiveMode = resolveMode(sessionMode, chatDefault);
    setCachedSessionMode(cur.id, effectiveMode);

    // Phase E — per-dispatch first-text flag. The progress message updates
    // to "⏳ Generating response…" only on the FIRST text chunk of a turn —
    // subsequent chunks are throttled out (no progress churn while the
    // streamer is mid-flight). Reset per dispatch.
    let progressTextSeen = false;

    // v1.2 Bug 1 — Track the last resolved tool of the turn so the suggestion
    // row ("▶️ Tiếp tục" / "🔁 Run again" / …) can be attached EXACTLY once
    // at end-of-turn (done/error), not on every intermediate tool_result.
    // Prior behavior: every tool_result message got a row, making the chat
    // look like a wall of buttons while the agent was still mid-stream and
    // the user couldn't actually "continue" anything — the agent was still
    // running. See docs/specs/telegram-media-input.html §R1.
    let lastResolvedTool: { toolName: string; filePath: string | null; ok: boolean } | null = null;

    // Phase A.5 — per-dispatch pending-tool tracker. Suggestion keyboards are
    // now attached when the matching tool_result arrives (Phase A.2 branch
    // below), NOT when the tool_use is announced — the user has more useful
    // context once the result is in. Adapters that don't emit tool_result
    // (currently Claude — fix deferred) get a 2-second fallback retrofit.
    //
    // Payload shape carried per pending entry: the suggestion-row builder
    // inputs plus the original message text. We rebuild the row at resolve
    // time because resolve carries the success bit (suggestion content can
    // depend on exit code — fs_write success vs failure path).
    interface PendingPayload {
      filePath: string | null;
      /**
       * Current text body of the tool_use announcement (excluding the
       * session-label prefix). Mutated by the C.4 collapse path via
       * {@link PendingTools.updateLatestPayload} as bursts grow so the
       * result-merge path uses the LATEST collapsed text instead of the
       * very first ToolName line.
       */
      line: string;
      /**
       * Phase C.3 — diff-cache key allocated for Edit-family tool_use events
       * when the resolved mode is `thinking` / `verbose`. Carried through so
       * the result-merge path can re-attach the `[📜 Show diff]` button on
       * the merged message alongside the suggestion row. `null` when no diff
       * was cached (most tools / summary+normal modes).
       */
      diffCallId: string | null;
    }
    const pending = new PendingTools<PendingPayload>({
      deferMs: 2_000,
      onTimeout: (entry) => {
        // Adapter never emitted tool_result. v1.2 Bug 1: drop the
        // suggestion-row retrofit (one row attaches once on done/error).
        // Keep the diff button retrofit because that's a per-tool affordance
        // (only meaningful for THIS Edit) — without it the user loses the
        // "Show diff" action entirely for adapters that don't emit
        // tool_result. Also remember the pending tool as the "last tool" so
        // the end-of-turn row reflects what actually happened.
        //
        // `messageId` should always be non-null here (the race-safe
        // `addPending` only starts the defer timer AFTER the send resolved).
        // Defensive guard anyway — silently no-op when the send failed and
        // we never got an id.
        if (entry.messageId == null) return;
        lastResolvedTool = {
          toolName: entry.toolName,
          filePath: entry.payload.filePath,
          ok: true,
        };
        if (entry.payload.diffCallId == null) return;
        const kb = new InlineKeyboard().text(
          '📜 Show diff',
          `diff:show:${cur.id}:${entry.payload.diffCallId}`,
        );
        void notifier.editReplyMarkup(entry.messageId, kb);
      },
    });

    // Fire-and-forget, await inside dispatch.
    //
    // v0.8 per-session gating (plan §2 behavior matrix):
    //   - text / tool_use → if session is currently ACTIVE for its chat,
    //     stream live (silent, with `[label] ` prefix). If BACKGROUND,
    //     append to the per-session OutputBuffer instead. Buffer is flushed
    //     either on /session switch or when a critical event (done/error)
    //     arrives.
    //   - error / done → ALWAYS live + NOTIFY. If background and buffer
    //     has content, drain it first as a catch-up message so the user
    //     sees the context that led to the failure/completion.
    //
    // Important: `cur` is captured at dispatch-start time, but the user can
    // switch active session mid-dispatch. We MUST re-read activeId from the
    // store on EVERY event — never cache it outside the callback.
    void manager
      .dispatch({
        sessionId: cur.id,
        sessionLabel: cur.label,
        chatId,
        cwd: projPath,
        agent: cur.agent,
        resumeId: cur.sdk_session_id,
        prompt: effectivePrompt,
        onEvent: (e) => {
          // Re-read on every event — active session can change during dispatch.
          const activeId = store.getChatState(chatId).active_session_id;
          const isActive = cur.id === activeId;

          // Phase B — mode filter (plan §B.4). Cached lookup so /mode change
          // during a turn is honored on the very next event. Fall back to the
          // dispatch-start resolved value if the cache was invalidated
          // mid-turn (defensive — see invalidateSessionModeCache).
          //
          // approval/error/done events ALWAYS leak through (handled inside
          // shouldEmit by returning true for those variants). The early
          // return below suppresses everything else when the active mode
          // rejects it — keeps the rest of this handler unchanged.
          const currentMode =
            getCachedSessionMode(cur.id) ?? effectiveMode;

          // Phase E — rolling progress message. Runs ONLY for active sessions
          // (a backgrounded session's events buffer up and replay on switch;
          // showing progress for a session the user isn't watching is
          // confusing). Mode awareness lives inside the manager — verbose
          // mode is a no-op there. We do all progress work BEFORE the
          // shouldEmit filter so the `status` events (suppressed in
          // non-verbose modes) still drive the indicator.
          if (isActive && progressMgr) {
            // Senior-review (Opus 4.7) [P1] — render the friendly progress
            // text from the event FIRST, then use it as either:
            //   (a) the bootstrap text on start() if no state exists yet, OR
            //   (b) the argument to update() if state already exists.
            //
            // Without this, the first event's text was lost: dispatch calls
            // `void start(...'⏳ Starting…')` and immediately `void update(text)`,
            // but `update()` reads `this.states.get()` BEFORE awaiting the
            // mutex and early-returns when state isn't yet populated by the
            // async `sendMessage()` inside `start()`. The first event's
            // meaningful text (e.g. "Codex thinking…") never made it to the
            // user — they saw "⏳ Starting…" pinned for the 1500ms throttle
            // window. Computing the text up front lets us seed the bootstrap
            // message directly so the first event is honored.
            const progressText: string | null = (() => {
              if (e.type === 'status') {
                return renderStatusEvent(e as AgentEventStatus);
              }
              if (e.type === 'tool_use') {
                return `⏳ Running ${friendlyToolLabel(e.tool)}…`;
              }
              if (e.type === 'text') {
                if (progressTextSeen) return null;
                progressTextSeen = true;
                return '⏳ Generating response…';
              }
              return null;
            })();

            if (e.type === 'done') {
              // Delete the progress message — Phase D done-summary card
              // takes over the user-visible "what just happened" surface.
              void progressMgr.finalize(cur.id);
            } else if (e.type === 'error') {
              // Tombstone with the error head so a quick glance shows the
              // failure mode (truncated to 60 chars — long stack traces
              // would push the message off-screen on mobile).
              const head = e.error.slice(0, 60).replace(/\n/g, ' ');
              void progressMgr.finalize(cur.id, '❌ ' + head);
            } else if (!progressMgr.has(cur.id)) {
              // First event of the turn → bootstrap. We treat ANY event as
              // the trigger so the message appears as fast as possible (the
              // adapter may emit a `status` long before its first `text`).
              // Use the friendly text computed above when available, or fall
              // back to the generic "Starting…" placeholder.
              void progressMgr.start(cur.id, chatId, progressText ?? '⏳ Starting…');
            } else if (progressText !== null) {
              void progressMgr.update(cur.id, progressText);
            }
          }

          if (!shouldEmit(e, currentMode)) {
            return;
          }

          if (e.type === 'text') {
            if (isActive) {
              // Phase C.2 — auto code-fence detection. When the chunk looks
              // like structured content (JSON / diff / shell / stack trace
              // / indented monospace), close the running stream first so
              // any in-flight prose finalizes, then send the wrapped block
              // as a SEPARATE MarkdownV2 message. Plain prose continues to
              // flow through `appendStream` so debounce + edit-rotation
              // still apply to ongoing narration.
              //
              // The detection itself never throws; `maybeWrapCodeBlock`
              // returns the original text on miss. We trust the heuristic
              // but still hard-fallback to plain text inside the notifier
              // if Telegram rejects the MarkdownV2 envelope.
              const detection = detectCodeBlock(e.text);
              if (detection) {
                const wrapped = maybeWrapCodeBlock(e.text);
                const composed = labelPrefix
                  ? escapeMd(labelPrefix) + '\n' + wrapped
                  : wrapped;
                // Drain any pending stream first so chunk order stays right.
                void (async () => {
                  await notifier.closeStream(streamKey);
                  await notifier.sendMarkdownV2(composed, { silent: true });
                })();
              } else {
                notifier.appendStream(streamKey, e.text, {
                  prefix: labelPrefix,
                  silent: true,
                });
              }
            } else {
              manager.appendBuffer(cur.id, {
                type: 'text',
                data: e.text,
                createdAt: Date.now(),
              });
            }
            store.appendTranscript(cur.id, e.text.split('\n').slice(-1)[0] ?? '');
          } else if (e.type === 'tool_use') {
            // Phase A.4 — friendly render replaces v1.0's raw-JSON dump.
            // Phase A.5 — suggestion keyboard deferred until tool_result OR
            // 2s fallback timer fires (see `pending.onTimeout` above).
            // Phase C.3 — for Edit-family tools in thinking/verbose modes
            // we also stash the diff payload in the per-session cache so
            // the result-merge path can render a `[📜 Show diff]` button.
            // Phase C.4 — bursts of identical tool_use events within 5s
            // are folded into a single editable message via the
            // {@link ToolCollapseManager} singleton.
            const friendly = renderToolUse(e.tool, e.input, { projectCwd: projPath });
            const scrubbedFriendly = scrubSecrets(friendly);
            // Background-session fallback line (used when not active — no
            // collapse logic for buffered events since the user won't see
            // them streamed; the catch-up will render them sequentially).
            const fallbackLine = `🔧 ${scrubbedFriendly}`;
            if (isActive) {
              const filePath = extractFilePath(e.input);
              const friendlyTool = friendlyToolLabel(e.tool);
              const item = extractToolItem(scrubbedFriendly, friendlyTool);

              // Phase C.3 — populate diff cache for Edit-family tools when
              // the user opts into thinking/verbose mode (no cost otherwise).
              // The callId is minted here per event; the result-merge path
              // and the `diff:show:<sessionId>:<callId>` router callback
              // both consume it.
              let diffCallId: string | null = null;
              const editLike =
                e.tool === 'Edit' ||
                e.tool === 'fs_write' ||
                e.tool === 'apply_patch' ||
                e.tool === 'NotebookEdit';
              if (
                editLike &&
                (currentMode === 'thinking' || currentMode === 'verbose')
              ) {
                const o = (e.input ?? {}) as Record<string, unknown>;
                const oldStr =
                  typeof o.old_string === 'string'
                    ? o.old_string
                    : typeof o.oldString === 'string'
                      ? o.oldString
                      : null;
                const newStr =
                  typeof o.new_string === 'string'
                    ? o.new_string
                    : typeof o.newString === 'string'
                      ? o.newString
                      : null;
                if (oldStr !== null && newStr !== null && oldStr !== newStr) {
                  diffCallId = randomUUID();
                  diffCache.set(cur.id, diffCallId, oldStr, newStr, filePath ?? '?');
                }
              }

              // Phase C.4 — burst collapse. Pure helper returns "what to do"
              // (send-new vs edit-existing); we drive notifier accordingly.
              const collapse = toolCollapseMgr.handle(
                cur.id,
                friendlyTool,
                item,
                labelPrefix,
              );

              if (collapse.action === 'edit') {
                // Within-window burst: edit the existing collapse message
                // in place. We ALSO enqueue an additional pending entry
                // sharing the same messageId — without this, adapters that
                // emit one tool_result per tool_use in a burst (Codex,
                // Cursor) would resolve only the first pending entry and
                // orphan-send the remaining N-1 results as separate
                // messages, defeating the collapse UX. Each extra pending
                // entry points at the same `collapse.msgId`, so every
                // matching tool_result edits the SAME collapsed message.
                // Senior-review (Opus 4.7) [P1] — refresh EVERY entry's
                // stored line via {@link PendingTools.updateAllPayloads}.
                // Refreshing only the most recent would leave the oldest
                // entries holding stale "first send" text, which the LAST
                // tool_result (LIFO consume reaches the oldest) would then
                // render as a stale "×1 · a" instead of the final
                // collapsed form.
                const newLine = collapse.formattedText.startsWith(labelPrefix)
                  ? collapse.formattedText.slice(labelPrefix.length)
                  : collapse.formattedText;
                pending.updateAllPayloads(e.tool, (p) => ({ ...p, line: newLine }));
                pending.addPending(
                  e.tool,
                  { filePath: extractFilePath(e.input), line: newLine, diffCallId },
                  Promise.resolve(collapse.msgId),
                );
                void notifier.editPlain(collapse.msgId, collapse.formattedText);
              } else {
                // Fresh send. Attach the diff button NOW if applicable —
                // user can tap immediately, even before tool_result arrives.
                const replyMarkup = diffCallId
                  ? new InlineKeyboard().text(
                      '📜 Show diff',
                      `diff:show:${cur.id}:${diffCallId}`,
                    )
                  : undefined;
                // Senior-review (Opus 4.7) [P1] — race-safe registration. We
                // enqueue the pending entry SYNCHRONOUSLY (with a
                // not-yet-resolved messageId) so a fast `tool_result` that
                // arrives before `sendPlain` resolves still matches and merges
                // into the same message instead of orphaning a separate one.
                const sendOpts: { silent: true; reply_markup?: unknown } = {
                  silent: true,
                };
                if (replyMarkup) sendOpts.reply_markup = replyMarkup;
                const sendPromise = notifier.sendPlain(
                  collapse.formattedText,
                  sendOpts,
                );
                const lineWithoutPrefix = collapse.formattedText.startsWith(labelPrefix)
                  ? collapse.formattedText.slice(labelPrefix.length)
                  : collapse.formattedText;
                pending.addPending(
                  e.tool,
                  { filePath, line: lineWithoutPrefix, diffCallId },
                  sendPromise,
                );
                // Record the message id back to the collapse manager so the
                // NEXT burst within window can edit this message.
                void sendPromise.then((id) => {
                  toolCollapseMgr.recordSent(collapse.key, id);
                });
              }
            } else {
              manager.appendBuffer(cur.id, {
                type: 'tool_use',
                data: fallbackLine,
                createdAt: Date.now(),
              });
            }
          } else if (e.type === 'tool_result') {
            // Phase A.2 — surface tool_result events that v1.0 silently
            // dropped. Render compact ✅/❌ marker + small preview. Active
            // sessions: edit the original tool_use message in place AND
            // attach the suggestion keyboard now that we know the outcome.
            // Background sessions: buffer a one-liner so /session switch
            // catch-up still surfaces it.
            const icon = e.ok ? '✅' : '❌';
            const label = e.ok ? 'ok' : 'failed';
            // Phase D.2/D.3/D.5 — full preview text is needed both for
            // auto-summarize (D.2, when length > threshold + mode != verbose)
            // and on-demand viewing (D.3 [💬 AI summary], D.5 [📜 Full
            // output]). The truncated 240-char `preview` is what we DISPLAY;
            // the full event.preview is what we CACHE so buttons can fetch
            // the un-trimmed content later.
            const fullPreview = e.preview ?? '';
            const truncated = fullPreview ? scrubSecrets(fullPreview.slice(0, 240)) : '';
            const preview = truncated ? `\n${truncated}` : '';
            // Senior-review (Opus 4.7) [P1] — use canonical friendly tool
            // label so a `codex.exec` tool_result reads `✅ Bash ok` (matching
            // the `🔧 Bash · ls` use header) instead of the raw adapter id.
            const friendlyTool = friendlyToolLabel(e.tool);
            const friendly = `${icon} ${friendlyTool} ${label}${preview}`;

            // Phase D.2 — auto-summarize gate. Fires only when:
            //   - Active session (background gets a single buffered line, no
            //     room to send placeholder + summary edit cleanly).
            //   - Mode != verbose (verbose users want raw transcript).
            //   - Full preview char-count exceeds the configurable threshold
            //     (default 500). Short outputs are already readable.
            //   - Session has a sdk_session_id (no resume token → summarize
            //     would have no context, falls through to original render).
            const autoSummarize =
              isActive &&
              currentMode !== 'verbose' &&
              fullPreview.length > autoSummarizeThreshold() &&
              !!cur.sdk_session_id;
            if (isActive) {
              const entry = pending.resolve(e.tool);
              if (entry) {
                // v1.2 Bug 1 — remember this as the last resolved tool so
                // the end-of-turn row reflects it. DO NOT attach the
                // suggestion row to this per-tool message; downstream
                // `row.length > 0` branches preserve existing diff +
                // AI-summary button logic unchanged.
                lastResolvedTool = {
                  toolName: e.tool,
                  filePath: entry.payload.filePath,
                  ok: e.ok,
                };
                const row: InlineKeyboardButton[] = [];
                // Build the merged message body. Two flavours:
                //   - Normal flow: `🔧 Bash · ls\n✅ Bash ok\n{truncated preview}`
                //   - D.2 auto-summarize flow: replace the result body with a
                //     `⏳ Summarizing 1.2KB output…` placeholder that gets
                //     edited again once summarizeWithSession resolves.
                const sizeHint = formatBytesShort(fullPreview.length);
                const placeholderBody =
                  `${labelPrefix}${entry.payload.line}\n` +
                  `${icon} ${friendlyTool} ${label}\n` +
                  `⏳ Summarizing ${sizeHint} output…`;
                const mergedBody = `${labelPrefix}${entry.payload.line}\n${friendly}`;
                const initialText = autoSummarize ? placeholderBody : mergedBody;

                // Phase D.3 — pre-decide whether the [💬 AI summary] button
                // should appear on the NON-auto-summarize path. We only
                // attach it when:
                //   - We have full preview text to cache (otherwise the
                //     button would have nothing to summarize).
                //   - Session has a resume id (the agent needs context).
                //   - We're NOT auto-summarizing (D.2 owns the keyboard in
                //     that branch — different buttons).
                const hasAiSummaryButton =
                  fullPreview.length > 0 && !!cur.sdk_session_id && !autoSummarize;

                // Edit the tool_use message in place. Real reply_markup
                // assembly happens AFTER we resolve `entry.messageReady` so
                // the [💬 AI summary] callback can encode the actual
                // messageId (Telegram callback_data is immutable per
                // message — can't be retrofitted later).
                void (async () => {
                  const msgId = await entry.messageReady;
                  if (msgId == null) {
                    await notifier.sendPlain(`${labelPrefix}${friendly}`, { silent: true });
                    return;
                  }
                  // Compose final keyboard for the initial edit.
                  let finalKb: InlineKeyboard | undefined;
                  if (row.length > 0 || entry.payload.diffCallId != null || hasAiSummaryButton) {
                    finalKb = new InlineKeyboard();
                    if (row.length > 0) finalKb.add(...row);
                    if (entry.payload.diffCallId != null) {
                      if (row.length > 0) finalKb.row();
                      finalKb.text(
                        '📜 Show diff',
                        `diff:show:${cur.id}:${entry.payload.diffCallId}`,
                      );
                    }
                    if (hasAiSummaryButton) {
                      if (row.length > 0 || entry.payload.diffCallId != null) finalKb.row();
                      finalKb.text('💬 AI summary', `summary:ai:${msgId}`);
                      summaryCache.set(msgId, fullPreview, friendlyTool, cur.id);
                    }
                  }
                  await notifier.editPlain(
                    msgId,
                    initialText,
                    finalKb ? { reply_markup: finalKb } : undefined,
                  );

                  // Phase D.2 — async auto-summarize. Fires AFTER the
                  // placeholder lands. summarizeWithSession blocks on the
                  // session-busy mutex (it WILL wait for the current
                  // dispatch to finish — that's OK; the user already sees
                  // the "⏳ Summarizing…" placeholder while waiting). On
                  // success, edit the placeholder into the final summary
                  // block with [📜 Full output] + [💬 Re-summarize]
                  // buttons. On failure/timeout, fall back to the regular
                  // truncated preview so the user is never stranded.
                  if (autoSummarize) {
                    // Pre-cache so a fast button tap doesn't race a missing
                    // entry (the [📜 Full output] callback uses this).
                    summaryCache.set(msgId, fullPreview, friendlyTool, cur.id);
                    void (async () => {
                      const summary = await summarizeWithSession({
                        manager,
                        store,
                        sessionId: cur.id,
                        content: fullPreview,
                        instruction: AUTO_TOOL_RESULT_SUMMARIZE_INSTRUCTION,
                        kind: 'auto-tool-result',
                      });
                      const lineCount = fullPreview.split('\n').length;
                      const fallbackKb = new InlineKeyboard();
                      let fallbackHasRow = false;
                      if (row.length > 0) {
                        fallbackKb.add(...row);
                        fallbackHasRow = true;
                      }
                      if (entry.payload.diffCallId != null) {
                        if (fallbackHasRow) fallbackKb.row();
                        fallbackKb.text(
                          '📜 Show diff',
                          `diff:show:${cur.id}:${entry.payload.diffCallId}`,
                        );
                        fallbackHasRow = true;
                      }
                      if (!summary) {
                        // Fallback: replace placeholder with the original
                        // truncated preview so the user sees SOMETHING.
                        // Keep [💬 AI summary] so they can retry manually.
                        if (fallbackHasRow) fallbackKb.row();
                        fallbackKb.text('💬 AI summary', `summary:ai:${msgId}`);
                        await notifier.editPlain(msgId, mergedBody, {
                          reply_markup: fallbackKb,
                        });
                        return;
                      }
                      // Success path — render the summary with full-output
                      // + re-summarize buttons.
                      const summarizedBody =
                        `${labelPrefix}${entry.payload.line}\n` +
                        `${icon} ${friendlyTool} ${label}\n${summary}`;
                      if (fallbackHasRow) fallbackKb.row();
                      fallbackKb.text(
                        `📜 Full output (${lineCount} lines)`,
                        `summary:full:${msgId}`,
                      );
                      fallbackKb.text('💬 Re-summarize', `summary:ai:${msgId}`);
                      await notifier.editPlain(msgId, summarizedBody, {
                        reply_markup: fallbackKb,
                      });
                    })();
                  }
                })();
              } else {
                // No pending tool_use to merge with (race / orphan event /
                // tool_use never reached us). Send the result as a fresh
                // message so the user still sees the outcome.
                // v1.2 Bug 1 — track even orphan results so the end-of-turn
                // suggestion row picks the right "last tool" heuristics.
                lastResolvedTool = { toolName: e.tool, filePath: null, ok: e.ok };
                const orphanKb = new InlineKeyboard();
                let hasOrphanButton = false;
                if (fullPreview.length > 0 && !!cur.sdk_session_id) {
                  // Pre-send so we can wire the real messageId into the
                  // button callback_data.
                  hasOrphanButton = true;
                }
                if (hasOrphanButton) {
                  // Send first to get the id, then edit to add the button.
                  void (async () => {
                    const orphanMsgId = await notifier.sendPlain(
                      `${labelPrefix}${friendly}`,
                      { silent: true },
                    );
                    if (orphanMsgId == null) return;
                    summaryCache.set(orphanMsgId, fullPreview, friendlyTool, cur.id);
                    orphanKb.text('💬 AI summary', `summary:ai:${orphanMsgId}`);
                    await notifier.editReplyMarkup(orphanMsgId, orphanKb);
                  })();
                } else {
                  void notifier.sendPlain(`${labelPrefix}${friendly}`, { silent: true });
                }
              }
            } else {
              manager.appendBuffer(cur.id, {
                type: 'tool_use',
                data: friendly,
                createdAt: Date.now(),
              });
            }
          } else if (e.type === 'error') {
            // ALWAYS live — critical event. Notify (not silent).
            // Flush buffered context first so the user sees what led here.
            // Senior-review (Opus 4.7) [P2] — tear down the pending tracker
            // too so any in-flight defer timers don't retrofit suggestion
            // keyboards onto a session that just errored out.
            pending.clear();
            // v1.2 Bug 1 — build the SINGLE suggestion row for this turn.
            // Falls back to default ("▶️ Tiếp tục") if no tool ever resolved.
            const errorSuggestionRow = buildEndOfTurnSuggestions(
              lastResolvedTool,
              cur.id,
              /*ok=*/ false,
            );
            const errorKb =
              errorSuggestionRow.length > 0
                ? new InlineKeyboard().add(...errorSuggestionRow)
                : undefined;
            void (async () => {
              if (!isActive && manager.hasBuffered(cur.id)) {
                await flushBufferedAsCatchUp(cur, manager, notifier);
              }
              const errMsgId = await notifier.sendPlain(`${labelPrefix}❌ ${e.error}`);
              if (errMsgId != null && errorKb) {
                await notifier.editReplyMarkup(errMsgId, errorKb);
              }
            })();
          } else if (e.type === 'done') {
            // ALWAYS live + notify. Close stream + flush buffer first so
            // catch-up arrives before the ✅ marker. Tear down the pending
            // tracker so orphan defer timers don't fire after the dispatch
            // window closed.
            pending.clear();
            const doneCost = e.totalCostUsd;
            const doneDurationMs = e.durationMs;
            const doneResultText = e.result;
            void (async () => {
              if (!isActive && manager.hasBuffered(cur.id)) {
                await flushBufferedAsCatchUp(cur, manager, notifier);
              }
              await notifier.closeStream(streamKey);

              // Phase D.4 — auto done-summary. Triggers when mode is summary
              // or normal AND we have a result/durationMs to format (i.e. the
              // dispatch ran a real turn, not a 0-event no-op). Verbose mode
              // skips — power users see the raw transcript already.
              //
              // Guard: skip when session.status is `waiting_approval` (an
              // approval is mid-flight; firing summarize now would pollute
              // the context window the agent is still using to make the
              // approval decision). In practice, by the time `done` fires
              // the broker has resolved everything, but read defensively.
              const freshSession = store.getSession(cur.id);
              const approvalInFlight = freshSession?.status === 'waiting_approval';
              // Use the FRESH session's resume id, not the stale `cur` row
              // captured at dispatch start. The first turn writes the sdk
              // session id mid-dispatch — by the time `done` fires the DB has
              // the new value but `cur.sdk_session_id` is still null. Without
              // this re-read, the very first done card never gets an
              // auto-summary even though the agent now has resume context
              // (Opus 4.7 review [P3]).
              const enableAutoDoneSummary =
                (currentMode === 'summary' || currentMode === 'normal') &&
                !approvalInFlight &&
                !!(freshSession?.sdk_session_id ?? cur.sdk_session_id);

              // Compose the basic done tail first — fallback if summarize
              // bails. Duration shown in seconds (rounded) when present.
              const durSec = typeof doneDurationMs === 'number'
                ? Math.round(doneDurationMs / 1000)
                : null;
              const baselineTail = doneResultText
                ? `✅ done${doneCost ? ` · $${doneCost.toFixed(4)}` : ''}`
                : '✅ done';
              const enhancedTail = (() => {
                const bits: string[] = ['✅ Done'];
                if (durSec !== null) bits.push(`${durSec}s`);
                if (typeof doneCost === 'number') bits.push(`$${doneCost.toFixed(4)}`);
                return bits.join(' · ');
              })();

              // v1.2 Bug 1 — single end-of-turn suggestion row. Built ONCE
              // from the last resolved tool of this turn (or default if no
              // tool ran) and attached to whichever done message we send.
              const doneSuggestionRow = buildEndOfTurnSuggestions(
                lastResolvedTool,
                cur.id,
                /*ok=*/ true,
              );
              const doneKb =
                doneSuggestionRow.length > 0
                  ? new InlineKeyboard().add(...doneSuggestionRow)
                  : undefined;

              if (!enableAutoDoneSummary) {
                // Verbose / no-resume / approval-pending → original v1.0 tail.
                const baselineMsgId = await notifier.sendPlain(
                  `${labelPrefix}${baselineTail}`,
                );
                if (baselineMsgId != null && doneKb) {
                  await notifier.editReplyMarkup(baselineMsgId, doneKb);
                }
                return;
              }

              // Send the done card immediately (so the user gets the ack
              // even if summarize takes a few seconds), then EDIT IT to
              // append the summary once the agent replies.
              const doneMsgId = await notifier.sendPlain(`${labelPrefix}${enhancedTail}`);
              if (doneMsgId == null) return;
              if (doneKb) {
                await notifier.editReplyMarkup(doneMsgId, doneKb);
              }

              // Build the summarize input — the most recent transcript tail
              // gives the agent enough context to summarize what it just did.
              const summarizePromptContent =
                freshSession?.transcript_tail ?? doneResultText ?? '';
              if (summarizePromptContent.length === 0) {
                // Nothing to summarize — leave the baseline tail in place.
                return;
              }

              const summary = await summarizeWithSession({
                manager,
                store,
                sessionId: cur.id,
                content: summarizePromptContent,
                instruction: AUTO_DONE_SUMMARIZE_INSTRUCTION,
                kind: 'auto-done',
              });
              if (!summary) {
                // Timeout / error — keep the baseline tail; no edit needed.
                return;
              }
              const enhancedBody = `${labelPrefix}${enhancedTail}\n${summary}`;
              // Bug fix (P1): use editPlainChunked so long summaries (>3500
              // chars) don't get silently `clip()`-ed by `editPlain`. Overflow
              // spills into continuation messages with `↪ (cont. N/M)` header.
              await notifier.editPlainChunked(doneMsgId, enhancedBody);
            })();
          } else if (e.type === 'session') {
            // resume id already persisted in adapter
          }
        },
      })
      .catch((err: unknown) => {
        pending.clear();
        logger.error({ err: String(err) }, 'dispatch crash');
      });
  }

  // ---- plain text → dispatch ----
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) return;
    await dispatchPromptToActiveSession(ctx, text);
  });

  // ---- photo → download + dispatch ----
  // v1.2 Feature 2 — user gửi photo vào chat, telecode lưu vào
  // ~/.telecode/inbox/<chatId>/, sau đó dispatch prompt với @path reference
  // cho agent đọc bằng Read tool. Caption (nếu có) trở thành body prompt;
  // không có caption → dùng default "Xem ảnh đính kèm và cho biết bạn thấy gì."
  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply(
        '📸 Nhận được ảnh nhưng không có active session — /session new <agent> <label> [path] rồi gửi lại.',
      );
      return;
    }
    // Telegram delivers a `PhotoSize[]` sorted small → large. Largest is
    // the highest resolution variant available; pick the last entry.
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) {
      await ctx.reply('📸 message:photo nhưng photo[] empty — không tải được.');
      return;
    }
    await ctx.reply(`📥 [${cur.label}] downloading photo…`);
    const result = await downloadTelegramAttachment(
      // Senior-review (Opus 4.7) [P3] — grammy exposes `bot.token` as a
      // public readonly (Bot.d.ts §106), so no `unknown` cast needed. The
      // earlier comment about "technically private" was wrong; the property
      // is part of the documented public surface used by the official
      // `@grammyjs/files` plugin.
      { token: bot.token, api: bot.api },
      chatId,
      largest.file_id,
      null,
      'photo',
      {
        maxBytes: config.telegram.attachment_max_bytes,
      },
    );
    if ('error' in result) {
      // Senior-review (Opus 4.7) [P2] — scrub on the bot token before
      // replying. Network error strings from `fetch` are clean by default,
      // but a malicious server could echo back the URL (which contains the
      // token) inside an error body. Defense-in-depth: never trust the
      // upstream message to be token-free.
      await ctx.reply(scrubSecrets(result.error));
      return;
    }
    logger.info(
      { chatId, sessionId: cur.id, path: result.absPath, size: result.sizeBytes },
      'photo saved',
    );
    const caption = ctx.message.caption ?? null;
    const prompt = buildPromptWithAttachment(caption, result);
    await dispatchPromptToActiveSession(ctx, prompt);
  });

  // ---- document → download + dispatch ----
  // v1.2 Feature 3 — same flow as photo but with extension allowlist (md /
  // html / docx / xlsx / pdf / …). Agent reads via its own Read tool — no
  // server-side parsing here (keep dep surface small).
  bot.on('message:document', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply(
        '📎 Nhận được file nhưng không có active session — /session new <agent> <label> [path] rồi gửi lại.',
      );
      return;
    }
    const doc = ctx.message.document;
    if (!doc) {
      await ctx.reply('📎 message:document nhưng document object missing — không tải được.');
      return;
    }
    await ctx.reply(`📥 [${cur.label}] downloading ${doc.file_name ?? 'file'}…`);
    // Build optional allowlist override from config — empty array means
    // "use default safe set" inside the attachments module.
    const overrideExts = config.telegram.attachment_allowed_exts;
    const allowedExts =
      overrideExts && overrideExts.length > 0
        ? new Set(overrideExts.map((s) => s.toLowerCase()))
        : undefined;
    const result = await downloadTelegramAttachment(
      // Senior-review (Opus 4.7) [P3] — public readonly per Bot.d.ts §106;
      // no `unknown` cast needed. Same cleanup as the photo handler above.
      { token: bot.token, api: bot.api },
      chatId,
      doc.file_id,
      doc.file_name ?? null,
      'document',
      {
        maxBytes: config.telegram.attachment_max_bytes,
        ...(allowedExts ? { allowedExts } : {}),
      },
    );
    if ('error' in result) {
      // Same scrub guard as the photo handler — see comment above.
      await ctx.reply(scrubSecrets(result.error));
      return;
    }
    logger.info(
      {
        chatId,
        sessionId: cur.id,
        path: result.absPath,
        size: result.sizeBytes,
        ext: result.ext,
      },
      'document saved',
    );
    const caption = ctx.message.caption ?? null;
    const prompt = buildPromptWithAttachment(caption, result);
    await dispatchPromptToActiveSession(ctx, prompt);
  });
}

/**
 * Drain a session's background OutputBuffer and send it as a single
 * "catch-up" message. Used when a background session emits a critical
 * event (done/error) or when the user switches to it — the user gets the
 * recent context before the closing message.
 *
 * Catch-up itself is sent silent (`disable_notification:true`) because the
 * subsequent critical message (or the act of switching) provides the
 * notification cue.
 *
 * No-op when the buffer is empty — callers may invoke unconditionally.
 */
export async function flushBufferedAsCatchUp(
  cur: SessionRow,
  manager: SessionManager,
  notifier: Notifier,
): Promise<void> {
  const events = manager.drainBuffer(cur.id);
  if (events.length === 0) return;
  const lines = events.map((e) => e.data);
  const header = `[${cur.label}] 📥 catch-up (${events.length} events from background):`;
  const contHeader = `[${cur.label}] 📥 catch-up (cont.):`;
  // Per plan §7 risk register (P2): a 50KB buffer joined into one message
  // would silently get clipped by Notifier (MAX_MSG_CHARS = 3500). Split at
  // line boundaries so the user sees the whole catch-up across multiple
  // silent messages.
  const parts = splitCatchUp(header, contHeader, lines);
  for (const part of parts) {
    await notifier.sendPlain(part, { silent: true });
  }
}
