/**
 * Regression — Claude adapter doubled `done` event bug.
 *
 * The Claude Agent SDK emits a synthetic `result` message at the end of each
 * turn (carries duration / cost / final text). The adapter forwards that as a
 * `done` AgentEvent inside `handleMessage`. v0.4 ALSO unconditionally fired a
 * second `done` after the for-await loop exited — every turn produced TWO
 * `done` events.
 *
 * Downstream impact: `bot/commands/index.ts` listens for `done` to trigger the
 * auto-done summarize call (mode = summary / normal). With doubled `done`, the
 * summarize agent ran TWICE per turn — 2× token cost + 6–15s extra latency +
 * the second `editPlain` flickered over the first in Telegram.
 *
 * Fix: track whether the `result` message already emitted `done`; only fire
 * the fallback when the iterator exits WITHOUT a result message (abort
 * mid-stream / unexpected SDK behaviour).
 *
 * This test stubs the SDK's `query` to drive specific message sequences and
 * asserts the count of `done` events forwarded to `onEvent`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level holders for the SDK message stream. Each test sets this to
// the iterable they want the adapter to consume.
let scriptedMessages: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const items = scriptedMessages;
    return (async function* () {
      for (const m of items) {
        yield m;
      }
    })();
  },
}));

import { ClaudeAdapter } from '../src/agents/claude.js';
import type { AgentEvent } from '../src/agents/types.js';

function makeAdapter(): ClaudeAdapter {
  const policy = {
    decide: vi.fn().mockReturnValue({ decision: 'allow', matched: 'Read' }),
    appendAllow: vi.fn(),
  };
  const store = { logTool: vi.fn(), updateSession: vi.fn() };
  const broker = { ask: vi.fn() };
  const askBroker = { askQuestion: vi.fn() };
  return new ClaudeAdapter({
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
}

async function runAdapter(): Promise<AgentEvent[]> {
  const adapter = makeAdapter();
  const events: AgentEvent[] = [];
  const ac = new AbortController();
  await adapter.run({
    sessionId: 'sess-done-dedup',
    sessionLabel: 'L',
    chatId: 1,
    cwd: '/tmp',
    initialPrompt: 'go',
    onEvent: (e) => events.push(e),
    abortSignal: ac.signal,
  });
  return events;
}

describe('Claude adapter — done-event dedup (regression for doubled summarize)', () => {
  beforeEach(() => {
    scriptedMessages = [];
  });

  it('emits exactly ONE done event when SDK delivers a result message', async () => {
    // Typical happy-path: SDK emits assistant text(s), then a result message
    // (subtype + duration + cost + final text). The adapter must forward
    // exactly one `done` event, not two.
    scriptedMessages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        duration_ms: 1234,
        total_cost_usd: 0.0042,
        result: 'final text',
      },
    ];

    const events = await runAdapter();
    const doneCount = events.filter((e) => e.type === 'done').length;
    expect(doneCount).toBe(1);

    // And the surviving `done` carries the result metadata — the LOOP-EXIT
    // fallback (which has no metadata) must NOT win the race.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    expect(
      done && done.type === 'done' ? done.durationMs : undefined,
    ).toBe(1234);
    expect(
      done && done.type === 'done' ? done.totalCostUsd : undefined,
    ).toBe(0.0042);
    expect(
      done && done.type === 'done' ? done.result : undefined,
    ).toBe('final text');
  });

  it('still emits a fallback done if the SDK iterator ends WITHOUT a result message', async () => {
    // Edge case: SDK iterator returns early (network blip / abort recovery /
    // future SDK quirk) without ever sending the `result` message. The
    // adapter must still emit `done` so downstream listeners (auto-done
    // summarize, progress finalize) don't hang waiting forever.
    scriptedMessages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      },
      // no result message
    ];

    const events = await runAdapter();
    const doneCount = events.filter((e) => e.type === 'done').length;
    expect(doneCount).toBe(1);

    // Fallback done has no metadata (we don't fabricate duration/cost).
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.durationMs : undefined).toBeUndefined();
    expect(done && done.type === 'done' ? done.totalCostUsd : undefined).toBeUndefined();
  });

  it('emits exactly ONE done across multiple result messages in same stream', async () => {
    // Defensive: even if SDK ever bug-emits two result messages in one
    // stream, the loop-exit fallback should NOT add a third.
    scriptedMessages = [
      { type: 'result', subtype: 'success', duration_ms: 100, result: 'a' },
      { type: 'result', subtype: 'success', duration_ms: 200, result: 'b' },
    ];

    const events = await runAdapter();
    const doneCount = events.filter((e) => e.type === 'done').length;
    // Two result messages → two dones (we don't dedup the SDK's own bugs),
    // but the loop-exit fallback must NOT add a third.
    expect(doneCount).toBe(2);
  });
});
