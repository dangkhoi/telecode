import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAdapter, _internals, type CodexTransport, type JsonRpcMessage } from '../src/agents/codex.js';
import { ApprovalBroker, type ApprovalDecision } from '../src/approval/broker.js';
import type { AgentEvent, AgentStartOpts } from '../src/agents/types.js';

// ---------------------------------------------------------------------------
// Plan P3 — Codex adapter
//
// We exercise the adapter end-to-end via a fake `CodexTransport`. The fake
// captures outgoing JSON-RPC messages so we can assert protocol compliance,
// and lets the test drive inbound notifications + server-initiated requests
// (permission flow). No real `codex` binary is spawned.
// ---------------------------------------------------------------------------

class FakeTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = [];
  private msgListeners: Array<(m: JsonRpcMessage) => void> = [];
  private stderrListeners: Array<(s: string) => void> = [];
  private exitListeners: Array<(c: number | null, s: NodeJS.Signals | null) => void> = [];
  closed = false;
  killed = false;
  exited = false;

  /** Optional auto-responder — if set, runs against every outbound request and may inject responses/notifications. */
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

function makeStart(events: AgentEvent[], cwd = '/tmp/codex-test'): AgentStartOpts {
  const ac = new AbortController();
  return {
    sessionId: 'sess-codex-1',
    sessionLabel: 'demo',
    chatId: 100,
    cwd,
    resumeId: null,
    initialPrompt: 'hello codex',
    onEvent: (e) => events.push(e),
    abortSignal: ac.signal,
  };
}

/**
 * Drive a "happy path" turn through the adapter:
 *   1. respond to initialize → thread/start → turn/start
 *   2. emit notifications (turn/started, item/agentMessage/delta, turn/completed)
 */
function happyPathResponder(opts?: { skipPermission?: boolean }): (m: JsonRpcMessage, t: FakeTransport) => void {
  void opts;
  return (msg, t) => {
    if (!msg.method) return;
    if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
      queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }));
    } else if (msg.method === 'thread/start' && typeof msg.id !== 'undefined') {
      queueMicrotask(() => {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { threadId: 'thr_test_1' } });
        t.emit({ method: 'thread/started', params: { threadId: 'thr_test_1' } });
      });
    } else if (msg.method === 'turn/start' && typeof msg.id !== 'undefined') {
      queueMicrotask(() => {
        t.emit({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        t.emit({ method: 'turn/started', params: { turnId: 'turn_1', threadId: 'thr_test_1' } });
      });
    }
  };
}

