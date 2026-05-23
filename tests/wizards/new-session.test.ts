import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation } from '@grammyjs/conversations';
import type { Context } from 'grammy';
import type { SessionStore, SessionRow, ProjectRow, AgentKind } from '../../src/session/store.js';
import type { SessionManager } from '../../src/session/manager.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import type { AgentAdapter } from '../../src/agents/types.js';
import { newSession, PROJECTS_PER_PAGE, type WizardDeps } from '../../src/bot/wizards/new-session.js';
import { createI18n } from '../../src/i18n/index.js';

/**
 * VI-locale i18n handle for tests. Wizard assertions historically check
 * Vietnamese substrings; threading this in keeps the assertions stable
 * across the i18n migration. (The wizard's own EN-fallback path is
 * exercised by separate Phase 1 i18n unit tests.)
 */
const viI18n = createI18n({
  store: {
    getChatLanguage: () => 'vi' as const,
    setChatLanguage: () => {},
  },
});

/**
 * Build a registry pre-populated with stub claude + kiro adapters. The stubs
 * never `run` — the wizard only reads `registry.list()` for picker rendering.
 */
function makeStubRegistry(extra: { kind: string; displayName: string; badge: string }[] = []): AgentRegistry {
  const r = new AgentRegistry();
  const stub = (k: string): AgentAdapter => ({ kind: k, run: async () => {} });
  r.register('claude', () => stub('claude'), { kind: 'claude', displayName: 'Claude', badge: '🤖' });
  r.register('kiro', () => stub('kiro'), { kind: 'kiro', displayName: 'Kiro', badge: '⚡' });
  for (const e of extra) {
    r.register(e.kind, () => stub(e.kind), { kind: e.kind, displayName: e.displayName, badge: e.badge });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/**
 * Fake `callback_query` context. Matches the subset of grammY's
 * `CallbackQueryContext` that `newSession()` actually reads. Each spy is
 * inspectable from tests so we can assert the wizard editMessageText'd or
 * answer'd as expected.
 */
function makeCbCtx(data: string) {
  return {
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Outer (entry) ctx — only the `chat.id` and `reply` fields are exercised by
 * the wizard. We use a chat id of 42 throughout.
 */
function makeEntryCtx() {
  return {
    chat: { id: 42 },
    reply: vi.fn().mockResolvedValue({ message_id: 100 }),
  } as unknown as Context;
}

/**
 * Build a fake Conversation handle. `waitFor` returns the queued cb-ctx
 * objects in FIFO order; `form.text` returns the queued strings; `external`
 * runs the supplied task synchronously (mimicking grammY's behaviour: first
 * execution always runs the real task).
 */
function makeConversation(
  cbQueue: ReturnType<typeof makeCbCtx>[],
  textQueue: string[],
) {
  return {
    waitFor: vi.fn().mockImplementation(async () => {
      const next = cbQueue.shift();
      if (!next) throw new Error('test: waitFor queue empty — unexpected extra wait');
      return next;
    }),
    form: {
      text: vi.fn().mockImplementation(async (opts?: { otherwise?: (c: unknown) => unknown }) => {
        const next = textQueue.shift();
        if (next === undefined) {
          throw new Error('test: form.text queue empty');
        }
        // Sentinel used by the "invalid input" test to fire `otherwise`.
        if (next === '__OTHERWISE__') {
          if (opts?.otherwise) {
            // Pass a tiny ctx with a reply spy so the test can verify the
            // otherwise hook ran.
            const otherwiseCtx = { reply: vi.fn().mockResolvedValue(undefined) };
            await opts.otherwise(otherwiseCtx);
            // Treat sentinel as "validation failed" — recurse for the next
            // queued text (mimic grammY: otherwise then re-wait).
            return (await ((): Promise<string> => {
              const after = textQueue.shift();
              if (after === undefined) throw new Error('test: form.text post-otherwise queue empty');
              return Promise.resolve(after);
            })());
          }
        }
        return next;
      }),
    },
    external: vi.fn().mockImplementation(async (op: unknown) => {
      const task = typeof op === 'function' ? op : (op as { task: () => unknown }).task;
      return await (task as (ctx?: unknown) => unknown)();
    }),
  } as unknown as Conversation;
}

/**
 * Minimal fakes for the store + manager. Each test wires only what it needs;
 * unused methods will throw "not implemented" if accidentally called.
 */
function makeDeps(overrides?: {
  projects?: ProjectRow[];
  findByLabel?: (chatId: number, label: string) => SessionRow | undefined;
  createSession?: (opts: {
    chatId: number;
    agent: AgentKind;
    label: string;
    projectId: number | null;
  }) => SessionRow;
  setActiveSession?: (chatId: number, id: string | null) => void;
}): WizardDeps {
  const projects = overrides?.projects ?? [
    { id: 1, name: 'telecode', path: '/Users/<you>/telecode', created_at: 0 },
    { id: 2, name: 'api', path: '/Users/<you>/api', created_at: 0 },
  ];
  const store = {
    listProjects: vi.fn().mockReturnValue(projects),
    findSessionByLabel: vi.fn().mockImplementation((chatId: number, label: string) =>
      overrides?.findByLabel?.(chatId, label),
    ),
    setActiveSession: vi.fn().mockImplementation((chatId: number, id: string | null) =>
      overrides?.setActiveSession?.(chatId, id),
    ),
  } as unknown as SessionStore;

  const createSessionSpy = vi.fn().mockImplementation((opts: {
    chatId: number;
    agent: AgentKind;
    label: string;
    projectId: number | null;
  }) => {
    if (overrides?.createSession) return overrides.createSession(opts);
    const row: SessionRow = {
      id: 'sess-uuid',
      label: opts.label,
      agent: opts.agent,
      project_id: opts.projectId,
      chat_id: opts.chatId,
      sdk_session_id: null,
      status: 'idle',
      created_at: 0,
      updated_at: 0,
      last_message: null,
      transcript_tail: '',
    };
    return row;
  });
  const manager = {
    createSession: createSessionSpy,
  } as unknown as SessionManager;

  return { store, manager, registry: makeStubRegistry(), i18n: viI18n };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('newSession wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path — agent=claude → project=1 → label=foo creates session + sets active', async () => {
    const deps = makeDeps();
    const cbQueue = [
      makeCbCtx('wizard:new-agent:claude'),
      makeCbCtx('wizard:new-project:1'),
    ];
    const conversation = makeConversation(cbQueue, ['foo']);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    // createSession called with all 3 collected inputs
    expect(deps.manager.createSession).toHaveBeenCalledTimes(1);
    expect(deps.manager.createSession).toHaveBeenCalledWith({
      chatId: 42,
      agent: 'claude',
      label: 'foo',
      projectId: 1,
    });
    // Active session set
    expect(deps.store.setActiveSession).toHaveBeenCalledWith(42, 'sess-uuid');
    // 5 user-facing replies: step1 agent, step2 project, step3 label,
    // step4 success, step5 keyboard-restore (B4) → at least 5 calls.
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(5);
    // The penultimate reply is the success confirmation containing the label
    // (the final reply is the B4 keyboard-restore "✓ Sẵn sàng nhận prompt").
    const allReplies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
    const successReply = allReplies.at(-2);
    expect(successReply?.[0]).toContain('foo');
    expect(successReply?.[0]).toContain('Claude');
    expect(successReply?.[0]).toContain('telecode');
    // Final reply restores the persistent reply keyboard (plan §4.2).
    const finalReply = allReplies.at(-1);
    expect(finalReply?.[0]).toContain('Sẵn sàng');
    expect(finalReply?.[1]).toHaveProperty('reply_markup');
  });

  it('cancel at step 1 — editMessageText "❌ Wizard hủy", createSession NOT called', async () => {
    const deps = makeDeps();
    const cancelCb = makeCbCtx('wizard:new-cancel');
    const conversation = makeConversation([cancelCb], []);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(cancelCb.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(cancelCb.editMessageText).toHaveBeenCalledWith('❌ Wizard hủy');
    expect(deps.manager.createSession).not.toHaveBeenCalled();
    expect(deps.store.setActiveSession).not.toHaveBeenCalled();
  });

  it('cancel at step 2 (project picker) — editMessageText "❌ Wizard hủy", no session', async () => {
    const deps = makeDeps();
    const agentCb = makeCbCtx('wizard:new-agent:claude');
    const cancelCb = makeCbCtx('wizard:new-cancel');
    const conversation = makeConversation([agentCb, cancelCb], []);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(cancelCb.editMessageText).toHaveBeenCalledWith('❌ Wizard hủy');
    expect(deps.manager.createSession).not.toHaveBeenCalled();
  });

  it('back at step 2 — exits wizard cleanly with restart hint', async () => {
    const deps = makeDeps();
    const agentCb = makeCbCtx('wizard:new-agent:kiro');
    const backCb = makeCbCtx('wizard:new-back');
    const conversation = makeConversation([agentCb, backCb], []);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(backCb.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('hủy'),
    );
    expect(deps.manager.createSession).not.toHaveBeenCalled();
  });

  it('invalid label triggers otherwise + loops until valid', async () => {
    const deps = makeDeps();
    const cbQueue = [
      makeCbCtx('wizard:new-agent:claude'),
      makeCbCtx('wizard:new-project:1'),
    ];
    // First text: "bad label" (has space → fails regex) → bot replies with
    // validation hint and loops. Second text: "good_label" → passes.
    const conversation = makeConversation(cbQueue, ['bad label', 'good_label']);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(deps.manager.createSession).toHaveBeenCalledTimes(1);
    expect(deps.manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'good_label' }),
    );
    // At least one of the ctx.reply calls should be the validation message.
    const validationMsg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('chữ-số-_'),
    );
    expect(validationMsg).toBeTruthy();
  });

  it('label "/cancel" aborts the wizard at step 3', async () => {
    const deps = makeDeps();
    const cbQueue = [
      makeCbCtx('wizard:new-agent:claude'),
      makeCbCtx('wizard:new-project:1'),
    ];
    const conversation = makeConversation(cbQueue, ['/cancel']);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(deps.manager.createSession).not.toHaveBeenCalled();
    const cancelReply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('hủy'),
    );
    expect(cancelReply).toBeTruthy();
  });

  it('duplicate label rejected — loops until unique', async () => {
    const taken = new Set(['existing']);
    const deps = makeDeps({
      findByLabel: (_chatId, label) =>
        taken.has(label)
          ? ({ id: 'old', label } as SessionRow)
          : undefined,
    });
    const cbQueue = [
      makeCbCtx('wizard:new-agent:claude'),
      makeCbCtx('wizard:new-project:1'),
    ];
    const conversation = makeConversation(cbQueue, ['existing', 'fresh']);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(deps.manager.createSession).toHaveBeenCalledTimes(1);
    expect(deps.manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'fresh' }),
    );
  });

  it('no projects registered — aborts with hint to /add', async () => {
    const deps = makeDeps({ projects: [] });
    const cbQueue = [makeCbCtx('wizard:new-agent:claude')];
    const conversation = makeConversation(cbQueue, []);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(deps.manager.createSession).not.toHaveBeenCalled();
    const hint = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('/add'),
    );
    expect(hint).toBeTruthy();
  });

  it('pagination — page navigation re-renders project list', async () => {
    // 10 projects → 2 pages (PROJECTS_PER_PAGE = 8). User navigates Next →
    // then picks project on page 2.
    expect(PROJECTS_PER_PAGE).toBe(8);
    const projects = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `p-${i + 1}`,
      path: `/x/p-${i + 1}`,
      created_at: 0,
    }));
    const deps = makeDeps({ projects });
    const agentCb = makeCbCtx('wizard:new-agent:claude');
    const pageCb = makeCbCtx('wizard:new-page:2'); // next page
    const pickCb = makeCbCtx('wizard:new-project:9'); // page 2
    const conversation = makeConversation([agentCb, pageCb, pickCb], ['ok']);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(pageCb.editMessageText).toHaveBeenCalled();
    expect(deps.manager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 9 }),
    );
  });

  it('aborts silently when ctx has no chat id', async () => {
    const deps = makeDeps();
    const conversation = makeConversation([], []);
    const ctx = { chat: undefined, reply: vi.fn() } as unknown as Context;

    await newSession(conversation, ctx, deps);

    expect(deps.manager.createSession).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('createSession failure surfaces user-friendly error', async () => {
    const deps = makeDeps({
      createSession: () => {
        throw new Error('db locked');
      },
    });
    const cbQueue = [
      makeCbCtx('wizard:new-agent:claude'),
      makeCbCtx('wizard:new-project:1'),
    ];
    const conversation = makeConversation(cbQueue, ['ok']);
    const ctx = makeEntryCtx();

    await newSession(conversation, ctx, deps);

    expect(deps.store.setActiveSession).not.toHaveBeenCalled();
    const errReply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('lỗi'),
    );
    expect(errReply).toBeTruthy();
  });

  // ===========================================================================
  // Plan P1.1 — picker is dynamic from registry, including the mock-adapter demo
  // ===========================================================================
  it('P1.1 — picker renders one button per registered adapter (3 with mock added)', async () => {
    const deps = makeDeps();
    // Re-bind registry with a 3rd "mock" adapter (the canonical demo from
    // plan acceptance A2). Picker should now show 3 buttons.
    deps.registry = makeStubRegistry([{ kind: 'mock', displayName: 'Mock', badge: '🧪' }]);

    const conversation = makeConversation([makeCbCtx('wizard:new-cancel')], []);
    const ctx = makeEntryCtx();
    await newSession(conversation, ctx, deps);

    const replies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
    // First reply renders the picker — its reply_markup carries one row per
    // adapter (up to 3 per row + Cancel row).
    const pickerReply = replies[0];
    expect(pickerReply?.[0]).toContain('chọn agent');
    const kb = pickerReply?.[1]?.reply_markup;
    expect(kb).toBeDefined();
    // Flatten rows and check button texts
    const rows = kb.inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    const buttons = rows.flat();
    const adapterButtons = buttons.filter((b) => b.callback_data.startsWith('wizard:new-agent:'));
    expect(adapterButtons.map((b) => b.callback_data)).toEqual([
      'wizard:new-agent:claude',
      'wizard:new-agent:kiro',
      'wizard:new-agent:mock',
    ]);
    expect(adapterButtons[2]?.text).toContain('Mock');
    expect(adapterButtons[2]?.text).toContain('🧪');
  });

  it('P1.1 — picker selects custom adapter and uses its displayName in the project step', async () => {
    const deps = makeDeps();
    deps.registry = makeStubRegistry([{ kind: 'mock', displayName: 'Mock', badge: '🧪' }]);

    const cbQueue = [
      makeCbCtx('wizard:new-agent:mock'),
      makeCbCtx('wizard:new-project:1'),
    ];
    const conversation = makeConversation(cbQueue, ['demo']);
    const ctx = makeEntryCtx();
    await newSession(conversation, ctx, deps);

    expect(deps.manager.createSession).toHaveBeenCalledWith({
      chatId: 42,
      agent: 'mock',
      label: 'demo',
      projectId: 1,
    });
    // Project step reply text should include displayName "Mock"
    const allReplies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
    const projectStepReply = allReplies.find((c) =>
      typeof c[0] === 'string' && c[0].startsWith('Agent: Mock'),
    );
    expect(projectStepReply).toBeTruthy();
  });

  it('P1.1 — empty registry — wizard exits with friendly error (defensive)', async () => {
    const deps = makeDeps();
    // Replace with an empty registry — no adapter has been registered.
    const { AgentRegistry } = await import('../../src/agents/registry.js');
    deps.registry = new AgentRegistry();

    const conversation = makeConversation([], []);
    const ctx = makeEntryCtx();
    await newSession(conversation, ctx, deps);

    const replies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
    const errReply = replies.find((c) =>
      typeof c[0] === 'string' && c[0].includes('Không có agent'),
    );
    expect(errReply).toBeTruthy();
    expect(deps.manager.createSession).not.toHaveBeenCalled();
  });
});
