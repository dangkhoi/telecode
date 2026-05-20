import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, CommandContext, Context } from 'grammy';
import { Keyboard } from 'grammy';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { registerCommands, type CommandDeps } from '../src/bot/commands/index.js';
import { applyCommandsAndMenu, COMMANDS } from '../src/bot/commands-registry.js';
import { isKeyboardActionText, keyboardActionToCommand } from '../src/bot/keyboard-actions.js';
import type { TelecodeConfig } from '../src/config.js';
import type { ApprovalBroker } from '../src/approval/broker.js';
import type { PolicyEngine } from '../src/approval/policy.js';

// ---------------------------------------------------------------------------
// Phase B4 — boot wiring tests
//
// These tests verify the three wiring concerns that connect A1–B3 features to
// the running bot:
//   1. The slash-menu / chat-menu-button push (`applyCommandsAndMenu`) is
//      invoked against a real grammY `Bot.api` shape during boot.
//   2. The persistent-reply-keyboard middleware rewrites incoming button
//      taps (e.g. "📋 Sessions") to the canonical slash command ("/sessions")
//      before downstream `bot.command(...)` middleware runs.
//   3. The `/start` command handler attaches the 6-button persistent keyboard
//      to its welcome reply so the user always has tap-to-command access.
//
// We avoid spinning up a real Bot + long-polling runner; instead each test
// exercises the relevant unit in isolation with mocks shaped after grammY's
// real interfaces.
// ---------------------------------------------------------------------------

const CHAT_ID = 7777;

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-boot-wiring-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function fakeConfig(): TelecodeConfig {
  return {
    defaults: { agent: 'claude' },
    session_switch_preview_lines: 3,
  } as unknown as TelecodeConfig;
}

type CommandHandler = (
  ctx: CommandContext<Context>,
) => Promise<unknown> | unknown;

function makeBotSpy(): { bot: Bot; handlers: Map<string, CommandHandler> } {
  const handlers = new Map<string, CommandHandler>();
  const bot = {
    command: vi.fn((name: string, handler: CommandHandler) => {
      handlers.set(name, handler);
      return bot;
    }),
    on: vi.fn(() => bot),
  } as unknown as Bot;
  return { bot, handlers };
}

// ---------------------------------------------------------------------------
// 1. applyCommandsAndMenu integrates with grammY's bot.api shape
// ---------------------------------------------------------------------------

describe('boot wiring — applyCommandsAndMenu (B4)', () => {
  it('invokes setMyCommands + setChatMenuButton on the bot.api at boot', async () => {
    // We assert the side effects an integrator would observe when calling
    // applyCommandsAndMenu(bot) inside startBot(). This complements
    // commands-registry.test.ts which exercises the function in isolation —
    // here we verify the *call shape* expected by Telegram in a single round.
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const setChatMenuButton = vi.fn().mockResolvedValue(true);
    const bot = {
      api: { setMyCommands, setChatMenuButton },
    } as unknown as Bot;

    await applyCommandsAndMenu(bot);

    expect(setMyCommands).toHaveBeenCalledTimes(1);
    expect(setChatMenuButton).toHaveBeenCalledTimes(1);

    // Order matters: commands first, menu button second — otherwise the
    // menu button could briefly point at a stale command list. router.ts
    // calls applyCommandsAndMenu after `run(bot)` so updates start arriving
    // immediately but slash-menu population follows in the next tick.
    expect(setMyCommands.mock.invocationCallOrder[0]!).toBeLessThan(
      setChatMenuButton.mock.invocationCallOrder[0]!,
    );

    // setMyCommands receives the canonical COMMANDS array scoped to private
    // chats (the bot is a single-user DM tool — no groups).
    const [cmdsArg, otherArg] = setMyCommands.mock.calls[0]!;
    expect(cmdsArg).toEqual(COMMANDS);
    expect(otherArg).toEqual({ scope: { type: 'all_private_chats' } });
  });
});

// ---------------------------------------------------------------------------
// 2. Keyboard-action middleware: rewrites button text → slash command
// ---------------------------------------------------------------------------

/**
 * Mirror of the middleware installed in `src/bot/router.ts` (B4). Kept here
 * as a small, testable copy because the middleware closure is created inline
 * inside startBot() and exposing it would require restructuring router.ts.
 *
 * Behaviour invariants (must match router.ts):
 *  - If text matches a KEYBOARD_ACTIONS key AND no conversation is active,
 *    mutate ctx.update.message.text to the slash command string.
 *  - Otherwise pass the update through unchanged.
 *  - Always call next().
 */
