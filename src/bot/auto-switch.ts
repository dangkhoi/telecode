import type { SessionStore } from '../session/store.js';
import type { SessionManager } from '../session/manager.js';
import { splitCatchUp } from './reply-builders.js';
import { logger } from '../util/logger.js';
import { isWizardActive, deferUntilWizardExits } from './wizard-state.js';

/**
 * Subset of {@link import('./notifier.js').Notifier} used by the auto-switch
 * helper. Declared structurally so callers can pass either the real Notifier
 * or a mock in tests.
 */
export interface AutoSwitchNotifier {
  sendPlain(
    text: string,
    extra?: Record<string, unknown> & { silent?: boolean },
  ): Promise<number | null>;
}

export interface AutoSwitchWizardGuard {
  isActive(chatId: number): boolean;
  deferUntilWizardExits(chatId: number, fn: () => void | Promise<void>): void;
}

export interface AutoSwitchDeps {
  store: Pick<SessionStore, 'getChatState' | 'setActiveSession'>;
  manager: Pick<SessionManager, 'hasBuffered' | 'drainBuffer'>;
  notifierFor: (chatId: number) => AutoSwitchNotifier;
  /**
   * Hook used to skip the switch when ANOTHER pending request has stolen
   * first-come-first-active focus. Mirrors `broker.hasPendingFor` from the
   * approval flow; for AskUserQuestion the caller may pass a no-op (askBroker
   * doesn't itself track focus competition — only one ask at a time per
   * session is realistic given the SDK's serial tool gate).
   */
  hasOtherPendingFor?(chatId: number, excludeSessionId: string): boolean;
  /** Optional override for tests; defaults to the wizardState singleton. */
  wizardGuard?: AutoSwitchWizardGuard;
}

export interface AutoSwitchArgs {
  chatId: number;
  sessionId: string;
  sessionLabel: string;
  deps: AutoSwitchDeps;
}

/**
 * Auto-switch the chat's active session to `sessionId` (when it's not
 * already active), draining its background buffer as a silent catch-up and
 * sending a silent "switched to" notice.
 *
 * Behavior preserved from `createApprovalPrompter.runAutoSwitch` (router.ts):
 *   1. Skip when the session is already active.
 *   2. Skip when another session in the same chat has a competing pending
 *      request (first-come-first-active).
 *   3. When a wizard is mid-flow for this chat, defer until it exits. On
 *      deferred fire, re-check that the user hasn't manually flipped the
 *      active session in the meantime; if they did, respect their choice.
 *   4. Drain any buffered events from background mode as a silent catch-up.
 *   5. Send a silent "🔔 Đã chuyển sang …" notice.
 *
 * Pure-async; no Telegram-specific imports beyond grammY-shaped Markdown opts.
 * Reused by both the approval prompter and the ask prompter so the UX of a
 * background session yanking focus is consistent.
 */
export async function runAutoSwitchForChat(args: AutoSwitchArgs): Promise<void> {
  const { chatId, sessionId, sessionLabel, deps } = args;
  const guard: AutoSwitchWizardGuard = deps.wizardGuard ?? {
    isActive: isWizardActive,
    deferUntilWizardExits,
  };

  const curActive = deps.store.getChatState(chatId).active_session_id;
  if (curActive === sessionId) return;

  // First-come-first-active: only auto-switch if no OTHER session in this
  // chat has a competing pending request. `hasOtherPendingFor` is optional;
  // when omitted, treat the path as clear (askBroker has no competition map).
  if (deps.hasOtherPendingFor?.(chatId, sessionId)) return;

  // Wizard guard: if a wizard owns the chat's text input, defer the switch
  // so we don't hijack the wizard step.
  if (guard.isActive(chatId)) {
    const activeAtDeferral = curActive;
    logger.info(
      { sessionId, chatId },
      'auto-switch deferred — wizard active',
    );
    guard.deferUntilWizardExits(chatId, () =>
      performSwitch({
        chatId,
        sessionId,
        sessionLabel,
        deps,
        expectedActive: activeAtDeferral,
      }),
    );
    return;
  }

  await performSwitch({
    chatId,
    sessionId,
    sessionLabel,
    deps,
    expectedActive: curActive,
  });
}

interface PerformSwitchArgs {
  chatId: number;
  sessionId: string;
  sessionLabel: string;
  deps: AutoSwitchDeps;
  expectedActive: string | null;
}

async function performSwitch(args: PerformSwitchArgs): Promise<void> {
  const { chatId, sessionId, sessionLabel, deps, expectedActive } = args;
  const n = deps.notifierFor(chatId);
  const curActive = deps.store.getChatState(chatId).active_session_id;
  if (curActive === sessionId) return;
  // User manually switched mid-defer — respect their choice.
  if (curActive !== expectedActive) {
    logger.info(
      { sessionId, chatId, curActive, expectedActive },
      'deferred auto-switch skipped — user changed active session manually',
    );
    return;
  }
  if (deps.hasOtherPendingFor?.(chatId, sessionId)) return;

  deps.store.setActiveSession(chatId, sessionId);

  if (deps.manager.hasBuffered(sessionId)) {
    const events = deps.manager.drainBuffer(sessionId);
    const lines = events.map((e) => e.data);
    const header = `[${sessionLabel}] 📥 catch-up (${events.length} events from background):`;
    const contHeader = `[${sessionLabel}] 📥 catch-up (cont.):`;
    const parts = splitCatchUp(header, contHeader, lines);
    for (const part of parts) {
      await n.sendPlain(part, { silent: true });
    }
  }

  await n.sendPlain(
    `🔔 Đã chuyển sang \`${sessionLabel}\` vì cần approval.`,
    { parse_mode: 'Markdown', silent: true },
  );
}
