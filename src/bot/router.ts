import { Bot, GrammyError } from 'grammy';
import { run } from '@grammyjs/runner';
import type { TelecodeConfig } from '../config.js';
import type { SessionStore } from '../session/store.js';
import type { SessionManager } from '../session/manager.js';
import type { ApprovalBroker, ApprovalRequest } from '../approval/broker.js';
import type { PolicyEngine } from '../approval/policy.js';
import { Notifier } from './notifier.js';
import { registerCommands } from './commands/index.js';
import { approvalKeyboard } from './keyboards.js';
import { logger } from '../util/logger.js';
import { scrubSecrets } from '../util/scrub.js';

export interface BotDeps {
  config: TelecodeConfig;
  store: SessionStore;
  manager: SessionManager;
  broker: ApprovalBroker;
  policy: PolicyEngine;
}

export interface StartedBot {
  bot: Bot;
  notifier: Notifier;
  stop: () => Promise<void>;
}

export async function startBot(deps: BotDeps): Promise<StartedBot> {
  const bot = new Bot(deps.config.telegram.bot_token);
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
      n = new Notifier({ bot, chatId });
      notifierByChat.set(chatId, n);
    }
    return n;
  };

  // Approval prompter — broker -> Telegram
  deps.broker.attach({
    async prompt(req: ApprovalRequest) {
      const n = notifierFor(req.chatId);
      const text = scrubSecrets(
        `🛡 *Approval needed*\n` +
          `Session: \`${req.sessionLabel}\`\n` +
          `Tool: \`${req.toolName}\`\n` +
          `Input: \`${req.inputPreview}\``,
      );
      try {
        deps.store.recordApproval(req.id, req.sessionId, req.toolName, JSON.stringify(req.input));
        await n.sendPlain(text, {
          parse_mode: 'Markdown',
          reply_markup: approvalKeyboard(req.id),
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'approval prompt send failed');
      }
    },
    async notifyTimeout(req: ApprovalRequest) {
      const n = notifierFor(req.chatId);
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
  });

  registerCommands(bot, { ...deps, notifierFor });

  // Callback for approval buttons
  bot.callbackQuery(/^apv:(once|always|deny):(.+)$/, async (ctx) => {
    const match = ctx.match;
    const kind = match[1] as 'once' | 'always' | 'deny';
    const requestId = match[2]!;
    const decision = kind === 'once' ? 'allow_once' : kind === 'always' ? 'allow_always' : 'deny';
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
  });

  // Callback for session quick-switch
  bot.callbackQuery(/^ses:switch:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    const chatId = ctx.chat?.id ?? 0;
    const row = deps.store.getSession(id);
    if (!row || row.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'not found' });
      return;
    }
    deps.store.setActiveSession(chatId, id);
    await ctx.answerCallbackQuery({ text: `→ ${row.label}` });
    await ctx.reply(`📍 [${row.label}]\n${row.transcript_tail.split('\n').slice(-deps.config.session_switch_preview_lines).join('\n') || '(no transcript yet)'}`);
  });

  bot.catch((err) => {
    if (err.error instanceof GrammyError) {
      logger.error({ err: err.error.description }, 'grammy error');
    } else {
      logger.error({ err: String(err.error) }, 'bot uncaught');
    }
  });

  const runner = run(bot);

  return {
    bot,
    notifier: notifierFor(deps.config.telegram.allowed_user_ids[0]!),
    async stop() {
      await runner.stop();
    },
  };
}
