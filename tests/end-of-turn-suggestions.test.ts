/**
 * v1.2 Bug 1 — `buildEndOfTurnSuggestions` unit tests.
 *
 * Asserts the single-row at-end-of-turn behavior:
 *   - When the turn invoked a tool, the row mirrors the last resolved tool
 *     (e.g. Bash → [▶️ Tiếp tục] [🔁 Run again]).
 *   - When the turn was pure text (no tool ran), the row falls back to the
 *     default `[▶️ Tiếp tục]` so the user still has a one-tap continuation.
 *   - The `ok=false` path forwards through `buildSuggestions` (which treats
 *     failure paths identically today, but the hook stays open for future
 *     refinement).
 */
import { describe, it, expect } from 'vitest';
import { buildEndOfTurnSuggestions } from '../src/bot/commands/index.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('buildEndOfTurnSuggestions', () => {
  it('returns default continue row when no tool ran', () => {
    const row = buildEndOfTurnSuggestions(null, SID, true);
    expect(row.map((b) => b.text)).toEqual(['▶️ Tiếp tục']);
  });

  it('mirrors Bash success heuristic when the last resolved tool was Bash', () => {
    const row = buildEndOfTurnSuggestions(
      { toolName: 'Bash', filePath: null, ok: true },
      SID,
      true,
    );
    expect(row.map((b) => b.text)).toEqual(['▶️ Tiếp tục', '🔁 Run again']);
  });

  it('mirrors fs_write success heuristic when last resolved tool was Edit', () => {
    const row = buildEndOfTurnSuggestions(
      { toolName: 'Edit', filePath: 'src/x.ts', ok: true },
      SID,
      true,
    );
    const labels = row.map((b) => b.text);
    expect(labels).toContain('▶️ Tiếp tục');
    expect(labels).toContain('↩️ Rollback');
  });

  it('forwards ok=false to underlying heuristic without crashing', () => {
    const row = buildEndOfTurnSuggestions(
      { toolName: 'Bash', filePath: null, ok: false },
      SID,
      false,
    );
    // Bash failure still surfaces Run again per existing buildSuggestions.
    expect(row.map((b) => b.text)).toContain('🔁 Run again');
  });

  it('all callback_data fit within Telegram 64-byte cap', () => {
    const row = buildEndOfTurnSuggestions(
      { toolName: 'fs_write', filePath: 'a.ts', ok: true },
      SID,
      true,
    );
    for (const b of row) {
      expect(Buffer.byteLength(b.callback_data!, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});
