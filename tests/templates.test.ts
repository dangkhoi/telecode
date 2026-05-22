import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-tpl-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('templates table + store methods', () => {
  let store: SessionStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeStore());
  });
  afterEach(() => cleanup());

  it('saveTemplate inserts and getTemplate retrieves', () => {
    store.saveTemplate(42, 'refactor', 'claude', 'refactor auth module', 1);
    const tpl = store.getTemplate(42, 'refactor');
    expect(tpl).toBeDefined();
    expect(tpl!.name).toBe('refactor');
    expect(tpl!.agent).toBe('claude');
    expect(tpl!.prompt).toBe('refactor auth module');
    expect(tpl!.project_id).toBe(1);
  });

  it('saveTemplate upserts on conflict', () => {
    store.saveTemplate(42, 'test', 'claude', 'run tests', null);
    store.saveTemplate(42, 'test', 'kiro', 'run all tests', 2);
    const tpl = store.getTemplate(42, 'test');
    expect(tpl!.agent).toBe('kiro');
    expect(tpl!.prompt).toBe('run all tests');
    expect(tpl!.project_id).toBe(2);
  });

  it('listTemplates returns all templates for a chat', () => {
    store.saveTemplate(42, 'alpha', 'claude', 'prompt a', null);
    store.saveTemplate(42, 'beta', 'kiro', 'prompt b', null);
    store.saveTemplate(99, 'gamma', 'codex', 'prompt c', null); // different chat
    const list = store.listTemplates(42);
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('getTemplate returns undefined for nonexistent', () => {
    expect(store.getTemplate(42, 'nope')).toBeUndefined();
  });

  it('deleteTemplate removes and returns true', () => {
    store.saveTemplate(42, 'del', 'claude', 'x', null);
    expect(store.deleteTemplate(42, 'del')).toBe(true);
    expect(store.getTemplate(42, 'del')).toBeUndefined();
  });

  it('deleteTemplate returns false for nonexistent', () => {
    expect(store.deleteTemplate(42, 'nope')).toBe(false);
  });

  it('saveTemplate with null projectId stores null', () => {
    store.saveTemplate(42, 'noproject', 'claude', 'hello', null);
    const tpl = store.getTemplate(42, 'noproject');
    expect(tpl!.project_id).toBeNull();
  });
});
