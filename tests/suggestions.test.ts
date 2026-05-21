import { describe, it, expect } from 'vitest';
import { buildSuggestions, suggestionAck } from '../src/bot/suggestions.js';
import { extractFilePath } from '../src/bot/commands/index.js';

// ---------------------------------------------------------------------------
// P0.3 — follow-up inline suggestions (Tier 3 #7).
//
// `buildSuggestions` is pure: pick a small row of inline buttons based on the
// tool name + exit. Tests cover the four documented heuristics + the default
// fallback + the "callback overflow" guard.
// ---------------------------------------------------------------------------

const SID = '11111111-2222-3333-4444-555555555555'; // 36-char uuid

describe('buildSuggestions', () => {
  it('fs_write success → [Xem file] [Tiếp tục] [Rollback]', () => {
    // Use a short path so callback_data (18 prefix + 36 uuid + 1 colon + N
    // path = within 64-byte cap). Real-world long paths fall through the
    // overflow guard, exercised in a separate test below.
    const shortPath = 'a.txt';
    const row = buildSuggestions({
      toolName: 'fs_write',
      exitCode: 0,
      filePath: shortPath,
      sessionId: SID,
    });
    const texts = row.map((b) => b.text);
    expect(texts).toEqual(['📄 Xem file', '▶️ Tiếp tục', '↩️ Rollback']);
    // Callback data is well-formed.
    expect(row[0]!.callback_data).toBe(`suggest:view-file:${SID}:${shortPath}`);
    expect(row[1]!.callback_data).toBe(`suggest:continue:${SID}`);
    expect(row[2]!.callback_data).toBe(`suggest:rollback:${SID}`);
  });

  it('fs_write without filePath skips the [Xem file] entry', () => {
    const row = buildSuggestions({
      toolName: 'fs_write',
      exitCode: 0,
      filePath: null,
      sessionId: SID,
    });
    expect(row.map((b) => b.text)).toEqual(['▶️ Tiếp tục', '↩️ Rollback']);
  });

  it('execute_bash success → [Tiếp tục] [Run again]', () => {
    const row = buildSuggestions({
      toolName: 'execute_bash',
      exitCode: 0,
      sessionId: SID,
    });
    expect(row.map((b) => b.text)).toEqual(['▶️ Tiếp tục', '🔁 Run again']);
  });

  it('execute_bash failure also offers [Run again]', () => {
    const row = buildSuggestions({
      toolName: 'Bash',
      exitCode: 1,
      sessionId: SID,
    });
    expect(row.map((b) => b.text)).toContain('🔁 Run again');
  });

  it('unknown tool falls back to a single [Tiếp tục] hint', () => {
    const row = buildSuggestions({
      toolName: 'WeirdNewTool',
      sessionId: SID,
    });
    expect(row.map((b) => b.text)).toEqual(['▶️ Tiếp tục']);
  });

  it('overlong path is dropped from view-file callback to respect 64-byte cap', () => {
    // 200-char path → callback_data well over budget; suggestion drops button.
    const longPath = '/'.padEnd(200, 'a');
    const row = buildSuggestions({
      toolName: 'fs_write',
      exitCode: 0,
      filePath: longPath,
      sessionId: SID,
    });
    // No [Xem file] entry — the budget guard removed it.
    expect(row.map((b) => b.text)).not.toContain('📄 Xem file');
    // Other suggestions still present.
    expect(row.map((b) => b.text)).toContain('▶️ Tiếp tục');
  });

  it('callback_data for every emitted button is within Telegram 64-byte cap', () => {
    for (const tool of ['fs_write', 'Bash', 'execute_bash', 'shell', 'Edit']) {
      const row = buildSuggestions({
        toolName: tool,
        exitCode: 0,
        filePath: 'a.ts',
        sessionId: SID,
      });
      for (const b of row) {
        expect(Buffer.byteLength(b.callback_data!, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('extractFilePath helper', () => {
  it('returns file_path when present (Claude-style Edit/Write)', () => {
    expect(extractFilePath({ file_path: '/x/y.ts' })).toBe('/x/y.ts');
  });

  it('returns path when present (Kiro-style)', () => {
    expect(extractFilePath({ path: '/x/y.ts' })).toBe('/x/y.ts');
  });

  it('unwraps operations[0].path (Kiro fs_read batch shape)', () => {
    expect(
      extractFilePath({ operations: [{ mode: 'Line', path: '/foo/bar' }] }),
    ).toBe('/foo/bar');
  });

  it('returns null for tools without path-shaped input', () => {
    expect(extractFilePath({ command: 'ls' })).toBeNull();
    expect(extractFilePath(null)).toBeNull();
    expect(extractFilePath(undefined)).toBeNull();
    expect(extractFilePath('plain-string')).toBeNull();
  });
});

describe('suggestionAck', () => {
  it('returns a Vietnamese hint for every known action', () => {
    expect(suggestionAck('continue')).toMatch(/Gõ/);
    expect(suggestionAck('run-again')).toMatch(/run again|lặp lại/);
    expect(suggestionAck('rollback')).toMatch(/rollback/i);
    expect(suggestionAck('view-file')).toMatch(/show|xem/i);
    expect(suggestionAck('summarize')).toMatch(/handoff/i);
  });

  it('falls back to a marker for unknown actions instead of crashing', () => {
    expect(suggestionAck('totally-unknown')).toContain('unknown');
  });
});
