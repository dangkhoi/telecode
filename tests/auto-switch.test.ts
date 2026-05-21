import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InlineKeyboard } from 'grammy';
import { SessionStore, type SessionRow } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import { ApprovalBroker } from '../src/approval/broker.js';
import {
  createApprovalPrompter,
  type ApprovalPrompterNotifier,
} from '../src/bot/router.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';

// ---------------------------------------------------------------------------
// Phase B3 — router.ts auto-switch + session strip + buffer flush
//
// We exercise `createApprovalPrompter` directly (factored out of `startBot`)
// against:
//   - a real SessionStore (sqlite tmpdir)
//   - a real SessionManager (with the per-session output buffer)
//   - a real ApprovalBroker (so `hasPendingFor` reflects actual state)
//   - a mock notifier that records every sendPlain call
//
// This way the assertion targets are the same code path used at runtime in
// `startBot`, minus the grammY Bot transport.
// ---------------------------------------------------------------------------

const CHAT_ID = 4242;

// Minimal AgentAdapter — the prompter never dispatches; SessionManager just
// needs *something* registered when sessions are created.
const noopAdapter: AgentAdapter = {
  kind: 'claude',
  async run() {
    /* unused */
  },
};

class FakeRegistry {
  constructor(private adapter: AgentAdapter) {}
  get(_k: AgentKind): AgentAdapter {
    return this.adapter;
  }
}

interface SendCall {
  text: string;
  extra: Record<string, unknown> | undefined;
}

interface MockNotifier extends ApprovalPrompterNotifier {
  calls: SendCall[];
}

function makeNotifier(): MockNotifier {
  const calls: SendCall[] = [];
  return {
    calls,
    async sendPlain(text, extra) {
      calls.push({ text, extra: extra as Record<string, unknown> | undefined });
      return 1;
    },
  };
}

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-autoswitch-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

interface Harness {
  store: SessionStore;
  manager: SessionManager;
  broker: ApprovalBroker;
  notifier: MockNotifier;
  cleanup: () => void;
  sessionA: SessionRow;
  sessionB: SessionRow;
  sessionC: SessionRow;
}

function setup(): Harness {
  const { store, cleanup } = makeStore();
  const manager = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
    bufferCapBytes: 50_000,
  });
  // Long timeout — we never want tests to wait on auto-deny.
  const broker = new ApprovalBroker({ timeoutMs: 60_000 });
  const notifier = makeNotifier();
  const sessionA = manager.createSession({
    chatId: CHAT_ID,
    agent: 'claude',
    label: 'A',
    projectId: null,
  });
  const sessionB = manager.createSession({
    chatId: CHAT_ID,
    agent: 'claude',
    label: 'B',
    projectId: null,
  });
  const sessionC = manager.createSession({
    chatId: CHAT_ID,
    agent: 'kiro',
    label: 'C',
    projectId: null,
  });
  // Initial state: A is active.
  store.setActiveSession(CHAT_ID, sessionA.id);

  const prompter = createApprovalPrompter({
    store,
    manager,
    broker,
    notifierFor: () => notifier,
  });
  broker.attach(prompter);

  return { store, manager, broker, notifier, cleanup, sessionA, sessionB, sessionC };
}

function inlineButtons(extra: Record<string, unknown> | undefined): string[][] {
  const rm = extra?.reply_markup as InlineKeyboard | undefined;
  if (!rm) return [];
  return rm.inline_keyboard.map((row) => row.map((b) => b.text));
}

// ---------------------------------------------------------------------------

