import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';

function makeStore(): { store: SessionStore; cleanup: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'telecode-cost-'));
  const store = new SessionStore(join(d, 's.db'));
  return { store, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

describe('cost_log table + store methods', () => {
  let store: SessionStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeStore());
  });
  afterEach(() => cleanup());

  it('logCost inserts a row and getCostBySession returns sum', () => {
    store.logCost('s1', 100, 'claude', 1000, 500, 0.01);
    store.logCost('s1', 100, 'claude', 2000, 1000, 0.02);
    const c = store.getCostBySession('s1');
    expect(c.total_cost).toBeCloseTo(0.03);
    expect(c.input_tokens).toBe(3000);
    expect(c.output_tokens).toBe(1500);
  });

  it('getCostBySession returns zeros for unknown session', () => {
    const c = store.getCostBySession('nonexistent');
    expect(c.total_cost).toBe(0);
    expect(c.input_tokens).toBe(0);
    expect(c.output_tokens).toBe(0);
  });

  it('getCostByChat sums all sessions in a chat', () => {
    store.logCost('s1', 42, 'claude', 100, 50, 0.005);
    store.logCost('s2', 42, 'kiro', 200, 100, 0.01);
    store.logCost('s3', 99, 'claude', 999, 999, 0.99); // different chat
    const c = store.getCostByChat(42);
    expect(c.total_cost).toBeCloseTo(0.015);
    expect(c.input_tokens).toBe(300);
  });

  it('getCostByChat filters by sinceDaysAgo', () => {
    // Insert a row with old timestamp
    store.db
      .prepare(
        `INSERT INTO cost_log (session_id,chat_id,agent,input_tokens,output_tokens,cost_usd,created_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run('s1', 42, 'claude', 100, 50, 0.1, Date.now() - 10 * 86_400_000); // 10 days ago
    store.logCost('s1', 42, 'claude', 200, 100, 0.05); // now
    const week = store.getCostByChat(42, 7);
    expect(week.total_cost).toBeCloseTo(0.05);
    const month = store.getCostByChat(42, 30);
    expect(month.total_cost).toBeCloseTo(0.15);
  });

  it('getCostBreakdown groups by agent', () => {
    store.logCost('s1', 42, 'claude', 1000, 500, 0.01);
    store.logCost('s2', 42, 'kiro', 2000, 1000, 0.02);
    store.logCost('s3', 42, 'claude', 500, 250, 0.005);
    const breakdown = store.getCostBreakdown(42);
    expect(breakdown).toHaveLength(2);
    const claude = breakdown.find((b) => b.agent === 'claude')!;
    const kiro = breakdown.find((b) => b.agent === 'kiro')!;
    expect(claude.total_cost).toBeCloseTo(0.015);
    expect(claude.input_tokens).toBe(1500);
    expect(kiro.total_cost).toBeCloseTo(0.02);
    expect(kiro.input_tokens).toBe(2000);
  });

  it('getCostBreakdown returns empty array when no data', () => {
    const breakdown = store.getCostBreakdown(42);
    expect(breakdown).toEqual([]);
  });
});
