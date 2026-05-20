import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, CommandContext, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { registerCommands, type CommandDeps } from '../src/bot/commands/index.js';
import type { TelecodeConfig } from '../src/config.js';
import type { ApprovalBroker } from '../src/approval/broker.js';
import type { PolicyEngine } from '../src/approval/policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_ID = 12345;

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-sessions-cmd-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function fakeConfig(): TelecodeConfig {
  // Minimal shape — registerCommands only reads `defaults.agent` and
  // `session_switch_preview_lines` (the latter is only used by /session switch,
  // not /sessions). Cast away to keep the test fixture tiny.
  return {
    defaults: { agent: 'claude' },
    session_switch_preview_lines: 3,
  } as unknown as TelecodeConfig;
}

/**
 * Capture all `bot.command(name, handler)` registrations so the test can
 * invoke a specific handler with a synthetic ctx without spinning up a real
 * Bot / runner. We only stub the methods registerCommands actually calls
 * (`bot.command`, `bot.on`) — anything else throws to surface accidental
 * coupling.
 */
type CommandHandler = (
  ctx: CommandContext<Context>,
) => Promise<unknown> | unknown;

function makeBotSpy(): {
  bot: Bot;
  handlers: Map<string, CommandHandler>;
} {
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

interface MockCtx {
  chat: { id: number };
  match: string;
  reply: ReturnType<typeof vi.fn>;
}

function makeCtx(chatId: number = CHAT_ID): MockCtx {
  return {
    chat: { id: chatId },
    match: '',
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/sessions command (B1)', () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  function setup(): {
    store: SessionStore;
    handler: CommandHandler;
  } {
    const { store, cleanup } = makeStore();
    teardown = cleanup;
    // SessionManager is required by CommandDeps but never invoked by
    // `/sessions`. Pass a registry stub it never touches.
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
    const handler = handlers.get('sessions');
    if (!handler) throw new Error('`/sessions` handler not registered');
    return { store, handler };
  }

  it('lists 3 sessions with active marker on the 2nd', async () => {
    const { store, handler } = setup();

    // Create 3 sessions; setActiveSession on the 2nd one. Inserting one at a
    // time with a tiny gap keeps `updated_at` ordering deterministic — the
    // store sorts list by `updated_at DESC` so insertion order is reverse of
    // display order. We don't assert order here, just count + active marker.
    const s1 = store.createSession({
      id: 'sess-1', label: 'refactor-auth', agent: 'claude',
      project_id: null, chat_id: CHAT_ID, sdk_session_id: null, status: 'idle',
    });
    const s2 = store.createSession({
      id: 'sess-2', label: 'debug-api', agent: 'claude',
      project_id: null, chat_id: CHAT_ID, sdk_session_id: null, status: 'idle',
    });
    const s3 = store.createSession({
      id: 'sess-3', label: 'mobile-ui', agent: 'kiro',
      project_id: null, chat_id: CHAT_ID, sdk_session_id: null, status: 'idle',
    });
    expect([s1.id, s2.id, s3.id]).toEqual(['sess-1', 'sess-2', 'sess-3']);
    store.setActiveSession(CHAT_ID, 'sess-2');

    const ctx = makeCtx();
    await handler(ctx as unknown as CommandContext<Context>);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.reply.mock.calls[0]!;

    // Header line includes the count.
    expect(text).toContain('Sessions (3)');
    // The 3 labels are present somewhere in the rendered body.
    expect(text).toContain('refactor-auth');
    expect(text).toContain('debug-api');
    expect(text).toContain('mobile-ui');
    // Active marker on the debug-api line (not on the other two).
    const lines = (text as string).split('\n');
    const debugLine = lines.find((l) => l.includes('debug-api'))!;
    expect(debugLine).toMatch(/●\s+debug-api/);
    const refactorLine = lines.find((l) => l.includes('refactor-auth'))!;
    expect(refactorLine).not.toContain('●');

    // reply_markup is an InlineKeyboard with at minimum 3 switch buttons +
    // a [➕ New session] button.
    const kb = (opts as { reply_markup: InlineKeyboard }).reply_markup;
    expect(kb).toBeInstanceOf(InlineKeyboard);
    const callbackData = kb.inline_keyboard.flat().map((b) =>
      'callback_data' in b ? b.callback_data : '',
    );
    expect(callbackData).toContain('session:switch:sess-1');
    expect(callbackData).toContain('session:switch:sess-2');
    expect(callbackData).toContain('session:switch:sess-3');
    expect(callbackData).toContain('wizard:new-start');
  });

  it('empty list — shows (0) header + new-session button only', async () => {
    const { handler } = setup();

    const ctx = makeCtx();
    await handler(ctx as unknown as CommandContext<Context>);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.reply.mock.calls[0]!;

    expect(text).toContain('Sessions (0)');
    const kb = (opts as { reply_markup: InlineKeyboard }).reply_markup;
    expect(kb).toBeInstanceOf(InlineKeyboard);
    const buttons = kb.inline_keyboard.flat();
    // Only the [➕ New session] button is present.
    expect(buttons).toHaveLength(1);
    const only = buttons[0]!;
    expect('callback_data' in only && only.callback_data).toBe('wizard:new-start');
    expect(only.text).toContain('New session');
  });

  it('excludes closed sessions from the list', async () => {
    const { store, handler } = setup();

    store.createSession({
      id: 'open-1', label: 'open-one', agent: 'claude',
      project_id: null, chat_id: CHAT_ID, sdk_session_id: null, status: 'idle',
    });
    store.createSession({
      id: 'closed-1', label: 'closed-one', agent: 'claude',
      project_id: null, chat_id: CHAT_ID, sdk_session_id: null, status: 'closed',
    });

    const ctx = makeCtx();
    await handler(ctx as unknown as CommandContext<Context>);

    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('Sessions (1)');
    expect(text).toContain('open-one');
    expect(text).not.toContain('closed-one');
  });
});
