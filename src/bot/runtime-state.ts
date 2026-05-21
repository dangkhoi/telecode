/**
 * Phase C integration — process-wide runtime state for the dispatch surface.
 *
 * Phase C (smart rendering) introduced two helpers that need to be shared
 * across multiple call sites:
 *
 *   - {@link ToolCollapseManager} — collapses bursts of identical tool_use
 *     events into a single edited message. Lives ABOVE the per-dispatch
 *     scope because a single user prompt produces a single `manager.dispatch`
 *     call, but the session-close callback (`router.ts`) must call
 *     {@link ToolCollapseManager.clearSession} on close — that handler has
 *     no access to dispatch-scoped state. A process-wide singleton sidesteps
 *     the threading problem.
 *
 *   - `diffCache` (re-exported from `./diff-cache.js`) — already a process
 *     singleton there; mentioned here so the integration surface has ONE
 *     well-known import for "phase C runtime state."
 *
 * Why a separate module instead of attaching to {@link CommandDeps}?
 *
 *   - Per-chat scoping happens via the `sessionId` KEY embedded in entries,
 *     not by instantiation. A second `Notifier` per chat does not need a
 *     second `ToolCollapseManager`.
 *   - The router's session-close handler (`session:close:<id>`) lives in
 *     `router.ts` and has no `CommandDeps` reference. Threading deps just to
 *     reach `clearSession` is over-engineering.
 *   - Tests can construct a fresh `ToolCollapseManager` directly OR call
 *     {@link _resetRuntimeState} between cases for a clean slate.
 */
import { ToolCollapseManager } from './tool-collapse.js';
import { ProgressManager, type ProgressApi, type ModeResolver } from './progress.js';

/**
 * Process-wide collapse manager. Constructed eagerly so the first dispatch
 * turn doesn't pay a stutter for the first `setInterval` registration.
 *
 * Live-binding `let` so {@link _resetRuntimeState} can replace the instance
 * cleanly (`.stop()` the old timer, allocate a fresh one). ES modules
 * propagate the new binding to all importers automatically.
 */
export let toolCollapseMgr: ToolCollapseManager = new ToolCollapseManager();

/**
 * Phase E — process-wide progress manager. Lazily initialized via
 * {@link initProgressManager} on daemon boot, since it needs the live
 * bot.api + mode-resolver dependencies. Before init the binding stays
 * `null` and dispatch must guard accordingly (the integration wiring
 * does — see `commands/index.ts`).
 *
 * Why a singleton: the router's `session:close:<id>` handler must call
 * `clear(sessionId)` and has no dispatch-scoped state to thread it through.
 * Same rationale as {@link toolCollapseMgr} above.
 */
export let progressMgr: ProgressManager | null = null;

/**
 * Initialize the progress manager singleton. Called once during boot from
 * {@link startBot} (router.ts) after the grammY `Bot` is constructed.
 * Idempotent — repeated calls replace the instance (the old one's idle
 * timers get garbage-collected once nothing references it; we explicitly
 * dispose to be safe). Tests reset via {@link _resetRuntimeState}.
 */
export function initProgressManager(opts: {
  api: ProgressApi;
  modeResolver: ModeResolver;
}): ProgressManager {
  if (progressMgr) progressMgr.dispose();
  progressMgr = new ProgressManager(opts);
  return progressMgr;
}

/**
 * Reset the singleton. Used by integration tests that need a clean slate
 * between cases — without this, collapse entries from prior tests leak
 * across test files and break burst assertions.
 *
 * Tests should call this in `beforeEach`/`afterEach` of suites that touch
 * the collapse pipeline. Production code does NOT call it.
 */
export function _resetRuntimeState(): void {
  toolCollapseMgr.stop();
  toolCollapseMgr = new ToolCollapseManager();
  if (progressMgr) {
    progressMgr.dispose();
    progressMgr = null;
  }
}
