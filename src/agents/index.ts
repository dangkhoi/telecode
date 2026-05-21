/**
 * Built-in adapter registration (plan P1.1).
 *
 * This file is the single source of truth for which adapters ship with
 * Telecode. To add a new adapter:
 *
 *   1. Create `src/agents/<kind>.ts` exporting an `AgentAdapter` class and an
 *      `AdapterMetadata` const (e.g. `codexMetadata`).
 *   2. Add ONE line below: `wire('<kind>', <kindMetadata>, () => new <Kind>Adapter(deps.<kind>));`
 *   3. Extend `BuiltinAdapterDeps` with the per-adapter options bag.
 *
 * That's it — no other file in the codebase needs to be touched. The wizard
 * picker reads from `registry.list()`, dashboards / reply-builders read
 * `registry.get(kind)?.metadata` via the registry, and the config layer
 * validates kinds against `registry.has(kind)`.
 */
import type { AgentRegistry } from './registry.js';
import { ClaudeAdapter, claudeMetadata, type ClaudeAdapterOpts } from './claude.js';
import { KiroAdapter, kiroMetadata, type KiroAdapterOpts } from './kiro.js';
import { CodexAdapter, codexMetadata, type CodexAdapterOpts } from './codex.js';
import { CursorAdapter, cursorMetadata, type CursorAdapterOpts } from './cursor.js';

/**
 * Per-adapter dependency bags. Each key here corresponds to one registered
 * adapter; the keys MUST match the `kind` passed to `registry.register`.
 *
 * Keeping this as `Partial<...>` lets tests wire only the adapters they need
 * (e.g. registering just `claude` for a Claude-only test environment).
 */
export interface BuiltinAdapterDeps {
  claude?: ClaudeAdapterOpts;
  kiro?: KiroAdapterOpts;
  codex?: CodexAdapterOpts;
  cursor?: CursorAdapterOpts;
}

/**
 * Register every built-in adapter whose dependency bag is present in `deps`.
 * Returns the same registry (for fluent wiring in `index.ts`).
 *
 * Behaviour:
 *   - `deps.claude` present → register `'claude'`.
 *   - `deps.kiro` present   → register `'kiro'`.
 *   - missing key           → adapter is NOT registered (no throw).
 *
 * The factory is invoked lazily by `registry.get()` so allocating expensive
 * SDK state is deferred until the first session of that kind runs.
 */
export function registerBuiltinAdapters(
  registry: AgentRegistry,
  deps: BuiltinAdapterDeps,
): AgentRegistry {
  if (deps.claude) {
    const opts = deps.claude;
    registry.register('claude', () => new ClaudeAdapter(opts), claudeMetadata);
  }
  if (deps.kiro) {
    const opts = deps.kiro;
    registry.register('kiro', () => new KiroAdapter(opts), kiroMetadata);
  }
  if (deps.codex) {
    const opts = deps.codex;
    registry.register('codex', () => new CodexAdapter(opts), codexMetadata);
  }
  if (deps.cursor) {
    const opts = deps.cursor;
    registry.register('cursor', () => new CursorAdapter(opts), cursorMetadata);
  }
  return registry;
}

// Re-export the metadata so callers (tests, dashboards) can import a single
// canonical source per adapter.
export { claudeMetadata, kiroMetadata, codexMetadata, cursorMetadata };
