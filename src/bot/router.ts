import { Bot, GrammyError } from 'grammy';
import type { Context } from 'grammy';
import { run } from '@grammyjs/runner';
import {
  conversations,
  createConversation,
  type Conversation,
  type ConversationFlavor,
} from '@grammyjs/conversations';
import type { TelecodeConfig } from '../config.js';
import type { SessionStore } from '../session/store.js';
import type { SessionManager } from '../session/manager.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ApprovalBroker, ApprovalRequest } from '../approval/broker.js';
import { PolicyEngine } from '../approval/policy.js';
import { Notifier } from './notifier.js';
import {
  registerCommands,
  executeHandoff,
  invalidateSessionModeCache,
  invalidateChatModeCache,
} from './commands/index.js';
import {
  approvalKeyboard,
  approvalForeverConfirmKeyboard,
  verbosityModeKeyboard,
} from './keyboards.js';
import {
  MODE_METADATA,
  isVerbosityMode,
  resolveMode,
} from '../session/verbosity.js';
import { buildSessionList, buildSessionStrip, splitCatchUp, type SessionListItem } from './reply-builders.js';
import { CallbackRouter } from './callback-router.js';
import { registerProjectCallbacks } from './callbacks/projects.js';
import { diffCache, renderDiffBlock } from './diff-cache.js';
import { summaryCache } from './summary-cache.js';
import { summarizeWithSession, discardSummarizeMutex } from '../agents/summarize.js';
import { codeBlock, escapeMd } from './markdown.js';
import { toolCollapseMgr, initProgressManager, progressMgr } from './runtime-state.js';
import { getCachedSessionMode } from './commands/index.js';
import { createSqliteConversationStorage } from './conversation-storage.js';
import { newSession } from './wizards/new-session.js';
import { applyCommandsAndMenu } from './commands-registry.js';
import { isKeyboardActionText, keyboardActionToCommand } from './keyboard-actions.js';
import { logger } from '../util/logger.js';
import { scrubSecrets } from '../util/scrub.js';
import { suggestionAck } from './suggestions.js';
import { enterWizard, exitWizard, isWizardActive, deferUntilWizardExits } from './wizard-state.js';
import { DashboardLoop } from './dashboard.js';
import { tStatic as _routerT } from '../i18n/index.js';

/**
 * Outside-middleware context flavor. Adds `ctx.conversation` (enter/exit/active
 * controls) so command handlers can call `ctx.conversation.enter('newSession')`.
 * The wizard's *inside* context stays the bare `Context` — conversations 2.x
 * forbids installing the flavor recursively (see plugin.d.ts §ConversationFlavor).
 */
export type BotContext = ConversationFlavor<Context>;

export interface BotDeps {
  config: TelecodeConfig;
  store: SessionStore;
  manager: SessionManager;
  broker: ApprovalBroker;
  policy: PolicyEngine;
  /**
   * Adapter registry (plan P1.1). The wizard reads `registry.list()` to
   * render the agent picker dynamically. Required so adding a new built-in
   * adapter never touches the wizard or router again.
   */
  registry: AgentRegistry;
  /**
   * i18n handle (Phase 1). Owns per-chat language cache; passed into command
   * handlers + callback router so every user-facing string goes through
   * {@link import('../i18n/index.js').I18n.t}. Optional so existing call
   * sites (tests that only exercise routing) don't need to wire it; when
   * absent, callers fall back to hard-coded strings.
   */
  i18n?: import('../i18n/index.js').I18n;
}

export interface StartedBot {
  bot: Bot<BotContext>;
  notifier: Notifier;
  stop: () => Promise<void>;
}