describe('router B3 — approval auto-switch + session strip + buffer flush', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.cleanup();
  });

  it('auto-switches active session to the requesting (background) session', async () => {
    // Active = A. Approval arrives for B (background).
    expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionA.id);

    const p = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'B',
    });

    // Let the prompter (async) run.
    await new Promise((r) => setImmediate(r));

    expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionB.id);

    // Resolve so the pending promise settles cleanly.
    const req = h.broker.pendingForSession(h.sessionB.id)[0]!;
    h.broker.resolve(req.id, 'allow_once');
    await expect(p).resolves.toBe('allow_once');
  });

  it('sends a "switched to" notice + the approval prompt itself', async () => {
    const p = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'B',
    });
    await new Promise((r) => setImmediate(r));

    // Find the switch notice + the approval prompt among the recorded calls.
    const switchNotice = h.notifier.calls.find((c) =>
      c.text.startsWith('🔔 Đã chuyển sang'),
    );
    expect(switchNotice, 'switch notice missing').toBeDefined();
    // Switch notice must be silent (R3 — UX: user is about to get a loud
    // approval ping next, no need to double-notify). The prompter calls
    // sendPlain with `{ silent: true }`; the real Notifier maps that to
    // disable_notification before hitting bot.api. We assert on the
    // Notifier-level vocabulary here.
    expect(switchNotice!.extra?.silent).toBe(true);

    const approvalCall = h.notifier.calls.find((c) =>
      c.text.startsWith('🛡 *Approval needed*'),
    );
    expect(approvalCall, 'approval prompt missing').toBeDefined();
    expect(approvalCall!.text).toContain('Session: `B`');
    expect(approvalCall!.text).toContain('Tool: `Bash`');
    // Approval prompt is NOT silent — this is the loud one.
    expect(approvalCall!.extra?.silent).toBeUndefined();
    expect(approvalCall!.extra?.disable_notification).toBeUndefined();
    expect(approvalCall!.extra?.parse_mode).toBe('Markdown');

    h.broker.resolve(h.broker.pendingForSession(h.sessionB.id)[0]!.id, 'allow_once');
    await p;
  });

  it('reply_markup combines approval buttons + session strip', async () => {
    const p = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'B',
    });
    await new Promise((r) => setImmediate(r));

    const approvalCall = h.notifier.calls.find((c) =>
      c.text.startsWith('🛡 *Approval needed*'),
    )!;
    const rows = inlineButtons(approvalCall.extra);

    // Row 0: Allow once + Allow always
    expect(rows[0]).toEqual(['✅ Allow once', '🌟 Allow always']);
    // Row 1: Forever + Deny (P0.4 added the Forever button).
    expect(rows[1]).toEqual(['📌 Forever', '🚫 Deny']);
    // Row 2: session strip with active marker on B.
    // Sessions are ordered newest-first by updated_at; after createSession
    // the order is C, B, A (C created last).
    const stripLabels = rows[2]!;
    expect(stripLabels).toContain('● B');
    // Both A and C appear without the active marker.
    expect(stripLabels).toContain('A');
    expect(stripLabels).toContain('C');
    // Row 3: trailing [+ New session] (no pagination — only 3 sessions).
    expect(rows[3]).toEqual(['➕ New session']);

    h.broker.resolve(h.broker.pendingForSession(h.sessionB.id)[0]!.id, 'allow_once');
    await p;
  });

  it('flushes the incoming session buffer as a silent catch-up before the prompt', async () => {
    // Background session B has accumulated output while A was active.
    h.manager.appendBuffer(h.sessionB.id, {
      type: 'text',
      data: '[B] running tests…',
      createdAt: Date.now(),
    });
    h.manager.appendBuffer(h.sessionB.id, {
      type: 'tool_use',
      data: '[B] 🔧 Bash: npm test',
      createdAt: Date.now(),
    });

    const p = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      inputPreview: 'rm -rf /',
      sessionLabel: 'B',
    });
    await new Promise((r) => setImmediate(r));

    const catchUp = h.notifier.calls.find((c) => c.text.includes('📥 catch-up'));
    expect(catchUp, 'catch-up message missing').toBeDefined();
    expect(catchUp!.text).toContain('[B] 📥 catch-up (2 events from background):');
    expect(catchUp!.text).toContain('[B] running tests…');
    expect(catchUp!.text).toContain('[B] 🔧 Bash: npm test');
    // Catch-up is silent — it's a context dump, not a notify-worthy event.
    // (See note on Notifier `silent` vocabulary in the switch-notice test.)
    expect(catchUp!.extra?.silent).toBe(true);
    // Buffer is drained.
    expect(h.manager.hasBuffered(h.sessionB.id)).toBe(false);

    h.broker.resolve(h.broker.pendingForSession(h.sessionB.id)[0]!.id, 'allow_once');
    await p;
  });

  it('skips catch-up when the buffer is empty (no spam)', async () => {
    // B has no buffered output.
    const p = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'B',
    });
    await new Promise((r) => setImmediate(r));

    const catchUp = h.notifier.calls.find((c) => c.text.includes('📥 catch-up'));
    expect(catchUp).toBeUndefined();

    h.broker.resolve(h.broker.pendingForSession(h.sessionB.id)[0]!.id, 'allow_once');
    await p;
  });

  it('does NOT switch when the requesting session is already active', async () => {
    // A is already active; approval for A should not change active, not send
    // a switch notice, and not drain (A has no buffer anyway).
    const p = h.broker.ask({
      sessionId: h.sessionA.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'A',
    });
    await new Promise((r) => setImmediate(r));

    expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionA.id);
    expect(
      h.notifier.calls.find((c) => c.text.startsWith('🔔 Đã chuyển sang')),
    ).toBeUndefined();

    h.broker.resolve(h.broker.pendingForSession(h.sessionA.id)[0]!.id, 'allow_once');
    await p;
  });

  it('multi-approval thrashing: second pending approval does NOT steal active focus', async () => {
    // 1) Approval for B → auto-switch (A was active).
    const pB = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'B',
    });
    await new Promise((r) => setImmediate(r));
    expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionB.id);

    // Snapshot how many notifier calls happened so we can isolate C's effect.
    const callsBeforeC = h.notifier.calls.length;

    // 2) While B is still pending, approval for C arrives → must NOT switch.
    const pC = h.broker.ask({
      sessionId: h.sessionC.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'pwd' },
      inputPreview: 'pwd',
      sessionLabel: 'C',
    });
    await new Promise((r) => setImmediate(r));

    // Active session stays at B.
    expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionB.id);

    // C produces an approval prompt but NO switch notice.
    const cCalls = h.notifier.calls.slice(callsBeforeC);
    const cSwitchNotice = cCalls.find((c) =>
      c.text.startsWith('🔔 Đã chuyển sang'),
    );
    expect(cSwitchNotice, 'should not announce a switch when C was gated').toBeUndefined();
    const cApproval = cCalls.find((c) => c.text.startsWith('🛡 *Approval needed*'));
    expect(cApproval, 'C still gets its approval prompt').toBeDefined();
    expect(cApproval!.text).toContain('Session: `C`');

    // Clean up both pendings.
    h.broker.resolve(h.broker.pendingForSession(h.sessionB.id)[0]!.id, 'allow_once');
    h.broker.resolve(h.broker.pendingForSession(h.sessionC.id)[0]!.id, 'allow_once');
    await Promise.all([pB, pC]);
  });

  it('recordApproval is still called even after refactor', async () => {
    const spy = vi.spyOn(h.store, 'recordApproval');
    const p = h.broker.ask({
      sessionId: h.sessionB.id,
      chatId: CHAT_ID,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'B',
    });
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledTimes(1);
    h.broker.resolve(h.broker.pendingForSession(h.sessionB.id)[0]!.id, 'allow_once');
    await p;
  });

  // -------------------------------------------------------------------------
  // P0.6 — wizard-aware auto-switch.
  //
  // When a conversations-plugin wizard is mid-flow, auto-switch must NOT
  // change the active session (it would hijack the wizard's text input
  // step). Instead the switch is queued and fires once the wizard exits.
  // -------------------------------------------------------------------------
  describe('P0.6 wizard-aware auto-switch', () => {
    it('defers auto-switch while a wizard is active for the chat', async () => {
      const { store, manager, broker, notifier, sessionA, sessionB } = setup();
      let isActiveFlag = true;
      const queued: Array<() => void | Promise<void>> = [];
      const prompter = createApprovalPrompter({
        store,
        manager,
        broker,
        notifierFor: () => notifier,
        wizardGuard: {
          isActive: () => isActiveFlag,
          deferUntilWizardExits: (_cid, fn) => {
            queued.push(fn);
          },
        },
      });
      broker.attach(prompter);

      const p = broker.ask({
        sessionId: sessionB.id,
        chatId: CHAT_ID,
        toolName: 'Bash',
        input: { command: 'ls' },
        inputPreview: 'ls',
        sessionLabel: 'B',
      });
      await new Promise((r) => setImmediate(r));

      // Wizard is active → no switch yet; one callback queued.
      expect(store.getChatState(CHAT_ID).active_session_id).toBe(sessionA.id);
      expect(queued).toHaveLength(1);
      // Switch notice should NOT have been sent yet.
      const switchNotice = notifier.calls.find((c) =>
        c.text.startsWith('🔔 Đã chuyển sang'),
      );
      expect(switchNotice).toBeUndefined();

      // Simulate wizard exit: flush the queue.
      isActiveFlag = false;
      for (const fn of queued) await fn();

      expect(store.getChatState(CHAT_ID).active_session_id).toBe(sessionB.id);
      const switchNoticeAfter = notifier.calls.find((c) =>
        c.text.startsWith('🔔 Đã chuyển sang'),
      );
      expect(switchNoticeAfter).toBeDefined();

      broker.resolve(broker.pendingForSession(sessionB.id)[0]!.id, 'allow_once');
      await p;
    });

    it('does not defer when no wizard is active', async () => {
      const { store, manager, broker, notifier, sessionA, sessionB } = setup();
      void sessionA;
      const queued: Array<() => void | Promise<void>> = [];
      const prompter = createApprovalPrompter({
        store,
        manager,
        broker,
        notifierFor: () => notifier,
        wizardGuard: {
          isActive: () => false,
          deferUntilWizardExits: (_cid, fn) => {
            queued.push(fn);
          },
        },
      });
      broker.attach(prompter);

      const p = broker.ask({
        sessionId: sessionB.id,
        chatId: CHAT_ID,
        toolName: 'Bash',
        input: { command: 'ls' },
        inputPreview: 'ls',
        sessionLabel: 'B',
      });
      await new Promise((r) => setImmediate(r));
      expect(queued).toHaveLength(0);
      expect(store.getChatState(CHAT_ID).active_session_id).toBe(sessionB.id);

      broker.resolve(broker.pendingForSession(sessionB.id)[0]!.id, 'allow_once');
      await p;
    });

    it('queued switch re-checks pending-for: another session may have taken focus while wizard was open', async () => {
      const { store, manager, broker, notifier, sessionA, sessionB, sessionC } = setup();
      let isActiveFlag = true;
      const queued: Array<() => void | Promise<void>> = [];
      const prompter = createApprovalPrompter({
        store,
        manager,
        broker,
        notifierFor: () => notifier,
        wizardGuard: {
          isActive: () => isActiveFlag,
          deferUntilWizardExits: (_cid, fn) => {
            queued.push(fn);
          },
        },
      });
      broker.attach(prompter);

      // Request approval for B while wizard active → queued.
      const pB = broker.ask({
        sessionId: sessionB.id,
        chatId: CHAT_ID,
        toolName: 'Bash',
        input: { command: 'ls' },
        inputPreview: 'ls',
        sessionLabel: 'B',
      });
      await new Promise((r) => setImmediate(r));
      expect(queued).toHaveLength(1);
      void sessionA;

      // Meanwhile user manually flips active to C.
      store.setActiveSession(CHAT_ID, sessionC.id);

      // Now wizard exits — the queued switch must NOT override C.
      isActiveFlag = false;
      for (const fn of queued) await fn();
      // Because B has a pending approval AND its own session is not the
      // exclusion target now, hasPendingFor returns true → switch skipped.
      expect(store.getChatState(CHAT_ID).active_session_id).toBe(sessionC.id);

      broker.resolve(broker.pendingForSession(sessionB.id)[0]!.id, 'allow_once');
      await pB;
    });
  });
});
