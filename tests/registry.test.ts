import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.js';
import type { AgentAdapter, AdapterMetadata } from '../src/agents/types.js';

// ---------------------------------------------------------------------------
// Plan P1.1 — AgentRegistry open-set behaviour
//
// Verifies:
//   1. register/get/list round-trip with metadata
//   2. duplicate kind throws
//   3. require returns adapter / lists known kinds on miss
//   4. list() returns deterministic sorted order
//   5. has() / kinds() reflect registrations
//   6. adapter factories instantiate lazily (and only once)
//   7. plugin demo — adding a fake "mock" adapter shows up in list/picker
// ---------------------------------------------------------------------------

function stubAdapter(kind: string): AgentAdapter {
  return { kind, run: async () => {} };
}

const claudeMeta: AdapterMetadata = {
  kind: 'claude',
  displayName: 'Claude',
  badge: '🤖',
  description: 'Anthropic SDK',
};
const kiroMeta: AdapterMetadata = {
  kind: 'kiro',
  displayName: 'Kiro',
  badge: '⚡',
};

describe('AgentRegistry (plan P1.1)', () => {
  it('register / get round-trip works with metadata', () => {
    const r = new AgentRegistry();
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    expect(r.has('claude')).toBe(true);
    expect(r.get('claude')?.kind).toBe('claude');
    const meta = r.list().find((m) => m.kind === 'claude');
    expect(meta?.displayName).toBe('Claude');
    expect(meta?.badge).toBe('🤖');
  });

  it('duplicate kind throws', () => {
    const r = new AgentRegistry();
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    expect(() => r.register('claude', () => stubAdapter('claude'), claudeMeta)).toThrow(
      /already registered/,
    );
  });

  it('metadata kind mismatch throws', () => {
    const r = new AgentRegistry();
    expect(() =>
      r.register('claude', () => stubAdapter('claude'), { ...claudeMeta, kind: 'kiro' }),
    ).toThrow(/does not match/);
  });

  it('require returns adapter when registered', () => {
    const r = new AgentRegistry();
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    expect(r.require('claude').kind).toBe('claude');
  });

  it('require throws helpful error with known kinds list on miss', () => {
    const r = new AgentRegistry();
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    r.register('kiro', () => stubAdapter('kiro'), kiroMeta);
    try {
      r.require('codex');
      throw new Error('should have thrown');
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("unknown agent kind 'codex'");
      expect(msg).toContain('claude');
      expect(msg).toContain('kiro');
    }
  });

  it('get returns undefined for unknown kind (non-throwing)', () => {
    const r = new AgentRegistry();
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    expect(r.get('codex')).toBeUndefined();
  });

  it('list returns metadata sorted by kind for stable UI rendering', () => {
    const r = new AgentRegistry();
    r.register('kiro', () => stubAdapter('kiro'), kiroMeta);
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    const out = r.list();
    expect(out.map((m) => m.kind)).toEqual(['claude', 'kiro']);
  });

  it('kinds() returns sorted kinds', () => {
    const r = new AgentRegistry();
    r.register('kiro', () => stubAdapter('kiro'), kiroMeta);
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    expect(r.kinds()).toEqual(['claude', 'kiro']);
  });

  it('factory invoked lazily and memoized', () => {
    const r = new AgentRegistry();
    let calls = 0;
    r.register('claude', () => {
      calls++;
      return stubAdapter('claude');
    }, claudeMeta);
    expect(calls).toBe(0);
    const a1 = r.get('claude');
    const a2 = r.get('claude');
    expect(calls).toBe(1);
    expect(a1).toBe(a2);
  });

  // Plan P1.1 acceptance — A2 in mega-plan: "thêm adapter giả lập 'mock' chỉ
  // touch 1 file mới + 1 dòng register". We don't need a real file here; we
  // demonstrate the registration step is a single call and surfaces in
  // `list()` so the wizard picker would render a 3rd option automatically.
  it('mock-adapter demo — adding a fake adapter surfaces in picker without any other change', () => {
    const r = new AgentRegistry();
    r.register('claude', () => stubAdapter('claude'), claudeMeta);
    r.register('kiro', () => stubAdapter('kiro'), kiroMeta);

    // BEFORE: registry has 2 kinds → wizard shows 2 buttons.
    expect(r.list()).toHaveLength(2);

    // ONE-LINE adapter registration. In production this would live in
    // src/agents/index.ts; here we add it inline to prove the contract.
    r.register('mock', () => stubAdapter('mock'), {
      kind: 'mock',
      displayName: 'Mock',
      badge: '🧪',
      description: 'in-memory stub adapter',
    });

    // AFTER: registry has 3 kinds → wizard would render 3 buttons.
    const out = r.list();
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.kind)).toEqual(['claude', 'kiro', 'mock']);
    const mock = out.find((m) => m.kind === 'mock')!;
    expect(mock.displayName).toBe('Mock');
    expect(mock.badge).toBe('🧪');
  });

  it('empty registry — list / kinds return empty arrays, has is false', () => {
    const r = new AgentRegistry();
    expect(r.list()).toEqual([]);
    expect(r.kinds()).toEqual([]);
    expect(r.has('claude')).toBe(false);
  });
});
