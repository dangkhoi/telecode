import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CursorAdapter,
  _internals,
  type CursorTransport,
  type JsonRpcMessage,
} from '../src/agents/cursor.js';
import { ApprovalBroker, type ApprovalDecision } from '../src/approval/broker.js';
import type { AgentEvent, AgentStartOpts } from '../src/agents/types.js';

// ---------------------------------------------------------------------------
// Plan P4 — Cursor adapter (ACP — Agent Client Protocol)
//
// We exercise the adapter end-to-end via a fake `CursorTransport`. The fake
// captures outgoing JSON-RPC messages so we can assert protocol compliance,
// and lets the test drive inbound notifications + server-initiated requests
// (permission flow). No real `cursor-agent` binary is spawned.
// ---------------------------------------------------------------------------

class FakeTransport implements CursorTransport {
  readonly sent: JsonRpcMessage[] = [];
  private msgListeners: Array<(m: JsonRpcMessage) => void> = [];
  private stderrListeners: Array<(s: string) => void> = [];
  private exitListeners: Array<(c: number | null, s: NodeJS.Signals | null) => void> = [];
  closed = false;
  killed = false;
  exited = false;

  /** Optional auto-responder — runs against every outbound request and may inject responses/notifications. */
  autoResponder?: (msg: JsonRpcMessage, self: FakeTransport) => void;

  async send(msg: JsonRpcMessage): Promise<void> {
    this.sent.push(msg);
    if (this.autoResponder) this.autoResponder(msg, this);
  }
  onMessage(fn: (m: JsonRpcMessage) => void): void {
    this.msgListeners.push(fn);
  }
  onStderr(fn: (s: string) => void): void {
    this.stderrListeners.push(fn);
  }
  onExit(fn: (c: number | null, s: NodeJS.Signals | null) => void): void {
    if (this.exited) fn(0, null);
    else this.exitListeners.push(fn);
  }
  async close(timeoutMs: number): Promise<void> {
    this.closed = true;
    if (!this.exited) {
      // Simulate graceful shutdown — exit naturally before timeout.
      await new Promise<void>((r) => setTimeout(r, Math.min(5, timeoutMs)));
      this.emitExit(0, null);
    }
  }
  kill(): void {
    this.killed = true;
    if (!this.exited) this.emitExit(null, 'SIGKILL');
  }

  /** Test helper: deliver an inbound JSON-RPC message synchronously. */
  emit(m: JsonRpcMessage): void {
    for (const fn of [...this.msgListeners]) fn(m);
  }
  /** Test helper: emit stderr text. */
  emitStderr(s: string): void {
    for (const fn of [...this.stderrListeners]) fn(s);
  }
  /** Test helper: emit child exit. */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const fn of [...this.exitListeners]) fn(code, signal);
  }
}

function makeBroker(decision: ApprovalDecision = 'allow_once'): ApprovalBroker {
  const broker = new ApprovalBroker({ timeoutMs: 500 });
  broker.attach({
    async prompt(req) {
      // Immediately resolve with the configured decision.
      setTimeout(() => broker.resolve(req.id, decision), 1);
    },
  });
  return broker;
}

function makeStart(events: AgentEvent[], cwd = '/tmp/cursor-test'): AgentStartOpts {
  const ac = new AbortController();
  return {
    sessionId: 'sess-cursor-1',
    sessionLabel: 'demo',
    chatId: 100,
    cwd,
    resumeId: null,
    initialPrompt: 'hello cursor',
    onEvent: (e) => events.push(e),
    abortSignal: ac.signal,
  };
}

/**
 * Drive a "happy path" through the adapter:
 *   1. respond to initialize → session/new → session/prompt
 *   2. defer responses via queueMicrotask so the adapter can register pending
 *      callbacks before the response lands.
 */
function happyPathResponder(opts?: { sessionId?: string; stopReason?: string }): (
  m: JsonRpcMessage,
  t: FakeTransport,
) => void {
  const sid = opts?.sessionId ?? 'sess_test_1';
  const stop = opts?.stopReason ?? 'end_turn';
  return (msg, t) => {
    if (!msg.method) return;
    if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
      queueMicrotask(() =>
        t.emit({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
        }),
      );
    } else if (msg.method === 'session/new' && typeof msg.id !== 'undefined') {
      queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } }));
    } else if (msg.method === 'session/prompt' && typeof msg.id !== 'undefined') {
      // The prompt response is what closes the turn — schedule a slight delay
      // so tests can inject session/update notifications mid-turn first.
      setTimeout(() => {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: stop } });
      }, 10);
    }
  };
}

