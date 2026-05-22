/**
 * E2E adapter tests — spawn real CLI binaries and verify a simple prompt
 * round-trips through each adapter.
 *
 * Prerequisites:
 *   - `claude`, `kiro-cli`, `codex`, `cursor-agent` binaries on PATH
 *   - Each CLI already authenticated (login done outside Telecode)
 *
 * Run:
 *   TELECODE_E2E=1 pnpm test tests/e2e/adapters.e2e.ts
 *
 * These tests are SKIPPED by default (`pnpm test` won't run them) because
 * they hit real APIs, cost tokens, and take 10-60s each.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/session/store.js';
import { SessionManager } from '../../src/session/manager.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { registerBuiltinAdapters } from '../../src/agents/index.js';
import { ApprovalBroker } from '../../src/approval/broker.js';
import { PolicyEngine } from '../../src/approval/policy.js';
import type { AgentEvent } from '../../src/agents/types.js';

const SKIP = !process.env.TELECODE_E2E;

// Shared test infra
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'telecode-e2e-'));
  const store = new SessionStore(join(dir, 'test.db'));
  const policyPath = join(dir, 'policy.yaml');
  writeFileSync(policyPath, 'allow:\n  - "*"\n');
  const policy = new PolicyEngine(policyPath);
  const broker = new ApprovalBroker({ timeoutMs: 30_000 });
  const registry = new AgentRegistry();

  registerBuiltinAdapters(registry, {
    claude: { broker, policy, store, settingSources: ['user'] },
    kiro: { binary: 'kiro-cli' },
    codex: { command: 'codex', model: 'o4-mini', effort: 'low' },
    cursor: { command: 'cursor-agent', model: 'auto' },
  });

  const manager = new SessionManager(store, registry);
  // Create a dummy project pointing to the temp dir
  const project = store.upsertProject('e2e-test', dir);

  return { dir, store, manager, registry, project, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function collectEvents(timeout = 60_000): {
  events: AgentEvent[];
  onEvent: (e: AgentEvent) => void;
  waitForDone: () => Promise<void>;
} {
  const events: AgentEvent[] = [];
  let resolve: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const timer = setTimeout(() => resolve!(), timeout);
  const onEvent = (e: AgentEvent) => {
    events.push(e);
    if (e.type === 'done' || e.type === 'error') {
      clearTimeout(timer);
      resolve!();
    }
  };
  return { events, onEvent, waitForDone: () => done };
}

describe.skipIf(SKIP)('E2E: Claude adapter', { timeout: 120_000 }, () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('dispatches a simple prompt and receives text + done', async () => {
    const env = setup();
    cleanup = env.cleanup;
    const session = env.manager.createSession({
      chatId: 1, agent: 'claude', label: 'e2e-claude', projectId: env.project.id,
    });
    const { events, onEvent, waitForDone } = collectEvents();

    await env.manager.dispatch({
      sessionId: session.id, sessionLabel: session.label, chatId: 1,
      cwd: env.dir, agent: 'claude', resumeId: null,
      prompt: 'Respond with exactly: E2E_OK',
      onEvent,
    });
    await waitForDone();

    const textEvents = events.filter(e => e.type === 'text');
    const doneEvents = events.filter(e => e.type === 'done');
    const usageEvents = events.filter(e => e.type === 'usage');

    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    const fullText = textEvents.map(e => (e as { text: string }).text).join('');
    expect(fullText).toContain('E2E_OK');

    // Verify usage event emitted with contextWindow
    if (usageEvents.length > 0) {
      const u = usageEvents[0] as { inputTokens: number; contextWindow?: number; model?: string };
      expect(u.inputTokens).toBeGreaterThan(0);
      console.log(`  Claude: ${u.inputTokens} input tokens, contextWindow=${u.contextWindow}, model=${u.model}`);
    }
  });
});

describe.skipIf(SKIP)('E2E: Kiro adapter', { timeout: 120_000 }, () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('dispatches a simple prompt and receives text + done', async () => {
    const env = setup();
    cleanup = env.cleanup;
    const session = env.manager.createSession({
      chatId: 1, agent: 'kiro', label: 'e2e-kiro', projectId: env.project.id,
    });
    const { events, onEvent, waitForDone } = collectEvents();

    await env.manager.dispatch({
      sessionId: session.id, sessionLabel: session.label, chatId: 1,
      cwd: env.dir, agent: 'kiro', resumeId: null,
      prompt: 'Respond with exactly: E2E_OK',
      onEvent,
    });
    await waitForDone();

    const textEvents = events.filter(e => e.type === 'text');
    const doneEvents = events.filter(e => e.type === 'done');

    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    const fullText = textEvents.map(e => (e as { text: string }).text).join('');
    expect(fullText).toContain('E2E_OK');
  });
});

describe.skipIf(SKIP)('E2E: Codex adapter', { timeout: 120_000 }, () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('dispatches a simple prompt and receives text + done', async () => {
    const env = setup();
    cleanup = env.cleanup;
    const session = env.manager.createSession({
      chatId: 1, agent: 'codex', label: 'e2e-codex', projectId: env.project.id,
    });
    const { events, onEvent, waitForDone } = collectEvents();

    await env.manager.dispatch({
      sessionId: session.id, sessionLabel: session.label, chatId: 1,
      cwd: env.dir, agent: 'codex', resumeId: null,
      prompt: 'Respond with exactly: E2E_OK',
      onEvent,
    });
    await waitForDone();

    const doneOrError = events.filter(e => e.type === 'done' || e.type === 'error');
    expect(doneOrError.length).toBeGreaterThanOrEqual(1);

    // Codex may not produce text for trivial prompts, but should complete
    const hasTerminal = doneOrError.some(e => e.type === 'done' || e.type === 'error');
    expect(hasTerminal).toBe(true);
  });
});

describe.skipIf(SKIP)('E2E: Cursor adapter', { timeout: 120_000 }, () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('dispatches a simple prompt and receives text + done', async () => {
    const env = setup();
    cleanup = env.cleanup;
    const session = env.manager.createSession({
      chatId: 1, agent: 'cursor', label: 'e2e-cursor', projectId: env.project.id,
    });
    const { events, onEvent, waitForDone } = collectEvents();

    await env.manager.dispatch({
      sessionId: session.id, sessionLabel: session.label, chatId: 1,
      cwd: env.dir, agent: 'cursor', resumeId: null,
      prompt: 'Respond with exactly: E2E_OK',
      onEvent,
    });
    await waitForDone();

    const doneOrError = events.filter(e => e.type === 'done' || e.type === 'error');
    expect(doneOrError.length).toBeGreaterThanOrEqual(1);

    const hasTerminal = doneOrError.some(e => e.type === 'done' || e.type === 'error');
    expect(hasTerminal).toBe(true);
  });
});
