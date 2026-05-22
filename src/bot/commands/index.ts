import type { Bot } from 'grammy';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path, { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputFile, InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { buildSuggestions } from '../suggestions.js';
import { downloadTelegramAttachment, buildPromptWithAttachment, sendFileToChat } from '../attachments.js';
import { renderToolUse, friendlyToolLabel, extractToolItem } from '../tool-render.js';
import { PendingTools } from '../pending-tools.js';
import { toolCollapseMgr, progressMgr } from '../runtime-state.js';
import { renderStatusEvent, type AgentEventStatus } from '../progress.js';
import { diffCache } from '../diff-cache.js';
import { summaryCache } from '../summary-cache.js';
import { detectCodeBlock, wrapCodeBlockChunked } from '../code-fence.js';
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
import { loadPinnedContext, hasPinnedContext, pinnedContextPath, clearPinnedContext } from '../pinned-context.js';
import { runVerifyCommand, shouldAutoVerify, buildRetryPrompt } from '../auto-verify.js';
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
  'Viết bản tóm tắt TỰ-CHỨA bằng tiếng Việt cho câu trả lời / công việc vừa rồi, ' +
  'đủ thông tin để người đọc NẮM ĐƯỢC KẾT QUẢ mà không cần xem lại chi tiết. ' +
  'Giữ lại các điểm chính, kết luận, con số và đường dẫn quan trọng. ' +
  'Nếu là tác vụ code: nêu đã làm gì, file/feature/test nào đụng, kết quả (pass/fail/blocked). ' +
  'Nếu là câu trả lời/giải thích: truyền tải các ý chính và kết luận. ' +
  'Độ dài thích ứng: việc nhỏ vài câu, việc lớn dùng gạch đầu dòng. ' +
  'Không thêm lời mở đầu kiểu "Đây là tóm tắt" — đi thẳng vào nội dung.';

/**
 * v1.3 (spec done-summary-all-modes §D2) — cap for the per-turn accumulated
 * assistant text. Keeps the summarize input (and the §D4 fallback payload)
 * bounded so a pathologically long turn can't pin RAM. On overflow we keep the
 * head + tail (the middle is where prose is most compressible / least
 * load-bearing for a summary).
 */
const TURN_TEXT_CAP = 32_000;
const TURN_TEXT_HEAD = 20_000;
const TURN_TEXT_TAIL = 11_000;

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

  // v1.2 D11 — auto-verify retry count per session
  const verifyRetryCount = new Map<string, number>();

  // Context window usage tracking per session (Feature 1: context %)
  const sessionUsage = new Map<string, { inputTokens: number; outputTokens: number; contextWindow: number; model: string }>();

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
      const usage = sessionUsage.get(cur.id) ?? store.getSessionUsage(cur.id);
      if (usage && usage.contextWindow > 0) {
        const pct = Math.round((usage.inputTokens / usage.contextWindow) * 100);
        const usedK = Math.round(usage.inputTokens / 1000);
        const maxK = usage.contextWindow >= 1_000_000
          ? `${(usage.contextWindow / 1_000_000).toFixed(0)}M`
          : `${Math.round(usage.contextWindow / 1000)}K`;
        lines.push(`Context: ${usedK}K/${maxK} (${pct}%)${usage.model ? ' · ' + usage.model : ''}`);
        if (pct >= 70) lines.push('⚠️ Context window >70% — cân nhắc /handoff');
      } else if (usage) {
        const usedK = Math.round(usage.inputTokens / 1000);
        lines.push(`Tokens used: ${usedK}K${usage.model ? ' · ' + usage.model : ''}`);
      }
    }
    await ctx.reply(lines.join('\n'));
  });

  // ----- /model — view/change model for active session --------------------
  const MODEL_OPTIONS: Record<string, string[]> = {
    claude: ['claude-sonnet-4', 'claude-opus-4.7', 'claude-haiku-4.5'],
    kiro: ['auto', 'claude-sonnet-4', 'claude-opus-4.7', 'claude-sonnet-4.6', 'claude-haiku-4.5'],
    codex: ['gpt-5.1-codex', 'o3', 'o4-mini'],
    cursor: ['auto', 'claude-sonnet-4', 'gpt-5.2'],
  };

  bot.command('model', async (ctx) => {
    const cur = activeSession(ctx, store);
    if (!cur) return ctx.reply('Không có session active — /new để tạo.');
    const arg = (ctx.match || '').trim();
    if (!arg) {
      const agentCfg = config.agents[cur.agent as keyof typeof config.agents] as { model?: string } | undefined;
      const effective = cur.model ?? agentCfg?.model ?? 'auto (server default)';
      const models = MODEL_OPTIONS[cur.agent] ?? ['auto'];
      const buttons = models.map((m) => [{ text: m === effective ? `● ${m}` : m, callback_data: `model:set:${m}` }]);
      return ctx.reply(`Model hiện tại: ${effective}`, { reply_markup: { inline_keyboard: buttons } });
    }
    store.setSessionModel(cur.id, arg);
    await ctx.reply(`✓ Model đổi thành: ${arg}`);
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

  // ----- /notify (v1.2 D2) — quiet hours -----
  bot.command('notify', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();

    if (!arg) {
      // Show current status
      const qh = store.getQuietHours(chatId);
      if (!qh) {
        await ctx.reply('🔔 Quiet hours: OFF\n\nUsage:\n/notify quiet 22:00-08:00\n/notify quiet off');
      } else {
        const startH = String(Math.floor(qh.start / 60)).padStart(2, '0');
        const startM = String(qh.start % 60).padStart(2, '0');
        const endH = String(Math.floor(qh.end / 60)).padStart(2, '0');
        const endM = String(qh.end % 60).padStart(2, '0');
        await ctx.reply(`🔕 Quiet hours: ${startH}:${startM}–${endH}:${endM} (${qh.tz})\n\nMessages vẫn đến nhưng không kêu trong khung giờ này.\n/notify quiet off — tắt`);
      }
      return;
    }

    if (arg === 'quiet off') {
      store.clearQuietHours(chatId);
      await ctx.reply('🔔 Quiet hours disabled.');
      return;
    }

    // Parse "quiet HH:MM-HH:MM" or "quiet HH:MM-HH:MM TZ"
    const m = arg.match(/^quiet\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(?:\s+(.+))?$/);
    if (!m) {
      await ctx.reply('Usage: /notify quiet 22:00-08:00 [timezone]\nExample: /notify quiet 23:00-07:00 Asia/Ho_Chi_Minh');
      return;
    }
    const startMinute = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const endMinute = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (startMinute >= 1440 || endMinute >= 1440) {
      await ctx.reply('❌ Invalid time — hours must be 0-23, minutes 0-59.');
      return;
    }
    const tz = m[5]?.trim() || 'Asia/Ho_Chi_Minh';
    // Validate timezone
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      await ctx.reply(`❌ Invalid timezone: ${tz}`);
      return;
    }
    store.setQuietHours(chatId, startMinute, endMinute, tz);
    const startStr = `${m[1].padStart(2, '0')}:${m[2]}`;
    const endStr = `${m[3].padStart(2, '0')}:${m[4]}`;
    await ctx.reply(`🔕 Quiet hours set: ${startStr}–${endStr} (${tz})\nMessages vẫn đến nhưng silent trong khung giờ này.`);
  });

  // ----- /context (v1.2 D7) — pinned context -----
  bot.command('context', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply('No active session — /session new <agent> <label> [path]');
      return;
    }
    const projPath = projectPathOf(cur, store, process.cwd());

    if (arg === 'edit') {
      const fp = pinnedContextPath(projPath);
      await ctx.reply(`📝 Pinned context file:\n\`${fp}\`\n\nEdit this file to change the context injected into prompts.`, { parse_mode: 'Markdown' });
      return;
    }

    if (arg === 'clear') {
      const removed = clearPinnedContext(projPath);
      await ctx.reply(removed ? '🗑 Pinned context cleared.' : 'No pinned context file found.');
      return;
    }

    // Default: show current context
    const content = loadPinnedContext(projPath);
    if (!content) {
      await ctx.reply(`No pinned context found.\n\nCreate \`${pinnedContextPath(projPath)}\` to inject context into every prompt.`, { parse_mode: 'Markdown' });
    } else {
      const preview = content.length > 3000 ? content.slice(0, 3000) + '\n…(truncated)' : content;
      await ctx.reply(`📌 Pinned context (${content.length} chars):\n\n${preview}`);
    }
  });

  // ---- v1.2 D1: /send command — outbound file sharing ----
  bot.command('send', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();
    if (!arg) {
      await ctx.reply('Usage: /send <path>\nGửi file từ project về Telegram. Path relative to active project.');
      return;
    }
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply('No active session — /session new <agent> <label> [path]');
      return;
    }
    const projPath = projectPathOf(cur, store, process.cwd());
    const resolved = path.resolve(projPath, arg);
    // Security: only allow files within the project directory
    if (!resolved.startsWith(projPath + path.sep) && resolved !== projPath) {
      await ctx.reply('❌ Path traversal không được phép — chỉ gửi file trong project.');
      return;
    }
    const result = await sendFileToChat(
      { api: bot.api as never },
      { chatId, filePath: resolved, caption: path.basename(resolved) },
    );
    if (!result.success) {
      await ctx.reply(`❌ ${result.error}`);
    }
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

  // ---- v1.2 D6: /history command ----
  bot.command('history', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = (ctx.match ?? '').trim();

    if (args.startsWith('search ')) {
      const query = args.slice(7).trim();
      if (!query) { await ctx.reply('Usage: /history search <query>'); return; }
      const results = store.searchSessions(chatId, query, 5);
      if (results.length === 0) { await ctx.reply(`🔍 Không tìm thấy kết quả cho "${query}".`); return; }
      let msg = `🔍 Kết quả tìm kiếm "${query}":\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const session = store.getSession(r.sessionId);
        const date = session ? new Date(session.created_at).toLocaleDateString('vi-VN') : '';
        const agent = session?.agent ?? '';
        const status = session?.status ?? '';
        msg += `\n${i + 1}. [${r.label}] (${agent}, ${status}, ${date})\n   ${r.snippet}\n`;
      }
      await ctx.reply(msg);
      return;
    }

    const lastMatch = args.match(/^last\s+(\d+)d$/);
    if (lastMatch) {
      const days = parseInt(lastMatch[1]!, 10);
      const sessions = store.getRecentSessions(chatId, days);
      if (sessions.length === 0) { await ctx.reply(`📋 Không có session nào trong ${days} ngày qua.`); return; }
      let msg = `📋 Sessions (${days} ngày qua): ${sessions.length}\n`;
      for (const s of sessions.slice(0, 20)) {
        const date = new Date(s.created_at).toLocaleDateString('vi-VN');
        msg += `\n• [${s.label}] ${s.agent} · ${s.status} · ${date}`;
      }
      await ctx.reply(msg);
      return;
    }

    // Default: show last 7 days
    const sessions = store.getRecentSessions(chatId, 7);
    if (sessions.length === 0) { await ctx.reply('📋 Không có session nào trong 7 ngày qua.'); return; }
    let msg = `📋 Sessions (7 ngày qua): ${sessions.length}\n`;
    for (const s of sessions.slice(0, 10)) {
      const date = new Date(s.created_at).toLocaleDateString('vi-VN');
      msg += `\n• [${s.label}] ${s.agent} · ${s.status} · ${date}`;
    }
    msg += '\n\n💡 /history search <query> — tìm kiếm\n💡 /history last <N>d — xem N ngày qua';
    await ctx.reply(msg);
  });

  // ---- v1.2 D3: /cost command ----
  bot.command('cost', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();

    if (arg) {
      // /cost <session-label>
      const session = store.findSessionByLabel(chatId, arg);
      if (!session) {
        await ctx.reply(`❌ Session "${arg}" không tìm thấy.`);
        return;
      }
      const c = store.getCostBySession(session.id);
      await ctx.reply(
        `💰 Cost — [${session.label}] (${session.agent})\n` +
        `├ Input: ${c.input_tokens.toLocaleString()} tokens\n` +
        `├ Output: ${c.output_tokens.toLocaleString()} tokens\n` +
        `└ Total: $${c.total_cost.toFixed(4)}`,
      );
      return;
    }

    const today = store.getCostByChat(chatId, 1);
    const week = store.getCostByChat(chatId, 7);
    const month = store.getCostByChat(chatId, 30);
    const breakdown = store.getCostBreakdown(chatId, 30);

    let msg =
      `💰 Cost summary\n` +
      `├ Today:  $${today.total_cost.toFixed(4)}\n` +
      `├ 7 days: $${week.total_cost.toFixed(4)}\n` +
      `└ 30 days: $${month.total_cost.toFixed(4)}`;

    if (breakdown.length > 0) {
      msg += `\n\n📊 Per-agent (30d):`;
      for (const b of breakdown) {
        msg += `\n  ${b.agent}: $${b.total_cost.toFixed(4)} (${b.input_tokens.toLocaleString()} in / ${b.output_tokens.toLocaleString()} out)`;
      }
    }

    await ctx.reply(msg);
  });

  // ---- v1.2 D9: /timeline command ----
  bot.command('timeline', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();
    let sessionId: string | null = null;
    if (arg) {
      const found = store.findSessionByLabel(chatId, arg);
      if (!found) { await ctx.reply(`❌ Session "${arg}" không tìm thấy.`); return; }
      sessionId = found.id;
    } else {
      const cur = activeSession(ctx, store);
      if (!cur) { await ctx.reply('No active session — /timeline <label> hoặc switch session trước.'); return; }
      sessionId = cur.id;
    }
    const port = (globalThis as any).__telecode_timeline_port as number | undefined;
    if (!port) { await ctx.reply('❌ Timeline server chưa khởi động.'); return; }
    await ctx.reply(`📜 http://localhost:${port}/timeline/${sessionId}`);
  });

  // ---- v1.2 D11: /verify command ----
  bot.command('verify', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();

    if (arg === 'status') {
      const av = config.auto_verify;
      await ctx.reply(
        `🔍 Auto-verify config:\n` +
        `├ Enabled: ${av.enabled}\n` +
        `├ Command: \`${av.command}\`\n` +
        `├ Max retries: ${av.max_retries}\n` +
        `└ Agents: ${av.agents.length === 0 ? '(all)' : av.agents.join(', ')}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply('No active session — /session new <agent> <label> [path]');
      return;
    }
    const projPath = projectPathOf(cur, store, process.cwd());
    const command = config.auto_verify.command;
    await ctx.reply(`🔍 Running: \`${command}\`…`, { parse_mode: 'Markdown' });
    const result = await runVerifyCommand(command, projPath);
    if (result.passed) {
      await ctx.reply(`✅ Verify passed.`);
    } else {
      const output = (result.stdout + '\n' + result.stderr).trim();
      const truncated = output.length > 2000 ? '…' + output.slice(-2000) : output;
      await ctx.reply(
        `❌ Verify failed (exit ${result.exitCode}):\n\`\`\`\n${truncated}\n\`\`\``,
        { parse_mode: 'Markdown' },
      );
    }
  });

  // ---- v1.2 D4: /template command ----
  bot.command('template', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = (ctx.match ?? '').trim().split(/\s+/);
    const sub = args[0] ?? '';
    const name = args.slice(1).join(' ').trim();

    if (sub === 'save') {
      if (!name) { await ctx.reply('Usage: /template save <name>'); return; }
      const cur = activeSession(ctx, store);
      if (!cur) { await ctx.reply('❌ Không có active session.'); return; }
      const lastPrompt = cur.last_message ?? '';
      store.saveTemplate(chatId, name, cur.agent, lastPrompt, cur.project_id);
      await ctx.reply(`✅ Template "${name}" saved (agent=${cur.agent}).`);
      return;
    }

    if (sub === 'list') {
      const templates = store.listTemplates(chatId);
      if (templates.length === 0) { await ctx.reply('📋 Chưa có template nào. Dùng /template save <name>'); return; }
      let msg = '📋 Templates:\n';
      for (const t of templates) {
        msg += `• ${t.name} — ${t.agent} — "${t.prompt.slice(0, 50)}${t.prompt.length > 50 ? '…' : ''}"\n`;
      }
      await ctx.reply(msg);
      return;
    }

    if (sub === 'run') {
      if (!name) { await ctx.reply('Usage: /template run <name>'); return; }
      const tpl = store.getTemplate(chatId, name);
      if (!tpl) { await ctx.reply(`❌ Template "${name}" không tìm thấy.`); return; }
      // Create a new session from template
      const label = `${name}-${Date.now() % 100000}`;
      const sessionId = randomUUID();
      store.createSession({
        id: sessionId,
        label,
        agent: tpl.agent as import('../../agents/types.js').AgentKind,
        project_id: tpl.project_id,
        chat_id: chatId,
        sdk_session_id: null,
        status: 'idle',
      });
      store.setActiveSession(chatId, sessionId);
      await ctx.reply(`📍 [${label}] created from template "${name}" (agent=${tpl.agent})`);
      // Dispatch the saved prompt
      if (tpl.prompt) {
        await dispatchPromptToActiveSession(ctx, tpl.prompt);
      }
      return;
    }

    if (sub === 'delete') {
      if (!name) { await ctx.reply('Usage: /template delete <name>'); return; }
      const deleted = store.deleteTemplate(chatId, name);
      await ctx.reply(deleted ? `🗑 Template "${name}" deleted.` : `❌ Template "${name}" không tìm thấy.`);
      return;
    }

    await ctx.reply(
      '📋 /template commands:\n' +
      '• /template save <name> — lưu session hiện tại\n' +
      '• /template list — liệt kê templates\n' +
      '• /template run <name> — tạo session mới từ template\n' +
      '• /template delete <name> — xóa template',
    );
  });

  // ---- /schedule (v1.2 D5) ----
  bot.command('schedule', async (ctx) => {
    const chatId = ctx.chat!.id;
    const raw = (ctx.match ?? '').trim();
    const args = raw.split(/\s+/);
    const sub = args[0] ?? '';

    if (sub === 'add') {
      // /schedule add <name> <min> <hour> <dom> <mon> <dow> <prompt...>
      if (args.length < 8) {
        await ctx.reply('Usage: /schedule add <name> <min> <hour> <dom> <mon> <dow> <prompt>');
        return;
      }
      const name = args[1]!;
      const cron = args.slice(2, 7).join(' ');
      const prompt = args.slice(7).join(' ');
      // Use active session's agent or default to claude
      const cur = activeSession(ctx, store);
      const agent = cur?.agent ?? 'claude';
      const projectId = cur?.project_id ?? null;
      try {
        store.createSchedule(chatId, name, cron, agent, prompt, projectId);
      } catch (err: any) {
        if (String(err).includes('UNIQUE')) {
          await ctx.reply(`❌ Schedule "${name}" đã tồn tại. Xóa trước rồi tạo lại.`);
          return;
        }
        throw err;
      }
      await ctx.reply(`✅ Schedule "${name}" created\n⏰ ${cron} · ${agent}\n📝 ${prompt}`);
      return;
    }

    if (sub === 'list') {
      const schedules = store.listSchedules(chatId);
      if (schedules.length === 0) { await ctx.reply('📋 Chưa có schedule nào. Dùng /schedule add <name> ...'); return; }
      let msg = '📋 Schedules:\n';
      for (const s of schedules) {
        const status = s.enabled ? '✅' : '⏸';
        msg += `${status} ${s.name} — ${s.cron} — ${s.agent} — "${s.prompt.slice(0, 40)}${s.prompt.length > 40 ? '…' : ''}"\n`;
      }
      await ctx.reply(msg);
      return;
    }

    if (sub === 'delete') {
      const name = args[1] ?? '';
      if (!name) { await ctx.reply('Usage: /schedule delete <name>'); return; }
      const deleted = store.deleteSchedule(chatId, name);
      await ctx.reply(deleted ? `🗑 Schedule "${name}" deleted.` : `❌ Schedule "${name}" không tìm thấy.`);
      return;
    }

    if (sub === 'enable') {
      const name = args[1] ?? '';
      if (!name) { await ctx.reply('Usage: /schedule enable <name>'); return; }
      store.toggleSchedule(chatId, name, true);
      await ctx.reply(`✅ Schedule "${name}" enabled.`);
      return;
    }

    if (sub === 'disable') {
      const name = args[1] ?? '';
      if (!name) { await ctx.reply('Usage: /schedule disable <name>'); return; }
      store.toggleSchedule(chatId, name, false);
      await ctx.reply(`⏸ Schedule "${name}" disabled.`);
      return;
    }

    await ctx.reply(
      '⏰ /schedule commands:\n' +
      '• /schedule add <name> <cron 5-field> <prompt>\n' +
      '• /schedule list — liệt kê schedules\n' +
      '• /schedule enable <name>\n' +
      '• /schedule disable <name>\n' +
      '• /schedule delete <name>\n\n' +
      'Ví dụ: /schedule add daily-test 0 9 * * * pnpm test',
    );
  });

  // ---- v1.2 D10: /chain command — multi-agent pipeline ----
  bot.command('chain', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = (ctx.match ?? '').trim();

    if (!arg) {
      await ctx.reply(
        '⛓️ /chain — multi-agent pipeline\n\n' +
        'Syntax: /chain agent1: prompt1 | agent2: prompt2\n' +
        'Token `{{prev}}` = output bước trước.\n\n' +
        'Ví dụ:\n' +
        '/chain claude: viết unit test cho auth.ts | kiro: review code {{prev}} và suggest fixes\n\n' +
        'Max 5 steps, phân cách bằng |.',
      );
      return;
    }

    const { parseChain, injectPreviousOutput, validateChainAgents } = await import('../chain.js');
    const defaultAgent = config.defaults.agent;
    const parsed = parseChain(arg, defaultAgent);
    if ('error' in parsed) {
      await ctx.reply(`❌ ${parsed.error}`);
      return;
    }

    const agentError = validateChainAgents(parsed, deps.registry.kinds());
    if (agentError) {
      await ctx.reply(`❌ ${agentError}`);
      return;
    }

    // Resolve project cwd
    const cur = activeSession(ctx, store);
    const projPath = cur
      ? projectPathOf(cur, store, process.cwd())
      : process.cwd();

    const total = parsed.length;
    await ctx.reply(`⛓️ Starting chain (${total} steps)…`);

    let prevOutput = '';
    let lastSessionId: string | null = null;
    const createdSessionIds: string[] = [];

    for (let i = 0; i < parsed.length; i++) {
      const step = parsed[i]!;
      const stepLabel = `chain-${i + 1}-${Date.now() % 100000}`;

      // Create session for this step
      const session = manager.createSession({
        chatId,
        agent: step.agent,
        label: stepLabel,
        projectId: cur?.project_id ?? null,
      });
      createdSessionIds.push(session.id);

      // Build prompt with previous output injection
      const prompt = i === 0
        ? step.prompt
        : injectPreviousOutput(step.prompt, prevOutput);

      // Dispatch and collect output
      const textChunks: string[] = [];
      await new Promise<void>((resolve, reject) => {
        void manager
          .dispatch({
            sessionId: session.id,
            sessionLabel: stepLabel,
            chatId,
            cwd: projPath,
            agent: step.agent,
            resumeId: null,
            prompt,
            onEvent: (e) => {
              if (e.type === 'text') {
                textChunks.push(e.text);
              } else if (e.type === 'done') {
                resolve();
              } else if (e.type === 'error') {
                reject(new Error(e.error));
              }
            },
          })
          .catch(reject);
      });

      prevOutput = textChunks.join('');
      lastSessionId = session.id;
      await ctx.reply(`⛓️ Step ${i + 1}/${total} (${step.agent}) complete`);
    }

    // Send final output
    const notifier = notifierFor(chatId);
    const finalOutput = prevOutput.trim();
    if (finalOutput) {
      await notifier.sendChunked(`⛓️ Chain result:\n\n${finalOutput}`, { silent: false });
    } else {
      await ctx.reply('⛓️ Chain complete (no text output).');
    }

    // Close intermediate sessions, keep last one active
    for (const id of createdSessionIds) {
      if (id !== lastSessionId) {
        store.updateSession(id, { status: 'closed' });
      }
    }
    if (lastSessionId) {
      store.setActiveSession(chatId, lastSessionId);
    }
  });

  // ---- shared dispatcher for plain text + attachment captions ----
  // v1.2 D7 — track sessions that already received pinned context injection.
  const pinnedContextInjected = new Set<string>();

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

    // v1.2 D7 — pinned context injection (once per session)
    if (!pinnedContextInjected.has(cur.id)) {
      const pinned = loadPinnedContext(projPath);
      if (pinned) {
        effectivePrompt =
          `[Pinned project context]\n${pinned}\n\n${effectivePrompt}`;
        pinnedContextInjected.add(cur.id);
      }
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

    // v1.3 (spec done-summary-all-modes §D2) — accumulate the FULL assistant
    // text of this turn so the auto-done-summary can be fed the real answer
    // (not `transcript_tail`, which keeps only the last line of each chunk and
    // thus mangles multi-paragraph replies). Accumulated BEFORE the shouldEmit
    // gate so it captures text even in `summary` mode where streaming is
    // suppressed — that captured text is also the guaranteed-content fallback
    // (§D4) when the summarizer times out / crashes. Capped to avoid pinning
    // RAM on pathologically long turns (keep head + tail).
    let turnText = '';
    const appendTurnText = (chunk: string): void => {
      turnText += chunk;
      if (turnText.length > TURN_TEXT_CAP) {
        const head = turnText.slice(0, TURN_TEXT_HEAD);
        const tail = turnText.slice(-TURN_TEXT_TAIL);
        turnText = `${head}\n…\n${tail}`;
      }
    };

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
        model: cur.model,
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

          // v1.3 (spec done-summary-all-modes §D2/§D4) — capture the full
          // assistant text BEFORE the shouldEmit gate so it's collected even
          // in `summary` mode (where text events are suppressed below).
          if (e.type === 'text') {
            appendTurnText(e.text);
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
              // The detection itself never throws; on a miss `detectCodeBlock`
              // returns null and we fall through to plain streaming. On a hit
              // `wrapCodeBlockChunked` returns ≥1 independently-valid fenced
              // chunks. We trust the heuristic but still hard-fallback to plain
              // text inside the notifier if Telegram rejects the MarkdownV2
              // envelope.
              const detection = detectCodeBlock(e.text);
              if (detection) {
                // v1.3 Bug fix — chunk long code blocks instead of clipping at
                // 3500. Each chunk is an independently-valid fenced block; the
                // label prefix rides only on the first message.
                const wrappedChunks = wrapCodeBlockChunked(e.text, detection.lang);
                // Drain any pending stream first so chunk order stays right.
                void (async () => {
                  await notifier.closeStream(streamKey);
                  for (let ci = 0; ci < wrappedChunks.length; ci++) {
                    const composed =
                      ci === 0 && labelPrefix
                        ? escapeMd(labelPrefix) + '\n' + wrappedChunks[ci]
                        : wrappedChunks[ci]!;
                    await notifier.sendMarkdownV2(composed, { silent: true });
                  }
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
            if (isActive && e.tool === 'AskUserQuestion') {
              // v1.3 Bug fix — AskUserQuestion must arrive in full. It is the
              // ONE tool_use the user has to read end-to-end to answer it, and
              // it is never part of a same-tool burst. Bypass the collapse
              // manager (which would funnel it through `sendPlain` → clip at
              // 3500, mangling long multi-question asks) and send the full
              // render via `sendChunked` so it spans multiple Telegram messages
              // when needed. No diff button / pending-merge applies here.
              const askText = `${labelPrefix}${fallbackLine}`;
              void notifier.sendChunked(askText, { silent: true });
            } else if (isActive) {
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
            //   - Full preview char-count exceeds the configurable threshold
            //     (default 500). Short outputs are already readable.
            //   - Session has a sdk_session_id (no resume token → summarize
            //     would have no context, falls through to original render).
            // NOTE: fires in ALL modes (including verbose) — user requirement
            // "mode nào cũng cần LLM summarize".
            const autoSummarize =
              isActive &&
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

              // v1.2 D11 — auto-verify helper (shared across all done exit paths)
              const triggerAutoVerify = async (): Promise<void> => {
                if (!config.auto_verify?.enabled) return;
                const avOpts = {
                  command: config.auto_verify.command,
                  maxRetries: config.auto_verify.max_retries,
                  agents: config.auto_verify.agents,
                };
                if (!shouldAutoVerify(avOpts, cur.agent)) return;
                const retries = verifyRetryCount.get(cur.id) ?? 0;
                const verifyResult = await runVerifyCommand(avOpts.command, projPath);
                if (verifyResult.passed) {
                  verifyRetryCount.delete(cur.id);
                  await notifier.sendPlain(`${labelPrefix}✅ Auto-verify passed.`);
                } else if (retries < avOpts.maxRetries) {
                  verifyRetryCount.set(cur.id, retries + 1);
                  const retryPrompt = buildRetryPrompt(
                    avOpts.command,
                    verifyResult,
                    retries + 1,
                    avOpts.maxRetries,
                  );
                  await notifier.sendPlain(
                    `${labelPrefix}❌ Auto-verify failed (attempt ${retries + 1}/${avOpts.maxRetries}). Retrying…`,
                  );
                  void dispatchPromptToActiveSession(
                    { chat: { id: chatId }, reply: async () => {} } as any,
                    retryPrompt,
                  );
                } else {
                  verifyRetryCount.delete(cur.id);
                  await notifier.sendPlain(
                    `${labelPrefix}❌ Auto-verify failed after ${avOpts.maxRetries} attempts.`,
                  );
                }
              };

              // Phase D.4 — auto done-summary.
              //
              // v1.3 (spec done-summary-all-modes §D1/R1): fire in ALL four
              // verbosity modes (was: summary|normal only). Per user requirement
              // "ở bất cứ mode nào … khi làm xong 1 tác vụ cũng cần summary lại,
              // đảm bảo đủ content để user nắm" — verbose/thinking now also get
              // an end-of-turn recap.
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
                !approvalInFlight &&
                !!(freshSession?.sdk_session_id ?? cur.sdk_session_id);

              // v1.3 (§D4/R3) — was the streaming text suppressed this turn?
              // In `summary` mode `shouldEmit('text')` is false, so the user
              // saw NOTHING during the turn — the done-summary (or its
              // fallback) is the ONLY content surface. Used below to guarantee
              // content reaches the user even when the summarizer bails.
              const textWasSuppressed = !shouldEmit(
                { type: 'text', text: '' },
                currentMode,
              );

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
                // No-resume / approval-pending → can't run the summarizer.
                // v1.3 (§D4/R3): if text was SUPPRESSED this turn (summary
                // mode) and we captured content, surface the raw turn text so
                // the user isn't left with a blank screen. Only when the turn
                // is actually finished (not approval-in-flight).
                if (textWasSuppressed && !approvalInFlight && turnText.trim().length > 0) {
                  await notifier.sendChunked(`${labelPrefix}${turnText.trim()}`, {
                    silent: true,
                  });
                }
                const baselineMsgId = await notifier.sendPlain(
                  `${labelPrefix}${baselineTail}`,
                );
                if (baselineMsgId != null && doneKb) {
                  await notifier.editReplyMarkup(baselineMsgId, doneKb);
                }
                await triggerAutoVerify();
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

              // v1.4 (perf-pass §C2/R3) — CHEAP recap for modes that already
              // streamed the full text (normal/thinking/verbose). The user has
              // SEEN the answer, so spending a full LLM round-trip (which also
              // holds the session mutex and stalls the next prompt) just to
              // re-summarize it is pure overhead. Build a zero-round-trip recap
              // from data we already have (last meaningful line of the turn).
              // Only `summary` mode — where streaming text was suppressed — pays
              // for the real LLM summarize below.
              if (!textWasSuppressed) {
                const lastLine = turnText
                  .trim()
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .pop();
                if (lastLine) {
                  const recap = `${labelPrefix}${enhancedTail}\n${lastLine.slice(0, 280)}`;
                  await notifier.editPlainChunked(doneMsgId, recap);
                }
                await triggerAutoVerify();
                return;
              }

              // Build the summarize input. v1.3 (§D2): prefer the FULL turn
              // text captured this turn — it's the real answer. `transcript_tail`
              // (last line of each chunk only) and `doneResultText` are fallbacks
              // for turns that produced no streamed text (e.g. tool-only turns).
              const summarizePromptContent =
                turnText.trim() || freshSession?.transcript_tail || doneResultText || '';
              if (summarizePromptContent.length === 0) {
                // Nothing to summarize — leave the baseline tail in place.
                await triggerAutoVerify();
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
                // v1.3 (§D4/R3, P0) — guaranteed content. Summarizer timed out
                // or crashed. If the streaming text was SUPPRESSED this turn
                // (summary mode), the user has seen nothing — falling back to a
                // bare "✅ Done" would lose the entire answer. Send the raw
                // captured turn text instead (chunked for >3500 chars). When
                // text WAS streamed (normal/thinking/verbose), the user already
                // saw it, so the baseline tail is sufficient.
                if (textWasSuppressed && turnText.trim().length > 0) {
                  await notifier.sendChunked(`${labelPrefix}${turnText.trim()}`, {
                    silent: true,
                  });
                }
                await triggerAutoVerify();
                return;
              }
              const enhancedBody = `${labelPrefix}${enhancedTail}\n${summary}`;
              // Bug fix (P1): use editPlainChunked so long summaries (>3500
              // chars) don't get silently `clip()`-ed by `editPlain`. Overflow
              // spills into continuation messages with `↪ (cont. N/M)` header.
              await notifier.editPlainChunked(doneMsgId, enhancedBody);

              await triggerAutoVerify();
            })();
          } else if (e.type === 'session') {
            // Persist sdk_session_id so subsequent dispatches pass --resume-id.
            // Claude adapter persists directly via store import; Kiro/Codex/Cursor
            // adapters emit this event and rely on the handler to persist.
            store.updateSession(cur.id, { sdk_session_id: e.sdkSessionId });
          } else if (e.type === 'usage') {
            const usageData = {
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              contextWindow: e.contextWindow ?? 0,
              model: e.model ?? cur.agent,
            };
            sessionUsage.set(cur.id, usageData);
            store.setSessionUsage(cur.id, usageData);
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

  // ---- voice / audio → transcribe → dispatch ----
  // v1.2 D8 — Voice-to-Prompt via OpenAI Whisper API.
  const handleVoiceOrAudio = async (ctx: any, fileId: string): Promise<void> => {
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply('🎵 Nhận được voice nhưng không có active session — /new rồi gửi lại.');
      return;
    }
    const apiKey = config.voice.openai_api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      await ctx.reply('🎵 Voice-to-prompt chưa được cấu hình. Thêm OPENAI_API_KEY vào .env.');
      return;
    }
    // Download voice file to temp
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply('🎵 Không lấy được file path từ Telegram.');
      return;
    }
    const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
    const tmpPath = path.join(os.tmpdir(), `telecode-voice-${Date.now()}.ogg`);
    try {
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        await ctx.reply(`🎵 Download voice thất bại (${resp.status}).`);
        return;
      }
      const { writeFile, unlink } = await import('node:fs/promises');
      const buf = Buffer.from(await resp.arrayBuffer());
      await writeFile(tmpPath, buf);

      const { transcribeAudio } = await import('../voice-handler.js');
      const result = await transcribeAudio(tmpPath, { apiKey, model: config.voice.model });
      await unlink(tmpPath).catch(() => {});

      if ('error' in result) {
        await ctx.reply(result.error);
        return;
      }
      const preview = result.text.length > 50 ? result.text.slice(0, 50) + '…' : result.text;
      await ctx.reply(`🎵 "${preview}"`);
      await dispatchPromptToActiveSession(ctx, result.text);
    } catch (err) {
      await import('node:fs/promises').then((fs) => fs.unlink(tmpPath).catch(() => {}));
      logger.warn({ err: String(err) }, 'voice handler error');
      await ctx.reply(`🎵 Lỗi xử lý voice: ${String(err).slice(0, 200)}`);
    }
  };

  bot.on('message:voice', async (ctx) => {
    await handleVoiceOrAudio(ctx, ctx.message.voice.file_id);
  });
  bot.on('message:audio', async (ctx) => {
    await handleVoiceOrAudio(ctx, ctx.message.audio.file_id);
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
