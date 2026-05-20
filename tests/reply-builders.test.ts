import { describe, it, expect } from 'vitest';
import { InlineKeyboard, Keyboard } from 'grammy';
import {
  buildPersistentKeyboard,
  removeKeyboard,
  buildSessionList,
  buildProjectList,
  relativeTime,
  splitCatchUp,
  type SessionListItem,
  type ProjectListItem,
} from '../src/bot/reply-builders.js';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const NOW = 1_716_220_000_000; // arbitrary fixed timestamp for deterministic tests

function mkSession(
  id: string,
  label: string,
  agent: 'claude' | 'kiro',
  ageMs: number,
): SessionListItem {
  return { id, label, agent, updatedAt: NOW - ageMs, status: 'idle' };
}

function mkProjects(n: number): ProjectListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `proj-${i + 1}`,
    path: `/Users/koi/workspaces/proj-${i + 1}`,
  }));
}

// ----------------------------------------------------------------------------
// buildPersistentKeyboard
// ----------------------------------------------------------------------------

describe('buildPersistentKeyboard', () => {
  it('emits a 6-button, 3-row, resized + persistent keyboard', () => {
    const kb = buildPersistentKeyboard();
    expect(kb).toBeInstanceOf(Keyboard);
    expect(kb.resize_keyboard).toBe(true);
    expect(kb.is_persistent).toBe(true);

    const rows = kb.keyboard;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.length)).toEqual([2, 2, 2]);

    const texts = rows.flat().map((b) => b.text);
    expect(texts).toEqual([
      '📋 Sessions',
      '📁 Projects',
      '📊 Status',
      '🛑 Stop',
      '📸 Screen',
      '❓ Help',
    ]);
  });
});

describe('removeKeyboard', () => {
  it('returns the standard ReplyKeyboardRemove shape', () => {
    expect(removeKeyboard()).toEqual({ remove_keyboard: true });
  });
});

// ----------------------------------------------------------------------------
// relativeTime
// ----------------------------------------------------------------------------

describe('relativeTime', () => {
  it('returns "just now" for <60s', () => {
    expect(relativeTime(NOW - 0, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59_000, NOW)).toBe('just now');
  });
  it('returns minutes for <60m', () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe('1m ago');
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });
  it('returns hours for <24h', () => {
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(relativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
  });
  it('returns days for >=24h', () => {
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('1d ago');
    expect(relativeTime(NOW - 10 * 24 * 60 * 60_000, NOW)).toBe('10d ago');
  });
  it('handles future timestamps gracefully', () => {
    expect(relativeTime(NOW + 10_000, NOW)).toBe('just now');
  });
});

// ----------------------------------------------------------------------------
// buildSessionList
// ----------------------------------------------------------------------------

