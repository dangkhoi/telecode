import { describe, it, expect } from 'vitest';
import {
  buildSessionStrip,
  type SessionListItem,
} from '../src/bot/reply-builders.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const NOW = 1_716_220_000_000;

function mkSession(
  id: string,
  label: string,
  agent: 'claude' | 'kiro' = 'claude',
  ageMs = 60_000,
): SessionListItem {
  return { id, label, agent, updatedAt: NOW - ageMs, status: 'idle' };
}

function mkSessions(n: number): SessionListItem[] {
  return Array.from({ length: n }, (_, i) =>
    mkSession(`aaaaaaaa-${String(i + 1).padStart(4, '0')}-4000-8000-000000000000`, `s${i + 1}`),
  );
}

function callbackOf(btn: unknown): string {
  return (btn as { callback_data: string }).callback_data;
}

function textOf(btn: unknown): string {
  return (btn as { text: string }).text;
}

// ----------------------------------------------------------------------------
// buildSessionStrip
// ----------------------------------------------------------------------------

describe('buildSessionStrip', () => {
  it('returns a single [+ New session] row for an empty session list', () => {
    const rows = buildSessionStrip([], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]![0]).toMatchObject({
      text: '➕ New session',
      callback_data: 'wizard:new-start',
    });
  });

  it('renders 1 inactive session without ● marker and a [+ New] row', () => {
    const sessions = [mkSession('id-1', 'refactor-auth')];
    const rows = buildSessionStrip(sessions, null);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(1);
    expect(textOf(rows[0]![0])).toBe('refactor-auth');
    expect(textOf(rows[0]![0])).not.toContain('●');
    expect(callbackOf(rows[0]![0])).toBe('session:switch:id-1');
    expect(rows[1]![0]).toMatchObject({
      text: '➕ New session',
      callback_data: 'wizard:new-start',
    });
  });

  it('marks the active session with ● when it is the only session', () => {
    const sessions = [mkSession('id-1', 'refactor-auth')];
    const rows = buildSessionStrip(sessions, 'id-1');
    expect(textOf(rows[0]![0])).toBe('● refactor-auth');
  });

  it('places ● on the middle session of a 3-session row', () => {
    const sessions: SessionListItem[] = [
      mkSession('id-1', 's1'),
      mkSession('id-2', 's2'),
      mkSession('id-3', 's3'),
    ];
    const rows = buildSessionStrip(sessions, 'id-2');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(3);
    expect(textOf(rows[0]![0])).toBe('s1');
    expect(textOf(rows[0]![1])).toBe('● s2');
    expect(textOf(rows[0]![2])).toBe('s3');

    // row 2: just [+ New session] (no pagination at ≤ perPage).
    expect(rows[1]).toHaveLength(1);
    expect(rows[1]![0]).toMatchObject({
      text: '➕ New session',
      callback_data: 'wizard:new-start',
    });
  });

  it('renders all 4 sessions inline + single [+ New] row at exactly perPage', () => {
    const sessions = mkSessions(4);
    const rows = buildSessionStrip(sessions, null);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(4);
    expect(rows[0]!.map(textOf)).toEqual(['s1', 's2', 's3', 's4']);
    // boundary: no pagination, just [+ New session].
    expect(rows[1]).toHaveLength(1);
    expect(rows[1]![0]).toMatchObject({
      text: '➕ New session',
      callback_data: 'wizard:new-start',
    });
  });

  it('paginates 5 sessions — page 1 shows s1..s4, with Next + [+ New]', () => {
    const sessions = mkSessions(5);
    const rows = buildSessionStrip(sessions, null, { page: 1 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(4);
    expect(rows[0]!.map(textOf)).toEqual(['s1', 's2', 's3', 's4']);

    // Control row: [no-op spacer] [Next →] [➕ New]
    expect(rows[1]).toHaveLength(3);
    expect(callbackOf(rows[1]![0])).toBe('session:strip-page:noop'); // prev at lower boundary
    expect(rows[1]![1]).toMatchObject({
      text: 'Next →',
      callback_data: 'session:strip-page:2',
    });
    expect(rows[1]![2]).toMatchObject({
      text: '➕ New',
      callback_data: 'wizard:new-start',
    });
  });

  it('paginates 5 sessions — page 2 shows only s5 with Prev + [+ New]', () => {
    const sessions = mkSessions(5);
    const rows = buildSessionStrip(sessions, null, { page: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(1);
    expect(textOf(rows[0]![0])).toBe('s5');

    expect(rows[1]).toHaveLength(3);
    expect(rows[1]![0]).toMatchObject({
      text: '← Prev',
      callback_data: 'session:strip-page:1',
    });
    expect(callbackOf(rows[1]![1])).toBe('session:strip-page:noop'); // next at upper boundary
    expect(rows[1]![2]).toMatchObject({
      text: '➕ New',
      callback_data: 'wizard:new-start',
    });
  });

  it('keeps the active marker on the correct session across pages', () => {
    const sessions = mkSessions(7); // 2 pages of 4
    const activeOnPage1 = sessions[1]!.id; // s2
    const activeOnPage2 = sessions[5]!.id; // s6

    const page1 = buildSessionStrip(sessions, activeOnPage1, { page: 1 });
    expect(textOf(page1[0]![1])).toBe('● s2');
    expect(textOf(page1[0]![0])).toBe('s1');
    expect(textOf(page1[0]![2])).toBe('s3');

    // when the active session is on a different page, no ● appears in slice.
    const page1NoActive = buildSessionStrip(sessions, activeOnPage2, { page: 1 });
    for (const btn of page1NoActive[0]!) {
      expect(textOf(btn)).not.toContain('●');
    }

    const page2 = buildSessionStrip(sessions, activeOnPage2, { page: 2 });
    // page 2 holds s5, s6, s7 — s6 should carry ●
    expect(textOf(page2[0]![0])).toBe('s5');
    expect(textOf(page2[0]![1])).toBe('● s6');
    expect(textOf(page2[0]![2])).toBe('s7');
  });

  it('clamps page=0 to first page and page=99 to last page', () => {
    const sessions = mkSessions(5); // 2 pages

    const tooLow = buildSessionStrip(sessions, null, { page: 0 });
    expect(tooLow[0]!.map(textOf)).toEqual(['s1', 's2', 's3', 's4']);
    // page 1 → no Prev (spacer), has Next
    expect(callbackOf(tooLow[1]![0])).toBe('session:strip-page:noop');
    expect(callbackOf(tooLow[1]![1])).toBe('session:strip-page:2');

    const tooHigh = buildSessionStrip(sessions, null, { page: 99 });
    expect(tooHigh[0]!.map(textOf)).toEqual(['s5']);
    // last page → has Prev, Next is spacer
    expect(callbackOf(tooHigh[1]![0])).toBe('session:strip-page:1');
    expect(callbackOf(tooHigh[1]![1])).toBe('session:strip-page:noop');
  });

  it('respects a custom perPage value', () => {
    const sessions = mkSessions(6);
    const rows = buildSessionStrip(sessions, null, { perPage: 2, page: 2 });
    expect(rows[0]!.map(textOf)).toEqual(['s3', 's4']);
    // 6 / 2 = 3 pages → page 2 has both Prev + Next
    expect(callbackOf(rows[1]![0])).toBe('session:strip-page:1');
    expect(callbackOf(rows[1]![1])).toBe('session:strip-page:3');
  });

  it('keeps every callback_data well under the Telegram 64-byte limit (realistic uuid)', () => {
    // Worst-case input: realistic 36-char UUID v4 + long page numbers.
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const sessions: SessionListItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `${id.slice(0, 27)}${String(i + 1).padStart(9, '0')}`,
      label: 'long-session-label-name-for-checking',
      agent: 'claude',
      updatedAt: NOW,
      status: 'idle',
    }));

    for (const page of [1, 2, 3]) {
      const rows = buildSessionStrip(sessions, sessions[0]!.id, { page });
      for (const row of rows) {
        for (const btn of row) {
          const data = callbackOf(btn);
          expect(Buffer.byteLength(data, 'utf8')).toBeLessThan(64);
        }
      }
    }
  });
});
