import { describe, it, expect, beforeEach } from 'vitest';
import {
  wizardState,
  enterWizard,
  exitWizard,
  isWizardActive,
  deferUntilWizardExits,
} from '../src/bot/wizard-state.js';

// ---------------------------------------------------------------------------
// P0.6 — Wizard-aware auto-switch.
//
// Verifies the shared registry tracks active wizards per chat and defers
// queued callbacks until `exit` fires. Ensures the API contract callers
// (router.ts, createApprovalPrompter) rely on.
// ---------------------------------------------------------------------------

describe('wizardState registry', () => {
  beforeEach(() => {
    wizardState.reset();
  });

  it('isWizardActive returns false by default and true after enter()', () => {
    expect(isWizardActive(1)).toBe(false);
    enterWizard(1);
    expect(isWizardActive(1)).toBe(true);
  });

  it('exit() clears active state', async () => {
    enterWizard(1);
    expect(isWizardActive(1)).toBe(true);
    await exitWizard(1);
    expect(isWizardActive(1)).toBe(false);
  });

  it('deferUntilWizardExits runs immediately when no wizard is active', async () => {
    let ran = false;
    deferUntilWizardExits(2, () => {
      ran = true;
    });
    // Synchronous-looking but it's a microtask; wait it out.
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(true);
  });

  it('deferUntilWizardExits queues callback while wizard is active, fires on exit', async () => {
    enterWizard(3);
    let fired = false;
    deferUntilWizardExits(3, () => {
      fired = true;
    });
    expect(fired).toBe(false);
    expect(wizardState.pendingCount(3)).toBe(1);
    await exitWizard(3);
    expect(fired).toBe(true);
    expect(wizardState.pendingCount(3)).toBe(0);
  });

  it('queue runs deferred callbacks in FIFO order', async () => {
    enterWizard(4);
    const seen: number[] = [];
    deferUntilWizardExits(4, () => {
      seen.push(1);
    });
    deferUntilWizardExits(4, () => {
      seen.push(2);
    });
    deferUntilWizardExits(4, () => {
      seen.push(3);
    });
    await exitWizard(4);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('errors in one deferred callback do not strand the rest', async () => {
    enterWizard(5);
    let ran = false;
    deferUntilWizardExits(5, () => {
      throw new Error('boom');
    });
    deferUntilWizardExits(5, () => {
      ran = true;
    });
    await exitWizard(5);
    expect(ran).toBe(true);
  });

  it('different chats are isolated', async () => {
    enterWizard(10);
    enterWizard(20);
    let a = false;
    let b = false;
    deferUntilWizardExits(10, () => {
      a = true;
    });
    deferUntilWizardExits(20, () => {
      b = true;
    });
    await exitWizard(10);
    expect(a).toBe(true);
    expect(b).toBe(false);
    await exitWizard(20);
    expect(b).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Post-conversations reconciliation middleware behaviour (router.ts).
//
// Regression guard for the senior-review [P0] finding: @grammyjs/conversations
// 2.x `onExit` is only fired on explicit `halt()` / `conversation.exit()` calls
// — NOT on normal `return` or thrown error. The router therefore relies on a
// reconciliation middleware that inspects `ctx.conversation.active()` AFTER
// every update is processed.
//
// We mirror the router's middleware body here as a small closure so we can
// drive it with synthetic `active()` snapshots and verify the state transitions
// without booting grammY.
// ---------------------------------------------------------------------------

describe('wizard-state reconciliation middleware', () => {
  beforeEach(() => {
    wizardState.reset();
  });

  async function runMw(
    chatId: number | undefined,
    activeFn: () => Record<string, number>,
    next: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    // Body mirrors router.ts post-conversations middleware. Kept in sync — see
    // `bot.use(async (ctx, next) => { ... })` block following the
    // `conversations(...)` install in router.ts.
    await next();
    if (typeof chatId !== 'number') return;
    const active = activeFn();
    const anyActive = Object.values(active).some((n) => n > 0);
    if (anyActive) {
      if (!isWizardActive(chatId)) enterWizard(chatId);
    } else if (isWizardActive(chatId)) {
      await exitWizard(chatId);
    }
  }

  it('marks the chat active when a conversation starts mid-update', async () => {
    // Before the update: nothing running. During next(): the wizard was
    // entered. After next(): active() reports it.
    await runMw(99, () => ({ newSession: 1 }));
    expect(isWizardActive(99)).toBe(true);
  });

  it('clears the chat when the conversation finishes via normal return', async () => {
    // Seed: wizard is active. The update completes the wizard (active() now
    // empty). Reconciliation must clear the singleton — fixes the [P0] leak
    // because `onExit` does not fire on normal return.
    enterWizard(77);
    expect(isWizardActive(77)).toBe(true);
    await runMw(77, () => ({}));
    expect(isWizardActive(77)).toBe(false);
  });

  it('no-ops when there is no chat id (channel posts, edited messages)', async () => {
    await runMw(undefined, () => ({ newSession: 1 }));
    // Singleton untouched.
    expect(isWizardActive(0)).toBe(false);
  });

  it('idempotent across consecutive ticks (no thrash)', async () => {
    // Two consecutive updates with the wizard active — second one must not
    // re-enter (which would be a no-op but is still wrong from a logging POV).
    await runMw(33, () => ({ newSession: 1 }));
    expect(isWizardActive(33)).toBe(true);
    expect(wizardState.pendingCount(33)).toBe(0);
    await runMw(33, () => ({ newSession: 1 }));
    expect(isWizardActive(33)).toBe(true);
  });

  it('fires deferred callbacks when the wizard exits via reconciliation', async () => {
    enterWizard(55);
    let fired = false;
    deferUntilWizardExits(55, () => {
      fired = true;
    });
    expect(fired).toBe(false);
    // Wizard returns normally → active() shows empty → exit fires deferred.
    await runMw(55, () => ({}));
    expect(fired).toBe(true);
    expect(isWizardActive(55)).toBe(false);
  });
});
