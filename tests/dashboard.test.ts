import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { ApprovalBroker } from '../src/approval/broker.js';
import {
  DashboardLoop,
  renderDashboard,
  type DashboardEditor,
  type DashboardSnapshot,
} from '../src/bot/dashboard.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';

// ---------------------------------------------------------------------------
// P0.5 — Live status dashboard.
// ---------------------------------------------------------------------------

const CHAT_ID = 8888;

const noopAdapter: AgentAdapter = {
  kind: 'claude',
  async run() {
    /* unused */
  },
};
class FakeRegistry {
  constructor(private a: AgentAdapter) {}
  get(_k: AgentKind): AgentAdapter {
    return this.a;
  }
}

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-dashboard-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

interface Editor extends DashboardEditor {
  edits: string[];
  initial: string | null;
  sendCalls: number;
  editResult: { ok: true } | { ok: false; reason: 'deleted' | 'throttled' | 'error' };
}

function makeEditor(): Editor {
  const ed: Editor = {
    edits: [],
    initial: null,
    sendCalls: 0,
    editResult: { ok: true },
    async sendInitial(text: string) {
      ed.initial = text;
      ed.sendCalls++;
      return 12345;
    },
    async editMessage(text: string) {
      ed.edits.push(text);
      return ed.editResult;
    },
  };
  return ed;
}

describe('renderDashboard', () => {
  it('renders zero-session snapshot with a friendly hint', () => {
    const snap: DashboardSnapshot = {
      sessions: [],
      activeId: null,
      pendingApprovals: 0,
      activeWizards: 0,
      bufferBytes: new Map(),
      lastEventMs: new Map(),
      now: Date.parse('2026-05-21T00:00:00Z'),
    };
    const text = renderDashboard(snap);
    expect(text).toContain('Sessions: 0');
    expect(text).toContain('Pending approvals: 0');
    expect(text).toContain('Active wizards: 0');
    expect(text).toContain('(no sessions');
  });

  it('escapes Markdown meta in labels so trailing italic footer parses correctly', () => {
    // `LABEL_PATTERN` permits `_` in session labels; without escape, a label
    // like `my_session` would pair with the footer's italic `_…_` and break
    // Markdown parse_mode on the live edit. Senior-review [P2] regression.
    const now = Date.parse('2026-05-21T00:00:00Z');
    const snap: DashboardSnapshot = {
      sessions: [
        {
          id: 'a',
          label: 'my_label',
          agent: 'claude',
          project_id: null,
          chat_id: CHAT_ID,
          sdk_session_id: null,
          status: 'idle',
          created_at: now,
          updated_at: now,
          last_message: null,
          transcript_tail: '',
          handoff_context: null,
        },
      ],
      activeId: null,
      pendingApprovals: 0,
      activeWizards: 0,
      bufferBytes: new Map(),
      lastEventMs: new Map(),
      now,
    };
    const text = renderDashboard(snap);
    // The literal label underscore must be escaped (\\_), not bare _.
    expect(text).toContain('my\\_label');
    expect(text).not.toMatch(/[^\\\\]my_label/);
  });

  it('renders active session marker + pending count + buffer size', () => {
    const now = Date.parse('2026-05-21T00:00:00Z');
    const snap: DashboardSnapshot = {
      sessions: [
        {
          id: 'a',
          label: 'foo',
          agent: 'claude',
          project_id: null,
          chat_id: CHAT_ID,
          sdk_session_id: null,
          status: 'running',
          created_at: now,
          updated_at: now,
          last_message: null,
          transcript_tail: '',
          handoff_context: null,
        },
        {
          id: 'b',
          label: 'bar',
          agent: 'kiro',
          project_id: null,
          chat_id: CHAT_ID,
          sdk_session_id: null,
          status: 'idle',
          created_at: now,
          updated_at: now - 5_000,
          last_message: null,
          transcript_tail: '',
          handoff_context: null,
        },
      ],
      activeId: 'a',
      pendingApprovals: 2,
      activeWizards: 1,
      bufferBytes: new Map([['b', 2048]]),
      lastEventMs: new Map(),
      now,
    };
    const text = renderDashboard(snap);
    expect(text).toContain('Pending approvals: 2');
    expect(text).toContain('Active wizards: 1');
    expect(text).toMatch(/●\s+foo/); // active marker on 'foo'
    expect(text).toMatch(/○\s+bar/); // inactive marker on 'bar'
    expect(text).toContain('buf=2.0KB');
  });
});

