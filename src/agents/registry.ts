import type { AgentAdapter, AgentKind, AdapterMetadata } from './types.js';

/**
 * Factory callable that builds an adapter instance.
 *
 * The factory pattern (not a pre-built instance) is required because some
 * adapters take per-daemon dependencies (broker / policy / store) that are
 * constructed before the registry is wired. See `wireBuiltinAdapters` in
 * `src/agents/index.ts` for the runtime contract.
 *
 * IMPORTANT: factories MUST be synchronous (no async/await). The lazy
 * memoization in {@link AgentRegistry.get} relies on the factory completing
 * before the assignment to `instance`. Node's single-threaded event loop
 * makes the current implementation safe for sync factories, but a future
 * `Promise<AgentAdapter>` factory would race with concurrent `get()` callers
 * and instantiate the adapter multiple times. If async construction becomes
 * necessary later (e.g. SDK that requires network handshake), the registry
 * needs an `inflightPromise` guard alongside `instance`.
 */
export type AdapterFactory = () => AgentAdapter;

/**
 * Registered entry — factory + UI metadata.
 *
 * Metadata is captured at register time so the picker / dashboard can render
 * without paying the cost of instantiating an adapter (the SDK adapter, in
 * particular, allocates significant state).
 */
interface AdapterEntry {
  factory: AdapterFactory;
  metadata: AdapterMetadata;
  /** Memoized instance — lazily constructed on first `get`. */
  instance: AgentAdapter | null;
}

/**
 * Open-set adapter registry (plan P1.1).
 *
 * Old behaviour: closed-set, constructor hardcoded `{ claude, kiro }`. Adding
 * an adapter required edits across 7 files.
 *
 * New behaviour: an empty registry boots empty. `register(kind, factory)`
 * plugs adapters in. Adding a new adapter = 1 file (the adapter) + 1 line in
 * `src/agents/index.ts`. Tests can build registries with stub adapters
 * without dragging the whole DI graph in.
 */
export class AgentRegistry {
  private readonly entries = new Map<AgentKind, AdapterEntry>();

  /**
   * Register an adapter factory. Throws if `kind` is already registered —
   * silently overwriting would mask config bugs (two modules both claiming
   * the same kind).
   */
  register(kind: AgentKind, factory: AdapterFactory, metadata: AdapterMetadata): void {
    if (this.entries.has(kind)) {
      throw new Error(`agent kind '${kind}' is already registered`);
    }
    if (metadata.kind !== kind) {
      throw new Error(
        `metadata.kind ('${metadata.kind}') does not match register kind ('${kind}')`,
      );
    }
    this.entries.set(kind, { factory, metadata, instance: null });
  }

  /**
   * Return a built adapter, instantiating it on first call. Returns
   * `undefined` for unknown kinds (the wizard / config layer surfaces the
   * error with a list of available kinds — they have better context).
   */
  get(kind: AgentKind): AgentAdapter | undefined {
    const e = this.entries.get(kind);
    if (!e) return undefined;
    if (!e.instance) e.instance = e.factory();
    return e.instance;
  }

  /**
   * Strict variant of `get` for code paths that already verified existence
   * (e.g. `dispatch` after wizard validation). Throws with a helpful list
   * if the kind was missed at config-validation time (defence in depth).
   */
  require(kind: AgentKind): AgentAdapter {
    const a = this.get(kind);
    if (!a) {
      const known = this.kinds().join(', ') || '(none)';
      throw new Error(`unknown agent kind '${kind}' — registered: ${known}`);
    }
    return a;
  }

  /** True iff the given kind has been registered. */
  has(kind: AgentKind): boolean {
    return this.entries.has(kind);
  }

  /** Sorted list of registered kinds — stable order for tests and UI. */
  kinds(): AgentKind[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * Metadata for every registered adapter, sorted by `kind` for deterministic
   * picker rendering. Used by `/new` wizard, dashboard, sessions list.
   */
  list(): AdapterMetadata[] {
    return this.kinds().map((k) => this.entries.get(k)!.metadata);
  }
}