describe('CursorAdapter — lifecycle (plan P4.2)', () => {
  let broker: ApprovalBroker;
  let transport: FakeTransport;
  beforeEach(() => {
    broker = makeBroker();
    transport = new FakeTransport();
  });
  afterEach(() => {
    if (!transport.exited) transport.emitExit(0, null);
  });

  it('initializes → session/new → session/prompt → completes with stopReason', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });

    const run = adapter.run(makeStart(events));
    // Drive notifications: text deltas while prompt is in-flight.
    await new Promise((r) => setTimeout(r, 5));
    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
      },
    });
    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      },
    });
    await run;

    // Protocol assertions.
    const methods = transport.sent.map((m) => m.method);
    expect(methods).toContain('initialize');
    expect(methods).toContain('session/new');
    expect(methods).toContain('session/prompt');

    const init = transport.sent.find((m) => m.method === 'initialize');
    expect(init?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'telecode', version: '1.0' },
    });

    const sessionNew = transport.sent.find((m) => m.method === 'session/new');
    expect(sessionNew?.params).toMatchObject({
      cwd: '/tmp/cursor-test',
      mcpServers: [],
    });

    const promptMsg = transport.sent.find((m) => m.method === 'session/prompt');
    expect(promptMsg?.params).toMatchObject({
      sessionId: 'sess_test_1',
      prompt: [{ type: 'text', text: 'hello cursor' }],
    });

    // Event assertions.
    expect(events.find((e) => e.type === 'status' && e.status === 'cursor_spawning')).toBeTruthy();
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('Hello world');
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    expect((done as { result?: string }).result).toBe('end_turn');
  });

  it('routes session/request_permission through ApprovalBroker → allow-once optionId', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker, // default allow_once
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    // Server emits a permission request — adapter must respond by id.
    const permId = 999;
    transport.emit({
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_test_1',
        toolCall: { toolCallId: 'call_1', title: 'Shell(rm -rf /tmp/foo)', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });

    // Allow broker to settle.
    await new Promise((r) => setTimeout(r, 30));
    await run;

    const reply = transport.sent.find((m) => m.id === permId && !m.method);
    expect(reply).toBeDefined();
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('allow_always decision maps to optionId=allow-always', async () => {
    transport.autoResponder = happyPathResponder();
    broker = makeBroker('allow_always');
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: { sessionId: 'sess_test_1', toolCall: { title: 'Write(./foo.txt)' }, options: [] },
    });
    await new Promise((r) => setTimeout(r, 30));
    await run;

    const reply = transport.sent.find((m) => m.id === 42 && !m.method);
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
  });

  it('deny decision maps to optionId=deny', async () => {
    transport.autoResponder = happyPathResponder();
    broker = makeBroker('deny');
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emit({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: { sessionId: 'sess_test_1', toolCall: { title: 'Shell(rm)' }, options: [] },
    });
    await new Promise((r) => setTimeout(r, 30));
    await run;

    const reply = transport.sent.find((m) => m.id === 7 && !m.method);
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
  });

  it('streams agent_message_chunk text into text_delta events in order', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    for (const t of ['Once ', 'upon ', 'a ', 'time']) {
      transport.emit({
        method: 'session/update',
        params: {
          sessionId: 'sess_test_1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } },
        },
      });
    }
    await run;

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('Once upon a time');
  });

  it('emits tool_use on tool_call session/update', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: {
          sessionUpdate: 'tool_call',
          title: 'Shell(ls)',
          kind: 'execute',
          rawInput: { command: 'ls -la' },
        },
      },
    });
    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: {
          sessionUpdate: 'tool_call_update',
          title: 'Shell(ls)',
          status: 'completed',
          content: [{ type: 'content', content: { text: 'file1\nfile2\n' } }],
        },
      },
    });
    await run;

    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect((toolUse as { tool: string }).tool).toBe('Shell(ls)');
    const toolRes = events.find((e) => e.type === 'tool_result');
    expect(toolRes).toBeTruthy();
    expect((toolRes as { ok: boolean }).ok).toBe(true);
    expect((toolRes as { preview?: string }).preview).toMatch(/file1/);
  });

  it('emits tool_result ok=false on tool_call_update status=failed', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));
    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: { sessionUpdate: 'tool_call', title: 'Shell(rm /etc/passwd)', kind: 'execute' },
      },
    });
    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: {
          sessionUpdate: 'tool_call_update',
          title: 'Shell(rm /etc/passwd)',
          status: 'failed',
        },
      },
    });
    await run;

    const toolRes = events.find((e) => e.type === 'tool_result');
    expect(toolRes).toBeTruthy();
    expect((toolRes as { ok: boolean }).ok).toBe(false);
  });

  it('surfaces Vietnamese auth hint when session/new returns "not authenticated"', async () => {
    const events: AgentEvent[] = [];
    transport.autoResponder = (msg, t) => {
      if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
        queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
      } else if (msg.method === 'session/new' && typeof msg.id !== 'undefined') {
        queueMicrotask(() =>
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'not authenticated — please run cursor-agent login' },
          }),
        );
      }
    };
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    await adapter.run(makeStart(events));

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    const errStr = (errEvent as { error: string }).error;
    expect(errStr).toMatch(/Cursor CLI chưa login/);
    expect(errStr).toMatch(/cursor-agent login/);
  });

  it('surfaces spawn-failure error when transport factory throws', async () => {
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => {
        throw new Error('ENOENT cursor-agent');
      },
    });
    await adapter.run(makeStart(events));
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { error: string }).error).toMatch(/spawn failed/);
  });

  it('aborts gracefully — sends session/cancel notification and closes transport', async () => {
    transport.autoResponder = happyPathResponder({ stopReason: 'cancelled' });
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const startOpts: AgentStartOpts = {
      sessionId: 'sess-cursor-abort',
      sessionLabel: 'demo',
      chatId: 100,
      cwd: '/tmp/cursor-test',
      resumeId: null,
      initialPrompt: 'hi',
      onEvent: (e) => events.push(e),
      abortSignal: ac.signal,
    };
    const run = adapter.run(startOpts);
    // Wait until session/new has resolved and we're "in prompt".
    await new Promise((r) => setTimeout(r, 5));

    ac.abort(new Error('user_stop'));
    await new Promise((r) => setTimeout(r, 30));
    if (!transport.exited) transport.emitExit(0, null);
    await run;

    const cancel = transport.sent.find((m) => m.method === 'session/cancel');
    expect(cancel).toBeTruthy();
    expect(cancel?.params).toMatchObject({ sessionId: 'sess_test_1' });
    expect(transport.closed).toBe(true);
  });

  it('force-kills transport when child does not exit within close timeout', async () => {
    class StubbornTransport extends FakeTransport {
      override async close(timeoutMs: number): Promise<void> {
        this.closed = true;
        // Don't emitExit on its own — wait beyond the caller's timeout.
        await new Promise<void>((r) => setTimeout(r, timeoutMs + 10));
        this.emitExit(null, 'SIGKILL');
      }
    }
    const stubborn = new StubbornTransport();
    stubborn.autoResponder = happyPathResponder();

    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => stubborn,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));
    await run;

    expect(stubborn.closed).toBe(true);
    expect(stubborn.exited).toBe(true);
  });

  it('surfaces JSON-RPC error in session/prompt response as an error event', async () => {
    const events: AgentEvent[] = [];
    transport.autoResponder = (msg, t) => {
      if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
        queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
      } else if (msg.method === 'session/new' && typeof msg.id !== 'undefined') {
        queueMicrotask(() =>
          t.emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_x' } }),
        );
      } else if (msg.method === 'session/prompt' && typeof msg.id !== 'undefined') {
        queueMicrotask(() =>
          t.emit({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: 'sandbox denied' },
          }),
        );
      }
    };
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    await adapter.run(makeStart(events));

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { error: string }).error).toMatch(/sandbox denied/);
  });

  it('reports non-zero exit code as error when not aborted', async () => {
    transport.autoResponder = (msg, t) => {
      // Stall everything — never respond, the child will "crash" instead.
      if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
        queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: {} }));
      }
    };
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emitStderr('panic: cursor-agent crashed\n');
    transport.emitExit(101, null);
    await run;

    const errEvent = events.find(
      (e) => e.type === 'error' && /exited with code 101/.test((e as { error: string }).error),
    );
    expect(errEvent).toBeTruthy();
  });

  it('surfaces auth error when stderr matches "login required"', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emitStderr('Error: login required. Run `cursor-agent login` first.\n');
    await run;

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { error: string }).error).toMatch(/cursor-agent login/i);
  });

  it('handles agent_thought_chunk as text events too', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emit({
      method: 'session/update',
      params: {
        sessionId: 'sess_test_1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'reasoning step 1' },
        },
      },
    });
    await run;

    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toContain('reasoning step 1');
  });

  it('ignores plan and unknown sessionUpdate variants without crashing', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CursorAdapter({
      command: 'cursor-agent',
      model: 'auto',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 5));

    transport.emit({
      method: 'session/update',
      params: { sessionId: 'sess_test_1', update: { sessionUpdate: 'plan' } },
    });
    transport.emit({
      method: 'session/update',
      params: { sessionId: 'sess_test_1', update: { sessionUpdate: 'galaxy_brained_event' } },
    });
    await run;

    // Should still complete cleanly.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    // Plan event surfaces as a status (so UI can render a panel) but no errors.
    const planStatus = events.find(
      (e) => e.type === 'status' && (e as { status: string }).status === 'cursor_plan_update',
    );
    expect(planStatus).toBeTruthy();
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toEqual([]);
  });
});

