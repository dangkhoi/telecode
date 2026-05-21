/**
 * Cross-component flag tracking which chats currently have an active
 * conversations-plugin wizard (e.g. `/new`). Lives outside `ctx` so any
 * caller — including async callbacks dispatched from outside grammY's
 * middleware chain (notably `ApprovalBroker.ask` → `createApprovalPrompter`) —
 * can consult it.
 *
 * Wired into the conversations plugin's `onEnter` / `onExit` hooks in
 * `router.ts`. When a wizard enters, the chat id is added to the set; when
 * it exits (or aborts), the chat id is removed and any deferred callback
 * for that chat fires.
 *
 * Auto-switch behavior (plan P0.6): the approval prompter checks
 * `isWizardActive(chatId)` before auto-switching the active session. If a
 * wizard is mid-flow we'd otherwise hijack its text input (label step).
 * Instead, we defer the switch via `deferUntilWizardExits` and let `onExit`
 * fire it once the wizard finishes/cancels.
 */

type DeferredFn = () => void | Promise<void>;

class WizardActiveRegistry {
  private readonly active = new Set<number>();
  private readonly deferred = new Map<number, DeferredFn[]>();

  /** Mark `chatId` as having an active wizard. Idempotent. */
  enter(chatId: number): void {
    this.active.add(chatId);
  }

  /**
   * Clear the active-wizard flag for `chatId` and fire every queued deferred
   * callback (FIFO). Each callback is awaited sequentially so handlers can
   * rely on store/manager state having stabilized before the next one runs.
   * Errors from a single callback are swallowed (logged by caller) so one
   * bad handler doesn't strand the rest.
   */
  async exit(chatId: number): Promise<void> {
    this.active.delete(chatId);
    const queue = this.deferred.get(chatId);
    if (!queue) return;
    this.deferred.delete(chatId);
    for (const fn of queue) {
      try {
        await fn();
      } catch {
        // Caller responsible for logging — registry must not throw.
      }
    }
  }

  /** True iff a wizard is currently mid-flow for this chat. */
  isActive(chatId: number): boolean {
    return this.active.has(chatId);
  }

  /**
   * Queue `fn` to run when the chat's wizard exits. If no wizard is active
   * for `chatId`, runs `fn` synchronously (caller awaits the promise).
   */
  deferUntilWizardExits(chatId: number, fn: DeferredFn): void {
    if (!this.active.has(chatId)) {
      // Fire-and-forget; caller can't easily await an unknown-future schedule.
      void fn();
      return;
    }
    let list = this.deferred.get(chatId);
    if (!list) {
      list = [];
      this.deferred.set(chatId, list);
    }
    list.push(fn);
  }

  /** Test-only: clear all state. */
  reset(): void {
    this.active.clear();
    this.deferred.clear();
  }

  /** Test-only: count of queued deferreds for a chat. */
  pendingCount(chatId: number): number {
    return this.deferred.get(chatId)?.length ?? 0;
  }
}

/** Singleton registry — see class doc for rationale. */
export const wizardState = new WizardActiveRegistry();

/** Convenience exports for callers that prefer functions over the singleton. */
export const enterWizard = (chatId: number): void => wizardState.enter(chatId);
export const exitWizard = (chatId: number): Promise<void> => wizardState.exit(chatId);
export const isWizardActive = (chatId: number): boolean => wizardState.isActive(chatId);
export const deferUntilWizardExits = (chatId: number, fn: DeferredFn): void =>
  wizardState.deferUntilWizardExits(chatId, fn);
