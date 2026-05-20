import type { Bot } from 'grammy';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { InputFile } from 'grammy';
import type { TelecodeConfig } from '../../config.js';
import type { SessionStore, SessionRow, AgentKind } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { ApprovalBroker } from '../../approval/broker.js';
import type { PolicyEngine } from '../../approval/policy.js';
import type { Notifier } from '../notifier.js';
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
import { logger } from '../../util/logger.js';

export interface CommandDeps {
  config: TelecodeConfig;
  store: SessionStore;
  manager: SessionManager;
  broker: ApprovalBroker;
  policy: PolicyEngine;
  notifierFor: (chatId: number) => Notifier;
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
  const { store, manager, policy, config, notifierFor } = deps;

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
        const agent = (args[1] as AgentKind) || config.defaults.agent;
        const label = args[2];
        const pathArg = args[3];
        if (!label) return ctx.reply('Usage: /session new <agent> <label> [path]');
        if (agent !== 'claude' && agent !== 'kiro') return ctx.reply('agent must be claude or kiro');
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
        const label = args[1];
        if (!label) return ctx.reply('Usage: /session switch <label>');
        const row = store.findSessionByLabel(chatId, label);
        if (!row) return ctx.reply(`unknown: ${label}`);
        store.setActiveSession(chatId, row.id);
        const tail = (row.transcript_tail ?? '')
          .split('\n')
          .slice(-config.session_switch_preview_lines)
          .join('\n');
        await ctx.reply(`📍 [${row.label}]\n${tail || '(no transcript yet)'}`);
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
  const HANDOFF_PROMPT =
    'Tóm tắt context của session hiện tại (5–15 dòng): chúng ta đang làm gì, ' +
    'đã đi đến đâu, các file/module/lệnh quan trọng đã đụng vào, và bước tiếp ' +
    'theo. Mục đích: dùng làm starting context cho 1 instance mới (sau khi ' +
    'clear context window). Output thuần text, không markdown nặng, không list ' +
    'dài; viết như note ngắn cho chính mình.';

  bot.command('handoff', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) return ctx.reply('no active session — /new để tạo');
    if (manager.isBusy(cur.id)) {
      return ctx.reply(
        `[${cur.label}] session đang busy — /stop xong rồi /handoff lại.`,
      );
    }
    if (!cur.sdk_session_id) {
      return ctx.reply(
        `[${cur.label}] chưa có resume id (session fresh, chưa chạy prompt nào) — không có context để handoff.`,
      );
    }

    const projPath = projectPathOf(cur, store, process.cwd());
    const notifier = notifierFor(chatId);
    const labelPrefix = `[${cur.label}] `;
    const summaryChunks: string[] = [];

    await ctx.reply(
      `🤝 [${cur.label}] requesting handoff summary từ agent…\n` +
        `Khi xong, context sẽ clear + summary lưu cho prompt kế tiếp.`,
      { disable_notification: true },
    );

