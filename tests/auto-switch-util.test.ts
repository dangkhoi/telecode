import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, type SessionRow } from '../src/session/store.js';
import { SessionManager } from '../src/session/manager.js';
import {
  runAutoSwitchForChat,
  type AutoSwitchNotifier,
  type AutoSwitchWizardGuard,
} from '../src/bot/auto-switch.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { AgentKind } from '../src/session/store.js';

const CHAT_ID = 9999;

const noopAdapter: AgentAdapter = {
  kind: 'claude',
  async run() {},
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

function makeNotifier(): AutoSwitchNotifier & { calls: SendCall[] } {
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
  const d = mkdtempSync(join(tmpdir(), 'telecode-asw-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

interface Harness {
  store: SessionStore;
  manager: SessionManager;
  notifier: AutoSwitchNotifier & { calls: SendCall[] };
  cleanup: () => void;
  sessionA: SessionRow;
  sessionB: SessionRow;
}

function setup(): Harness {
  const { store, cleanup } = makeStore();
  const manager = new SessionManager(store, new FakeRegistry(noopAdapter) as never, {
    bufferCapBytes: 50_000,
  });
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
  store.setActiveSession(CHAT_ID, sessionA.id);
  return { store, manager, notifier, cleanup, sessionA, sessionB };
}

describe('runAutoSwitchForChat', () => {
  it('no-op when session already active', async () => {
    const h = setup();
    try {
      await runAutoSwitchForChat({
        chatId: CHAT_ID,
        sessionId: h.sessionA.id,
        sessionLabel: 'A',
        deps: {
          store: h.store,
          manager: h.manager,
          notifierFor: () => h.notifier,
          wizardGuard: { isActive: () => false, deferUntilWizardExits: () => {} },
        },
      });
      // No switch notice, no buffer drain.
      expect(h.notifier.calls).toHaveLength(0);
      expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionA.id);
    } finally {
      h.cleanup();
    }
  });

  it('switches active + drains buffer + sends switch notice', async () => {
    const h = setup();
    try {
      h.manager.appendBuffer(h.sessionB.id, {
        type: 'text',
        data: '[B] hello from background',
        createdAt: Date.now(),
      });
      await runAutoSwitchForChat({
        chatId: CHAT_ID,
        sessionId: h.sessionB.id,
        sessionLabel: 'B',
        deps: {
          store: h.store,
          manager: h.manager,
          notifierFor: () => h.notifier,
          wizardGuard: { isActive: () => false, deferUntilWizardExits: () => {} },
        },
      });
      expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionB.id);
      const catchUp = h.notifier.calls.find((c) => c.text.includes('📥 catch-up'));
      expect(catchUp).toBeDefined();
      expect(catchUp!.extra?.silent).toBe(true);
      const notice = h.notifier.calls.find((c) => c.text.startsWith('🔔 Đã chuyển sang'));
      expect(notice).toBeDefined();
      expect(notice!.text).toContain('B');
      expect(notice!.extra?.silent).toBe(true);
      expect(notice!.extra?.parse_mode).toBe('Markdown');
    } finally {
      h.cleanup();
    }
  });

  it('defers via wizard guard when a wizard is active', async () => {
    const h = setup();
    try {
      let isActiveFlag = true;
      const queued: Array<() => void | Promise<void>> = [];
      const guard: AutoSwitchWizardGuard = {
        isActive: () => isActiveFlag,
        deferUntilWizardExits: (_cid, fn) => {
          queued.push(fn);
        },
      };
      await runAutoSwitchForChat({
        chatId: CHAT_ID,
        sessionId: h.sessionB.id,
        sessionLabel: 'B',
        deps: {
          store: h.store,
          manager: h.manager,
          notifierFor: () => h.notifier,
          wizardGuard: guard,
        },
      });
      // No switch happened yet.
      expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionA.id);
      expect(queued).toHaveLength(1);

      isActiveFlag = false;
      for (const fn of queued) await fn();

      expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionB.id);
      const notice = h.notifier.calls.find((c) => c.text.startsWith('🔔 Đã chuyển sang'));
      expect(notice).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('skip when hasOtherPendingFor returns true (focus stolen)', async () => {
    const h = setup();
    try {
      await runAutoSwitchForChat({
        chatId: CHAT_ID,
        sessionId: h.sessionB.id,
        sessionLabel: 'B',
        deps: {
          store: h.store,
          manager: h.manager,
          notifierFor: () => h.notifier,
          hasOtherPendingFor: () => true,
          wizardGuard: { isActive: () => false, deferUntilWizardExits: () => {} },
        },
      });
      expect(h.store.getChatState(CHAT_ID).active_session_id).toBe(h.sessionA.id);
      expect(h.notifier.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});
