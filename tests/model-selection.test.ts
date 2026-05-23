import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SessionStore } from '../src/session/store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { normalizeModelForAgent } from '../src/agents/model-normalize.js';

describe('model-selection: SessionStore', () => {
  let store: SessionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'telecode-model-test-'));
    store = new SessionStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migration adds model column', () => {
    const cols = store.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('model');
  });

  it('setSessionModel stores and retrieves model', () => {
    const session = store.createSession({
      id: 'test-session-1',
      label: 'test',
      agent: 'claude',
      project_id: null,
      chat_id: 123,
      sdk_session_id: null,
      status: 'idle',
    });
    expect(session.model).toBeNull();

    store.setSessionModel('test-session-1', 'claude-sonnet-4-20250514');
    const updated = store.getSession('test-session-1');
    expect(updated!.model).toBe('claude-sonnet-4-20250514');
  });

  it('setSessionModel can clear model to null', () => {
    store.createSession({
      id: 'test-session-2',
      label: 'test2',
      agent: 'claude',
      project_id: null,
      chat_id: 123,
      sdk_session_id: null,
      status: 'idle',
    });
    store.setSessionModel('test-session-2', 'gpt-5.1');
    expect(store.getSession('test-session-2')!.model).toBe('gpt-5.1');

    store.setSessionModel('test-session-2', null);
    expect(store.getSession('test-session-2')!.model).toBeNull();
  });

  it('model flows through AgentStartOpts type', async () => {
    // Type-level test: ensure model is accepted in AgentStartOpts
    const opts: import('../src/agents/types.js').AgentStartOpts = {
      sessionId: 'x',
      sessionLabel: 'x',
      chatId: 1,
      cwd: '/tmp',
      initialPrompt: 'hi',
      onEvent: () => {},
      abortSignal: new AbortController().signal,
      model: 'claude-sonnet-4-20250514',
    };
    expect(opts.model).toBe('claude-sonnet-4-20250514');
  });

  it('normalizes Claude dotted model versions to Claude Code IDs', () => {
    expect(normalizeModelForAgent('claude', 'claude-opus-4.7')).toBe('claude-opus-4-7');
    expect(normalizeModelForAgent('claude', 'claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(normalizeModelForAgent('claude', 'opus')).toBe('opus');
    // Kiro CLI uses dotted IDs — reverse normalize hyphenated → dotted
    expect(normalizeModelForAgent('kiro', 'claude-opus-4-7')).toBe('claude-opus-4.7');
    expect(normalizeModelForAgent('kiro', 'claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
    // Already dotted → unchanged
    expect(normalizeModelForAgent('kiro', 'claude-opus-4.7')).toBe('claude-opus-4.7');
    expect(normalizeModelForAgent('kiro', 'auto')).toBe('auto');
    expect(normalizeModelForAgent('codex', 'gpt-5.5')).toBe('gpt-5.5');
  });
});