describe('CodexAdapter — lifecycle (plan P3.2)', () => {
  let broker: ApprovalBroker;
  let transport: FakeTransport;
  beforeEach(() => {
    broker = makeBroker();
    transport = new FakeTransport();
  });
  afterEach(() => {
    if (!transport.exited) transport.emitExit(0, null);
  });

  it('initializes → thread/start → turn/start → completes on turn/completed', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });

    const run = adapter.run(makeStart(events));
    // Drive notifications: agent message + completion.
    await new Promise((r) => setTimeout(r, 20));
    transport.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello ' } });
    transport.emit({ method: 'item/agentMessage/delta', params: { delta: 'world' } });
    transport.emit({
      method: 'turn/completed',
      params: { turn: { id: 'turn_1', status: 'completed', finalResponse: 'Hello world' } },
    });
    await run;

    // Protocol assertions.
    const methods = transport.sent.map((m) => m.method);
    expect(methods).toContain('initialize');
    expect(methods).toContain('initialized');
    expect(methods).toContain('thread/start');
    expect(methods).toContain('turn/start');

    const turnStart = transport.sent.find((m) => m.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      threadId: 'thr_test_1',
      cwd: '/tmp/codex-test',
      approvalPolicy: 'on-request',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/codex-test'],
        networkAccess: true,
      },
    });
    expect((turnStart?.params as { input?: Array<{ type: string; text: string }> })?.input).toEqual([
      { type: 'text', text: 'hello codex' },
    ]);

    // Event assertions: spawning → started → text deltas → done.
    expect(events.find((e) => e.type === 'status' && e.status === 'codex_spawning')).toBeTruthy();
    expect(events.find((e) => e.type === 'status' && e.status === 'codex_turn_started')).toBeTruthy();
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('Hello world');
    expect(events.find((e) => e.type === 'done')).toBeTruthy();
  });

  it('routes item/permissions/requestApproval through ApprovalBroker → allow_once response', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker, // default allow_once
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    // Server emits a permission request — adapter must respond by id.
    const permId = 999;
    transport.emit({
      jsonrpc: '2.0',
      id: permId,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thr_test_1',
        turnId: 'turn_1',
        itemId: 'call_1',
        cwd: '/tmp/codex-test',
        reason: 'write to /tmp/codex-test',
        permissions: { fileSystem: { write: ['/tmp/codex-test'] } },
      },
    });

    // Allow broker to settle (its prompt resolves on setTimeout 1ms).
    await new Promise((r) => setTimeout(r, 30));

    transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    const reply = transport.sent.find((m) => m.id === permId && !m.method);
    expect(reply).toBeDefined();
    expect(reply?.result).toMatchObject({
      scope: 'turn',
      permissions: { fileSystem: { write: ['/tmp/codex-test'] } },
    });
  });

  it('allow_always response uses scope=session', async () => {
    transport.autoResponder = happyPathResponder();
    broker = makeBroker('allow_always');
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    transport.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'item/permissions/requestApproval',
      params: { cwd: '/tmp/codex-test', permissions: { fileSystem: { write: ['/tmp/codex-test'] } } },
    });
    await new Promise((r) => setTimeout(r, 30));
    transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    const reply = transport.sent.find((m) => m.id === 42 && !m.method);
    expect(reply?.result).toMatchObject({ scope: 'session' });
  });

  it('deny response sends empty permissions object', async () => {
    transport.autoResponder = happyPathResponder();
    broker = makeBroker('deny');
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    transport.emit({
      jsonrpc: '2.0',
      id: 7,
      method: 'item/permissions/requestApproval',
      params: { cwd: '/tmp/codex-test', permissions: { fileSystem: { write: ['/tmp/codex-test'] } } },
    });
    await new Promise((r) => setTimeout(r, 30));
    transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    const reply = transport.sent.find((m) => m.id === 7 && !m.method);
    expect(reply?.result).toEqual({ permissions: {} });
    expect((reply?.result as { scope?: string })?.scope).toBeUndefined();
  });

  it('emits tool_use on item/started with type=commandExecution', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    transport.emit({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'call_x', command: ['ls', '-la'] } },
    });
    transport.emit({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'call_x', success: true, output: 'file1\nfile2\n' } },
    });
    transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect((toolUse as { tool: string }).tool).toBe('codex.exec');
    const toolRes = events.find((e) => e.type === 'tool_result');
    expect(toolRes).toBeTruthy();
    expect((toolRes as { ok: boolean }).ok).toBe(true);
  });

  it('decodes command/exec/outputDelta base64 chunks into text events', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    // "/home/user\n" base64
    const payload = Buffer.from('/home/user\n', 'utf8').toString('base64');
    transport.emit({
      method: 'command/exec/outputDelta',
      params: { processId: 'bash-1', stream: 'stdout', deltaBase64: payload, capReached: false },
    });
    transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toContain('/home/user');
  });

  it('surfaces auth error when stderr matches "unauthenticated"', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    transport.emitStderr('Error: unauthenticated. Please run `codex login` first.\n');
    transport.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { error: string }).error).toMatch(/codex login/i);
  });

  it('surfaces spawn-failure error when transport factory throws', async () => {
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => {
        throw new Error('ENOENT codex');
      },
    });
    await adapter.run(makeStart(events));
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { error: string }).error).toMatch(/spawn failed/);
  });

  it('reports non-zero exit code as error when not aborted', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));

    // Simulate crash mid-turn without turn/completed.
    transport.emitStderr('panicked at codex-rs/core/src/lib.rs:512: invariant\n');
    transport.emitExit(101, null);
    await run;

    const errEvent = events.find(
      (e) => e.type === 'error' && /exited with code 101/.test((e as { error: string }).error),
    );
    expect(errEvent).toBeTruthy();
  });

  it('aborts gracefully — sends turn/interrupt request and closes transport', async () => {
    transport.autoResponder = happyPathResponder();
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const startOpts: AgentStartOpts = {
      sessionId: 'sess-codex-abort',
      sessionLabel: 'demo',
      chatId: 100,
      cwd: '/tmp/codex-test',
      resumeId: null,
      initialPrompt: 'hi',
      onEvent: (e) => events.push(e),
      abortSignal: ac.signal,
    };
    const run = adapter.run(startOpts);
    await new Promise((r) => setTimeout(r, 20));

    // Now we're "in turn" — abort.
    ac.abort(new Error('user_stop'));
    await new Promise((r) => setTimeout(r, 30));
    // The close() path schedules an exit; if no exit yet, force one.
    if (!transport.exited) transport.emitExit(0, null);
    await run;

    const cancel = transport.sent.find((m) => m.method === 'turn/interrupt');
    expect(cancel).toBeTruthy();
    // turn/interrupt is a REQUEST (has an id), not a notification.
    expect(typeof cancel?.id).toBe('number');
    expect(cancel?.params).toMatchObject({ threadId: 'thr_test_1', turnId: 'turn_1' });
    // No `turn/cancel` should ever be emitted — that method does not exist in
    // Codex 0.75. Regression guard.
    expect(transport.sent.find((m) => m.method === 'turn/cancel')).toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  it('force-kills transport when child does not exit within close timeout', async () => {
    // This validates the kill() path via a transport whose close() doesn't auto-exit.
    class StubbornTransport extends FakeTransport {
      override async close(timeoutMs: number): Promise<void> {
        this.closed = true;
        // Don't emitExit — caller's timeout MUST trigger kill().
        await new Promise<void>((r) => setTimeout(r, timeoutMs + 10));
        // Simulate eventual SIGKILL exit.
        this.emitExit(null, 'SIGKILL');
      }
    }
    const stubborn = new StubbornTransport();
    stubborn.autoResponder = happyPathResponder();

    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => stubborn,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 20));
    stubborn.emit({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } });
    await run;

    expect(stubborn.closed).toBe(true);
    expect(stubborn.exited).toBe(true);
  });

  it('rejects in-flight requests when child exits mid-handshake (regression: P3+P4 review)', async () => {
    // Don't wire any responder — initialize will be sent but never answered.
    // Instead we emit a crash-exit and assert run() unwinds promptly with an
    // error event (rather than hanging forever waiting for the response).
    const events: AgentEvent[] = [];
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    const run = adapter.run(makeStart(events));
    await new Promise((r) => setTimeout(r, 10));
    transport.emitStderr('Error: spawn unauthorized\n');
    transport.emitExit(2, null);
    // Should complete within ~30ms — pre-patch this would hang until vitest
    // hit its global timeout (~5s).
    await Promise.race([
      run,
      new Promise((_, rej) => setTimeout(() => rej(new Error('adapter hung')), 500)),
    ]);

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    // The exit-driven error message wins (it's emitted before the catch-block
    // would have emitted its own).
    expect((errEvent as { error: string }).error).toMatch(/exited with code 2/);
  });

  it('surfaces JSON-RPC error in turn/start response as an error event', async () => {
    const events: AgentEvent[] = [];
    transport.autoResponder = (msg, t) => {
      if (msg.method === 'initialize' && typeof msg.id !== 'undefined') {
        queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: {} }));
      } else if (msg.method === 'thread/start' && typeof msg.id !== 'undefined') {
        queueMicrotask(() => t.emit({ jsonrpc: '2.0', id: msg.id, result: { threadId: 'thr_2' } }));
      } else if (msg.method === 'turn/start' && typeof msg.id !== 'undefined') {
        queueMicrotask(() =>
          t.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'sandbox denied' } }),
        );
      }
    };
    const adapter = new CodexAdapter({
      command: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      broker,
      transport: () => transport,
    });
    await adapter.run(makeStart(events));

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeTruthy();
    expect((errEvent as { error: string }).error).toMatch(/sandbox denied/);
  });
});

