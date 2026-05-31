/**
 * Phase A.1 — Claude tool_use duplicate bug fix.
 *
 * v1.0 emitted `tool_use` from BOTH `canUseTool` (the policy gate) AND the
 * `PreToolUse` hook → every tool announce duplicated in Telegram.
 *
 * The fix removes the emit from `canUseTool`. This test stubs the Claude
 * Agent SDK's `query` to simulate the SDK invoking BOTH callbacks for one
 * tool call, then asserts the AgentAdapter forwards exactly ONE tool_use
 * event to its onEvent sink.
 *
 * We mock `@anthropic-ai/claude-agent-sdk` rather than instantiate the real
 * SDK — the production behaviour we care about is the bridging logic inside
 * the adapter, not the SDK's protocol. Stubbing is the only way to deliver
 * a precise canUseTool + PreToolUse sequence on demand.
 */
import { describe, it, expect, vi } from 'vitest';

// Capture the canUseTool + hooks the adapter registers so we can re-invoke
// them from the stubbed `query` async-iterable. Plain module-scoped vars are
// fine because vitest spawns isolated workers per test file.
let capturedCanUseTool:
  | ((tool: string, input: unknown, opts: unknown) => Promise<unknown>)
  | null = null;
let capturedPreToolUseHook:
  | ((event: unknown) => Promise<unknown>)
  | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: {
    options: {
      canUseTool: (t: string, i: unknown, o: unknown) => Promise<unknown>;
      hooks: { PreToolUse?: Array<{ hooks: Array<(e: unknown) => Promise<unknown>> }> };
    };
  }) => {
    capturedCanUseTool = opts.options.canUseTool;
    const matcher = opts.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    capturedPreToolUseHook = matcher ?? null;
    // Empty async iterable — adapter loop body doesn't execute (we only care
    // about the callback registrations, not message forwarding).
    return (async function* () {
      // yield nothing → for-await loop exits → adapter emits its final `done`.
    })();
  },
}));

import { ClaudeAdapter } from '../src/agents/claude.js';
import type { AgentEvent } from '../src/agents/types.js';

describe('Phase A.1 — Claude tool_use de-dup', () => {
  it('emits exactly one tool_use when both canUseTool (allow) and PreToolUse fire', async () => {
    // Minimal stubs — adapter only touches `decide`, `logTool`, `updateSession`.
    const policy = {
      decide: vi.fn().mockReturnValue({ decision: 'allow', matched: 'Read' }),
      appendAllow: vi.fn(),
    };
    const store = {
      logTool: vi.fn(),
      updateSession: vi.fn(),
    };
    const broker = { ask: vi.fn() };
    const askBroker = { askQuestion: vi.fn() };

    const adapter = new ClaudeAdapter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      broker: broker as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      policy: policy as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      settingSources: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      askBroker: askBroker as any,
    });

    const events: AgentEvent[] = [];
    const ac = new AbortController();
    await adapter.run({
      sessionId: 'sess-1',
      sessionLabel: 'L',
      chatId: 1,
      cwd: '/tmp',
      initialPrompt: 'go',
      onEvent: (e) => events.push(e),
      abortSignal: ac.signal,
    });

    // canUseTool + PreToolUse hook should both have been wired.
    expect(capturedCanUseTool).toBeTruthy();
    expect(capturedPreToolUseHook).toBeTruthy();

    // Simulate SDK calling BOTH callbacks for one tool invocation.
    const before = events.filter((e) => e.type === 'tool_use').length;
    await capturedCanUseTool!('Read', { file_path: '/tmp/x' }, {});
    await capturedPreToolUseHook!({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });

    const toolUseAfter = events.filter((e) => e.type === 'tool_use');
    // Exactly ONE new tool_use surfaced (PreToolUse hook). canUseTool no
    // longer emits — verified by counting from `before`.
    expect(toolUseAfter.length - before).toBe(1);

    // Policy gate side effects still fire — we asserted dedup, not regression.
    expect(policy.decide).toHaveBeenCalledTimes(1);
    expect(store.logTool).toHaveBeenCalledTimes(1);
  });
});
