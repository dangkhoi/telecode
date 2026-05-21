/**
 * Phase C.4 — Collapse repeated tool calls.
 *
 * Coverage:
 *  - First emit returns 'send'; subsequent within window returns 'edit'.
 *  - 3 Read events within 2s → 1 send + 2 edits, count climbs to 3, items
 *    list appends.
 *  - 4th Read after 6s (past 5s window) → fresh 'send', count resets to 1.
 *  - Different tool name in same session does NOT collapse — fresh send.
 *  - Different session is isolated (race safety).
 *  - clearSession drops only the targeted session's entries.
 *  - Item list truncation when total chars > maxDisplayChars.
 *  - recordSent(null) tears down so we don't try to edit a phantom.
 *  - Stop() halts the sweep cleanly.
 */
import { describe, it, expect } from 'vitest';
import { ToolCollapseManager } from '../src/bot/tool-collapse.js';

function mkClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('ToolCollapseManager', () => {
  it('first event returns send action with formatted text', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r = m.handle('s1', 'Read', 'foo.ts', '[lbl] ');
    expect(r.action).toBe('send');
    expect(r.formattedText).toBe('[lbl] 🔧 Read · foo.ts');
  });

  it('three Read events within window → send + 2 edits with growing count', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r1 = m.handle('s1', 'Read', 'foo.ts', '[lbl] ');
    expect(r1.action).toBe('send');
    expect(r1.formattedText).toBe('[lbl] 🔧 Read · foo.ts');
    m.recordSent(r1.key, 42);

    clock.advance(1000);
    const r2 = m.handle('s1', 'Read', 'bar.ts', '[lbl] ');
    expect(r2.action).toBe('edit');
    expect(r2).toMatchObject({ msgId: 42 });
    expect(r2.formattedText).toBe('[lbl] 🔧 Read ×2 · foo.ts, bar.ts');

    clock.advance(1000);
    const r3 = m.handle('s1', 'Read', 'baz.ts', '[lbl] ');
    expect(r3.action).toBe('edit');
    expect(r3).toMatchObject({ msgId: 42 });
    expect(r3.formattedText).toBe('[lbl] 🔧 Read ×3 · foo.ts, bar.ts, baz.ts');
  });

  it('4th Read after 6s past window → fresh send with count=1', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r1 = m.handle('s1', 'Read', 'foo.ts', '');
    m.recordSent(r1.key, 100);
    clock.advance(1000);
    m.handle('s1', 'Read', 'bar.ts', '');
    clock.advance(1000);
    m.handle('s1', 'Read', 'baz.ts', '');
    clock.advance(6000); // past 5s window from last lastSeenAt
    const r4 = m.handle('s1', 'Read', 'qux.ts', '');
    expect(r4.action).toBe('send');
    expect(r4.formattedText).toBe('🔧 Read · qux.ts');
  });

  it('different tool name in same session does not collapse', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r1 = m.handle('s1', 'Read', 'foo.ts', '');
    m.recordSent(r1.key, 1);
    clock.advance(500);
    const r2 = m.handle('s1', 'Bash', 'npm test', '');
    expect(r2.action).toBe('send');
    expect(r2.formattedText).toBe('🔧 Bash · npm test');
    // After Bash, a subsequent Read should also be a fresh send (the
    // previous Read entry is finalized on tool switch).
    clock.advance(500);
    const r3 = m.handle('s1', 'Read', 'baz.ts', '');
    expect(r3.action).toBe('send');
  });

  it('isolates per session (race safety)', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r1 = m.handle('s1', 'Read', 'foo.ts', '');
    m.recordSent(r1.key, 1);
    const r2 = m.handle('s2', 'Read', 'foo.ts', '');
    // s2 has its own state; first event is a send not an edit even though
    // s1 is in-window.
    expect(r2.action).toBe('send');
    expect(r2.formattedText).toBe('🔧 Read · foo.ts');
  });

  it('clearSession drops only that session', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r1 = m.handle('s1', 'Read', 'a.ts', '');
    m.recordSent(r1.key, 1);
    const r2 = m.handle('s2', 'Read', 'b.ts', '');
    m.recordSent(r2.key, 2);
    m.clearSession('s1');
    // s2 should still have its entry — next Read on s2 within window
    // should be 'edit'.
    clock.advance(100);
    const r3 = m.handle('s2', 'Read', 'c.ts', '');
    expect(r3.action).toBe('edit');
    expect(r3).toMatchObject({ msgId: 2 });
  });

  it('truncates items list when total chars exceed maxDisplayChars', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({
      now: clock.now,
      disableSweep: true,
      maxDisplayChars: 20,
    });
    const r1 = m.handle('s1', 'Read', 'longfilename1.ts', '');
    m.recordSent(r1.key, 1);
    clock.advance(100);
    const r2 = m.handle('s1', 'Read', 'longfilename2.ts', '');
    clock.advance(100);
    const r3 = m.handle('s1', 'Read', 'longfilename3.ts', '');
    // r3 should have ellipsis (oldest dropped).
    expect(r3.formattedText).toContain('…');
    expect(r3.formattedText).toContain('longfilename3.ts');
  });

  it('recordSent(null) tears down the entry so next call is a fresh send', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    const r1 = m.handle('s1', 'Read', 'foo.ts', '');
    expect(r1.action).toBe('send');
    m.recordSent(r1.key, null); // send failed
    clock.advance(100);
    const r2 = m.handle('s1', 'Read', 'bar.ts', '');
    expect(r2.action).toBe('send'); // not edit — entry dropped
  });

  it('handles missing recordSent gracefully (msgId stays null)', () => {
    const clock = mkClock();
    const m = new ToolCollapseManager({ now: clock.now, disableSweep: true });
    m.handle('s1', 'Read', 'foo.ts', '');
    // Skip recordSent — simulate a slow send. Next event within window
    // falls back to 'send' (rather than 'edit' against null msgId).
    clock.advance(100);
    const r2 = m.handle('s1', 'Read', 'bar.ts', '');
    expect(r2.action).toBe('send');
  });

  it('stop() halts the background sweep idempotently', () => {
    const m = new ToolCollapseManager();
    expect(() => m.stop()).not.toThrow();
    expect(() => m.stop()).not.toThrow();
  });
});
