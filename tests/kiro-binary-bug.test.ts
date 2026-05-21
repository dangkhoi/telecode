import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Regression guard — bug "kiro-cli exit ?" on fresh macOS launchd install.
//
// Pre-v1.0 the `config.example.yaml` template shipped with placeholder
// `binary: /Users/YOU/.local/bin/kiro-cli`, and `install-launchd.sh` did a
// blind `cp` of that file into `~/.telecode/config.yaml`. Fresh installs that
// only patched `allowed_user_ids` + `workspace_scan.roots` (as documented in
// the README install steps) would inherit the bogus placeholder path; the
// daemon's KiroAdapter would then `execa('/Users/YOU/.local/bin/kiro-cli')`
// → ENOENT → `kiro-cli exit ?` with empty stderr → Telegram session dead.
//
// v1.0 fix:
//   1. `config.example.yaml` now ships `binary: kiro-cli` (bare name) —
//      runtime PATH enrichment (`buildKiroMcpPath()`) prepends `~/.local/bin`
//      and friends to PATH at spawn time so execa resolves the binary.
//   2. `install-launchd.sh` auto-detects the absolute path via `command -v
//      kiro-cli` (or honours `TELECODE_KIRO_BINARY` env var) and sed-rewrites
//      the seeded config — defence-in-depth in case PATH enrichment ever
//      fails to find the binary at runtime (eg. user installed kiro-cli to a
//      non-standard location after Telecode boot).
//
// These tests are STATIC content checks — they don't run the installer.
// Running install-launchd.sh requires launchctl which isn't sandbox-safe.
// We assert the two source-file invariants that, if both hold, eliminate the
// failure mode described in the bug report.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

describe('Regression — kiro-cli ENOENT on fresh install (pre-v1.0 bug)', () => {
  it('config.example.yaml uses bare `kiro-cli`, NOT the broken `/Users/YOU/...` placeholder', () => {
    const example = readFileSync(path.join(REPO_ROOT, 'config.example.yaml'), 'utf8');

    // The broken placeholder MUST be gone (any /Users/YOU/ form):
    expect(example).not.toMatch(/\/Users\/YOU\//);

    // The kiro binary line MUST be the bare name. Anchored to match the
    // `binary: kiro-cli` line under `kiro:`, not a comment.
    const kiroBinaryLine = example
      .split('\n')
      .find((l) => /^\s+binary:\s+kiro-cli\s*$/.test(l));
    expect(kiroBinaryLine, 'config.example.yaml must have `    binary: kiro-cli` under kiro:').toBeDefined();
  });

  it('install-launchd.sh auto-resolves kiro-cli path after seeding config', () => {
    const installer = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'install-launchd.sh'),
      'utf8',
    );

    // Must lookup kiro-cli via command -v (POSIX-portable) or honour the
    // TELECODE_KIRO_BINARY override (parity with install-systemd.sh).
    expect(installer).toMatch(/TELECODE_KIRO_BINARY/);
    expect(installer).toMatch(/command -v kiro-cli/);

    // Must sed-rewrite the seeded config in place. BSD sed on macOS requires
    // `-i ''`. The substitution must target the bare `binary: kiro-cli` line.
    expect(installer).toMatch(/sed -i ''/);
    expect(installer).toMatch(/binary: kiro-cli/);
  });

  it('install-launchd.sh surfaces a warn hint when kiro-cli is missing', () => {
    const installer = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'install-launchd.sh'),
      'utf8',
    );

    // Loud install-time hint (vs the old silent placeholder) so the user
    // knows BEFORE first Kiro session attempt that the daemon will fail.
    expect(installer).toMatch(/exit \?/);
  });
});
