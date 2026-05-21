import { describe, it, expect } from 'vitest';
import { _internalsBase } from '../src/agents/kiro.js';

// Re-export the internal helpers via a small probe file would be cleaner, but
// to avoid restructuring the adapter we re-declare the same regexes here and
// assert they behave the way the adapter expects. If kiro-cli's output format
// changes, both this test and the adapter need to be updated together.

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const CURSOR_HIDE_SHOW_RE = /\x1b\[\?25[hl]/g;
const SESSION_ID_RE = /Chat SessionId:\s*([0-9a-f-]{36})/i;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(CURSOR_HIDE_SHOW_RE, '');
}

describe('kiro adapter helpers', () => {
  it('strips ANSI colour + cursor sequences', () => {
    // Captured from a real `kiro-cli chat --no-interactive` reply.
    const raw = '\x1b[38;5;252m\x1b[0m\x1b[?25l\x1b[38;5;141m> \x1b[0m4\x1b[0m';
    expect(stripAnsi(raw)).toBe('> 4');
  });

  it('parses session UUID out of --list-sessions output', () => {
    const sample =
      '\x1b[38;5;12m\nChat sessions for /private/tmp:\n\n\x1b[0m' +
      'Chat SessionId: \x1b[38;5;141mafc178a7-2019-4fe8-b532-a750b80ab78c\n\x1b[0m' +
      '  \x1b[2m26 seconds ago\x1b[0m | hi | \x1b[2m2 msgs\x1b[0m | \x1b[2mv1\x1b[0m\n';
    const m = stripAnsi(sample).match(SESSION_ID_RE);
    expect(m?.[1]).toBe('afc178a7-2019-4fe8-b532-a750b80ab78c');
  });

  it('returns null when --list-sessions has no sessions yet', () => {
    const sample = 'No chat sessions found for /tmp\n';
    const m = stripAnsi(sample).match(SESSION_ID_RE);
    expect(m).toBeNull();
  });
});

describe('[P5 senior review P1] compareNvmVersionsDesc — numeric semver order', () => {
  // The naive lexical sort that this helper replaces would rank v9.0.0 above
  // v22.0.0 because "9" > "2". Real-world impact: an nvm install retaining
  // node 8 alongside node 22 would silently feed the unsupported (<22)
  // binary into kiro-cli's PATH and the daemon would refuse to spawn it.
  const { compareNvmVersionsDesc } = _internalsBase as unknown as {
    compareNvmVersionsDesc: (a: string, b: string) => number;
  };

  it('v22 outranks v9 (numeric, not lexical)', () => {
    expect(compareNvmVersionsDesc('v22.0.0', 'v9.0.0')).toBeLessThan(0);
  });

  it('v22.10.0 outranks v22.9.5 (minor compared numerically)', () => {
    expect(compareNvmVersionsDesc('v22.10.0', 'v22.9.5')).toBeLessThan(0);
  });

  it('v22.0.10 outranks v22.0.5 (patch compared numerically)', () => {
    expect(compareNvmVersionsDesc('v22.0.10', 'v22.0.5')).toBeLessThan(0);
  });

  it('handles bare major (v22 vs v9 with no minor.patch)', () => {
    expect(compareNvmVersionsDesc('v22', 'v9')).toBeLessThan(0);
  });

  it('sort() with comparator descending puts the newest first', () => {
    const arr = ['v8.17.0', 'v22.10.0', 'v9.0.0', 'v22.9.5', 'v20.18.0'];
    arr.sort(compareNvmVersionsDesc);
    expect(arr[0]).toBe('v22.10.0');
    expect(arr[1]).toBe('v22.9.5');
    expect(arr[2]).toBe('v20.18.0');
    expect(arr[3]).toBe('v9.0.0');
    expect(arr[4]).toBe('v8.17.0');
  });

  it('identical versions tie at 0', () => {
    expect(compareNvmVersionsDesc('v22.10.0', 'v22.10.0')).toBe(0);
  });
});