describe('CursorAdapter — message queue ordering (plan P4 backpressure)', () => {
  it('runs handlers sequentially even when an await blocks mid-message', async () => {
    const { MessageQueue } = _internals as {
      MessageQueue: new (h: (m: JsonRpcMessage) => Promise<void>) => {
        push(m: JsonRpcMessage): void;
      };
    };
    const order: string[] = [];
    let release = (): void => {};
    const blocker = new Promise<void>((r) => (release = r));
    const q = new MessageQueue(async (m: JsonRpcMessage) => {
      order.push(`start:${m.method}`);
      if (m.method === 'a') await blocker;
      order.push(`end:${m.method}`);
    });
    q.push({ method: 'a' });
    q.push({ method: 'b' });
    q.push({ method: 'c' });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['start:a']);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });
});

describe('CursorAdapter — registry metadata (plan P4.4)', () => {
  it('exports valid AdapterMetadata that registers cleanly', async () => {
    const { cursorMetadata, CursorAdapter: Adapter } = await import('../src/agents/cursor.js');
    expect(cursorMetadata.kind).toBe('cursor');
    expect(cursorMetadata.displayName).toBe('Cursor');
    expect(cursorMetadata.badge).toBe('✦');
    expect(cursorMetadata.badge.length).toBeLessThanOrEqual(2);
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    expect(() => new Adapter({ command: 'cursor-agent', model: 'auto', broker })).not.toThrow();
  });

  it('AUTH_ERR_RE matches common Cursor auth-failure phrasings', () => {
    const { AUTH_ERR_RE } = _internals as { AUTH_ERR_RE: RegExp };
    expect(AUTH_ERR_RE.test('Error: unauthenticated')).toBe(true);
    expect(AUTH_ERR_RE.test('not authenticated — please run cursor-agent login')).toBe(true);
    expect(AUTH_ERR_RE.test('please run cursor-agent login first')).toBe(true);
    expect(AUTH_ERR_RE.test('login required')).toBe(true);
    expect(AUTH_ERR_RE.test('Sign-in required')).toBe(true);
    expect(AUTH_ERR_RE.test('no auth token found')).toBe(true);
    expect(AUTH_ERR_RE.test('random unrelated panic')).toBe(false);
  });

  it('decisionToOptionId maps every ApprovalDecision deterministically', () => {
    const { decisionToOptionId } = _internals as {
      decisionToOptionId: (d: ApprovalDecision) => string;
    };
    expect(decisionToOptionId('allow_once')).toBe('allow-once');
    expect(decisionToOptionId('allow_always')).toBe('allow-always');
    expect(decisionToOptionId('deny')).toBe('deny');
    expect(decisionToOptionId('timeout')).toBe('deny');
  });
});

// Keep vi in the import surface for parity with other adapter tests.
void vi;
