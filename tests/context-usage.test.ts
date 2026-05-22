import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../src/agents/types.js';

describe('context-usage: AgentEvent usage variant', () => {
  it('accepts a valid usage event', () => {
    const event: AgentEvent = {
      type: 'usage',
      inputTokens: 50000,
      outputTokens: 2000,
      cacheReadTokens: 10000,
      cacheCreationTokens: 5000,
      contextWindow: 200000,
      model: 'claude-sonnet-4-20250514',
    };
    expect(event.type).toBe('usage');
    expect(event.inputTokens).toBe(50000);
    expect(event.outputTokens).toBe(2000);
    expect(event.contextWindow).toBe(200000);
    expect(event.model).toBe('claude-sonnet-4-20250514');
  });

  it('accepts usage event with optional fields omitted', () => {
    const event: AgentEvent = {
      type: 'usage',
      inputTokens: 30000,
      outputTokens: 1000,
    };
    expect(event.type).toBe('usage');
    if (event.type === 'usage') {
      expect(event.cacheReadTokens).toBeUndefined();
      expect(event.cacheCreationTokens).toBeUndefined();
      expect(event.contextWindow).toBeUndefined();
      expect(event.model).toBeUndefined();
    }
  });
});

describe('context-usage: percentage calculation', () => {
  function calcPct(inputTokens: number, contextWindow: number): number {
    return Math.round((inputTokens / contextWindow) * 100);
  }

  it('calculates 50% correctly', () => {
    expect(calcPct(100000, 200000)).toBe(50);
  });

  it('calculates 0% for zero input', () => {
    expect(calcPct(0, 200000)).toBe(0);
  });

  it('calculates 100% when at limit', () => {
    expect(calcPct(200000, 200000)).toBe(100);
  });

  it('rounds correctly', () => {
    // 33.33% → 33
    expect(calcPct(66666, 200000)).toBe(33);
    // 66.67% → 67
    expect(calcPct(133333, 200000)).toBe(67);
  });
});

describe('context-usage: formatting K vs M', () => {
  function formatMax(contextWindow: number): string {
    return contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(0)}M`
      : `${Math.round(contextWindow / 1000)}K`;
  }

  it('formats 200K context window', () => {
    expect(formatMax(200000)).toBe('200K');
  });

  it('formats 1M context window', () => {
    expect(formatMax(1_000_000)).toBe('1M');
  });

  it('formats 2M context window', () => {
    expect(formatMax(2_000_000)).toBe('2M');
  });

  it('formats 128K context window', () => {
    expect(formatMax(128000)).toBe('128K');
  });
});

describe('context-usage: 70% warning threshold', () => {
  function shouldWarn(inputTokens: number, contextWindow: number): boolean {
    const pct = Math.round((inputTokens / contextWindow) * 100);
    return pct >= 70;
  }

  it('warns at exactly 70%', () => {
    expect(shouldWarn(140000, 200000)).toBe(true);
  });

  it('warns above 70%', () => {
    expect(shouldWarn(160000, 200000)).toBe(true);
  });

  it('does not warn below 70%', () => {
    expect(shouldWarn(130000, 200000)).toBe(false);
  });

  it('does not warn at 69%', () => {
    expect(shouldWarn(138000, 200000)).toBe(false);
  });
});
