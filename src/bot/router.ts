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
import type { ApprovalBroker, ApprovalRequest } from '../approval/broker.js';
import type { PolicyEngine } from '../approval/policy.js';
import { Notifier } from './notifier.js';
import { registerCommands, executeHandoff } from './commands/index.js';
import { approvalKeyboard } from './keyboards.js';
import { buildSessionStrip, splitCatchUp, type SessionListItem } from './reply-builders.js';
import { CallbackRouter } from './callback-router.js';
import { registerProjectCallbacks } from './callbacks/projects.js';
import { createSqliteConversationStorage } from './conversation-storage.js';
import { newSession } from './wizards/new-session.js';
import { applyCommandsAndMenu } from './commands-registry.js';
import { isKeyboardActionText, keyboardActionToCommand } from './keyboard-actions.js';
import { logger } from '../util/logger.js';
import { scrubSecrets } from '../util/scrub.js';

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
}

export interface StartedBot {
  bot: Bot<BotContext>;
  notifier: Notifier;
  stop: () => Promise<void>;
}

export async function startBot(deps: BotDeps): Promise<StartedBot> {
  const bot = new Bot<BotContext>(deps.config.telegram.bot_token);
  const allowed = new Set(deps.config.telegram.allowed_user_ids);

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
      n = new Notifier({ bot, chatId, debounceMs: deps.config.notifier.debounce_ms });
      notifierByChat.set(chatId, n);
    }
    return n;
  };

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

  // Curry deps into the wizard so it stays a pure async function (easier to
  // unit-test). The plugin requires the identifier explicitly when the wrapped
  // function is anonymous — we pass 'newSession' as the second arg.
  bot.use(
    createConversation(
      (conversation: Conversation, ctx: Context) =>
        newSession(conversation, ctx, { store: deps.store, manager: deps.manager }),
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
    try {
      await ctx.conversation.enter('newSession');
    } catch (err) {
      logger.warn({ err: String(err) }, '/new: enter failed');
      await ctx.reply('Đang có wizard chạy — hoàn tất hoặc /cancel trước.');
    }
  });

  // `/help` — short Vietnamese guide listing the 6 keyboard buttons and the
  // discoverable slash commands. Registered separately from registerCommands
  // because the slash-menu listing (commands-registry.ts) names it explicitly
  // — every entry there must have a matching handler or Telegram clients
  // surface a "no response" warning on tap.
  bot.command('help', async (ctx) => {
    const lines = [
      '*Telecode — hướng dẫn nhanh*',
      '',
      '*Keyboard (6 nút phía dưới):*',
      '• 📋 Sessions — list + switch session',
      '• 📁 Projects — chọn project',
      '• 📊 Status — trạng thái session active',
      '• 🛑 Stop — dừng task đang chạy',
      '• 📸 Screen — chụp desktop Mac',
      '• ❓ Help — màn hình này',
      '',
      '*Slash commands:*',
      '• `/new` — wizard tạo session (3 bước: agent → project → label)',
      '• `/sessions` — list session + switch',
      '• `/projects` — list project + chuyển cwd',
      '• `/status` — trạng thái session active',
      '• `/stop` — dừng task đang chạy',
      '• `/screenshot` — chụp desktop Mac',
      '',
      'Gõ prompt thường để gửi cho session active.',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
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
    deps.store.setActiveSession(chatId, id);
    await ctx.answerCallbackQuery({ text: `→ ${row.label}` });
    await ctx.reply(
      `📍 [${row.label}]\n${
        row.transcript_tail
          .split('\n')
          .slice(-deps.config.session_switch_preview_lines)
          .join('\n') || '(no transcript yet)'
      }`,
    );

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
          logger.warn({ err: String(err), sessionId: id }, 'switch catch-up flush failed');
          break;
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
      await ctx.reply('Đang có wizard chạy — hoàn tất hoặc /cancel trước.');
    }
  };

  // T3 placeholders — buttons rendered on the wizard success message. The real
  // handlers (list / logs) live in T3 scope; for now we just ack so the
  // buttons are not dead clicks. See plan §5.1 step 5.
  // TODO(T3): wire session:list-trigger and session:logs-trigger to real
  // handlers that render `/sessions` and `/status logs` respectively.
  const t3SessionListTrigger = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
  ): Promise<void> => {
    await ctx.answerCallbackQuery({ text: 'Dùng /sessions' });
  };
  const t3SessionLogsTrigger = async (
    ctx: Parameters<Parameters<typeof callbackRouter.on>[2]>[0],
  ): Promise<void> => {
    await ctx.answerCallbackQuery({ text: 'Dùng /status logs' });
  };

  callbackRouter
    .on('apv', 'once', (ctx, payload) => resolveApproval(ctx, payload, 'allow_once'))
    .on('apv', 'always', (ctx, payload) => resolveApproval(ctx, payload, 'allow_always'))
    .on('apv', 'deny', (ctx, payload) => resolveApproval(ctx, payload, 'deny'))
    // New ns used by reply-builders / B1+ inline buttons.
    .on('session', 'switch', switchSessionHandler)
    .on('session', 'close', closeSessionHandler)
    .on('session', 'handoff', handoffSessionHandler)
    // Backward-compat: legacy `ses:switch:<id>` from `sessionPickKeyboard`
    // (still emitted by `/session list`). Same handler closure.
    .on('ses', 'switch', switchSessionHandler)
    .on('wizard', 'new-start', wizardNewStartHandler)
    .on('session', 'list-trigger', t3SessionListTrigger)
    .on('session', 'logs-trigger', t3SessionLogsTrigger);

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
            deps.store.setActiveSession(req.chatId, req.sessionId);
            if (deps.manager.hasBuffered(req.sessionId)) {
              // Header format matches `flushBufferedAsCatchUp` in commands/index.ts
              // so users see consistent catch-up wording regardless of trigger
              // (auto-switch on approval / manual switch / done-error flush).
              //
              // Per plan §7 risk register (P2): a 50KB buffer would otherwise
              // be silently clipped to 3500 chars by Notifier — split first.
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
          }
        }

        const sessions: SessionListItem[] = deps.store.listSessions(req.chatId).map((s) => ({
          id: s.id,
          label: s.label,
          agent: s.agent as 'claude' | 'kiro',
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
