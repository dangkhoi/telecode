/**
 * Phase E — renderStatusEvent unit tests.
 *
 * Pure function — exercise the friendly-text table for each known adapter
 * status string + payload extraction (cursor_plan_update.plan_summary) +
 * graceful fallback for unknown / empty statuses.
 */
import { describe, it, expect } from 'vitest';
import { renderStatusEvent } from '../src/bot/progress.js';
import type { AgentEventStatus } from '../src/bot/progress.js';

function ev(status: string, payload?: Record<string, unknown>): AgentEventStatus {
  const e: AgentEventStatus = { type: 'status', status };
  if (payload) e.payload = payload;
  return e;
}

describe('renderStatusEvent', () => {
  it('kiro_spawning → "⏳ Starting Kiro…"', () => {
    expect(renderStatusEvent(ev('kiro_spawning'))).toBe('⏳ Starting Kiro…');
  });

  it('codex_turn_started → "⏳ Codex thinking…"', () => {
    expect(renderStatusEvent(ev('codex_turn_started'))).toBe('⏳ Codex thinking…');
  });

  it('codex_turn_exited → "✓ Codex turn complete"', () => {
    expect(renderStatusEvent(ev('codex_turn_exited'))).toBe('✓ Codex turn complete');
  });

  it('cursor_spawning → "⏳ Starting Cursor…"', () => {
    expect(renderStatusEvent(ev('cursor_spawning'))).toBe('⏳ Starting Cursor…');
  });

  it('cursor_plan_update with plan_summary uses the summary text', () => {
    expect(
      renderStatusEvent(
        ev('cursor_plan_update', { plan_summary: 'Refactor auth handlers' }),
      ),
    ).toBe('⏳ Refactor auth handlers');
  });

  it('cursor_plan_update without plan_summary falls back to "Planning…"', () => {
    expect(renderStatusEvent(ev('cursor_plan_update'))).toBe('⏳ Planning…');
    // Non-string payload — also defaults.
    expect(
      renderStatusEvent(ev('cursor_plan_update', { plan_summary: 123 })),
    ).toBe('⏳ Planning…');
  });

  it('unknown status falls back to "⏳ <status>"', () => {
    expect(renderStatusEvent(ev('unknown_event'))).toBe('⏳ unknown_event');
  });

  it('empty status renders the generic "Working…" placeholder', () => {
    expect(renderStatusEvent(ev(''))).toBe('⏳ Working…');
  });
});
