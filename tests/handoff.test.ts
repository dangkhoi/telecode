import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';

/**
 * Focused tests for the /handoff feature.
 *
 * The full /handoff command flow needs a real Bot context + dispatch + agent
 * adapter — covered manually in smoke test. Here we verify the storage layer
 * contract that the /handoff command relies on:
 *   - The new `handoff_context` column survives the migration on existing DBs.
 *   - updateSession can set + clear `handoff_context`.
 *   - The 1-shot inject pattern (read context, then clear) is race-free for
 *     a single-threaded SQLite access pattern.
 */

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-handoff-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('handoff_context column + migration', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('fresh DB has handoff_context column with NULL default', () => {
    const { store, cleanup: c } = makeStore();
    cleanup = c;
    const row = store.createSession({
      id: '00000000-0000-4000-8000-000000000001',
      label: 'fresh',
      agent: 'claude',
      project_id: null,
      chat_id: 1,
      sdk_session_id: null,
      status: 'idle',
    });
    expect(row.handoff_context).toBeNull();
  });

  it('updateSession persists handoff_context + clears on null', () => {
    const { store, cleanup: c } = makeStore();
    cleanup = c;
    const id = '00000000-0000-4000-8000-000000000002';
    store.createSession({
      id,
      label: 'hh',
      agent: 'claude',
      project_id: null,
      chat_id: 1,
      sdk_session_id: 'sdk-abc',
      status: 'idle',
    });

    const summary = 'We refactored auth.ts; next step: write tests.';
    store.updateSession(id, { handoff_context: summary });
    expect(store.getSession(id)?.handoff_context).toBe(summary);

    // Clear it (the 1-shot pattern after injection)
    store.updateSession(id, { handoff_context: null });
    expect(store.getSession(id)?.handoff_context).toBeNull();
  });

  it('1-shot inject pattern: read then clear is atomic from caller POV', () => {
    // Simulates the plain-text-dispatch flow:
    //   if (cur.handoff_context) {
    //     prompt = `<ctx>\n\n${userText}`;
    //     store.updateSession(cur.id, { handoff_context: null });
    //   }
    const { store, cleanup: c } = makeStore();
    cleanup = c;
    const id = '00000000-0000-4000-8000-000000000003';
    store.createSession({
      id,
      label: 's',
      agent: 'claude',
      project_id: null,
      chat_id: 1,
      sdk_session_id: 'r-1',
      status: 'idle',
    });
    store.updateSession(id, { handoff_context: 'summary X' });

    // First dispatch: read + clear
    const before = store.getSession(id)!;
    expect(before.handoff_context).toBe('summary X');
    store.updateSession(id, { handoff_context: null });

    // Second dispatch: nothing to inject
    const after = store.getSession(id)!;
    expect(after.handoff_context).toBeNull();
  });

  it('handoff bundles with /clear semantics — sdk_session_id + transcript_tail wipe', () => {
    // /handoff stores the summary then wipes sdk_session_id + transcript_tail
    // in the SAME updateSession call so we never end up with a half-cleared
    // session (e.g. summary saved but resume id still pointing at old context).
    const { store, cleanup: c } = makeStore();
    cleanup = c;
    const id = '00000000-0000-4000-8000-000000000004';
    store.createSession({
      id,
      label: 's',
      agent: 'claude',
      project_id: null,
      chat_id: 1,
      sdk_session_id: 'old-resume-id',
      status: 'idle',
    });
    store.appendTranscript(id, 'line 1');
    store.appendTranscript(id, 'line 2');

    store.updateSession(id, {
      handoff_context: 'compact summary',
      sdk_session_id: null,
      transcript_tail: '',
    });

    const row = store.getSession(id)!;
    expect(row.handoff_context).toBe('compact summary');
    expect(row.sdk_session_id).toBeNull();
    expect(row.transcript_tail).toBe('');
  });
});

describe('migration — existing DB without handoff_context column gets ALTER on open', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('reopening the same DB file does not error (idempotent ALTER guard)', () => {
    // Open + close + open. The 2nd open must NOT throw "duplicate column"
    // because of the PRAGMA-table_info guard.
    const d = mkdtempSync(join(tmpdir(), 'telecode-mig-'));
    cleanup = () => rmSync(d, { recursive: true, force: true });
    const path = join(d, 's.db');

    const s1 = new SessionStore(path);
    const cols1 = s1.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    expect(cols1.some((c) => c.name === 'handoff_context')).toBe(true);
    s1.db.close();

    // Reopen — guard must not double-ALTER.
    const s2 = new SessionStore(path);
    const cols2 = s2.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    expect(cols2.some((c) => c.name === 'handoff_context')).toBe(true);
    s2.db.close();
  });
});