interface MwMessage {
  text: string;
  entities?: { type: string; offset: number; length: number }[];
}
async function keyboardActionMiddleware(
  ctx: {
    message?: { text?: string };
    update: { message?: MwMessage };
    conversation: { active: () => Record<string, number> };
  },
  next: () => Promise<void>,
): Promise<void> {
  const text = ctx.message?.text;
  if (text && isKeyboardActionText(text)) {
    const active = ctx.conversation.active();
    const anyActive = Object.values(active).some((n) => n > 0);
    if (!anyActive) {
      const cmd = keyboardActionToCommand(text);
      if (cmd && ctx.update.message) {
        ctx.update.message.text = cmd;
        // Inject synthetic bot_command entity — grammY's bot.command() matcher
        // checks message.entities, not raw text. Without this the rewrite is
        // a no-op (the bug fixed post-v0.8 ship).
        ctx.update.message.entities = [
          { type: 'bot_command', offset: 0, length: cmd.length },
        ];
      }
    }
  }
  await next();
}

describe('boot wiring — keyboard-action middleware (B4)', () => {
  it('rewrites "📋 Sessions" to "/sessions" before downstream', async () => {
    const message = { text: '📋 Sessions' };
    const ctx = {
      message,
      update: { message },
      conversation: { active: () => ({}) },
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await keyboardActionMiddleware(ctx, next);

    expect(ctx.update.message.text).toBe('/sessions');
    expect((ctx.update.message as MwMessage).entities).toEqual([
      { type: 'bot_command', offset: 0, length: '/sessions'.length },
    ]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT rewrite when a conversation is active (wizard owns input)', async () => {
    // A wizard mid-flow (e.g. waiting on label-step text) must NOT have its
    // user input hijacked by a stale keyboard tap. The middleware defers when
    // ctx.conversation.active() reports any running conversation.
    const message = { text: '📋 Sessions' };
    const ctx = {
      message,
      update: { message },
      conversation: { active: () => ({ newSession: 1 }) },
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await keyboardActionMiddleware(ctx, next);

    // Text untouched — the wizard's form.text() gets the literal "📋 Sessions".
    expect(ctx.update.message.text).toBe('📋 Sessions');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes through unrelated text untouched', async () => {
    // Free-form prompts ("refactor the auth module") must reach the
    // `bot.on('message:text', ...)` handler unchanged — only the 6 known
    // emoji-button labels are rewritten.
    const message = { text: 'refactor the auth module' };
    const ctx = {
      message,
      update: { message },
      conversation: { active: () => ({}) },
    };
    const next = vi.fn().mockResolvedValue(undefined);

    await keyboardActionMiddleware(ctx, next);

    expect(ctx.update.message.text).toBe('refactor the auth module');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rewrites every one of the 6 known buttons', async () => {
    // Defence against accidental drift between keyboard-actions.ts map and
    // the middleware: every entry in the public KEYBOARD_ACTIONS table must
    // dispatch to its slash command via this middleware.
    const buttons: ReadonlyArray<[string, string]> = [
      ['📋 Sessions', '/sessions'],
      ['📁 Projects', '/projects'],
      ['📊 Status', '/status'],
      ['🛑 Stop', '/stop'],
      ['📸 Screen', '/screenshot'],
      ['❓ Help', '/help'],
    ];
    for (const [label, cmd] of buttons) {
      const message = { text: label };
      const ctx = {
        message,
        update: { message },
        conversation: { active: () => ({}) },
      };
      await keyboardActionMiddleware(ctx, vi.fn().mockResolvedValue(undefined));
      expect(ctx.update.message.text).toBe(cmd);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. /start handler attaches the 6-button persistent keyboard
// ---------------------------------------------------------------------------

describe('boot wiring — /start sends persistent keyboard (B4)', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it('reply_markup is a Keyboard with the 6 emoji-prefixed buttons', async () => {
    const { store, cleanup } = makeStore();
    teardown = cleanup;
    const manager = new SessionManager(store, {} as never);
    const deps: CommandDeps = {
      config: fakeConfig(),
      store,
      manager,
      broker: {} as ApprovalBroker,
      policy: {} as PolicyEngine,
      notifierFor: () => ({} as never),
    };
    const { bot, handlers } = makeBotSpy();
    registerCommands(bot, deps);

    const startHandler = handlers.get('start');
    if (!startHandler) throw new Error('/start handler not registered');

    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = { chat: { id: CHAT_ID }, reply } as unknown as CommandContext<Context>;
    await startHandler(ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    const [text, opts] = reply.mock.calls[0]!;
    expect(typeof text).toBe('string');
    expect((opts as { parse_mode: string }).parse_mode).toBe('Markdown');

    const kb = (opts as { reply_markup: Keyboard }).reply_markup;
    expect(kb).toBeInstanceOf(Keyboard);

    // Flatten the 2-D button grid and pull the visible text labels.
    const labels = kb.keyboard.flat().map((b) =>
      typeof b === 'string' ? b : (b as { text: string }).text,
    );
    expect(labels).toEqual([
      '📋 Sessions',
      '📁 Projects',
      '📊 Status',
      '🛑 Stop',
      '📸 Screen',
      '❓ Help',
    ]);
    // Persistent + resized — see plan §4.2 ("persistent reply keyboard").
    expect(kb.is_persistent).toBe(true);
    expect(kb.resize_keyboard).toBe(true);
  });
});
