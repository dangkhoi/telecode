/**
 * Phase A.3 — stripAnsi helper (extracted from kiro.ts).
 *
 * Ensures the helper now lives in src/util/ansi.ts and that Kiro's existing
 * behaviour is preserved (the Kiro adapter still imports from here). Codex
 * uses the same helper for `command/exec/outputDelta` — verified indirectly
 * via tests/codex.test.ts (no separate ANSI test there: covered by these
 * pure-helper snapshots).
 */
import { describe, it, expect } from 'vitest';
import { stripAnsi, _internals } from '../src/util/ansi.js';

describe('stripAnsi', () => {
  it('removes basic SGR colour sequences', () => {
    const raw = '\x1b[31merror\x1b[0m: oops';
    expect(stripAnsi(raw)).toBe('error: oops');
  });

  it('removes cursor show/hide sequences emitted by spinners (npm, ora, …)', () => {
    const raw = '\x1b[?25l[spinner]\x1b[?25hdone';
    expect(stripAnsi(raw)).toBe('[spinner]done');
  });

  it('handles multi-line output with mixed SGR codes', () => {
    const raw =
      '\x1b[32mPASS\x1b[0m tests/foo.test.ts\n' +
      '\x1b[31mFAIL\x1b[0m tests/bar.test.ts\n';
    expect(stripAnsi(raw)).toBe('PASS tests/foo.test.ts\nFAIL tests/bar.test.ts\n');
  });

  it('is idempotent on clean strings (hot path)', () => {
    const clean = 'no escapes here';
    expect(stripAnsi(clean)).toBe(clean);
    expect(stripAnsi(stripAnsi(clean))).toBe(clean);
  });

  it('handles complex bracketed sequences with numbers + semicolons', () => {
    // 256-color palette SGR: ESC[38;5;208m (orange)
    const raw = '\x1b[38;5;208mwarn\x1b[0m';
    expect(stripAnsi(raw)).toBe('warn');
  });

  it('preserves regex source so downstream tooling can inspect patterns', () => {
    expect(_internals.ANSI_RE).toBeInstanceOf(RegExp);
    expect(_internals.CURSOR_HIDE_SHOW_RE).toBeInstanceOf(RegExp);
  });
});
