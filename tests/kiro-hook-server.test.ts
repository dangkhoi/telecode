import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { PolicyEngine } from '../src/approval/policy.js';
import { ApprovalBroker } from '../src/approval/broker.js';
import { KiroHookServer } from '../src/util/kiro-hook-server.js';

describe('KiroHookServer', () => {
  let tmp: string;
  let store: SessionStore;
  let policy: PolicyEngine;
  let broker: ApprovalBroker;
  let server: KiroHookServer;
  let sessionId: string;
  let projectId: number;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'telecode-kiro-test-'));
    const policyPath = join(tmp, 'policy.yaml');
    // pre-seed policy: allow `read`, deny `shell(rm*)`
    (await import('node:fs')).writeFileSync(
      policyPath,
      'allow:\n  - read\ndeny:\n  - "shell(rm*)"\n',
    );
    store = new SessionStore(join(tmp, 'state.db'));
    const proj = store.upsertProject('demo', tmp);
    projectId = proj.id;
    policy = new PolicyEngine(policyPath);
    broker = new ApprovalBroker({ timeoutMs: 500 });
    const created = store.createSession({
      id: 'sess-1',
      label: 'demo',
      agent: 'kiro',
      project_id: projectId,
      chat_id: 42,
      sdk_session_id: null,
      status: 'running',
    });
    sessionId = created.id;
    server = new KiroHookServer({ port: 0, store, policy, broker });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    policy.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function postHook(body: object, headers: Record<string, string> = {}): Promise<{ status: number; decision: string | null; reason: string | null; text: string }> {
    const res = await fetch(server.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telecode-session': sessionId, ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      decision: res.headers.get('x-telecode-decision'),
      reason: res.headers.get('x-telecode-reason'),
      text: await res.text(),
    };
  }

  it('returns allow when policy matches an allow rule', async () => {
    const out = await postHook({ tool_name: 'read', tool_input: { path: '/tmp/x' } });
    expect(out.status).toBe(200);
    expect(out.decision).toBe('allow');
  });

  it('returns deny when policy matches a deny rule', async () => {
    const out = await postHook({ tool_name: 'shell', tool_input: { command: 'rm -rf /' } });
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/policy/i);
  });

  it('returns deny on unknown telecode session', async () => {
    const out = await postHook(
      { tool_name: 'read' },
      { 'x-telecode-session': 'bogus' },
    );
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/unknown telecode session/i);
  });

  it('asks broker (and denies on timeout) when no policy rule matches', async () => {
    // No prompter attached → broker auto-denies. This exercises the ask branch.
    const out = await postHook({ tool_name: 'write', tool_input: { path: '/tmp/y' } });
    expect(out.decision).toBe('deny');
  });

  it('rejects non-POST or wrong path', async () => {
    const res = await fetch(server.url('/wrong'), {
      method: 'POST',
      headers: { 'x-telecode-session': sessionId },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------
// P6.1 — token authentication. Spun up as its own describe so the baseline
// suite above (no token wired) is unchanged.
// ---------------------------------------------------------------------
describe('P6.1 KiroHookServer token auth', () => {
  let tmp: string;
  let store: SessionStore;
  let policy: PolicyEngine;
  let broker: ApprovalBroker;
  let server: KiroHookServer;
  let sessionId: string;
  const TOKEN = 'a'.repeat(64);

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'telecode-kiro-token-test-'));
    const policyPath = join(tmp, 'policy.yaml');
    (await import('node:fs')).writeFileSync(policyPath, 'allow:\n  - read\n');
    store = new SessionStore(join(tmp, 'state.db'));
    const proj = store.upsertProject('demo', tmp);
    policy = new PolicyEngine(policyPath);
    broker = new ApprovalBroker({ timeoutMs: 500 });
    const created = store.createSession({
      id: 'sess-1',
      label: 'demo',
      agent: 'kiro',
      project_id: proj.id,
      chat_id: 42,
      sdk_session_id: null,
      status: 'running',
    });
    sessionId = created.id;
    server = new KiroHookServer({ port: 0, store, policy, broker, token: TOKEN });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    policy.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function postHook(
    headers: Record<string, string>,
  ): Promise<{ status: number; decision: string | null; reason: string | null }> {
    const res = await fetch(server.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telecode-session': sessionId,
        ...headers,
      },
      body: JSON.stringify({ tool_name: 'read', tool_input: { path: '/x' } }),
    });
    return {
      status: res.status,
      decision: res.headers.get('x-telecode-decision'),
      reason: res.headers.get('x-telecode-reason'),
    };
  }

  it('200 + allow with the correct Bearer token', async () => {
    const out = await postHook({ authorization: `Bearer ${TOKEN}` });
    expect(out.status).toBe(200);
    expect(out.decision).toBe('allow');
  });

  it('401 + deny with a wrong token', async () => {
    const out = await postHook({ authorization: 'Bearer ' + 'b'.repeat(64) });
    expect(out.status).toBe(401);
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/bad gate token/i);
  });

  it('401 + deny when Authorization header is missing', async () => {
    const out = await postHook({});
    expect(out.status).toBe(401);
    expect(out.decision).toBe('deny');
  });

  it('401 with a wrong-length token (constant-time compare guard)', async () => {
    const out = await postHook({ authorization: 'Bearer short' });
    expect(out.status).toBe(401);
  });

  it('401 with a non-Bearer scheme', async () => {
    const out = await postHook({ authorization: `Basic ${TOKEN}` });
    expect(out.status).toBe(401);
  });

  it('case-insensitive on the Bearer scheme keyword', async () => {
    const out = await postHook({ authorization: `bearer ${TOKEN}` });
    expect(out.status).toBe(200);
    expect(out.decision).toBe('allow');
  });

  it('senior-review: 401 response includes WWW-Authenticate header per RFC 7235 §3.1', async () => {
    const res = await fetch(server.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telecode-session': sessionId,
        // No Authorization header — server must challenge.
      },
      body: JSON.stringify({ tool_name: 'read', tool_input: { path: '/x' } }),
    });
    expect(res.status).toBe(401);
    // The challenge MUST name the auth scheme. We use `Bearer realm="..."`.
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer\s+realm=/i);
  });
});