describe('buildSessionList', () => {
  it('renders empty list with only [+ New session] button', () => {
    const payload = buildSessionList([], null, [], NOW);
    expect(payload.text).toBe('📋 Sessions (0):');
    const rows = payload.reply_markup.inline_keyboard;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]![0]).toMatchObject({
      text: '➕ New session',
      callback_data: 'wizard:new-start',
    });
  });

  it('marks active session with ● and renders agent icons + relative times', () => {
    const sessions: SessionListItem[] = [
      mkSession('aaaaaaaa-0001-4000-8000-000000000001', 'refactor-auth', 'claude', 2 * 60_000),
      mkSession('aaaaaaaa-0002-4000-8000-000000000002', 'debug-api', 'claude', 60 * 60_000),
      mkSession('aaaaaaaa-0003-4000-8000-000000000003', 'mobile-ui', 'kiro', 3 * 60 * 60_000),
    ];
    const activeId = sessions[1]!.id;
    const payload = buildSessionList(sessions, activeId, [], NOW);

    const expected = [
      '📋 Sessions (3):',
      '   refactor-auth · 🤖 · 2m ago',
      '● debug-api · 🤖 · 1h ago',
      '   mobile-ui · ⚡ · 3h ago',
    ].join('\n');
    expect(payload.text).toBe(expected);

    const rows = payload.reply_markup.inline_keyboard;
    // 3 switch buttons + 1 new-session row
    expect(rows).toHaveLength(4);
    expect(rows[0]![0]).toMatchObject({
      text: 'refactor-auth',
      callback_data: `session:switch:${sessions[0]!.id}`,
    });
    expect(rows[1]![0]).toMatchObject({
      text: 'debug-api',
      callback_data: `session:switch:${sessions[1]!.id}`,
    });
    expect(rows[2]![0]).toMatchObject({
      text: 'mobile-ui',
      callback_data: `session:switch:${sessions[2]!.id}`,
    });
    expect(rows[3]![0]).toMatchObject({
      text: '➕ New session',
      callback_data: 'wizard:new-start',
    });
  });

  it('appends extraButtons rows below the new-session row', () => {
    const sessions = [mkSession('id1', 'foo', 'claude', 1_000)];
    const payload = buildSessionList(sessions, null, [
      [{ text: '🔁 Resume', callback_data: 'follow:resume:id1' }],
      [
        { text: '📜 Logs', callback_data: 'follow:logs:id1' },
        { text: '🛑 Stop', callback_data: 'follow:stop:id1' },
      ],
    ], NOW);

    const rows = payload.reply_markup.inline_keyboard;
    // 1 switch + new-session + 2 extra = 4 rows
    expect(rows).toHaveLength(4);
    expect(rows[2]![0]).toMatchObject({ text: '🔁 Resume' });
    expect(rows[3]).toHaveLength(2);
    expect(rows[3]![1]).toMatchObject({ text: '🛑 Stop' });
  });

  it('keeps session:switch callback_data well under Telegram 64-byte limit', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; // 36-char UUID v4
    const sessions = [mkSession(id, 'long-label-name', 'claude', 1_000)];
    const payload = buildSessionList(sessions, id, [], NOW);
    const rows = payload.reply_markup.inline_keyboard;
    const data = (rows[0]![0] as { callback_data: string }).callback_data;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThan(64);
  });
});

// ----------------------------------------------------------------------------
// buildProjectList
// ----------------------------------------------------------------------------

describe('buildProjectList', () => {
  it('renders empty list with a hint and no actionable buttons', () => {
    const payload = buildProjectList([]);
    expect(payload.text).toContain('📁 Projects (0):');
    expect(payload.text).toContain('no projects registered');
    // grammy InlineKeyboard always starts with a [[]] seed row; what matters
    // is that no actual buttons (with text) are rendered.
    const flat = payload.reply_markup.inline_keyboard.flat();
    expect(flat).toHaveLength(0);
  });

  it('shows 2 action buttons per project — Switch + New', () => {
    const projects = mkProjects(2);
    const payload = buildProjectList(projects);
    const rows = payload.reply_markup.inline_keyboard;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0]![0]).toMatchObject({
      text: '📍 Switch',
      callback_data: 'project:cd:1',
    });
    expect(rows[0]![1]).toMatchObject({
      text: '➕ New',
      callback_data: 'project:new:1',
    });
  });

  it('omits pagination at the boundary (exactly 8 projects)', () => {
    const projects = mkProjects(8);
    const payload = buildProjectList(projects);
    const rows = payload.reply_markup.inline_keyboard;
    expect(rows).toHaveLength(8); // 8 project rows, no nav
    // none should be pagination
    const allTexts = rows.flat().map((b) => b.text);
    expect(allTexts).not.toContain('Next →');
    expect(allTexts).not.toContain('← Prev');
  });

  it('adds pagination nav when total > perPage', () => {
    const projects = mkProjects(9);
    const payload = buildProjectList(projects);
    const rows = payload.reply_markup.inline_keyboard;
    // 8 project rows on page 1 + 1 nav row
    expect(rows).toHaveLength(9);
    const navRow = rows[8]!;
    // Page 1: no Prev, has page indicator + Next
    expect(navRow.map((b) => b.text)).toEqual(['page 1/2', 'Next →']);
    expect(navRow[1]).toMatchObject({ callback_data: 'project:page:2' });
  });

  it('renders correct subset on page 2/2 with Prev nav', () => {
    const projects = mkProjects(9);
    const payload = buildProjectList(projects, { page: 2 });
    const rows = payload.reply_markup.inline_keyboard;
    // 1 project on page 2 + nav row
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toMatchObject({ callback_data: 'project:cd:9' });
    const navRow = rows[1]!;
    expect(navRow.map((b) => b.text)).toEqual(['← Prev', 'page 2/2']);
    expect(navRow[0]).toMatchObject({ callback_data: 'project:page:1' });
    // text shows only the 9th project
    expect(payload.text).toContain('proj-9');
    expect(payload.text).not.toContain('proj-1 ·'); // proj-1 absent on page 2
  });

  it('clamps out-of-range page to valid bounds', () => {
    const projects = mkProjects(9);
    const tooHigh = buildProjectList(projects, { page: 99 });
    expect(tooHigh.text).toContain('proj-9'); // falls onto last page
    const tooLow = buildProjectList(projects, { page: 0 });
    expect(tooLow.text).toContain('proj-1'); // clamps up to page 1
  });

  it('appends extraButtons rows after pagination nav', () => {
    const projects = mkProjects(9);
    const payload = buildProjectList(projects, {
      extraButtons: [[{ text: '➕ Register', callback_data: 'project:register' }]],
    });
    const rows = payload.reply_markup.inline_keyboard;
    // 8 projects + nav + 1 extra = 10 rows
    expect(rows).toHaveLength(10);
    expect(rows[9]![0]).toMatchObject({ text: '➕ Register' });
  });

  it('keeps project callback_data well under Telegram 64-byte limit', () => {
    // even a 6-digit project_id stays small: "project:new:999999" = 18 bytes
    const projects: ProjectListItem[] = [
      { id: 999_999, name: 'huge', path: '/Users/koi/x' },
    ];
    const payload = buildProjectList(projects);
    const rows = payload.reply_markup.inline_keyboard;
    for (const row of rows) {
      for (const btn of row) {
        const data = (btn as { callback_data: string }).callback_data;
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThan(64);
      }
    }
  });

  it('returns an InlineKeyboard instance (not a raw object)', () => {
    const payload = buildProjectList(mkProjects(1));
    expect(payload.reply_markup).toBeInstanceOf(InlineKeyboard);
  });
});

