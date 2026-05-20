import { describe, it, expect } from 'vitest';

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
