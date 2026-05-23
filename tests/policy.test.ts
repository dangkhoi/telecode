import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyEngine } from '../src/approval/policy.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telecode-policy-'));
  path = join(dir, 'policy.yaml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(content: string) {
  writeFileSync(path, content);
}

describe('PolicyEngine', () => {
  it('plain tool name allow matches', () => {
    write('allow:\n  - Read\ndeny: []\n');
    const p = new PolicyEngine(path);
    expect(p.decide('Read', { file_path: '/x' }).decision).toBe('allow');
  });

  it('deny beats allow', () => {
    write('allow:\n  - Bash(*)\ndeny:\n  - "Bash(rm -rf*)"\n');
    const p = new PolicyEngine(path);
    expect(p.decide('Bash', { command: 'rm -rf /tmp/x' }).decision).toBe('deny');
    expect(p.decide('Bash', { command: 'ls' }).decision).toBe('allow');
  });

  it('asks when no rule matches', () => {
    write('allow:\n  - Read\ndeny: []\n');
    const p = new PolicyEngine(path);
    expect(p.decide('Bash', { command: 'git push' }).decision).toBe('ask');
  });

  it('substitutes {{project_dir}}', () => {
    write('allow:\n  - "Edit({{project_dir}}/**)"\ndeny: []\n');
    const p = new PolicyEngine(path);
    expect(
      p.decide('Edit', { file_path: '/Users/<you>/work/x/foo.ts' }, { projectDir: '/Users/<you>/work/x' }).decision,
    ).toBe('allow');
    expect(
      p.decide('Edit', { file_path: '/etc/passwd' }, { projectDir: '/Users/<you>/work/x' }).decision,
    ).toBe('ask');
  });

  it('appendAllow is atomic and adds rule', () => {
    write('allow: []\ndeny: []\n');
    const p = new PolicyEngine(path);
    p.appendAllow('Bash(npm run lint)');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('Bash(npm run lint)');
    expect(p.decide('Bash', { command: 'npm run lint' }).decision).toBe('allow');
  });

  it('non-existent file produces empty policy that asks for everything', () => {
    const p = new PolicyEngine(join(dir, 'no.yaml'));
    expect(p.decide('Read', {}).decision).toBe('ask');
  });

  it('expands leading ~ in patterns to user home (regression: SSH deny rule)', () => {
    write('allow: []\ndeny:\n  - "Edit(~/.ssh/**)"\n');
    const p = new PolicyEngine(path);
    const sshPath = `${homedir()}/.ssh/id_rsa`;
    expect(p.decide('Edit', { file_path: sshPath }).decision).toBe('deny');
    // a literal '~' in the actual file path should NOT match (we want real home only)
    expect(p.decide('Edit', { file_path: '/some/other/path' }).decision).toBe('ask');
  });

  it('matches multiline Bash commands (dotAll regex)', () => {
    write('allow:\n  - "Bash(npm run *)"\ndeny: []\n');
    const p = new PolicyEngine(path);
    expect(p.decide('Bash', { command: 'npm run build\n# trailing' }).decision).toBe('allow');
  });

  it('curl pipe-to-shell deny pattern actually fires', () => {
    write('allow: []\ndeny:\n  - "Bash(curl * | sh*)"\n');
    const p = new PolicyEngine(path);
    expect(p.decide('Bash', { command: 'curl https://x/install.sh | sh' }).decision).toBe('deny');
  });

  it('kiro read tool uses tool_input.operations[0].path for matching', () => {
    // kiro-cli's `read` payload nests path inside operations[]. Without
    // unwrapping this, deny rules like `read(~/.ssh/**)` silently no-op.
    write('allow: []\ndeny:\n  - "read(/etc/passwd*)"\n');
    const p = new PolicyEngine(path);
    expect(
      p.decide('read', { operations: [{ mode: 'Line', path: '/etc/passwd' }] }).decision,
    ).toBe('deny');
  });

  it('kiro shell + execute_bash commands match Bash-style rules', () => {
    write('allow: []\ndeny:\n  - "shell(rm -rf*)"\n  - "execute_bash(rm -rf*)"\n');
    const p = new PolicyEngine(path);
    expect(p.decide('shell', { command: 'rm -rf /tmp/x' }).decision).toBe('deny');
    expect(p.decide('execute_bash', { command: 'rm -rf /tmp/x' }).decision).toBe('deny');
  });

  // -------------------------------------------------------------------------
  // P0.4 — appendRule + buildPattern (Forever button persistence)
  // -------------------------------------------------------------------------

  describe('P0.4 appendRule (Forever 2-step confirm persistence)', () => {
    it('buildPattern produces escaped Tool(arg) form from object input', () => {
      // Bash command should round-trip through the literal-escape path:
      // glob meta `*` becomes `\*` so it's exact-match in the persisted rule.
      const pat = PolicyEngine.buildPattern('Bash', { command: 'rm -rf /tmp/x' });
      expect(pat).toBe('Bash(rm -rf /tmp/x)');
      // A command WITH a `*` literal must be escaped so future calls match
      // verbatim (not glob).
      const pat2 = PolicyEngine.buildPattern('Bash', { command: 'echo *' });
      expect(pat2).toBe('Bash(echo \\*)');
    });

    it('buildPattern returns bare tool name when input has no meaningful args', () => {
      expect(PolicyEngine.buildPattern('Read', {})).toBe('Read');
      expect(PolicyEngine.buildPattern('Read', '')).toBe('Read');
    });

    it('appendRule persists a literal allow rule + decide() resolves it', () => {
      write('allow: []\ndeny: []\n');
      const p = new PolicyEngine(path);
      p.appendRule('Bash', { command: 'npm run lint' }, 'allow_always');
      const yaml = readFileSync(path, 'utf8');
      expect(yaml).toContain('Bash(npm run lint)');
      // The persisted rule must auto-allow the same command in a fresh
      // PolicyEngine — verifies the atomic write actually landed on disk.
      const fresh = new PolicyEngine(path);
      expect(fresh.decide('Bash', { command: 'npm run lint' }).decision).toBe('allow');
    });

    it('appendRule is atomic — tmp file is renamed not concatenated', () => {
      write('allow: []\ndeny: []\n');
      const p = new PolicyEngine(path);
      p.appendRule('fs_write', { path: '/tmp/foo.txt' }, 'allow_always');
      // Verify the directory does NOT contain a stray .tmp.* file once
      // appendRule returns — proves the rename succeeded.
      const tmps = readdirSync(dir).filter((f) => f.includes('.tmp.'));
      expect(tmps).toEqual([]);
      // Re-load + recheck — content is the new rule, not appended.
      const reloaded = readFileSync(path, 'utf8');
      const matches = (reloaded.match(/fs_write\(/g) ?? []).length;
      expect(matches).toBe(1);
    });

    it('appendRule rejects unsupported decisions to leave room for future deny-forever', () => {
      write('allow: []\ndeny: []\n');
      const p = new PolicyEngine(path);
      // We accept the current sole-supported decision; anything else must
      // throw rather than silently no-op (would mask a UI wiring bug).
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        p.appendRule('Bash', { command: 'x' }, 'deny_forever' as any),
      ).toThrow(/unsupported decision/);
    });
  });
});
