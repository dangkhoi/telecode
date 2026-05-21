import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, _applyOverlays, validateConfigAgainstRegistry } from '../src/config.js';

// ---------------------------------------------------------------------------
// Plan P1.1 — Config schema is open-set via z.record + post-parse overlays
//
// Verifies:
//   1. Existing claude/kiro YAML still works (backward compatibility)
//   2. An unknown adapter key passes z.record but is rejected when
//      `knownKinds` cross-check is supplied
//   3. Unknown adapter is preserved (passthrough) when no cross-check
//   4. defaults.agent now accepts any string (not just claude|kiro)
//   5. defaults.agent unknown triggers cross-check error too
// ---------------------------------------------------------------------------

function withTempConfig(yaml: string, cb: (configPath: string) => void): void {
  const d = mkdtempSync(path.join(tmpdir(), 'telecode-cfg-'));
  const p = path.join(d, 'config.yaml');
  writeFileSync(p, yaml, 'utf8');
  try {
    cb(p);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe('config schema (plan P1.1)', () => {
  it('backward compat — claude + kiro YAML loads unchanged', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
agents:
  claude:
    binary: claude
  kiro:
    binary: kiro-cli
defaults:
  agent: claude
`,
      (cfg) => {
        const c = loadConfig(cfg);
        expect(c.agents.claude?.binary).toBe('claude');
        expect(c.agents.kiro?.binary).toBe('kiro-cli');
        expect(c.defaults.agent).toBe('claude');
      },
    );
  });

  it('unknown adapter key is preserved (no cross-check)', () => {
    // `gemini` is unregistered (future v1.1+ adapter per plan §15) — use it
    // as the canonical "unknown adapter" for passthrough validation.
    // (`codex` was a placeholder before P3 made it a real overlay; `cursor`
    // was a placeholder before P4 did the same.)
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
agents:
  gemini:
    binary: gemini
    model: gemini-2.5
`,
      (cfg) => {
        const c = loadConfig(cfg);
        expect(c.agents.gemini).toBeDefined();
        expect((c.agents.gemini as Record<string, unknown>).binary).toBe('gemini');
      },
    );
  });

  it('cross-check rejects unknown adapter key with helpful message', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
agents:
  gemini:
    binary: gemini
`,
      (cfg) => {
        expect(() => loadConfig(cfg, ['claude', 'kiro'])).toThrow(/unknown agent kinds: gemini/);
      },
    );
  });

  it('cross-check rejects unknown defaults.agent', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
agents:
  claude:
    binary: claude
defaults:
  agent: gemini
`,
      (cfg) => {
        expect(() => loadConfig(cfg, ['claude', 'kiro'])).toThrow(
          /defaults\.agent='gemini' is not a registered adapter/,
        );
      },
    );
  });

  it('default agents section is allowed (empty record) when no overlay needed', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
`,
      (cfg) => {
        const c = loadConfig(cfg);
        // overlays still synthesize claude/kiro defaults so daemon code can
        // safely read them.
        expect(c.agents.claude?.binary).toBe('claude');
        expect(c.agents.kiro?.binary).toBe('kiro-cli');
      },
    );
  });

  // -------------------------------------------------------------------------
  // P1 senior-review patch — boot-time registry cross-check via
  // validateConfigAgainstRegistry. Plan §4 P1.1 promises "config has unknown
  // agent kinds: …" at boot when a user references an unregistered adapter.
  // -------------------------------------------------------------------------
  it('validateConfigAgainstRegistry — passes when every user-authored kind is registered', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
agents:
  claude:
    binary: claude
  kiro:
    binary: kiro-cli
`,
      (cfg) => {
        const c = loadConfig(cfg);
        expect(() => validateConfigAgainstRegistry(c, ['claude', 'kiro'])).not.toThrow();
      },
    );
  });

  it('validateConfigAgainstRegistry — rejects user-authored unknown kind', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
agents:
  gemini:
    binary: gemini
`,
      (cfg) => {
        const c = loadConfig(cfg);
        expect(() => validateConfigAgainstRegistry(c, ['claude', 'kiro'])).toThrow(
          /unknown agent kinds: gemini/,
        );
      },
    );
  });

  it('validateConfigAgainstRegistry — skips overlay-synthesized defaults (claude not registered)', () => {
    // Empty `agents:` — overlay synthesizes claude/kiro/codex defaults so the
    // daemon can read `config.agents.claude.binary` safely. The cross-check
    // must NOT flag these synthesized entries as "unknown kinds" because the
    // user never authored them; otherwise a build without the Claude adapter
    // (e.g. a future Codex-only deployment) would fail to boot purely due to
    // overlay bookkeeping.
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
defaults:
  agent: codex
agents:
  codex:
    command: codex
`,
      (cfg) => {
        const c = loadConfig(cfg);
        // Only `codex` is registered — synthesized `claude`/`kiro` defaults
        // must not surface as unknown.
        expect(() => validateConfigAgainstRegistry(c, ['codex'])).not.toThrow();
      },
    );
  });

  it('validateConfigAgainstRegistry — rejects unknown defaults.agent even when agents section empty', () => {
    withTempConfig(
      `
telegram:
  bot_token: '1234567890:test'
  allowed_user_ids: [1]
daemon:
  log_dir: /tmp/x
defaults:
  agent: gemini
`,
      (cfg) => {
        const c = loadConfig(cfg);
        expect(() => validateConfigAgainstRegistry(c, ['claude', 'kiro'])).toThrow(
          /defaults\.agent='gemini' is not a registered adapter/,
        );
      },
    );
  });

  it('overlay test — applyOverlays directly on parsed object', () => {
    const parsed = {
      telegram: { bot_token: '1234567890:t', allowed_user_ids: [1] },
      daemon: {
        log_dir: '/tmp',
        approval_timeout_sec: 300,
        kiro_hook_port: 0,
        workspace_scan: { roots: [], max_depth: 1, exclude: [] },
      },
      agents: {
        gemini: { binary: 'gemini', extra: 'hello' },
      },
      defaults: { agent: 'claude' },
      session_switch_preview_lines: 3,
      notifier: { debounce_ms: 3000, buffer_cap_bytes: 50_000 },
    };
    // No cross-check → gemini is preserved
    const c = _applyOverlays(parsed as never);
    expect(c.agents.gemini).toBeDefined();
    expect((c.agents.gemini as Record<string, unknown>).extra).toBe('hello');
    // With cross-check including gemini → still preserved
    const c2 = _applyOverlays(parsed as never, ['claude', 'kiro', 'gemini']);
    expect(c2.agents.gemini).toBeDefined();
  });
});
