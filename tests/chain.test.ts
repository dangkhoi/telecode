import { describe, it, expect } from 'vitest';
import { parseChain, injectPreviousOutput, validateChainAgents } from '../src/bot/chain.js';

describe('parseChain', () => {
  it('parses a valid 2-step chain with agent prefixes', () => {
    const result = parseChain('claude: write tests | kiro: review code', 'claude');
    expect(result).toEqual([
      { agent: 'claude', prompt: 'write tests' },
      { agent: 'kiro', prompt: 'review code' },
    ]);
  });

  it('parses chain with mixed agent prefixes', () => {
    const result = parseChain('codex: generate | cursor: refactor | claude: test', 'claude');
    expect(result).toEqual([
      { agent: 'codex', prompt: 'generate' },
      { agent: 'cursor', prompt: 'refactor' },
      { agent: 'claude', prompt: 'test' },
    ]);
  });

  it('uses default agent when no prefix', () => {
    const result = parseChain('write tests | review code', 'kiro');
    expect(result).toEqual([
      { agent: 'kiro', prompt: 'write tests' },
      { agent: 'kiro', prompt: 'review code' },
    ]);
  });

  it('returns error when less than 2 steps', () => {
    const result = parseChain('only one step', 'claude');
    expect(result).toEqual({ error: 'Chain cần ít nhất 2 steps (phân cách bằng |).' });
  });

  it('returns error when more than 5 steps', () => {
    const result = parseChain('a: 1 | b: 2 | c: 3 | d: 4 | e: 5 | f: 6', 'claude');
    expect(result).toEqual({ error: 'Chain tối đa 5 steps.' });
  });

  it('returns error when step has empty prompt', () => {
    const result = parseChain('claude: | kiro: do something', 'claude');
    expect(result).toEqual({ error: 'Step "claude" không có prompt.' });
  });

  it('handles prompts containing colons after the agent prefix', () => {
    const result = parseChain('claude: fix this: error | kiro: review', 'claude');
    expect(result).toEqual([
      { agent: 'claude', prompt: 'fix this: error' },
      { agent: 'kiro', prompt: 'review' },
    ]);
  });

  it('does not treat long prefix (>20 chars) as agent', () => {
    const result = parseChain('thisisaverylongprefix: foo | bar', 'claude');
    expect(result).toEqual([
      { agent: 'claude', prompt: 'thisisaverylongprefix: foo' },
      { agent: 'claude', prompt: 'bar' },
    ]);
  });
});

describe('injectPreviousOutput', () => {
  it('replaces {{prev}} token with previous output', () => {
    const result = injectPreviousOutput('review this: {{prev}}', 'hello world');
    expect(result).toBe('review this: hello world');
  });

  it('replaces multiple {{prev}} tokens', () => {
    const result = injectPreviousOutput('{{prev}} and also {{prev}}', 'data');
    expect(result).toBe('data and also data');
  });

  it('prepends previous output when no {{prev}} token', () => {
    const result = injectPreviousOutput('review the code', 'function foo() {}');
    expect(result).toBe(
      'Previous step output:\n\nfunction foo() {}\n\n---\n\nreview the code',
    );
  });
});

describe('validateChainAgents', () => {
  it('returns null when all agents are registered', () => {
    const steps = [
      { agent: 'claude', prompt: 'test' },
      { agent: 'kiro', prompt: 'review' },
    ];
    const result = validateChainAgents(steps, ['claude', 'kiro', 'codex']);
    expect(result).toBeNull();
  });

  it('returns error message for unknown agent', () => {
    const steps = [
      { agent: 'claude', prompt: 'test' },
      { agent: 'unknown', prompt: 'review' },
    ];
    const result = validateChainAgents(steps, ['claude', 'kiro']);
    expect(result).toBe('Agent "unknown" không được đăng ký. Có: claude, kiro');
  });
});
