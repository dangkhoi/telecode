/**
 * v1.4 — AskUserQuestion routing in the Claude adapter.
 *
 * Verifies the special-case branch at the top of `canUseTool`:
 *   - bypasses PolicyEngine + ApprovalBroker (R7)
 *   - suspends on AskQuestionBroker until user answers
 *   - returns `{ behavior: 'allow', updatedInput: { questions, answers } }` shape
 *   - logs audit trail via store.logTool with decision `user_allow:<summary>`
 *   - handles deny (cancel / timeout) gracefully
 *   - rejects empty questions array
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the canUseTool function the adapter passes to the SDK so we can
// invoke it directly without spinning a real Claude session.
let capturedCanUseTool: ((toolName: string, input: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal }) => Promise<unknown>) | null = null;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: { canUseTool: typeof capturedCanUseTool } }) => {
    capturedCanUseTool = args.options.canUseTool;
    return (async function* () {
      // emit nothing; adapter exits cleanly.
    })();
  },
}));

import { ClaudeAdapter } from '../src/agents/claude.js';
import { AskQuestionBroker } from '../src/approval/ask-broker.js';
import type { AgentEvent } from '../src/agents/types.js';

interface Harness {
  adapter: ClaudeAdapter;
  askBroker: AskQuestionBroker;
  logToolCalls: Array<{
    session_id: string;
    tool_name: string;
    input_preview: string | null;
    decision: string | null;
    duration_ms: number | null;
  }>;
}

function makeHarness(): Harness {
  const policy = {
    decide: vi.fn().mockReturnValue({ decision: 'allow', matched: 'X' }),
    appendAllow: vi.fn(),
  };
  const logToolCalls: Harness['logToolCalls'] = [];
  const store = {
    logTool: vi.fn((row: Harness['logToolCalls'][number]) => {
      logToolCalls.push(row);
    }),
    updateSession: vi.fn(),
  };
  const broker = { ask: vi.fn() };
  const askBroker = new AskQuestionBroker({ timeoutMs: 60_000 });
  // Attach a dummy prompter so askQuestion doesn't auto-deny.
  askBroker.attach({ prompt: async () => undefined });

  const adapter = new ClaudeAdapter({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    broker: broker as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    policy: policy as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: store as any,
    settingSources: [],
    askBroker,
  });
  return { adapter, askBroker, logToolCalls };
}

async function bootAdapter(h: Harness): Promise<void> {
  const ac = new AbortController();
  const events: AgentEvent[] = [];
  // run() is short-circuited by our mocked query (empty stream); it captures
  // canUseTool and returns. Allow microtasks to settle.
  await h.adapter.run({
    sessionId: 'sess-1',
    sessionLabel: 'lab',
    chatId: 42,
    cwd: '/tmp',
    initialPrompt: 'go',
    onEvent: (e) => events.push(e),
    abortSignal: ac.signal,
  });
}

beforeEach(() => {
  capturedCanUseTool = null;
});

describe('Claude adapter — AskUserQuestion routing', () => {
  it('routes AskUserQuestion through AskQuestionBroker and returns SDK shape', async () => {
    const h = makeHarness();
    await bootAdapter(h);
    expect(capturedCanUseTool).not.toBeNull();
    const cut = capturedCanUseTool!;

    const input = {
      questions: [
        {
          question: 'Which DB?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'PostgreSQL', description: 'battle-tested' },
            { label: 'MySQL' },
          ],
        },
      ],
    };

    const ac = new AbortController();
    const p = cut('AskUserQuestion', input as Record<string, unknown>, {
      toolUseID: 'tu-xyz',
      signal: ac.signal,
    });

    // Wait until pending entry exists, then submit answer.
    await new Promise((r) => setImmediate(r));
    expect(h.askBroker.getPending('tu-xyz')).toBeDefined();
    const r = h.askBroker.submitAnswer('tu-xyz', 'Which DB?', 'PostgreSQL');
    expect(r.ok).toBe(true);

    const result = await p;
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            question: 'Which DB?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'PostgreSQL', description: 'battle-tested' },
              { label: 'MySQL' },
            ],
          },
        ],
        answers: { 'Which DB?': 'PostgreSQL' },
      },
    });

    // Audit log.
    const logRow = h.logToolCalls.find((c) => c.tool_name === 'AskUserQuestion');
    expect(logRow).toBeDefined();
    expect(logRow!.decision).toMatch(/^user_allow:PostgreSQL/);
  });

  it('multi-question batch resolves with all answers', async () => {
    const h = makeHarness();
    await bootAdapter(h);
    const cut = capturedCanUseTool!;
    const input = {
      questions: [
        {
          question: 'Pick A?',
          multiSelect: false,
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
        {
          question: 'Pick B?',
          multiSelect: true,
          options: [{ label: 'One' }, { label: 'Two' }],
        },
      ],
    };
    const ac = new AbortController();
    const p = cut('AskUserQuestion', input as Record<string, unknown>, {
      toolUseID: 'tu-multi',
      signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    h.askBroker.submitAnswer('tu-multi', 'Pick A?', 'Beta');
    h.askBroker.submitAnswer('tu-multi', 'Pick B?', ['One', 'Two']);

    const result = (await p) as {
      behavior: string;
      updatedInput: { answers: Record<string, string> };
    };
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toEqual({
      'Pick A?': 'Beta',
      'Pick B?': 'One, Two',
    });
  });

  it('cancel resolves as deny "user cancelled"', async () => {
    const h = makeHarness();
    await bootAdapter(h);
    const cut = capturedCanUseTool!;
    const input = {
      questions: [
        {
          question: 'q?',
          multiSelect: false,
          options: [{ label: 'a' }],
        },
      ],
    };
    const ac = new AbortController();
    const p = cut('AskUserQuestion', input as Record<string, unknown>, {
      toolUseID: 'tu-cancel',
      signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    h.askBroker.cancel('tu-cancel');
    const result = await p;
    expect(result).toEqual({ behavior: 'deny', message: 'user cancelled' });
    const logRow = h.logToolCalls.find((c) => c.tool_name === 'AskUserQuestion');
    expect(logRow!.decision).toBe('user_deny:user cancelled');
  });

  it('denies empty questions array', async () => {
    const h = makeHarness();
    await bootAdapter(h);
    const cut = capturedCanUseTool!;
    const input = { questions: [] };
    const ac = new AbortController();
    const result = await cut('AskUserQuestion', input as Record<string, unknown>, {
      toolUseID: 'tu-empty',
      signal: ac.signal,
    });
    expect(result).toEqual({
      behavior: 'deny',
      message: 'AskUserQuestion: empty questions array',
    });
    const logRow = h.logToolCalls.find((c) => c.tool_name === 'AskUserQuestion');
    expect(logRow!.decision).toBe('user_deny:empty questions array');
  });

  it('does NOT call PolicyEngine.decide for AskUserQuestion', async () => {
    const h = makeHarness();
    // Re-grab the spied policy
    const policy = (h.adapter as unknown as { opts: { policy: { decide: ReturnType<typeof vi.fn> } } }).opts.policy;
    await bootAdapter(h);
    const cut = capturedCanUseTool!;
    const input = {
      questions: [
        {
          question: 'q?',
          multiSelect: false,
          options: [{ label: 'a' }],
        },
      ],
    };
    const ac = new AbortController();
    const p = cut('AskUserQuestion', input as Record<string, unknown>, {
      toolUseID: 'tu-bypass',
      signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    h.askBroker.submitAnswer('tu-bypass', 'q?', 'a');
    await p;
    expect(policy.decide).not.toHaveBeenCalled();
  });

  it('OTHER tools still go through PolicyEngine (no regression)', async () => {
    const h = makeHarness();
    const policy = (h.adapter as unknown as { opts: { policy: { decide: ReturnType<typeof vi.fn> } } }).opts.policy;
    await bootAdapter(h);
    const cut = capturedCanUseTool!;
    const ac = new AbortController();
    const result = await cut('Read', { file_path: '/x' }, {
      toolUseID: 'tu-other',
      signal: ac.signal,
    });
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/x' },
    });
    expect(policy.decide).toHaveBeenCalledWith('Read', { file_path: '/x' }, expect.any(Object));
  });
});