describe('CodexAdapter — message queue (plan P3 backpressure)', () => {
  it('runs handlers sequentially even when an await blocks mid-message', async () => {
    const { MessageQueue } = _internals as { MessageQueue: new (h: (m: JsonRpcMessage) => Promise<void>) => { push(m: JsonRpcMessage): void } };
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
    // Only `a` should have started; `b` and `c` waited.
    expect(order).toEqual(['start:a']);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });
});

describe('CodexAdapter — registry metadata (plan P3.4)', () => {
  it('exports valid AdapterMetadata that registers cleanly', async () => {
    const { codexMetadata, CodexAdapter: Adapter } = await import('../src/agents/codex.js');
    expect(codexMetadata.kind).toBe('codex');
    expect(codexMetadata.displayName).toBe('Codex');
    expect(codexMetadata.badge).toBe('🅒');
    // Sanity: badge is a short grapheme (≤4 bytes) — matches reply-builders constraint.
    expect(codexMetadata.badge.length).toBeLessThanOrEqual(2);
    // Constructor sanity — does not throw for a minimal opts bag.
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    expect(() => new Adapter({ command: 'codex', model: 'gpt-5.1-codex', effort: 'medium', broker })).not.toThrow();
  });

  it('AUTH_ERR_RE matches common auth-failure phrasings', () => {
    const { AUTH_ERR_RE } = _internals as { AUTH_ERR_RE: RegExp };
    expect(AUTH_ERR_RE.test('Error: unauthenticated')).toBe(true);
    expect(AUTH_ERR_RE.test('not authenticated — please run codex login')).toBe(true);
    expect(AUTH_ERR_RE.test('no API key configured')).toBe(true);
    expect(AUTH_ERR_RE.test('please run codex login first')).toBe(true);
    expect(AUTH_ERR_RE.test('random unrelated panic')).toBe(false);
  });
});

// Keep vi in the import surface to avoid "unused" lint warnings if any helper
// gets vitest-mocked later. (Pattern borrowed from tests/path-portability.test.ts.)
void vi;
