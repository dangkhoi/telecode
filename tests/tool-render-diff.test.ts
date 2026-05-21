/**
 * Phase C.3 — Diff stats for Edit tool + per-session diff cache.
 *
 * Coverage split into two suites:
 *   1. renderToolUse 'Edit' / 'fs_write' / 'apply_patch' — diff-stat suffix.
 *   2. DiffCache — set/get/TTL/LRU/clearSession + renderDiffBlock format.
 */
import { describe, it, expect } from 'vitest';
import { renderToolUse, friendlyToolLabel } from '../src/bot/tool-render.js';
import { DiffCache, renderDiffBlock } from '../src/bot/diff-cache.js';

describe('renderToolUse — Edit diff stats', () => {
  it('appends (-X +Y) when old_string + new_string are both present', () => {
    const out = renderToolUse('Edit', {
      file_path: '/tmp/foo.ts',
      old_string: 'a\nb\nc',
      new_string: 'a\nb\nc\nd\ne\nf\ng',
    });
    // 3 removed, 7 added.
    expect(out).toBe('Edit · /tmp/foo.ts (-3 +7)');
  });

  it('counts single-line edits as -1 +1', () => {
    const out = renderToolUse('Edit', {
      file_path: '/tmp/foo.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
    expect(out).toBe('Edit · /tmp/foo.ts (-1 +1)');
  });

  it('renders "(no change)" when old_string === new_string', () => {
    const out = renderToolUse('Edit', {
      file_path: '/tmp/foo.ts',
      old_string: 'identical',
      new_string: 'identical',
    });
    expect(out).toBe('Edit · /tmp/foo.ts (no change)');
  });

  it('falls back to bare path when only file_path is present', () => {
    expect(renderToolUse('Edit', { file_path: '/tmp/foo.ts' })).toBe(
      'Edit · /tmp/foo.ts',
    );
  });

  it('handles fs_write (Kiro) with diff stats', () => {
    const out = renderToolUse('fs_write', {
      path: '/tmp/foo.ts',
      old_string: 'a',
      new_string: 'a\nb\nc',
    });
    expect(out).toBe('Edit · /tmp/foo.ts (-1 +3)');
  });

  it('handles apply_patch (Codex) with diff stats', () => {
    const out = renderToolUse('apply_patch', {
      file_path: '/tmp/foo.ts',
      old_string: 'line1\nline2',
      new_string: 'line1',
    });
    expect(out).toBe('Edit · /tmp/foo.ts (-2 +1)');
  });

  it('camelCase oldString / newString variants also detected', () => {
    const out = renderToolUse('Edit', {
      file_path: '/tmp/foo.ts',
      oldString: 'a',
      newString: 'b',
    });
    expect(out).toBe('Edit · /tmp/foo.ts (-1 +1)');
  });

  it('apply_patch maps to friendly "Edit" label', () => {
    expect(friendlyToolLabel('apply_patch')).toBe('Edit');
  });
});

describe('DiffCache', () => {
  it('stores and retrieves a diff by (sessionId, callId)', () => {
    const cache = new DiffCache();
    cache.set('s1', 'c1', 'old', 'new', '/tmp/foo.ts');
    expect(cache.get('s1', 'c1')).toEqual({
      old: 'old',
      new: 'new',
      filePath: '/tmp/foo.ts',
    });
  });

  it('returns null for unknown sessionId / callId', () => {
    const cache = new DiffCache();
    expect(cache.get('s1', 'c1')).toBeNull();
    cache.set('s1', 'c1', 'a', 'b', 'f.ts');
    expect(cache.get('s2', 'c1')).toBeNull();
    expect(cache.get('s1', 'c2')).toBeNull();
  });

  it('evicts entries past TTL', async () => {
    const cache = new DiffCache({ ttlMs: 20 });
    cache.set('s1', 'c1', 'a', 'b', 'f.ts');
    expect(cache.get('s1', 'c1')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.get('s1', 'c1')).toBeNull();
  });

  it('LRU-evicts oldest entry when per-session cap is reached', async () => {
    const cache = new DiffCache({ maxPerSession: 2 });
    cache.set('s1', 'a', 'A', 'A2', 'a.ts');
    await new Promise((r) => setTimeout(r, 5));
    cache.set('s1', 'b', 'B', 'B2', 'b.ts');
    await new Promise((r) => setTimeout(r, 5));
    // Insert c — should evict a (oldest).
    cache.set('s1', 'c', 'C', 'C2', 'c.ts');
    expect(cache.get('s1', 'a')).toBeNull();
    expect(cache.get('s1', 'b')).not.toBeNull();
    expect(cache.get('s1', 'c')).not.toBeNull();
  });

  it('overwrites existing entry on duplicate (sessionId, callId)', () => {
    const cache = new DiffCache();
    cache.set('s1', 'c1', 'old1', 'new1', 'a.ts');
    cache.set('s1', 'c1', 'old2', 'new2', 'a.ts');
    expect(cache.get('s1', 'c1')?.old).toBe('old2');
    expect(cache.size()).toBe(1);
  });

  it('clearSession removes all entries for the session', () => {
    const cache = new DiffCache();
    cache.set('s1', 'c1', 'a', 'b', 'f.ts');
    cache.set('s1', 'c2', 'a', 'b', 'f.ts');
    cache.set('s2', 'c1', 'a', 'b', 'f.ts');
    cache.clearSession('s1');
    expect(cache.get('s1', 'c1')).toBeNull();
    expect(cache.get('s1', 'c2')).toBeNull();
    expect(cache.get('s2', 'c1')).not.toBeNull();
  });

  it('clearSession on unknown session is a no-op', () => {
    const cache = new DiffCache();
    cache.set('s1', 'c1', 'a', 'b', 'f.ts');
    cache.clearSession('s-unknown');
    expect(cache.get('s1', 'c1')).not.toBeNull();
  });

  it('size() returns total across all sessions', () => {
    const cache = new DiffCache();
    expect(cache.size()).toBe(0);
    cache.set('s1', 'a', 'x', 'y', 'f.ts');
    cache.set('s1', 'b', 'x', 'y', 'f.ts');
    cache.set('s2', 'a', 'x', 'y', 'f.ts');
    expect(cache.size()).toBe(3);
  });
});

describe('renderDiffBlock', () => {
  it('formats unified-diff style for a multi-line edit', () => {
    const out = renderDiffBlock('foo.ts', 'a\nb', 'c\nd\ne');
    expect(out).toBe(
      [
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '-a',
        '-b',
        '+c',
        '+d',
        '+e',
      ].join('\n'),
    );
  });

  it('handles pure insert (empty old)', () => {
    const out = renderDiffBlock('foo.ts', '', 'new line');
    // Empty old still produces one "-" line for the empty string —
    // matches unified-diff convention for empty-source edits.
    expect(out).toContain('+new line');
    expect(out).toContain('--- a/foo.ts');
  });

  it('handles pure delete (empty new)', () => {
    const out = renderDiffBlock('foo.ts', 'gone', '');
    expect(out).toContain('-gone');
    expect(out).toContain('+++ b/foo.ts');
  });

  it('emits "(no change)" sentinel when both sides empty', () => {
    expect(renderDiffBlock('foo.ts', '', '')).toContain('(no change)');
  });
});
