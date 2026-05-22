/**
 * Agent identifier.
 *
 * v1.0 plan P1.1 changed this from a closed literal union
 * (`'claude' | 'kiro'`) to an open `string` so new adapters can be plugged in
 * via {@link AgentRegistry.register} without touching this file. Validation is
 * deferred to runtime: anything not registered in the {@link AgentRegistry} is
 * rejected by config loading / wizard / session creation.
 *
 * Existing callers that branched on `kind === 'claude' | 'kiro'` continue to
 * compile because string literal types narrow to `string`. New adapters should
 * pick a short stable identifier (lower-case, ascii, no spaces).
 */
export type AgentKind = string;

export type AgentEvent =
  | { type: 'text'; text: string; final?: boolean }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; ok: boolean; preview?: string }
  | { type: 'session'; sdkSessionId: string }
  | { type: 'status'; status: string }
  | { type: 'error'; error: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; contextWindow?: number; model?: string }
  | { type: 'done'; durationMs?: number; totalCostUsd?: number; result?: string };

export interface AgentStartOpts {
  sessionId: string;
  sessionLabel: string;
  chatId: number;
  cwd: string;
  resumeId?: string | null;
  initialPrompt: string;
  onEvent: (e: AgentEvent) => void;
  abortSignal: AbortSignal;
  model?: string | null;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  run(opts: AgentStartOpts): Promise<void>;
}

/**
 * UI / picker metadata exposed by each adapter. Consumed by the wizard
 * (`/new` agent picker), the session-list renderer, and any other surface
 * that needs to render agent-kind-specific affordances dynamically.
 *
 * Adding a new adapter no longer requires touching the wizard or the
 * reply-builders — just export the metadata next to the adapter and register
 * it via `src/agents/index.ts`.
 */
export interface AdapterMetadata {
  /** Stable identifier — must match `AgentAdapter.kind`. */
  kind: AgentKind;
  /** Human-friendly name shown in pickers (e.g. `Claude`, `Kiro`). */
  displayName: string;
  /**
   * Short emoji / symbol used as a row marker in session lists, dashboards,
   * approval prompts. One- or two-grapheme strings only — long text will
   * push tabular alignment out.
   */
  badge: string;
  /** Optional one-line description rendered in the picker secondary row. */
  description?: string;
}