describe('DashboardLoop', () => {
  let h: { store: SessionStore; cleanup: () => void };
  let manager: SessionManager;
  let broker: ApprovalBroker;
  let editor: Editor;
  let now: number;
  beforeEach(() => {
    h = makeStore();
    manager = new SessionManager(h.store, new FakeRegistry(noopAdapter) as never, {
      bufferCapBytes: 50_000,
    });
    broker = new ApprovalBroker({ timeoutMs: 60_000 });
    editor = makeEditor();
    now = Date.parse('2026-05-21T00:00:00Z');
  });
  afterEach(() => {
    h.cleanup();
  });

  it('start() sends an initial message + arms ticker', async () => {
    const loop = new DashboardLoop({
      store: h.store,
      manager: { hasBuffered: (id) => manager.hasBuffered(id), bufferBytesFor: () => 0 },
      broker: { hasPendingFor: (c, e) => broker.hasPendingFor(c, e), countPendingFor: () => 0 },
      activeWizardsFor: () => 0,
      editor,
      chatId: CHAT_ID,
      intervalMs: 100,
      now: () => now,
    });
    await loop.start();
    expect(editor.sendCalls).toBe(1);
    expect(editor.initial).toContain('Sessions: 0');
    expect(loop.isRunning()).toBe(true);
    await loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it('tick() edits the message with refreshed snapshot', async () => {
    // Seed a session so successive ticks have something to render.
    const s = manager.createSession({
      chatId: CHAT_ID,
      agent: 'claude',
      label: 'A',
      projectId: null,
    });
    void s;
    const loop = new DashboardLoop({
      store: h.store,
      manager: { hasBuffered: (id) => manager.hasBuffered(id), bufferBytesFor: () => 0 },
      broker: { hasPendingFor: (c, e) => broker.hasPendingFor(c, e), countPendingFor: () => 0 },
      activeWizardsFor: () => 0,
      editor,
      chatId: CHAT_ID,
      intervalMs: 100_000, // huge — we drive ticks manually
      now: () => now,
    });
    await loop.start();
    await loop.tick();
    await loop.tick();
    // First send + 2 edits.
    expect(editor.edits.length).toBe(2);
    expect(editor.edits[0]).toContain('Sessions: 1');
    await loop.stop();
  });

  it('stops on editor "deleted" reason', async () => {
    const loop = new DashboardLoop({
      store: h.store,
      manager: { hasBuffered: () => false, bufferBytesFor: () => 0 },
      broker: { hasPendingFor: () => false, countPendingFor: () => 0 },
      activeWizardsFor: () => 0,
      editor,
      chatId: CHAT_ID,
      intervalMs: 100_000,
      now: () => now,
    });
    let stoppedReason: string | null = null;
    await loop.start((r) => {
      stoppedReason = r;
    });
    editor.editResult = { ok: false, reason: 'deleted' };
    await loop.tick();
    expect(stoppedReason).toBe('deleted');
    expect(loop.isRunning()).toBe(false);
  });

  it('stops after idle timeout', async () => {
    const loop = new DashboardLoop({
      store: h.store,
      manager: { hasBuffered: () => false, bufferBytesFor: () => 0 },
      broker: { hasPendingFor: () => false, countPendingFor: () => 0 },
      activeWizardsFor: () => 0,
      editor,
      chatId: CHAT_ID,
      intervalMs: 100_000,
      idleTimeoutMs: 1_000,
      now: () => now,
    });
    let stoppedReason: string | null = null;
    await loop.start((r) => {
      stoppedReason = r;
    });
    // Advance "time" past the idle threshold without markUserActivity().
    now += 2_000;
    await loop.tick();
    expect(stoppedReason).toBe('idle');
  });

  it('markUserActivity resets the idle clock', async () => {
    const loop = new DashboardLoop({
      store: h.store,
      manager: { hasBuffered: () => false, bufferBytesFor: () => 0 },
      broker: { hasPendingFor: () => false, countPendingFor: () => 0 },
      activeWizardsFor: () => 0,
      editor,
      chatId: CHAT_ID,
      intervalMs: 100_000,
      idleTimeoutMs: 1_000,
      now: () => now,
    });
    await loop.start();
    // Almost-idle, then activity, then a tick: should NOT stop.
    now += 900;
    loop.markUserActivity();
    now += 900;
    await loop.tick();
    expect(loop.isRunning()).toBe(true);
    await loop.stop();
  });

  it('throttled edits do not stop the loop', async () => {
    const loop = new DashboardLoop({
      store: h.store,
      manager: { hasBuffered: () => false, bufferBytesFor: () => 0 },
      broker: { hasPendingFor: () => false, countPendingFor: () => 0 },
      activeWizardsFor: () => 0,
      editor,
      chatId: CHAT_ID,
      intervalMs: 100_000,
      now: () => now,
    });
    await loop.start();
    editor.editResult = { ok: false, reason: 'throttled' };
    await loop.tick();
    expect(loop.isRunning()).toBe(true);
    await loop.stop();
  });
});