    void manager
      .dispatch({
        sessionId: cur.id,
        sessionLabel: cur.label,
        chatId,
        cwd: projPath,
        agent: cur.agent,
        resumeId: cur.sdk_session_id,
        prompt: HANDOFF_PROMPT,
        onEvent: (e) => {
          // Stream the summary live to chat so user can see what got captured.
          // Per-session gating still applies — if session went background mid
          // way, output goes to buffer like normal dispatches.
          const activeId = store.getChatState(chatId).active_session_id;
          const isActive = cur.id === activeId;

          if (e.type === 'text') {
            summaryChunks.push(e.text);
            if (isActive) {
              notifier.appendStream(`s:${cur.id}`, e.text, {
                prefix: labelPrefix,
                silent: true,
              });
            }
            // (deliberately NOT appendTranscript — we're about to wipe it)
          } else if (e.type === 'tool_use') {
            // Agent shouldn't tool-use for a summarize prompt, but if it does
            // we just ignore (no-op) — we only want the text.
          } else if (e.type === 'error') {
            void notifier.sendPlain(
              `${labelPrefix}❌ handoff failed: ${e.error}\n` +
                `Context KHÔNG bị clear (an toàn).`,
            );
          } else if (e.type === 'done') {
            const summary = summaryChunks.join('').trim();
            if (!summary) {
              void notifier.sendPlain(
                `${labelPrefix}⚠️ handoff: agent trả về empty summary, không clear context.`,
              );
              return;
            }
            // Save summary, wipe context. Keep label + agent + project.
            store.updateSession(cur.id, {
              handoff_context: summary,
              sdk_session_id: null,
              transcript_tail: '',
            });
            // Also close any open stream so next prompt starts fresh bubble.
            void notifier.closeStream(`s:${cur.id}`).then(() =>
              notifier.sendPlain(
                `${labelPrefix}🤝 handoff complete — ${summary.length} chars saved.\n` +
                  `Context window đã clear. Gõ prompt tiếp theo, summary sẽ inject làm preamble (1-shot).`,
              ),
            );
          }
        },
      })
      .catch((err: unknown) => {
        logger.error({ err: String(err) }, 'handoff dispatch crash');
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
    const tmp = `/tmp/telecode-screen-${Date.now()}.png`;
    try {
      const r = await execa('screencapture', ['-x', tmp], { timeout: 10_000, reject: false });
      // macOS screencapture exits 0 even when Screen Recording permission is
      // missing — it just writes a black image (or fails to write at all).
      // Surface a clearer hint when the file is missing or suspiciously tiny.
      const { statSync } = await import('node:fs');
      let size = 0;
      try {
        size = statSync(tmp).size;
      } catch {
        size = 0;
      }
      if (r.exitCode !== 0 || size < 1024) {
        await ctx.reply(
          '📸 screencapture failed or returned empty image.\n' +
            'Most often this means *Screen Recording* permission is missing.\n' +
            'System Settings → Privacy & Security → Screen & System Audio Recording → enable the binary running the daemon (Terminal / node / launchd) → restart daemon.',
          { parse_mode: 'Markdown' },
        );
        return;
      }
      await ctx.replyWithPhoto(new InputFile(tmp));
    } catch (err) {
      await ctx.reply(`screencapture error: ${String(err).slice(0, 200)}`);
    }
  });

  // ---- plain text → dispatch ----
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) return;
    const chatId = ctx.chat!.id;
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

          if (e.type === 'text') {
            if (isActive) {
              notifier.appendStream(streamKey, e.text, {
                prefix: labelPrefix,
                silent: true,
              });
            } else {
              manager.appendBuffer(cur.id, {
                type: 'text',
                data: e.text,
                createdAt: Date.now(),
              });
            }
            store.appendTranscript(cur.id, e.text.split('\n').slice(-1)[0] ?? '');
          } else if (e.type === 'tool_use') {
            const line = `🔧 ${e.tool} — ${scrubSecrets(
              JSON.stringify(e.input).slice(0, 200),
            )}`;
            if (isActive) {
              void notifier.sendPlain(`${labelPrefix}${line}`, { silent: true });
            } else {
              manager.appendBuffer(cur.id, {
                type: 'tool_use',
                data: line,
                createdAt: Date.now(),
              });
            }
          } else if (e.type === 'error') {
            // ALWAYS live — critical event. Notify (not silent).
            // Flush buffered context first so the user sees what led here.
            void (async () => {
              if (!isActive && manager.hasBuffered(cur.id)) {
                await flushBufferedAsCatchUp(cur, manager, notifier);
              }
              await notifier.sendPlain(`${labelPrefix}❌ ${e.error}`);
            })();
          } else if (e.type === 'done') {
            // ALWAYS live + notify. Close stream + flush buffer first so
            // catch-up arrives before the ✅ marker.
            void (async () => {
              if (!isActive && manager.hasBuffered(cur.id)) {
                await flushBufferedAsCatchUp(cur, manager, notifier);
              }
              await notifier.closeStream(streamKey);
              const tail = e.result
                ? `✅ done${e.totalCostUsd ? ` · $${e.totalCostUsd.toFixed(4)}` : ''}`
                : '✅ done';
              await notifier.sendPlain(`${labelPrefix}${tail}`);
            })();
          } else if (e.type === 'session') {
            // resume id already persisted in adapter
          }
        },
      })
      .catch((err: unknown) => {
        logger.error({ err: String(err) }, 'dispatch crash');
      });
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
