/**
 * Phase B — pure module tests for src/session/verbosity.ts.
 *
 * Covers:
 *  - Metadata invariants (every mode has icon + name + description).
 *  - Type-guard {@link isVerbosityMode} accepts/rejects appropriately.
 *  - {@link shouldEmit} filter table per plan §B.4 (mode × event → emit).
 *  - {@link resolveMode} fallback chain (session → chat → default).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VERBOSITY_MODE,
  MODE_METADATA,
  VERBOSITY_MODES,
  isVerbosityMode,
  resolveMode,
  shouldEmit,
  type VerbosityMode,
} from '../src/session/verbosity.js';
import type { AgentEvent } from '../src/agents/types.js';

describe('verbosity: constants', () => {
  it('exposes exactly 4 modes in canonical order', () => {
    expect(VERBOSITY_MODES).toEqual(['summary', 'normal', 'thinking', 'verbose']);
  });

  it('VERBOSITY_MODES is frozen (runtime mutation rejected)', () => {
    expect(Object.isFrozen(VERBOSITY_MODES)).toBe(true);
  });

  it('default mode is normal (v1.3 — summary suppressed all text → blank-screen bug)', () => {
    expect(DEFAULT_VERBOSITY_MODE).toBe('normal');
  });

  it('MODE_METADATA has an entry per mode with non-empty fields', () => {
    for (const m of VERBOSITY_MODES) {
      const meta = MODE_METADATA[m];
      expect(meta).toBeDefined();
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(meta.displayName.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('icons are unique per mode (avoids visual aliasing in keyboards)', () => {
    const icons = VERBOSITY_MODES.map((m) => MODE_METADATA[m].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('MODE_METADATA is frozen', () => {
    expect(Object.isFrozen(MODE_METADATA)).toBe(true);
  });
});

describe('verbosity: isVerbosityMode', () => {
  it('accepts every canonical mode', () => {
    for (const m of VERBOSITY_MODES) {
      expect(isVerbosityMode(m)).toBe(true);
    }
  });

  it('rejects unknown strings + non-strings + casing variants', () => {
    expect(isVerbosityMode('Summary')).toBe(false); // case sensitive
    expect(isVerbosityMode('SUMMARY')).toBe(false);
    expect(isVerbosityMode('quiet')).toBe(false);
    expect(isVerbosityMode('')).toBe(false);
    expect(isVerbosityMode(null)).toBe(false);
    expect(isVerbosityMode(undefined)).toBe(false);
    expect(isVerbosityMode(42)).toBe(false);
    expect(isVerbosityMode({})).toBe(false);
  });
});

describe('verbosity: resolveMode', () => {
  it('session > chat > default', () => {
    expect(resolveMode('verbose', 'normal')).toBe('verbose');
    expect(resolveMode(null, 'thinking')).toBe('thinking');
    expect(resolveMode(undefined, undefined)).toBe('normal');
    expect(resolveMode(null, null)).toBe('normal');
  });

  it('session null + chat present → chat', () => {
    expect(resolveMode(null, 'normal')).toBe('normal');
    expect(resolveMode(null, 'verbose')).toBe('verbose');
  });
});

describe('verbosity: shouldEmit filter matrix (plan §B.4)', () => {
  // Helper — build a minimal AgentEvent of the given type with sane defaults.
  function mk(type: AgentEvent['type'], extra?: Partial<AgentEvent>): AgentEvent {
    switch (type) {
      case 'text':
        return { type: 'text', text: '...' } as AgentEvent;
      case 'tool_use':
        return { type: 'tool_use', tool: 'Bash', input: { command: 'ls' } } as AgentEvent;
      case 'tool_result':
        return {
          type: 'tool_result',
          tool: 'Bash',
          ok: true,
          ...(extra as object),
        } as AgentEvent;
      case 'session':
        return { type: 'session', sdkSessionId: 'sid' } as AgentEvent;
      case 'status':
        return { type: 'status', status: 'kiro_spawning' } as AgentEvent;
      case 'error':
        return { type: 'error', error: 'boom' } as AgentEvent;
      case 'done':
        return { type: 'done' } as AgentEvent;
    }
  }

  // Each row: [event variant, expected per mode].
  const MATRIX: Array<{
    name: string;
    event: AgentEvent;
    expected: Record<VerbosityMode, boolean>;
  }> = [
    {
      name: 'error always emits',
      event: mk('error'),
      expected: { summary: true, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'done always emits',
      event: mk('done'),
      expected: { summary: true, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'session always emits (housekeeping)',
      event: mk('session'),
      expected: { summary: true, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'tool_use: summary suppresses, others emit',
      event: mk('tool_use'),
      expected: { summary: false, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'tool_result ok=true: summary suppresses, others emit',
      event: mk('tool_result', { ok: true } as Partial<AgentEvent>),
      expected: { summary: false, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'tool_result ok=false: emits everywhere (errors visible)',
      event: mk('tool_result', { ok: false } as Partial<AgentEvent>),
      expected: { summary: true, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'text: summary suppresses, others emit',
      event: mk('text'),
      expected: { summary: false, normal: true, thinking: true, verbose: true },
    },
    {
      name: 'status: only verbose emits',
      event: mk('status'),
      expected: { summary: false, normal: false, thinking: false, verbose: true },
    },
  ];

  for (const row of MATRIX) {
    for (const mode of VERBOSITY_MODES) {
      it(`[${mode}] ${row.name} → ${row.expected[mode]}`, () => {
        expect(shouldEmit(row.event, mode)).toBe(row.expected[mode]);
      });
    }
  }
});
