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
