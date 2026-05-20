export type AgentKind = 'claude' | 'kiro';

export type AgentEvent =
  | { type: 'text'; text: string; final?: boolean }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; ok: boolean; preview?: string }
  | { type: 'session'; sdkSessionId: string }
  | { type: 'status'; status: string }
  | { type: 'error'; error: string }
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
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  run(opts: AgentStartOpts): Promise<void>;
}