export async function startBot(deps: BotDeps): Promise<StartedBot> {
  const bot = new Bot<BotContext>(deps.config.telegram.bot_token);
  const allowed = new Set(deps.config.telegram.allowed_user_ids);

  /**
   * Phase 3 i18n shorthand (router.ts). Captures `deps.i18n` so the router-
   * level callbacks and `/help` / `/new` / approval flow can share the
   * single per-chat-cached lookup. Falls back to `tStatic('en', key, vars)`
   * when no i18n handle is wired (test seam) so existing assertions keep
   * matching English substrings.
   */
  const t = (
    chatId: number | null | undefined,
    key: import('../i18n/index.js').MessageKey,
    vars?: Record<string, string | number>,
  ): string => {
    if (deps.i18n && chatId != null) return deps.i18n.t(chatId, key, vars);
    return _routerT('en', key, vars);
  };
  void t;

  // global whitelist middleware
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid || !allowed.has(uid)) {
      logger.warn({ uid }, 'unauthorized telegram user blocked');
      return;
    }
    await next();
  });

  // Build a notifier bound to the single allowed user/chat for approvals.
  // For approval prompts we use ctx where available, otherwise the broker's chatId.
  const notifierByChat = new Map<number, Notifier>();
  const notifierFor = (chatId: number): Notifier => {
    let n = notifierByChat.get(chatId);
    if (!n) {
      n = new Notifier({
        bot,
        chatId,
        debounceMs: deps.config.notifier.debounce_ms,
        isQuiet: () => deps.store.isQuietNow(chatId),
      });
      notifierByChat.set(chatId, n);
    }
    return n;
  };

  // Phase E — initialize the process-wide ProgressManager singleton.
  // Bound to `bot.api` for sendMessage/editMessageText/deleteMessage and a
  // mode resolver that prefers the cached per-session mode (set by the
  // dispatch handler at turn start) and falls back to the chat default. The
  // resolver is sync — no SQLite hit on the hot path (cache is populated on
  // every dispatch).
  initProgressManager({
    api: {
      sendMessage: (chatId, text, extra) =>
        bot.api.sendMessage(chatId, text, extra as never),
      editMessageText: (chatId, msgId, text) =>
        bot.api.editMessageText(chatId, msgId, text),
      deleteMessage: (chatId, msgId) => bot.api.deleteMessage(chatId, msgId),
    },
    modeResolver: (sessionId, chatId) => {
      const cached = getCachedSessionMode(sessionId);
      if (cached) return cached;
      // Fallback: chat default; never block on session-level lookup since
      // that requires a SQLite round-trip per event.
      const chatDefault = deps.store.getChatDefaultMode(chatId);
      return resolveMode(undefined, chatDefault);
    },
  });

  // Approval prompter — broker -> Telegram. Extracted to a factory so tests
  // can exercise the auto-switch/flush/strip behavior with real broker + store
  // + manager and a mock notifier (see tests/auto-switch.test.ts).
  deps.broker.attach(
    createApprovalPrompter({
      store: deps.store,
      manager: deps.manager,
      broker: deps.broker,
      notifierFor,
    }),
  );

  // ---- @grammyjs/conversations wiring (B3) ----------------------------------
  // Must run BEFORE registerCommands so `ctx.conversation.enter('newSession')`
  // is available inside `/new`. Storage is the shared SQLite handle so wizard
  // state survives daemon restarts (plan §3.2, acceptance criterion §8).
  bot.use(
    conversations({
      storage: {
        type: 'key',
        version: 1,
        adapter: createSqliteConversationStorage(deps.store.db),
      },
    }),
  );

  // ---- Wizard-state reconciliation middleware (plan P0.6) -------------------
  // Mirror the chat's wizard-active state into the global `wizardState`
  // singleton so the approval prompter — which runs outside any ctx — can
  // decide whether to defer auto-switch.
  //
  // We deliberately do NOT use the plugin's `onEnter`/`onExit` hooks: per
  // @grammyjs/conversations 2.x docs (plugin.d.ts §ConversationOptions.onExit),
  // `onExit` is only fired when a conversation is left via the explicit
  // `conversation.halt()` or `ctx.conversation.exit()` calls. It does NOT
  // fire when a conversation function returns or throws normally — which is
  // exactly how our `/new` wizard finishes its happy path. Relying on the
  // hook would leak `chatId` into `wizardState.active` forever and break all
  // subsequent auto-switches for the chat.
  //
  // Instead, after every update is processed we compare `ctx.conversation
  // .active()` against the registry and reconcile. This works for ALL exit
  // paths (return / throw / halt / exit) since the conversations storage
  // adapter mirrors the truth deterministically post-await.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    await next();
    if (typeof chatId !== 'number') return;
    try {
      const active = ctx.conversation.active();
      const anyActive = Object.values(active).some((n) => n > 0);
      if (anyActive) {
        if (!isWizardActive(chatId)) {
          enterWizard(chatId);
          logger.debug({ chatId }, 'wizard entered (reconciled)');
        }
      } else if (isWizardActive(chatId)) {
        await exitWizard(chatId);
        logger.debug({ chatId }, 'wizard exited (reconciled)');
      }
    } catch (err) {
      logger.warn({ err: String(err), chatId }, 'wizard-state reconcile failed');
    }
  });

  // Curry deps into the wizard so it stays a pure async function (easier to
  // unit-test). The plugin requires the identifier explicitly when the wrapped
  // function is anonymous — we pass 'newSession' as the second arg.
  bot.use(
    createConversation(
      (conversation: Conversation, ctx: Context) =>
        newSession(conversation, ctx, {
          store: deps.store,
          manager: deps.manager,
          registry: deps.registry,
          i18n: deps.i18n,
        }),
      'newSession',
    ),
  );

  // Keyboard-action interception (Phase B4 / plan §4.2). Persistent reply
  // keyboard taps arrive as ordinary `message:text` updates whose text is the
  // emoji-prefixed button label (e.g. `📋 Sessions`). Map those to the
  // canonical slash command BEFORE downstream `bot.command(...)` middleware
  // runs, so a tap dispatches the same handler as typing the command.
  //
  // Implementation: mutate `ctx.update.message.text` in place. grammY's
  // command matcher reads from `ctx.message.text` (which reads from
  // `ctx.update.message.text`), so a rewrite here transparently re-routes the
  // update without us calling handlers directly.
  //
  // Skipped while a conversation is active — the wizard owns the input flow
  // and waits for raw text (e.g. label step). Letting the keyboard hijack
  // input mid-wizard would discard the user's intended label/answer.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text && isKeyboardActionText(text)) {
      // ctx.conversation.active() returns `Record<name, count>` of running
      // conversations in this chat. Empty record → no wizard owns input,
      // safe to rewrite. Any key with count > 0 → defer to the wizard.
      const active = ctx.conversation.active();
      const anyActive = Object.values(active).some((n) => n > 0);
      if (!anyActive) {
        const cmd = keyboardActionToCommand(text);
        if (cmd && ctx.update.message) {
          // Mutate the raw update so grammY's command middleware picks it up.
          // grammY's `bot.command('x', ...)` matcher checks `message.entities`
          // for a `bot_command` entity at offset 0 — NOT just the raw text.
          // Rewriting text alone (as we did originally) didn't trigger any
          // handler. Inject a synthetic entity covering the slash command so
          // the matcher recognizes it as a command-typed message.
          const msg = ctx.update.message as {
            text: string;
            entities?: { type: string; offset: number; length: number }[];
          };
          msg.text = cmd;
          msg.entities = [{ type: 'bot_command', offset: 0, length: cmd.length }];
        }
      }
    }
    await next();
  });

  // `/new` — enter the wizard. Legacy `/session new <agent> <label> [path]`
  // (registered inside registerCommands) is preserved for backward compat.
  //
  // @grammyjs/conversations 2.x throws when `enter()` is called while another
  // (or the same) conversation is already active for the chat. Catch + tell
  // the user rather than letting the throw bubble to `bot.catch` (silent UX).
  bot.command('new', async (ctx) => {
    const chatId = ctx.chat?.id;
    try {
      await ctx.conversation.enter('newSession');
    } catch (err) {
      logger.warn({ err: String(err) }, '/new: enter failed');
      await ctx.reply(t(chatId, 'router.wizard.busy'));
    }
  });

  // `/help` — short bilingual guide listing the 6 keyboard buttons and the
  // discoverable slash commands. Registered separately from registerCommands
  // because the slash-menu listing (commands-registry.ts) names it explicitly
  // — every entry there must have a matching handler or Telegram clients
  // surface a "no response" warning on tap.
  bot.command('help', async (ctx) => {
    const chatId = ctx.chat?.id;
    await ctx.reply(t(chatId, 'router.help'), { parse_mode: 'Markdown' });
  });

  registerCommands(bot, { ...deps, notifierFor });

  // Namespaced callback dispatcher — replaces direct bot.callbackQuery() regex.
  // Backward-compat: existing callback_data strings like `apv:once:<id>` and
  // `ses:switch:<id>` are parsed as ns=`apv|ses`, action, payload=remainder.
  //
  // Typed to BotContext so handlers (e.g. wizard:new-start) can call
  // `ctx.conversation.enter(...)` injected by the conversations plugin above.
  const callbackRouter = new CallbackRouter<BotContext>();

  const resolveApproval = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
    decision: 'allow_once' | 'allow_always' | 'deny',
  ): Promise<void> => {
    const requestId = payload;
    const ok = deps.broker.resolve(requestId, decision);
    deps.store.resolveApproval(requestId, decision);
    await ctx.answerCallbackQuery({ text: ok ? decision : 'expired' });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      /* ignore */
    }
    const tag = decision === 'allow_once' ? '✅' : decision === 'allow_always' ? '🌟' : '🚫';
    try {
      await ctx.reply(`${tag} ${decision}`);
    } catch {
      /* ignore */
    }
  };

  // Session switch handler — used by both the new `session:switch:<id>` ns
  // (emitted by reply-builders / B1+) and the legacy `ses:switch:<id>` ns
  // (emitted by `sessionPickKeyboard` in `keyboards.ts`, still wired from the
  // `/session list` subcommand). We register the same closure under both
  // namespaces so old approved messages keep working after the rename — see
  // SDD §B1 for the namespace-decision rationale.
  const switchSessionHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const id = payload;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    const row = deps.store.getSession(id);
    if (!row || row.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'not found' });
      return;
    }
    // Bug fix (P1): before activating the incoming session, flush the
    // OUTGOING session's pending output so the user doesn't lose the tail of
    // its last reply. Two sources:
    //   (1) Notifier's debounced text stream (active sessions stream via
    //       `appendStream`, debounce window may still be open when the user
    //       taps switch). `closeStream` drains the timer + sends the pending
    //       buffer as a normal Telegram message.
    //   (2) SessionManager's per-session background buffer — populated only
    //       while the session is NOT active, but a fast back-and-forth toggle
    //       can leave events buffered from an earlier background spell that
    //       were never drained. Senior-review (Opus 4.7) [P2]: previously the
    //       outgoing flush only covered (2); (1) is the more common path on
    //       a recently-active session, so add closeStream as well.
    const prevActiveId = deps.store.getChatState(chatId).active_session_id;
    if (prevActiveId && prevActiveId !== id) {
      // (1) drain the debounced text stream — safe no-op if no stream exists.
      await notifierFor(chatId).closeStream(`s:${prevActiveId}`);
      // (2) drain any leftover background-buffer events.
      if (deps.manager.hasBuffered(prevActiveId)) {
        const prevRow = deps.store.getSession(prevActiveId);
        if (prevRow) {
          const events = deps.manager.drainBuffer(prevActiveId);
          const lines = events.map((e) => e.data);
          const header = `[${prevRow.label}] 📤 flushing on session switch (${events.length} pending):`;
          const contHeader = `[${prevRow.label}] 📤 flushing (cont.):`;
          const parts = splitCatchUp(header, contHeader, lines);
          for (const part of parts) {
            try {
              await ctx.reply(part, { disable_notification: true });
            } catch (err) {
              // Bug fix (P1): do NOT break — log and continue so partial
              // delivery failure doesn't drop remaining content silently.
              logger.warn(
                { err: String(err), sessionId: prevActiveId },
                'switch outgoing flush failed (continuing)',
              );
            }
          }
        }
      }
    }

    deps.store.setActiveSession(chatId, id);
    await ctx.answerCallbackQuery({ text: `→ ${row.label}` });
    // Bug fix (P1): use chunked send so a long transcript_tail (or a long
    // last-assistant message stored at its tail) isn't silently truncated by
    // grammY's implicit 4096-char limit. We still respect
    // `session_switch_preview_lines` as a soft cap — within a chunk, split
    // at line boundaries; if still over the per-message limit, spill into
    // continuation messages so the user sees the FULL tail (not just an
    // ellipsis).
    const tail =
      row.transcript_tail
        .split('\n')
        .slice(-deps.config.session_switch_preview_lines)
        .join('\n') || '(no transcript yet)';
    await notifierFor(chatId).sendChunked(`📍 [${row.label}]\n${tail}`);

    // v0.8 (plan §3.5): on manual switch, flush the incoming session's RAM
    // buffer so the user catches up on the output produced while it was
    // background. Silent (disable_notification) so the catch-up arrives
    // without an extra ping — the switch itself is user-initiated. Header
    // format mirrors `flushBufferedAsCatchUp` in commands/index.ts so all
    // catch-up paths share the same wording.
    //
    // Per plan §7 risk register (P2): split into multiple messages if the
    // joined catch-up exceeds Telegram's per-message char limit — buffer can
    // hold ~50KB which would otherwise be silently clipped at 4096 chars.
    if (deps.manager.hasBuffered(id)) {
      const events = deps.manager.drainBuffer(id);
      const lines = events.map((e) => e.data);
      const header = `[${row.label}] 📥 catch-up (${events.length} events from background):`;
      const contHeader = `[${row.label}] 📥 catch-up (cont.):`;
      const parts = splitCatchUp(header, contHeader, lines);
      for (const part of parts) {
        try {
          await ctx.reply(part, { disable_notification: true });
        } catch (err) {
          // Bug fix (P1): do NOT break — log and continue so transient
          // 429s on one part don't truncate the remaining catch-up content.
          logger.warn(
            { err: String(err), sessionId: id },
            'switch catch-up flush failed (continuing)',
          );
        }
      }
    }
  };

  // `session:close:<id>` — inline [🗑] button from /sessions list. Mirrors the
  // legacy `/session close <label>` subcommand: interrupt running task,
  // mark status='closed', discard the RAM output buffer, clear active if it
  // was this session.
  const closeSessionHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const id = payload;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    const row = deps.store.getSession(id);
    if (!row || row.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'not found' });
      return;
    }
    deps.manager.interrupt(id);
    deps.store.updateSession(id, { status: 'closed' });
    deps.manager.discardBuffer(id);
    // Phase C.4/C.3 — drop in-memory state tied to this session so a
    // long-running daemon doesn't accumulate collapse entries / diff
    // payloads for sessions the user has dismissed. Senior-review
    // (Opus 4.7) [P3]: also wipe the per-session verbosity-mode cache
    // (lives in commands/index.ts; routed through the exported helper).
    toolCollapseMgr.clearSession(id);
    diffCache.clearSession(id);
    // Phase D — drop summary cache + summarize mutex for this session.
    summaryCache.clearSession(id);
    discardSummarizeMutex(id);
    invalidateSessionModeCache(id);
    // Phase E — drop the rolling progress message state (sync, no Telegram
    // call; the message on the user's chat stays where it last was). The
    // dispatch handler's `done` / `error` branches already cover the
    // happy-path finalize — this clear() is just for explicit user-driven
    // close.
    progressMgr?.clear(id);
    const st = deps.store.getChatState(chatId);
    if (st.active_session_id === id) {
      deps.store.setActiveSession(chatId, null);
    }
    await ctx.answerCallbackQuery({ text: `🗑 closed ${row.label}` });
    // Strip the inline keyboard from the /sessions message so the just-closed
    // row's button can't be tapped again (defensive — taps would hit the
    // not-found branch anyway, but cleaner UX).
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      /* message may be too old to edit — ignore */
    }
    await ctx.reply(`🗑 closed [${row.label}]`);
  };

  // `session:handoff:<id>` — inline [🤝] button from /sessions list. Shares
  // the same core as `bot.command('handoff')` (see executeHandoff in
  // commands/index.ts). Unlike the /handoff command which acts on the active
  // session, the button acts on the TAPPED session — useful when you want
  // to summarize+clear a background session without switching to it first.
  const handoffSessionHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const id = payload;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    const result = executeHandoff(id, chatId, {
      store: deps.store,
      manager: deps.manager,
      notifier: notifierFor(chatId),
      i18n: deps.i18n,
    });
    // Short answer in the cbq toast (Telegram caps at ~200 chars for alerts);
    // the user-visible progress / completion arrives via notifier.sendPlain.
    await ctx.answerCallbackQuery({
      text: result.ok ? '🤝 handoff started' : result.message.slice(0, 180),
      show_alert: !result.ok,
    });
  };

  // Wizard new-session entry from inline [➕ New session] taps. Acknowledges
  // the spinner then defers to `ctx.conversation.enter('newSession')` so the
  // same code path runs as `/new`. The conversations plugin handles the
  // "already in a conversation" case by throwing — we catch + tell the user.
  const wizardNewStartHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    _payload: string,
  ): Promise<void> => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.conversation.enter('newSession');
    } catch (err) {
      logger.warn({ err: String(err) }, 'wizard new-start: enter failed');
      await ctx.reply(t(ctx.chat?.id, 'router.wizard.busy'));
    }
  };

  // T3 carry-over (plan P0.1 / P0.2): wizard success-message buttons that
  // used to be ack-only stubs now dispatch real list / logs renders.
  //
  // P0.1 — `[🔀 Switch khác]` on the wizard success message. We render the
  // same `/sessions` payload (buildSessionList) as a NEW reply so the wizard
  // success bubble keeps its history intact — editing the wizard message
  // would erase the "session created OK" record.
  const t3SessionListTrigger = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    await ctx.answerCallbackQuery();
    const rows = deps.store.listSessions(chatId);
    const activeId = deps.store.getChatState(chatId).active_session_id;
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
  };
  // P0.2 — `[📋 Tail logs]` on the wizard success message. Payload is the
  // session id whose logs to tail; the handler does the same work as
  // `/status logs 30` scoped to that session.
  const t3SessionLogsTrigger = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    const sessionId = payload;
    const row = deps.store.getSession(sessionId);
    if (!row || row.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'session not found' });
      return;
    }
    await ctx.answerCallbackQuery();
    const tools = deps.store.tailToolLog(sessionId, 30);
    if (tools.length === 0) {
      await ctx.reply(`[${row.label}] no tool logs yet`);
      return;
    }
    const txt = tools
      .map(
        (r) =>
          `${new Date(r.created_at).toISOString().slice(11, 19)} ${r.tool_name} ${r.decision ?? ''} ${(r.input_preview ?? '').slice(0, 60)}`,
      )
      .join('\n');
    await ctx.reply('```\n' + scrubSecrets(txt) + '\n```', { parse_mode: 'Markdown' });
  };

  // P0.4 — `[📌 Forever]` 2-step confirm flow.
  //
  // Step 1: user taps `[📌 Forever]` on an approval prompt. We pivot the
  // SAME message to a "are you sure?" body + 2-button keyboard. The original
  // 4 approval buttons are saved off the request so we can restore them on
  // cancel.
  const apvForeverInit = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const requestId = payload;
    const req = deps.broker.get(requestId);
    if (!req) {
      await ctx.answerCallbackQuery({ text: 'expired' });
      return;
    }
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const text =
      `${t(chatId, 'router.approval.foreverConfirmTitle')}\n` +
      `${t(chatId, 'router.approval.foreverConfirmTool', { tool: req.toolName })}\n` +
      `${t(chatId, 'router.approval.foreverConfirmArgs', { args: req.inputPreview })}\n` +
      t(chatId, 'router.approval.foreverConfirmNote');
    try {
      await ctx.editMessageText(scrubSecrets(text), {
        parse_mode: 'Markdown',
        reply_markup: approvalForeverConfirmKeyboard(requestId),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'apv:forever-init editMessageText failed');
    }
  };

  // Step 2a: user taps `✅ Xác nhận` — persist rule + resolve as allow_always.
  const apvForeverConfirm = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const requestId = payload;
    const req = deps.broker.get(requestId);
    if (!req) {
      await ctx.answerCallbackQuery({ text: 'expired' });
      return;
    }
    let pattern: string;
    try {
      // Persist atomically (tmpfile + rename inside policy.appendRule).
      deps.policy.appendRule(req.toolName, req.input, 'allow_always');
      // Surface the canonical pattern that ended up in policy.yaml so the
      // user can find + edit it later.
      pattern = PolicyEngine.buildPattern(req.toolName, req.input);
    } catch (err) {
      logger.error({ err: String(err), requestId }, 'apv:forever-confirm appendRule failed');
      await ctx.answerCallbackQuery({
        text: t(ctx.chat?.id, 'router.approval.foreverWriteError'),
        show_alert: true,
      });
      return;
    }
    // Resolve the in-flight approval as allow_always so the agent doesn't
    // block. The session-scoped allow_always behavior is the same as if the
    // user had tapped 🌟 — the persistence is a separate side-effect.
    deps.broker.resolve(requestId, 'allow_always');
    deps.store.resolveApproval(requestId, 'allow_always');
    await ctx.answerCallbackQuery({ text: 'forever ✓' });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      /* message too old to edit — ignore */
    }
    // The persisted pattern may contain backticks (e.g. shell command with
    // `` ` ``). Wrap inside a triple-backtick block — Telegram's legacy
    // Markdown allows literal backticks inside a fenced code block.
    await ctx.reply(t(ctx.chat?.id, 'router.approval.foreverApplied', { pattern }), {
      parse_mode: 'Markdown',
    });
  };

  // Step 2b: user taps `❌ Hủy` — restore the original 4-button keyboard so
  // they can pick a different decision. No write happened on init, so this
  // is purely a UI rollback.
  const apvForeverCancel = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const requestId = payload;
    const req = deps.broker.get(requestId);
    if (!req) {
      await ctx.answerCallbackQuery({ text: 'expired' });
      return;
    }
    await ctx.answerCallbackQuery({ text: t(ctx.chat?.id, 'router.approval.cancelToast') });
    const text = scrubSecrets(
      t(ctx.chat?.id, 'router.approval.body', {
        sessionLabel: req.sessionLabel,
        tool: req.toolName,
        input: req.inputPreview,
      }),
    );
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: approvalKeyboard(requestId),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'apv:forever-cancel editMessageText failed');
    }
  };

  // P0.3 — suggestion buttons (stubs that turn user taps into reply hints).
  // The buttons themselves are appended by callers via the existing
  // extraButtons hook on reply-builders / notifier. Each callback action
  // returns a human-readable hint (Vietnamese) via `suggestionAck`.
  const suggestHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
    action: string,
  ): Promise<void> => {
    // payload = "<sessionId>" or "<sessionId>:<path>" for view-file. We don't
    // need the path here (the ack already tells the user how to proceed).
    void payload;
    await ctx.answerCallbackQuery();
    await ctx.reply(suggestionAck(action));
  };

  // Phase B (plan §B.3) — verbosity-mode callbacks.
  //
  // `mode:set:<name>`         → set per-session override (active session in
  //                             current chat) + invalidate cache so the next
  //                             dispatched event respects the new mode.
  // `settings:mode:<name>`    → set chat-level default + invalidate every
  //                             cached session in the chat (broad invalidate
  //                             matches the broad blast-radius of a chat
  //                             default change).
  //
  // Both handlers re-render the original picker with the new "●" marker so
  // the user sees instant feedback without scrolling — much friendlier than
  // a popup ack alone, especially on mobile where the toast is small.
  const modeSetSessionHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const name = payload;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    if (!isVerbosityMode(name)) {
      await ctx.answerCallbackQuery({ text: 'invalid mode' });
      return;
    }
    const st = deps.store.getChatState(chatId);
    if (!st.active_session_id) {
      await ctx.answerCallbackQuery({ text: 'no active session', show_alert: true });
      return;
    }
    const row = deps.store.getSession(st.active_session_id);
    if (!row) {
      await ctx.answerCallbackQuery({ text: 'session vanished', show_alert: true });
      return;
    }
    deps.store.setSessionMode(row.id, name);
    invalidateSessionModeCache(row.id);
    const meta = MODE_METADATA[name];
    await ctx.answerCallbackQuery({ text: `${meta.icon} ${meta.displayName}` });
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: verbosityModeKeyboard('mode:set', name),
      });
    } catch (err) {
      const description = (err as { description?: string }).description ?? '';
      if (!/message is not modified/i.test(description)) {
        logger.warn({ err: String(err) }, 'mode:set re-render failed');
      }
    }
  };

  const settingsModeHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const name = payload;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    if (!isVerbosityMode(name)) {
      await ctx.answerCallbackQuery({ text: 'invalid mode' });
      return;
    }
    deps.store.setChatDefaultMode(chatId, name);
    invalidateChatModeCache(chatId, deps.store);
    const meta = MODE_METADATA[name];
    await ctx.answerCallbackQuery({ text: `${meta.icon} default → ${meta.displayName}` });
    // Re-render the picker so the highlighted button reflects the new default.
    // Resolve the now-effective mode for picker highlighting — session
    // override on the active session (if any) still beats the chat default,
    // matching the on-screen narrative.
    const st = deps.store.getChatState(chatId);
    let highlight = name;
    if (st.active_session_id) {
      const sessionMode = deps.store.getSessionMode(st.active_session_id);
      highlight = resolveMode(sessionMode, name);
    }
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: verbosityModeKeyboard('settings:mode', highlight),
      });
    } catch (err) {
      const description = (err as { description?: string }).description ?? '';
      if (!/message is not modified/i.test(description)) {
        logger.warn({ err: String(err) }, 'settings:mode re-render failed');
      }
    }
  };

  // Phase C.3 — split a long diff body at line boundaries so each part fits
  // under Telegram's per-message char cap. Lines longer than `max` are
  // emitted as their own part (no mid-line truncation — diff context is
  // worthless if a line is chopped). Returns at least one part even for
  // empty input so callers can iterate without a length check.
  const splitDiffParts = (body: string, max: number): string[] => {
    if (body.length <= max) return [body];
    const lines = body.split('\n');
    const parts: string[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    for (const line of lines) {
      const add = (buf.length === 0 ? 0 : 1) + line.length; // \n separator
      if (bufLen + add > max && buf.length > 0) {
        parts.push(buf.join('\n'));
        buf = [];
        bufLen = 0;
      }
      buf.push(line);
      bufLen += add;
    }
    if (buf.length > 0) parts.push(buf.join('\n'));
    return parts.length > 0 ? parts : [body];
  };

  // Phase C.3 — `diff:show:<sessionId>:<callId>` callback handler.
  //
  // Triggered by the [📜 Show diff] button attached to Edit-family tool_use
  // messages in thinking/verbose modes. The dispatcher cached the
  // (old_string, new_string, file_path) trio under the callId at tool_use
  // time; this handler reads it back, renders a unified-diff block, wraps
  // it in MarkdownV2 ```diff fence, and replies (no edit — keeps the
  // original tool message intact). Long diffs split at MAX_DIFF_CHARS to
  // respect Telegram's 4096-char message limit (we use 3500 to leave room
  // for the fence + label prefix).
  const MAX_DIFF_CHARS = 3500;
  const diffShowHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    // payload shape: "<sessionId>:<callId>" — split on the FIRST colon only
    // (UUIDs don't contain colons but we're defensive against future formats).
    const colonIdx = payload.indexOf(':');
    if (colonIdx < 0) {
      await ctx.answerCallbackQuery({ text: 'invalid diff key' });
      return;
    }
    const sessionId = payload.slice(0, colonIdx);
    const callId = payload.slice(colonIdx + 1);

    // Senior-review (Opus 4.7) [P1] — ownership check. With multiple users in
    // `allowed_user_ids`, user B could theoretically tap a [📜 Show diff]
    // button that surfaced in user A's chat (callback_data is replayable
    // until the message is deleted). Refuse if the session doesn't belong to
    // the current chat. Mirrors the existing chat-id guards on
    // switch/close/handoff callbacks.
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'no chat' });
      return;
    }
    const sess = deps.store.getSession(sessionId);
    if (!sess || sess.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'not found', show_alert: false });
      return;
    }

    const cached = diffCache.get(sessionId, callId);
    await ctx.answerCallbackQuery();
    if (!cached) {
      // TTL expired (15min default) — friendly message rather than silently
      // swallowing the tap.
      try {
        await ctx.reply(t(chatId, 'router.diff.cacheMiss'));
      } catch (err) {
        logger.warn({ err: String(err) }, 'diff:show miss-reply failed');
      }
      return;
    }
    const block = renderDiffBlock(cached.filePath, cached.old, cached.new);
    // Split on line boundaries so the diff stays readable when it overflows
    // Telegram's per-message char cap. Header repeats on continuation parts.
    const parts = splitDiffParts(block, MAX_DIFF_CHARS);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const header = i === 0 ? `📜 \`${escapeMd(cached.filePath)}\`` : `📜 (cont\\.)`;
      const composed = header + '\n' + codeBlock(part, 'diff');
      try {
        await ctx.reply(composed, { parse_mode: 'MarkdownV2' });
      } catch (err) {
        // Fallback: plain text if MarkdownV2 trips on something pathological.
        // Include the file-path header in plain form so context isn't lost.
        logger.warn({ err: String(err) }, 'diff:show MarkdownV2 send failed — plain fallback');
        const plainHeader = i === 0 ? `📜 ${cached.filePath}` : `📜 (cont.)`;
        try {
          await ctx.reply(`${plainHeader}\n${part}`);
        } catch (plainErr) {
          logger.warn({ err: String(plainErr) }, 'diff:show plain fallback failed');
        }
      }
    }
  };

  // Phase D.3 / D.5 — summary callbacks shared between auto-summarize and
  // on-demand summarize.
  //
  //   summary:ai:<messageId>     — D.3 — fetch full cached preview, run
  //     summarizeWithSession, edit message with the new summary body.
  //   summary:full:<messageId>   — D.5 — fetch full cached preview, send as
  //     code-fenced reply (split if > MAX_FULL_OUTPUT_CHARS).
  //
  // Both verify chat ownership via the cached `sessionId` (mirrors the
  // diff:show security pattern from Phase C senior review [P1]).
  const MAX_FULL_OUTPUT_CHARS = 3500;

  const summaryAiHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    // payload = "<messageId>"
    const msgId = parseInt(payload, 10);
    if (!Number.isFinite(msgId)) {
      await ctx.answerCallbackQuery({ text: t(ctx.chat?.id, 'callback.invalidId') });
      return;
    }
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: t(null, 'callback.noChat') });
      return;
    }
    const cached = summaryCache.get(msgId);
    if (!cached) {
      await ctx.answerCallbackQuery({ text: t(chatId, 'router.summary.cacheExpired'), show_alert: false });
      try {
        await ctx.reply(t(chatId, 'router.summary.cacheMissAi'));
      } catch (err) {
        logger.warn({ err: String(err) }, 'summary:ai miss-reply failed');
      }
      return;
    }
    // Ownership check — same pattern as diff:show.
    const sess = deps.store.getSession(cached.sessionId);
    if (!sess || sess.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: t(chatId, 'callback.notFound') });
      return;
    }
    await ctx.answerCallbackQuery({ text: t(chatId, 'router.summary.summarizing') });
    // Edit a small "⏳" placeholder so user sees feedback while we wait for
    // the session mutex + agent reply.
    const placeholder = t(chatId, 'router.summary.placeholder', { label: sess.label });
    try {
      await ctx.api.editMessageText(chatId, msgId, placeholder);
    } catch (err) {
      logger.warn({ err: String(err), msgId }, 'summary:ai placeholder edit failed');
    }
    const summary = await summarizeWithSession({
      manager: deps.manager,
      store: deps.store,
      sessionId: cached.sessionId,
      content: cached.fullText,
      instruction: t(chatId, 'llm.summarize.onDemand'),
      kind: 'on-demand',
    });
    const labelPrefix = `[${sess.label}] `;
    const lineCount = cached.fullText.split('\n').length;
    if (!summary) {
      // Fallback: show original truncated preview + keep [💬 AI summary]
      // button for retry.
      const truncated = cached.fullText.slice(0, 240);
      const body =
        `${labelPrefix}✅ ${cached.toolLabel}\n${truncated}\n` +
        t(chatId, 'router.summary.fallbackHint');
      try {
        await ctx.api.editMessageText(chatId, msgId, body, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: `📜 Full output (${lineCount} lines)`, callback_data: `summary:full:${msgId}` },
                { text: '💬 AI summary', callback_data: `summary:ai:${msgId}` },
              ],
            ],
          },
        });
      } catch (err) {
        logger.warn({ err: String(err), msgId }, 'summary:ai fallback edit failed');
      }
      return;
    }
    // Success — render summary + [📜 Full output] + [💬 Re-summarize].
    const body = `${labelPrefix}✅ ${cached.toolLabel}\n${summary}`;
    try {
      await ctx.api.editMessageText(chatId, msgId, body, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `📜 Full output (${lineCount} lines)`, callback_data: `summary:full:${msgId}` },
              { text: '💬 Re-summarize', callback_data: `summary:ai:${msgId}` },
            ],
          ],
        },
      });
    } catch (err) {
      logger.warn({ err: String(err), msgId }, 'summary:ai success edit failed');
    }
  };

  const summaryFullHandler = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
    payload: string,
  ): Promise<void> => {
    const msgId = parseInt(payload, 10);
    if (!Number.isFinite(msgId)) {
      await ctx.answerCallbackQuery({ text: t(ctx.chat?.id, 'callback.invalidId') });
      return;
    }
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: t(null, 'callback.noChat') });
      return;
    }
    const cached = summaryCache.get(msgId);
    if (!cached) {
      await ctx.answerCallbackQuery({ text: t(chatId, 'router.summary.cacheExpired') });
      try {
        await ctx.reply(t(chatId, 'router.summary.cacheMissFull'));
      } catch (err) {
        logger.warn({ err: String(err) }, 'summary:full miss-reply failed');
      }
      return;
    }
    const sess = deps.store.getSession(cached.sessionId);
    if (!sess || sess.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: t(chatId, 'callback.notFound') });
      return;
    }
    await ctx.answerCallbackQuery();
    // Detect a sensible language for the fence. Bash/exec output usually has
    // no useful syntax highlighter; default to plain `code` fence.
    const fenceLang = cached.toolLabel === 'Bash' ? 'bash' : '';
    // Split at line boundaries so chunks fit Telegram's 4096-char limit.
    const lines = cached.fullText.split('\n');
    const parts: string[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    for (const line of lines) {
      const add = (buf.length === 0 ? 0 : 1) + line.length;
      if (bufLen + add > MAX_FULL_OUTPUT_CHARS && buf.length > 0) {
        parts.push(buf.join('\n'));
        buf = [];
        bufLen = 0;
      }
      buf.push(line);
      bufLen += add;
    }
    if (buf.length > 0) parts.push(buf.join('\n'));
    if (parts.length === 0) parts.push(cached.fullText);
    const labelPrefix = `[${sess.label}] `;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const header =
        i === 0
          ? `${labelPrefix}📜 ${escapeMd(`${cached.toolLabel} · full output`)}`
          : `${labelPrefix}📜 ${escapeMd(`(cont. ${i + 1}/${parts.length})`)}`;
      const composed = header + '\n' + codeBlock(part, fenceLang);
      try {
        await ctx.reply(composed, { parse_mode: 'MarkdownV2' });
      } catch (err) {
        // MarkdownV2 fallback — same pattern as diff:show.
        logger.warn(
          { err: String(err) },
          'summary:full MarkdownV2 send failed — plain fallback',
        );
        try {
          await ctx.reply(`${labelPrefix}📜 ${cached.toolLabel}\n${part}`);
        } catch (plainErr) {
          logger.warn({ err: String(plainErr) }, 'summary:full plain fallback failed');
        }
      }
    }
  };

  callbackRouter
    .on('apv', 'once', (ctx, payload) => resolveApproval(ctx, payload, 'allow_once'))
    .on('apv', 'always', (ctx, payload) => resolveApproval(ctx, payload, 'allow_always'))
    .on('apv', 'deny', (ctx, payload) => resolveApproval(ctx, payload, 'deny'))
    // P0.4 — Forever 2-step confirm flow.
    .on('apv', 'forever-init', apvForeverInit)
    .on('apv', 'forever-confirm', apvForeverConfirm)
    .on('apv', 'forever-cancel', apvForeverCancel)
    // New ns used by reply-builders / B1+ inline buttons.
    .on('session', 'switch', switchSessionHandler)
    .on('session', 'close', closeSessionHandler)
    .on('session', 'handoff', handoffSessionHandler)
    // Backward-compat: legacy `ses:switch:<id>` from `sessionPickKeyboard`
    // (still emitted by `/session list`). Same handler closure.
    .on('ses', 'switch', switchSessionHandler)
    .on('wizard', 'new-start', wizardNewStartHandler)
    .on('session', 'list-trigger', t3SessionListTrigger)
    .on('session', 'logs-trigger', t3SessionLogsTrigger)
    // P0.3 — follow-up suggestions. The router just acks with a hint; the
    // user follows up via plain-text prompt (no automation behind the scene).
    .on('suggest', 'continue', (ctx, p) => suggestHandler(ctx, p, 'continue'))
    .on('suggest', 'run-again', (ctx, p) => suggestHandler(ctx, p, 'run-again'))
    .on('suggest', 'rollback', (ctx, p) => suggestHandler(ctx, p, 'rollback'))
    .on('suggest', 'view-file', (ctx, p) => suggestHandler(ctx, p, 'view-file'))
    .on('suggest', 'summarize', (ctx, p) => suggestHandler(ctx, p, 'summarize'))
    // Phase B — verbosity mode toggles.
    .on('mode', 'set', modeSetSessionHandler)
    .on('settings', 'mode', settingsModeHandler)
    // Model picker callback.
    .on('model', 'set', async (ctx, payload) => {
      const chatId = ctx.chat?.id;
      if (!chatId) { await ctx.answerCallbackQuery({ text: 'no chat' }); return; }
      const st = deps.store.getChatState(chatId);
      if (!st.active_session_id) { await ctx.answerCallbackQuery({ text: 'no active session', show_alert: true }); return; }
      deps.store.setSessionModel(st.active_session_id, payload);
      await ctx.answerCallbackQuery({ text: `✓ ${payload}` });
      try { await ctx.editMessageText(`Model đổi thành: ${payload}`); } catch { /* ignore */ }
    })
    // Phase C.3 — diff reveal button.
    .on('diff', 'show', diffShowHandler)
    // Phase D.3 / D.5 — summary buttons.
    .on('summary', 'ai', summaryAiHandler)
    .on('summary', 'full', summaryFullHandler)
    // Phase i18n — language picker callback. Idempotent: clicking the same
    // button twice writes the same value; clicking the OTHER button updates
    // the cache + DB and acknowledges in the NEW language. After setting we
    // remove the inline keyboard so the user can't keep tapping the stale
    // message and re-send the welcome confirmation in the chosen locale.
    .on('lang', 'set', async (ctx, payload) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery({ text: 'no chat' });
        return;
      }
      if (payload !== 'en' && payload !== 'vi') {
        await ctx.answerCallbackQuery({ text: 'unknown language', show_alert: true });
        return;
      }
      const i18n = deps.i18n;
      if (!i18n) {
        // Defensive: if the daemon was started without i18n wiring, write
        // straight to the store so the user's pick still persists, then
        // bail with a generic ack. Should be unreachable in production.
        deps.store.setChatLanguage(chatId, payload);
        await ctx.answerCallbackQuery({ text: `✓ ${payload}` });
        return;
      }
      // Detect first-pick (no row before our setLanguage call) so we only
      // emit the verbosity migration note ONCE per chat. Subsequent
      // `/language` taps shouldn't re-spam the migration help.
      const isFirstPick = !deps.store.chatSettingsExists(chatId);
      i18n.setLanguage(chatId, payload);
      await ctx.answerCallbackQuery({ text: `✓ ${payload}` });
      // Strip the inline buttons so the previous picker bubble doesn't
      // keep accepting taps. Failure is non-fatal (e.g. message already
      // edited / deleted — Telegram returns 400).
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        /* ignore */
      }
      // Confirmation in the freshly-chosen language.
      try {
        await ctx.reply(i18n.t(chatId, 'language.changed'), { parse_mode: 'Markdown' });
      } catch (err) {
        logger.warn({ err: String(err), chatId }, 'language confirmation send failed');
      }
      if (isFirstPick) {
        // Phase i18n + Phase B (§B.5) — emit the verbosity migration note
        // in the chosen language exactly once (on the very first language
        // pick). Subsequent `/language` toggles skip this so we don't spam.
        try {
          await ctx.reply(i18n.t(chatId, 'verbosity.migrationNote'), {
            parse_mode: 'Markdown',
          });
        } catch (err) {
          logger.warn({ err: String(err), chatId }, 'verbosity migration note send failed');
        }
      }
    });

  // B2: project picker callbacks (`project:cd`, `project:new`, `project:page`).
  // Implementation in src/bot/callbacks/projects.ts so the handlers can be
  // unit-tested without a full Bot boot. See SDD §B2.
  registerProjectCallbacks(callbackRouter, { store: deps.store });

  callbackRouter.attach(bot);

  bot.catch((err) => {
    if (err.error instanceof GrammyError) {
      logger.error({ err: err.error.description }, 'grammy error');
    } else {
      logger.error({ err: String(err.error) }, 'bot uncaught');
    }
  });

  const runner = run(bot);

  // Push slash-menu + chat menu button to Telegram (plan §4.1). Wrapped in
  // try/catch — a transient Telegram API hiccup here should NOT block boot.
  // The slash menu is cosmetic discovery surface; commands still work via
  // typing or persistent keyboard even if this call fails. Subsequent reboots
  // retry idempotently.
  try {
    await applyCommandsAndMenu(bot);
  } catch (err) {
    logger.warn(
      { err: String(err) },
      'applyCommandsAndMenu failed at boot — continuing without slash menu sync',
    );
  }

  return {
    bot,
    notifier: notifierFor(deps.config.telegram.allowed_user_ids[0]!),
    async stop() {
      await runner.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Approval prompter factory (v0.8 §3.5)
// ---------------------------------------------------------------------------

/**
 * Subset of {@link Notifier} the approval prompter actually uses. Declared as
 * a structural interface so unit tests can pass a mock without standing up a
 * real Bot + chat. The real Notifier (constructed in `startBot`) satisfies
 * this interface implicitly.
 */
export interface ApprovalPrompterNotifier {
  sendPlain(
    text: string,
    extra?: Record<string, unknown> & { silent?: boolean },
  ): Promise<number | null>;
}

export interface ApprovalPrompterDeps {
  store: Pick<
    SessionStore,
    'recordApproval' | 'getChatState' | 'setActiveSession' | 'listSessions'
  >;
  manager: Pick<SessionManager, 'hasBuffered' | 'drainBuffer'>;
  broker: Pick<ApprovalBroker, 'hasPendingFor'>;
  notifierFor: (chatId: number) => ApprovalPrompterNotifier;
  /**
   * P0.6 hook — defaults to the global `wizardState` singleton's
   * `isActive` / `deferUntilWizardExits`. Injected so tests can substitute
   * a deterministic fake without poking module-level state.
   */
  wizardGuard?: {
    isActive(chatId: number): boolean;
    deferUntilWizardExits(chatId: number, fn: () => void | Promise<void>): void;
  };
}

/**
 * Build the broker prompter that the router attaches to the broker.
 *
 * Behavior (plan §3.5 + behavior matrix §2):
 *   1. `recordApproval(req)` so audit-log captures the request even if the
 *      send below fails.
 *   2. If the request's session is NOT currently active AND no OTHER session
 *      in the same chat has a pending approval (first-come-first-active):
 *        a. `setActiveSession(chatId, req.sessionId)`.
 *        b. If the session has buffered output, drain + send a silent
 *           catch-up message so the user sees the context.
 *        c. Send a silent "switched to X" notice.
 *   3. Send the approval prompt (loud — default notification) with
 *      `approvalKeyboard(req.id, sessionStripRows)` so the user can quick-
 *      switch sessions from the same message.
 *
 * Question events: AgentEvent has no `question` variant today — agent
 * questions surface through the approval mechanism. If a dedicated event
 * type lands later, mirror this flow.
 *
 * Wizard guard limitation: broker callbacks have no `ctx`, so we can't
 * inspect `ctx.conversation.active()` to defer the auto-switch while the
 * /new wizard is mid-step. The wizard is short-lived and the user can
 * `/cancel`; the switch notice + catch-up are sent silent so they don't
 * yank focus.
 */
export function createApprovalPrompter(deps: ApprovalPrompterDeps): {
  prompt(req: ApprovalRequest): Promise<void>;
  notifyTimeout(req: ApprovalRequest): Promise<void>;
} {
  // Default the wizard guard to the singleton — preserves existing behavior
  // for tests that don't pass it. Tests can inject a fake to skip OS effects.
  const guard = deps.wizardGuard ?? {
    isActive: isWizardActive,
    deferUntilWizardExits,
  };

  /**
   * Effective body of auto-switch. Factored so we can either run it inline
   * OR defer it to the wizard's onExit hook (plan P0.6).
   *
   * `expectedActive` is the active-session id we observed at the moment the
   * decision to switch was made. When the switch runs deferred, we compare
   * against the current value — if it changed (e.g. user manually flipped
   * to a different session while the wizard was open) we abort, respecting
   * their explicit choice.
   */
  const runAutoSwitch = async (
    req: ApprovalRequest,
    expectedActive: string | null,
  ): Promise<void> => {
    const n = deps.notifierFor(req.chatId);
    // Re-check at run-time — by the time a deferred switch fires, state may
    // have changed.
    const curActive = deps.store.getChatState(req.chatId).active_session_id;
    if (curActive === req.sessionId) return;
    // User manually switched mid-defer; don't override.
    if (curActive !== expectedActive) {
      logger.info(
        { sessionId: req.sessionId, chatId: req.chatId, curActive, expectedActive },
        'deferred auto-switch skipped — user changed active session manually',
      );
      return;
    }
    // Also skip if another session has stolen focus first-come-first-active.
    if (deps.broker.hasPendingFor(req.chatId, req.sessionId)) return;
    deps.store.setActiveSession(req.chatId, req.sessionId);
    if (deps.manager.hasBuffered(req.sessionId)) {
      const events = deps.manager.drainBuffer(req.sessionId);
      const lines = events.map((e) => e.data);
      const header = `[${req.sessionLabel}] 📥 catch-up (${events.length} events from background):`;
      const contHeader = `[${req.sessionLabel}] 📥 catch-up (cont.):`;
      const parts = splitCatchUp(header, contHeader, lines);
      for (const part of parts) {
        await n.sendPlain(part, { silent: true });
      }
    }
    await n.sendPlain(
      `🔔 Đã chuyển sang \`${req.sessionLabel}\` vì cần approval.`,
      { parse_mode: 'Markdown', silent: true },
    );
  };

  return {
    async prompt(req: ApprovalRequest): Promise<void> {
      const n = deps.notifierFor(req.chatId);
      const text = scrubSecrets(
        `🛡 *Approval needed*\n` +
          `Session: \`${req.sessionLabel}\`\n` +
          `Tool: \`${req.toolName}\`\n` +
          `Input: \`${req.inputPreview}\``,
      );
      try {
        deps.store.recordApproval(req.id, req.sessionId, req.toolName, JSON.stringify(req.input));

        const curActive = deps.store.getChatState(req.chatId).active_session_id;
        if (curActive !== req.sessionId) {
          // First-come-first-active: only auto-switch if no OTHER session in
          // this chat has a pending approval. broker.ask() adds the request
          // to the pending map before invoking us, so we exclude it from the
          // check by passing req.sessionId.
          if (!deps.broker.hasPendingFor(req.chatId, req.sessionId)) {
            // P0.6: if a wizard owns the chat's input, defer the switch
            // until the wizard exits so we don't hijack its text step.
            // Snapshot the "expected active" at deferral time so when the
            // queued callback fires we can detect if the user manually
            // switched while the wizard was open — in which case we MUST
            // respect their choice and skip the auto-switch entirely.
            if (guard.isActive(req.chatId)) {
              const activeAtDeferral = curActive;
              logger.info(
                { sessionId: req.sessionId, chatId: req.chatId },
                'auto-switch deferred — wizard active',
              );
              guard.deferUntilWizardExits(req.chatId, () =>
                runAutoSwitch(req, activeAtDeferral),
              );
            } else {
              await runAutoSwitch(req, curActive);
            }
          }
        }

        const sessions: SessionListItem[] = deps.store.listSessions(req.chatId).map((s) => ({
          id: s.id,
          label: s.label,
          // Plan P1.1: agent is now open-set (string). Reply-builders accept
          // any kind and look the badge up via registry metadata.
          agent: s.agent,
          updatedAt: s.updated_at,
          status: s.status,
        }));
        const activeId = deps.store.getChatState(req.chatId).active_session_id;
        const stripRows = buildSessionStrip(sessions, activeId);

        await n.sendPlain(text, {
          parse_mode: 'Markdown',
          reply_markup: approvalKeyboard(req.id, stripRows),
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'approval prompt send failed');
      }
    },
    async notifyTimeout(req: ApprovalRequest): Promise<void> {
      const n = deps.notifierFor(req.chatId);
      const text = scrubSecrets(
        `⏱ *Approval timeout — denied*\n` +
          `Session: \`${req.sessionLabel}\`\n` +
          `Tool: \`${req.toolName}\`\n` +
          `Input: \`${req.inputPreview}\``,
      );
      try {
        await n.sendPlain(text, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error({ err: String(err) }, 'approval timeout notify failed');
      }
    },
  };
}
