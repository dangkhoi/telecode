import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const { writeKiroTelecodeAgent, renderHookCommand } = await import(
  '../src/agents/kiro-agent-config.js'
);

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

  it('declares tools + allowedTools with the documented "*" wildcard (covers built-in + MCP)', () => {
    // kiro-cli docs: `"*"` matches both built-in tools AND every MCP tool
    // from servers loaded via includeMcpJson. The undocumented `"@*"` was
    // tried first but produced no extra effect — stick with the canonical
    // single-entry array.
    writeKiroTelecodeAgent({
      gateScriptPath: '/abs/path/kiro-gate.js',
      approvalTimeoutMs: 60_000,
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.tools).toEqual(['*']);
    expect(cfg.allowedTools).toEqual(['*']);
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
    expect(cfg.tools).toEqual(['*']);
  });

  // -----------------------------------------------------------------
  // P6.5 — Hardening test coverage for writeKiroTelecodeAgent.
  // -----------------------------------------------------------------

  it('P6.5 — idempotent: two writes leave the file byte-identical (no churn)', () => {
    writeKiroTelecodeAgent({ gateScriptPath: '/abs/gate.js', approvalTimeoutMs: 60_000 });
    const first = readFileSync(TMP_AGENT_PATH, 'utf8');
    writeKiroTelecodeAgent({ gateScriptPath: '/abs/gate.js', approvalTimeoutMs: 60_000 });
    const second = readFileSync(TMP_AGENT_PATH, 'utf8');
    expect(second).toBe(first);
  });

  it('P6.5 — atomic rename: no `.tmp.<pid>` orphan is left behind on success', () => {
    writeKiroTelecodeAgent({ gateScriptPath: '/abs/gate.js', approvalTimeoutMs: 60_000 });
    const entries = readdirSync(TMP_AGENTS_DIR);
    // Only the final `telecode.json` should remain — the tmp file is renamed
    // over it. A `.tmp.<pid>` survivor would indicate a missing rename or a
    // crash mid-write.
    expect(entries.filter((e) => e.startsWith('telecode.json'))).toEqual(['telecode.json']);
  });

  it('P6.5 — mode 0o600 on POSIX (skipped on Windows where NTFS uses ACLs)', () => {
    writeKiroTelecodeAgent({ gateScriptPath: '/abs/gate.js', approvalTimeoutMs: 60_000 });
    if (process.platform === 'win32') {
      // NTFS ignores POSIX permission bits. The plan calls this out as a
      // documented no-op rather than a portability bug.
      return;
    }
    const st = statSync(TMP_AGENT_PATH);
    // Mask to the file-mode bits we care about (low 9 bits).
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('P6.5 — schema upgrade: stale v0.8 fields are FULLY replaced (no partial merge)', () => {
    // Simulate a v0.8 config with a deprecated `extraTools` field + an
    // obsolete `hooks.postToolUse` array. After the rewrite the file must
    // contain only the canonical v1.0 schema — no leftover fields from the
    // old version.
    writeFileSync(
      TMP_AGENT_PATH,
      JSON.stringify({
        name: 'telecode',
        tools: ['shell', 'fs'],
        allowedTools: ['shell', 'fs'],
        extraTools: ['legacy'],
        hooks: { postToolUse: [{ command: '/abs/old.js' }] },
      }) + '\n',
    );
    writeKiroTelecodeAgent({ gateScriptPath: '/abs/gate.js', approvalTimeoutMs: 1000 });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    // Canonical surface present.
    expect(cfg.tools).toEqual(['*']);
    expect(cfg.allowedTools).toEqual(['*']);
    expect(cfg.includeMcpJson).toBe(true);
    expect(cfg.hooks.preToolUse).toBeDefined();
    // Obsolete fields are gone (last-write-wins, no merge).
    expect(cfg).not.toHaveProperty('extraTools');
    expect(cfg.hooks).not.toHaveProperty('postToolUse');
  });

  it('P6.5 — multiple invocations with different inputs: last write wins', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/abs/v1.js',
      approvalTimeoutMs: 11_111,
      model: 'first',
    });
    writeKiroTelecodeAgent({
      gateScriptPath: '/abs/v2.js',
      approvalTimeoutMs: 22_222,
      model: 'second',
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.model).toBe('second');
    expect(cfg.hooks.preToolUse[0].command).toBe('/abs/v2.js');
    expect(cfg.hooks.preToolUse[0].timeout_ms).toBe(22_222);
  });

  it('P6.5 — write into a missing parent directory creates it (mkdir recursive)', () => {
    rmSync(TMP_AGENTS_DIR, { recursive: true, force: true });
    writeKiroTelecodeAgent({ gateScriptPath: '/abs/gate.js', approvalTimeoutMs: 1000 });
    expect(readdirSync(TMP_AGENTS_DIR)).toContain('telecode.json');
  });

  // -----------------------------------------------------------------
  // P5.3 — Windows hook command rendering (no real Windows VM needed; we
  // exercise the platform branch via the explicit `platform` opt).
  // -----------------------------------------------------------------

  it('P5.3 — POSIX hook command is the bare absolute path (shebang dispatches node)', () => {
    expect(renderHookCommand('/abs/path/kiro-gate.js', 'darwin')).toBe(
      '/abs/path/kiro-gate.js',
    );
    expect(renderHookCommand('/abs/path/kiro-gate.js', 'linux')).toBe(
      '/abs/path/kiro-gate.js',
    );
  });

  it('P5.3 — Windows hook command wraps script in `node "..."` (shebang ignored on win32)', () => {
    expect(renderHookCommand('C:\\Program Files\\telecode\\kiro-gate.js', 'win32')).toBe(
      'node "C:\\Program Files\\telecode\\kiro-gate.js"',
    );
  });

  it('P5.3 — Windows: escapes embedded double quotes in the script path to keep cmd.exe happy', () => {
    // Pathological but possible: NTFS allows literal " in file names (though
    // tools rarely emit them). Verify our defensive escape doubles the quote
    // so `node "C:\\weird\\\"path\".js"` parses as one argument.
    expect(renderHookCommand('C:\\weird\\"path".js', 'win32')).toBe(
      'node "C:\\weird\\""path"".js"',
    );
  });

  it('P5.3 — writeKiroTelecodeAgent emits Windows-style command when platform=win32', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: 'C:\\Telecode\\dist\\cli\\kiro-gate.js',
      approvalTimeoutMs: 60_000,
      platform: 'win32',
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.hooks.preToolUse[0].command).toBe(
      'node "C:\\Telecode\\dist\\cli\\kiro-gate.js"',
    );
  });

  it('P5.3 — writeKiroTelecodeAgent emits POSIX-style command when platform=linux', () => {
    writeKiroTelecodeAgent({
      gateScriptPath: '/opt/telecode/dist/cli/kiro-gate.js',
      approvalTimeoutMs: 60_000,
      platform: 'linux',
    });
    const cfg = JSON.parse(readFileSync(TMP_AGENT_PATH, 'utf8'));
    expect(cfg.hooks.preToolUse[0].command).toBe('/opt/telecode/dist/cli/kiro-gate.js');
  });
});
