import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Plan P2.1 — scripts/install-systemd.sh / uninstall-systemd.sh
//
// We can't exercise systemd inside the test sandbox (needs a Linux user
// session bus). Instead we drive each script with --dry-run, parse the
// emitted unit file + commands, and assert structural invariants. This
// covers the template + arg parsing + atomic-write plumbing, which is what
// would actually regress in source-only changes. Real boot is deferred to
// the P5/P6 Linux VM smoke test (per plan §10).
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const INSTALL = path.join(REPO_ROOT, 'scripts', 'install-systemd.sh');
const UNINSTALL = path.join(REPO_ROOT, 'scripts', 'uninstall-systemd.sh');

interface DryRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runDry(script: string, args: string[] = [], env: Record<string, string> = {}): DryRunResult {
  const out = spawnSync('bash', [script, '--dry-run', ...args], {
    env: {
      ...process.env,
      HOME: process.env.HOME ?? '/tmp',
      // Pre-fill the prompts so the wizard never blocks.
      TELECODE_BOT_TOKEN: env.TELECODE_BOT_TOKEN ?? 'TESTTOKEN:abc123',
      TELECODE_ALLOWED_CHAT_IDS: env.TELECODE_ALLOWED_CHAT_IDS ?? '111,222',
      TELECODE_KIRO_BINARY: env.TELECODE_KIRO_BINARY ?? '',
      ...env,
    },
    encoding: 'utf8',
  });
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

// Extract the unit file body from the dry-run output. The script indents
// the rendered body with 4 spaces; we strip and re-join.
function extractUnitBody(stdout: string): string {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.includes('telecode.service (mode 0644) — body'));
  if (start < 0) throw new Error('unit body marker not found');
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('    ')) {
      body.push(line.slice(4));
    } else if (body.length > 0) {
      break;
    }
  }
  return body.join('\n');
}

function extractConfigBody(stdout: string): string {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.includes('config.yaml (mode 0600) — body'));
  if (start < 0) throw new Error('config body marker not found');
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('    ')) {
      body.push(line.slice(4));
    } else if (body.length > 0) {
      break;
    }
  }
  return body.join('\n');
}