// ---------------------------------------------------------------------------
// splitCatchUp (v0.8 — P2 fix: avoid silent Notifier clip at 3500 chars)
// ---------------------------------------------------------------------------

describe('splitCatchUp', () => {
  const HEADER = '[A] 📥 catch-up (3 events from background):';
  const CONT = '[A] 📥 catch-up (cont.):';

  it('returns [] when there are no lines', () => {
    expect(splitCatchUp(HEADER, CONT, [])).toEqual([]);
  });

  it('keeps everything in one message when total fits the cap', () => {
    const parts = splitCatchUp(HEADER, CONT, ['l1', 'l2', 'l3'], 100);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(`${HEADER}\nl1\nl2\nl3`);
  });

  it('splits at line boundaries when the joined body exceeds the cap', () => {
    // Use a tiny cap to force a split between event lines.
    const lines = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']; // 10 chars each
    const cap = HEADER.length + 1 + 10 + 1; // enough only for header + one line
    const parts = splitCatchUp(HEADER, CONT, lines, cap);
    expect(parts.length).toBeGreaterThan(1);
    // First part starts with the full header.
    expect(parts[0]!.startsWith(HEADER)).toBe(true);
    // Subsequent parts use the continuation header.
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.startsWith(CONT)).toBe(true);
    }
    // No part exceeds the cap.
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(cap);
    }
    // Every input line ends up in some output part.
    const joined = parts.join('\n');
    for (const l of lines) expect(joined).toContain(l);
  });

  it('hard-splits a single line longer than the cap', () => {
    const huge = 'x'.repeat(200);
    const cap = HEADER.length + 30; // header + 30 chars/payload
    const parts = splitCatchUp(HEADER, CONT, [huge], cap);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(cap);
    }
    // Concatenating the payload parts (after stripping headers) reconstructs huge.
    let recovered = '';
    for (const p of parts) {
      const body = p.startsWith(HEADER)
        ? p.slice(HEADER.length + 1)
        : p.slice(CONT.length + 1);
      recovered += body;
    }
    expect(recovered).toBe(huge);
  });

  it('handles a 50KB buffer realistically (default cap)', () => {
    // Simulate the worst case from plan §7 P2.
    const lines = Array.from({ length: 5000 }, (_, i) => `event-${i}-` + 'x'.repeat(8));
    const parts = splitCatchUp(HEADER, CONT, lines);
    // No part exceeds the default 3400-char cap.
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3400);
    }
    // Every line landed somewhere.
    const joined = parts.join('\n');
    expect(joined).toContain('event-0-');
    expect(joined).toContain('event-4999-');
  });
});