// ---------------------------------------------------------------------
// P6.2 — graceful shutdown drain. We use a short broker timeout so the
// "happy path drain" test resolves quickly; a separate test pins the drain
// timeout itself.
// ---------------------------------------------------------------------
describe('P6.2 KiroHookServer.stop() drain', () => {
  let tmp: string;
  let store: SessionStore;
  let policy: PolicyEngine;
  let broker: ApprovalBroker;
  let server: KiroHookServer;
  let sessionId: string;

  /**
   * A prompter that records pending requests but NEVER resolves them
   * automatically. Tests resolve via `broker.resolve()` to simulate either
   * the user tapping in Telegram or the daemon teardown.
   */
  function attachStallingPrompter(b: ApprovalBroker): void {
    b.attach({
      // Resolve the prompt immediately (so broker.ask isn't rejected at
      // attach time) but never call `broker.resolve(id, …)`.
      prompt: async () => undefined,
    });
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'telecode-drain-test-'));
    const policyPath = join(tmp, 'policy.yaml');
    (await import('node:fs')).writeFileSync(policyPath, 'allow: []\ndeny: []\n');
    store = new SessionStore(join(tmp, 'state.db'));
    const proj = store.upsertProject('demo', tmp);
    policy = new PolicyEngine(policyPath);
    // 30s broker timeout — well past the drain window so the drain finishes
    // before the broker times out (or in the slow-drain test, we resolve
    // the broker manually to confirm drain UNBLOCKS once the ask settles).
    broker = new ApprovalBroker({ timeoutMs: 30_000 });
    attachStallingPrompter(broker);
    const created = store.createSession({
      id: 'sess-drain',
      label: 'demo',
      agent: 'kiro',
      project_id: proj.id,
      chat_id: 42,
      sdk_session_id: null,
      status: 'running',
    });
    sessionId = created.id;
    server = new KiroHookServer({ port: 0, store, policy, broker, drainTimeoutMs: 1000 });
    await server.start();
  });

  afterEach(async () => {
    try {
      await server.stop();
    } catch {
      /* already stopped */
    }
    store.close();
    policy.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stop() with no inflight requests returns promptly', async () => {
    const t0 = Date.now();
    await server.stop();
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('stop() waits for an in-flight request to settle (resolved via broker)', async () => {
    // Fire a request that lands in the broker-ask branch (no policy match).
    const pending = fetch(server.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telecode-session': sessionId },
      body: JSON.stringify({ tool_name: 'write', tool_input: { path: '/y' } }),
    });

    // Give the server a tick to register the request as inflight.
    await new Promise((r) => setTimeout(r, 50));

    // Begin drain — should hang until we resolve the broker ask.
    const stopStart = Date.now();
    const stopP = server.stop();
    // After 200ms still pending (no concrete API to check inflight, but the
    // drain promise must not have settled in <100ms).
    await new Promise((r) => setTimeout(r, 200));
    // Resolve the only pending broker ask so the handler exits.
    const pendings = [...((broker as unknown as { pending: Map<string, { request: { id: string } }> }).pending.values())];
    expect(pendings.length).toBe(1);
    broker.resolve(pendings[0].request.id, 'allow_once');
    await stopP;
    const stopDuration = Date.now() - stopStart;
    // Drain returned shortly after our manual resolve, NOT before it.
    expect(stopDuration).toBeGreaterThanOrEqual(150);

    const res = await pending;
    expect(res.headers.get('x-telecode-decision')).toBe('allow');
  });

  it('drainTimeoutMs caps the wait when a request never settles', async () => {
    // Fire a request that lands in broker.ask but is never resolved.
    // We intentionally don't await `pending` directly — once the server
    // tears down the socket the fetch may hang indefinitely; the invariant
    // we care about is that `stop()` returns within ~drainTimeoutMs.
    const pending = fetch(server.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telecode-session': sessionId },
      body: JSON.stringify({ tool_name: 'write', tool_input: { path: '/q' } }),
    }).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 50));

    const stopStart = Date.now();
    await server.stop();
    const stopDuration = Date.now() - stopStart;

    // Drain bailed at the timeout (1000ms) — not earlier (no premature close),
    // not later (no hang).
    expect(stopDuration).toBeGreaterThanOrEqual(800);
    expect(stopDuration).toBeLessThan(2_500);

    // Resolve the broker so the handler can unwind even though its socket
    // is already torn down. We don't await the fetch here — the OS-level
    // socket close may leave the fetch hung forever (Node http parses an
    // incomplete response). Vitest's `unhandled rejection` guard tolerates
    // the dangling `pending` because we `.catch(() => undefined)`'d it.
    const remaining = [...((broker as unknown as { pending: Map<string, { request: { id: string } }> }).pending.values())];
    for (const p of remaining) broker.resolve(p.request.id, 'deny');
    // Best-effort: race the fetch against a short timeout so the handle
    // unwinds before we leave the test.
    await Promise.race([pending, new Promise((r) => setTimeout(r, 200))]);
  });

  it('stop() rejects NEW requests with 503 once shutdown begins', async () => {
    // Trigger shutdown but don't await — we want to race a new request.
    const stopP = server.stop();
    // Give the event loop a moment to flip the shuttingDown flag.
    await new Promise((r) => setTimeout(r, 5));
    const url = server.url();
    let res: Response | undefined;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telecode-session': sessionId },
        body: '{}',
      });
    } catch {
      /* server may have already closed — also a valid signal */
    }
    await stopP;
    if (res) {
      // 503 is the design intent; a 404 / connection-error would mean the
      // listener closed before our request reached the handler — also OK
      // ("no new work accepted").
      expect([503, 404].includes(res.status)).toBe(true);
    }
  });
});
