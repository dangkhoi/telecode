import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, CommandContext, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { registerCommands, type CommandDeps } from '../src/bot/commands/index.js';
import {
  projectCdHandler,
  projectNewHandler,
  projectPageHandler,
} from '../src/bot/callbacks/projects.js';
import type { TelecodeConfig } from '../src/config.js';
import type { ApprovalBroker } from '../src/approval/broker.js';
import type { PolicyEngine } from '../src/approval/policy.js';
import type { CallbackRouterContext } from '../src/bot/callback-router.js';

// ---------------------------------------------------------------------------
// Fixtures — mirror tests/sessions-cmd.test.ts
// ---------------------------------------------------------------------------

const CHAT_ID = 99001;

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-projects-cmd-'));
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

interface MockCommandCtx {
  chat: { id: number };
  match: string;
  reply: ReturnType<typeof vi.fn>;
}

function makeCommandCtx(chatId: number = CHAT_ID): MockCommandCtx {
  return {
    chat: { id: chatId },
    match: '',
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

interface MockCallbackCtx {
  chat: { id: number };
  callbackQuery: { data: string };
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  editMessageReplyMarkup: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

function makeCallbackCtx(data: string, chatId: number = CHAT_ID): MockCallbackCtx {
  return {
    chat: { id: chatId },
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function setupCommand(): {
  store: SessionStore;
  handler: CommandHandler;
  cleanup: () => void;
} {
  const { store, cleanup } = makeStore();
  const manager = new SessionManager(store, {} as never);
  const deps: CommandDeps = {
    config: fakeConfig(),
    store,
    manager,
    broker: {} as ApprovalBroker,
    policy: {} as PolicyEngine,
    // Plan P1.1: open-set registry. `/projects` never touches it; no-op stub.
    registry: {
      has: () => true,
      get: () => undefined,
      require: () => { throw new Error('unused in /projects tests'); },
      kinds: () => ['claude'],
      list: () => [{ kind: 'claude', displayName: 'Claude', badge: '🤖' }],
    } as never,
    notifierFor: () => ({} as never),
  };
  const { bot, handlers } = makeBotSpy();
  registerCommands(bot, deps);
  const handler = handlers.get('projects');
  if (!handler) throw new Error('`/projects` handler not registered');
  return { store, handler, cleanup };
}

// ---------------------------------------------------------------------------
// /projects command
// ---------------------------------------------------------------------------

describe('/projects command (B2)', () => {
  let teardown: (() => void) | null = null;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it('lists 10 projects with header count + pagination nav (first page)', async () => {
    const { store, handler, cleanup } = setupCommand();
    teardown = cleanup;

    for (let i = 1; i <= 10; i++) {
      store.upsertProject(`name-${i}`, `/tmp/proj-${i}`);
    }

    const ctx = makeCommandCtx();
    await handler(ctx as unknown as CommandContext<Context>);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('Projects (10)');

    const kb = (opts as { reply_markup: InlineKeyboard }).reply_markup;
    expect(kb).toBeInstanceOf(InlineKeyboard);

    // Page 1 of 2: should include the page-indicator + Next nav button.
    const allTexts = kb.inline_keyboard.flat().map((b) => b.text);
    expect(allTexts).toContain('page 1/2');
    expect(allTexts).toContain('Next →');
    expect(allTexts).not.toContain('← Prev');

    // 8 projects on the first page, 1 button each (post-v0.8 simplified layout).
    const cdCallbacks = kb.inline_keyboard
      .flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''))
      .filter((d) => d.startsWith('project:cd:'));
    expect(cdCallbacks).toHaveLength(8);
    // No more `[➕ New]` per-project buttons — removed because they were
    // unlabeled and duplicated the /new wizard's project picker.
    const newCallbacks = kb.inline_keyboard
      .flat()
      .map((b) => ('callback_data' in b ? b.callback_data : ''))
      .filter((d) => d.startsWith('project:new:'));
    expect(newCallbacks).toHaveLength(0);
  });

  it('empty list — shows (0) header + empty hint, no actionable rows', async () => {
    const { handler, cleanup } = setupCommand();
    teardown = cleanup;

    const ctx = makeCommandCtx();
    await handler(ctx as unknown as CommandContext<Context>);

    const [text, opts] = ctx.reply.mock.calls[0]!;
    expect(text).toContain('Projects (0)');
    expect(text).toMatch(/no projects/i);
    const kb = (opts as { reply_markup: InlineKeyboard }).reply_markup;
    expect(kb.inline_keyboard.flat()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// project:* callback handlers
// ---------------------------------------------------------------------------

describe('project:* callbacks (B2)', () => {
  let teardown: (() => void) | null = null;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  function setup(): { store: SessionStore } {
    const { store, cleanup } = makeStore();
    teardown = cleanup;
    return { store };
  }

  it('project:page:2 re-renders the picker on page 2 via editMessageText', async () => {
    const { store } = setup();
    for (let i = 1; i <= 10; i++) {
      store.upsertProject(`name-${i}`, `/tmp/proj-${i}`);
    }

    const ctx = makeCallbackCtx('project:page:2');
    await projectPageHandler(
      ctx as unknown as CallbackRouterContext,
      '2',
      { store },
    );

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.editMessageText.mock.calls[0]!;
    expect(text).toContain('Projects (10)');
    // Page 2 contains projects 9 + 10 (perPage=8, sorted by name).
    // ORDER BY name in store.listProjects() — string sort puts name-10 before
    // name-2..9. Page-1 (first 8 by name sort): 1, 10, 2, 3, 4, 5, 6, 7.
    // Page-2: 8, 9.
    expect(text).toContain('name-8');
    expect(text).toContain('name-9');
    expect(text).not.toContain('name-1 ·');
    const kb = (opts as { reply_markup: InlineKeyboard }).reply_markup;
    const navTexts = kb.inline_keyboard.flat().map((b) => b.text);
    expect(navTexts).toContain('← Prev');
    expect(navTexts).toContain('page 2/2');
    expect(navTexts).not.toContain('Next →');
  });

  it('project:page:current is a no-op ack', async () => {
    const { store } = setup();
    for (let i = 1; i <= 10; i++) {
      store.upsertProject(`name-${i}`, `/tmp/proj-${i}`);
    }

    const ctx = makeCallbackCtx('project:page:current');
    await projectPageHandler(
      ctx as unknown as CallbackRouterContext,
      'current',
      { store },
    );

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it('project:cd:<id> sets the chat active project + strips the keyboard', async () => {
    const { store } = setup();
    const p1 = store.upsertProject('alpha', '/tmp/alpha');
    const p2 = store.upsertProject('beta', '/tmp/beta');

    // Pre-condition: no active project.
    expect(store.getChatState(CHAT_ID).active_project_id).toBeNull();

    const ctx = makeCallbackCtx(`project:cd:${p2.id}`);
    await projectCdHandler(
      ctx as unknown as CallbackRouterContext,
      String(p2.id),
      { store },
    );

    expect(store.getChatState(CHAT_ID).active_project_id).toBe(p2.id);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery.mock.calls[0]![0]).toMatchObject({
      text: `→ ${p2.name}`,
    });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [replyText, replyOpts] = ctx.reply.mock.calls[0]!;
    expect(replyText).toContain('Active project');
    expect(replyText).toContain(p2.name);
    expect(replyOpts).toMatchObject({ parse_mode: 'Markdown' });
    // Switching again to p1 updates state idempotently.
    const ctx2 = makeCallbackCtx(`project:cd:${p1.id}`);
    await projectCdHandler(
      ctx2 as unknown as CallbackRouterContext,
      String(p1.id),
      { store },
    );
    expect(store.getChatState(CHAT_ID).active_project_id).toBe(p1.id);
  });

  it('project:cd retargets the active session’s project_id', async () => {
    const { store } = setup();
    const p1 = store.upsertProject('alpha', '/tmp/alpha');
    const p2 = store.upsertProject('beta', '/tmp/beta');
    store.createSession({
      id: 'sess-1',
      label: 'work',
      agent: 'claude',
      project_id: p1.id,
      chat_id: CHAT_ID,
      sdk_session_id: null,
      status: 'idle',
    });
    store.setActiveSession(CHAT_ID, 'sess-1');

    const ctx = makeCallbackCtx(`project:cd:${p2.id}`);
    await projectCdHandler(
      ctx as unknown as CallbackRouterContext,
      String(p2.id),
      { store },
    );

    expect(store.getSession('sess-1')!.project_id).toBe(p2.id);
  });

  it('project:cd rejects bogus ids without mutating state', async () => {
    const { store } = setup();
    store.upsertProject('alpha', '/tmp/alpha');

    const ctx = makeCallbackCtx('project:cd:not-a-number');
    await projectCdHandler(
      ctx as unknown as CallbackRouterContext,
      'not-a-number',
      { store },
    );

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'bad project id' });
    expect(store.getChatState(CHAT_ID).active_project_id).toBeNull();

    const ctx2 = makeCallbackCtx('project:cd:999999');
    await projectCdHandler(
      ctx2 as unknown as CallbackRouterContext,
      '999999',
      { store },
    );
    expect(ctx2.answerCallbackQuery).toHaveBeenCalledWith({ text: 'not found' });
    expect(store.getChatState(CHAT_ID).active_project_id).toBeNull();
  });

  it('project:new is a no-op ack post-v0.8 (deprecated handler)', async () => {
    // The per-project [➕ New] button was removed when the /projects picker
    // was simplified to 1 button per project. Old chat history may still
    // contain the legacy two-button layout, so we keep the handler registered
    // as a no-op ack with a hint message — never crashes, never replies.
    const { store } = setup();
    const p1 = store.upsertProject('alpha', '/tmp/alpha');

    const ctx = makeCallbackCtx(`project:new:${p1.id}`);
    await projectNewHandler(
      ctx as unknown as CallbackRouterContext,
      String(p1.id),
      { store },
    );

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Dùng /new để tạo session mới' });
    // No follow-up reply — just the ack.
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
