import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Override the paths module BEFORE importing the SUT so the agent file writes
// into a tmp dir instead of the real ~/.kiro/agents/telecode.json. The two
// constants resolved at import time are KIRO_AGENTS_DIR + KIRO_TELECODE_AGENT.
const TMP = mkdtempSync(join(tmpdir(), 'telecode-kiro-agent-cfg-'));
const TMP_AGENTS_DIR = join(TMP, 'agents');
const TMP_AGENT_PATH = join(TMP_AGENTS_DIR, 'telecode.json');

vi.mock('../src/util/paths.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    KIRO_AGENTS_DIR: TMP_AGENTS_DIR,
    KIRO_TELECODE_AGENT: TMP_AGENT_PATH,
  };
});

// Import AFTER the mock is registered.
const { writeKiroTelecodeAgent } = await import('../src/agents/kiro-agent-config.js');

describe('writeKiroTelecodeAgent', () => {
  afterEach(() => {
    // Clean state between tests so config-compare logic is exercised properly.
    try {
      rmSync(TMP_AGENT_PATH, { force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits config with includeMcpJson:true so global MCP servers are inherited', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/abs/path/kiro-gate.js',
      approvalTimeoutMs: 60_000,
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.includeMcpJson).toBe(true);
  });

  it('declares tools + allowedTools with both built-in (*) and MCP (@*) wildcards', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/abs/path/kiro-gate.js',
      approvalTimeoutMs: 60_000,
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.tools).toEqual(['*', '@*']);
    expect(cfg.allowedTools).toEqual(['*', '@*']);
  });

  it('registers the preToolUse hook with the gate script + timeout', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/abs/x/gate.js',
      approvalTimeoutMs: 123_456,
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.hooks.preToolUse).toEqual([
      { command: '/abs/x/gate.js', timeout_ms: 123_456 },
    ]);
  });

  it('includes optional model when provided', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/g.js',
      approvalTimeoutMs: 1000,
      model: 'claude-sonnet-4-5',
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.model).toBe('claude-sonnet-4-5');
  });

  it('omits model field when not provided', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/g.js',
      approvalTimeoutMs: 1000,
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg).not.toHaveProperty('model');
  });

  it('skips rewrite when on-disk config is byte-identical (no churn)', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/g.js',
      approvalTimeoutMs: 1000,
    });
    const mtime1 = readFileSync(TMP_AGENT_PATH, 'utf8');

    writeKiroTelecodeAgent({
      gateScriptPath: '/g.js',
      approvalTimeoutMs: 1000,
    });
    const mtime2 = readFileSync(TMP_AGENT_PATH, 'utf8');
    expect(mtime1).toBe(mtime2);
  });

  it('rewrites when previous on-disk config differs (e.g. upgrade path)', () => {
    // Simulate a stale v0.8 config (missing includeMcpJson + @* wildcard) so
    // the upgrade rewrites the file.
    writeFileSync(
      TMP_AGENT_PATH,
      JSON.stringify({ name: 'telecode', tools: ['*'], allowedTools: ['*'] }) + '\n',
    );
    writeKiroTelecodeAgent({
      gateScriptPath: '/g.js',
      approvalTimeoutMs: 1000,
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.includeMcpJson).toBe(true);
    expect(cfg.tools).toContain('@*');
  });
});