describe('P2.1 — install-systemd.sh --dry-run', () => {
  it('scripts exist and are executable', () => {
    expect(fs.existsSync(INSTALL)).toBe(true);
    expect(fs.existsSync(UNINSTALL)).toBe(true);
    const installMode = fs.statSync(INSTALL).mode & 0o777;
    const uninstallMode = fs.statSync(UNINSTALL).mode & 0o777;
    // owner-exec bit must be set
    expect(installMode & 0o100).toBe(0o100);
    expect(uninstallMode & 0o100).toBe(0o100);
  });

  it('--help exits 0 with usage banner', () => {
    const out = spawnSync('bash', [INSTALL, '--help'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/USAGE:/);
    expect(out.stdout).toMatch(/--dry-run/);
  });

  it('rejects unknown args with non-zero exit', () => {
    const out = spawnSync('bash', [INSTALL, '--bogus'], { encoding: 'utf8' });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/unknown arg/);
  });

  it('renders a valid systemd user unit', () => {
    const result = runDry(INSTALL);
    expect(result.status).toBe(0);

    const unit = extractUnitBody(result.stdout);

    // [Unit] section
    expect(unit).toMatch(/^\[Unit\]/m);
    expect(unit).toMatch(/^Description=Telecode/m);
    expect(unit).toMatch(/^After=network-online\.target/m);

    // [Service] section — the core invariants from the plan §5
    expect(unit).toMatch(/^\[Service\]/m);
    expect(unit).toMatch(/^Type=simple$/m);
    expect(unit).toMatch(/^ExecStart=.*\/node .*dist\/index\.js/m);
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^RestartSec=5$/m);
    expect(unit).toMatch(/^Environment=TELECODE_HOME=%h\/\.telecode$/m);
    expect(unit).toMatch(/^Environment=PATH=/m);
    expect(unit).toMatch(/^StandardOutput=journal$/m);
    expect(unit).toMatch(/^StandardError=journal$/m);

    // [Install] section
    expect(unit).toMatch(/^\[Install\]/m);
    expect(unit).toMatch(/^WantedBy=default\.target$/m);
  });

  it('emits the canonical systemctl commands in order', () => {
    const result = runDry(INSTALL);
    const out = result.stdout;
    const reloadIdx = out.indexOf('systemctl --user daemon-reload');
    const enableIdx = out.indexOf('systemctl --user enable --now telecode.service');
    expect(reloadIdx).toBeGreaterThan(0);
    expect(enableIdx).toBeGreaterThan(reloadIdx);
  });

  it('renders config.yaml with chat IDs from env and kiro block when provided', () => {
    const result = runDry(INSTALL, [], {
      TELECODE_ALLOWED_CHAT_IDS: '99,100',
      TELECODE_KIRO_BINARY: '/opt/kiro/bin/kiro-cli',
    });
    expect(result.status).toBe(0);

    const config = extractConfigBody(result.stdout);
    expect(config).toMatch(/allowed_user_ids: \[99, 100\]/);
    expect(config).toMatch(/binary: \/opt\/kiro\/bin\/kiro-cli/);
    // Token reference uses env var indirection, not the literal token
    expect(config).toMatch(/bot_token: \$\{TELEGRAM_BOT_TOKEN\}/);
  });

  it('omits the kiro: block when TELECODE_KIRO_BINARY is blank', () => {
    const result = runDry(INSTALL, [], { TELECODE_KIRO_BINARY: '' });
    expect(result.status).toBe(0);
    const config = extractConfigBody(result.stdout);
    expect(config).toMatch(/binary: claude/);
    expect(config).not.toMatch(/\bkiro:\b/);
  });

  it('writes .env body containing the bot token', () => {
    const result = runDry(INSTALL, [], { TELECODE_BOT_TOKEN: 'XYZ-9876:secret' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/TELEGRAM_BOT_TOKEN=XYZ-9876:secret/);
  });

  it('rejects a REQUIRED env var set to empty (would yield a broken .env)', () => {
    // Senior-review P2 patch: an `export TELECODE_BOT_TOKEN=` in CI used to
    // silently produce an empty token and the daemon would fail later with a
    // cryptic zod error. We now fail fast at the install seam.
    const result = runDry(INSTALL, [], { TELECODE_BOT_TOKEN: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/TELECODE_BOT_TOKEN is set but empty/);
  });

  it('emits no stray blank line in agents: block when kiro is absent', () => {
    // Senior-review P2 patch: heredoc command substitution used to insert an
    // empty line between the claude block and `defaults:` whenever the optional
    // kiro block was omitted.
    const result = runDry(INSTALL, [], { TELECODE_KIRO_BINARY: '' });
    expect(result.status).toBe(0);
    const config = extractConfigBody(result.stdout);
    expect(config).toMatch(/setting_sources: \[user, project, local\]\ndefaults:/);
  });

  it('uses absolute paths in ExecStart so systemd PATH does not matter', () => {
    const result = runDry(INSTALL);
    const unit = extractUnitBody(result.stdout);
    const execStart = unit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';
    const [, command] = execStart.split('ExecStart=');
    expect(command).toBeDefined();
    // Both node + the install dir entrypoint must be absolute
    const [nodeBin] = command!.split(' ');
    expect(path.isAbsolute(nodeBin!)).toBe(true);
    expect(command!).toMatch(/\/dist\/index\.js/);
  });
});

describe('P2.1 — uninstall-systemd.sh --dry-run', () => {
  it('--help exits 0', () => {
    const out = spawnSync('bash', [UNINSTALL, '--help'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/USAGE:/);
  });

  it('emits disable + rm + daemon-reload in order with --keep-data', () => {
    const out = spawnSync('bash', [UNINSTALL, '--dry-run', '--keep-data'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const stdout = out.stdout;
    const disableIdx = stdout.indexOf('systemctl --user disable --now telecode.service');
    const rmIdx = stdout.indexOf('rm -f');
    const reloadIdx = stdout.indexOf('systemctl --user daemon-reload');
    expect(disableIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThan(disableIdx);
    expect(reloadIdx).toBeGreaterThan(rmIdx);
    // --keep-data must skip the ~/.telecode wipe
    expect(stdout).toMatch(/keeping .*\.telecode/);
  });

  it('--purge prints rm -rf of ~/.telecode', () => {
    const out = spawnSync('bash', [UNINSTALL, '--dry-run', '--purge'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/rm -rf .*\.telecode/);
  });

  it('--purge requires explicit confirm unless --yes is passed', () => {
    // Senior-review patch: plan §5 P2.1 requires a confirm prompt before
    // rm -rf. Dry-run prints the prompt-line followed by the rm; --yes
    // suppresses the prompt.
    const out = spawnSync('bash', [UNINSTALL, '--dry-run', '--purge'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/prompt: PURGE .*\.telecode\?/);
    expect(out.stdout).toMatch(/rm -rf .*\.telecode/);

    const withYes = spawnSync('bash', [UNINSTALL, '--dry-run', '--purge', '--yes'], {
      encoding: 'utf8',
    });
    expect(withYes.status).toBe(0);
    expect(withYes.stdout).not.toMatch(/prompt: PURGE/);
    expect(withYes.stdout).toMatch(/rm -rf .*\.telecode.*--yes, no confirm/);
  });

  it('rejects unknown args', () => {
    const out = spawnSync('bash', [UNINSTALL, '--bogus'], { encoding: 'utf8' });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/unknown arg/);
  });
});
