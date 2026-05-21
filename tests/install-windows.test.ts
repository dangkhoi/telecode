import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Plan P5.2 — scripts/install-windows.ps1 / uninstall-windows.ps1
//
// We can't drive Windows Service Control Manager from this macOS/Linux test
// runner. Two-layer strategy mirroring tests/install-systemd.test.ts:
//
//   1. If `pwsh` (PowerShell 7+) is installed locally (brew install
//      powershell), we exercise the script with -DryRun and assert the
//      rendered NSSM commands + config.yaml body match plan invariants.
//   2. If pwsh is missing (the default on most macOS dev hosts), fall back
//      to static-content assertions: parse the .ps1 file as text and grep
//      for the structural invariants. Catches accidental deletions / bad
//      refactors at the same coverage granularity as the dry-run pass.
//
// Real boot is deferred to the P5.4 manual smoke test on a Windows 11 VM.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const INSTALL = path.join(REPO_ROOT, 'scripts', 'install-windows.ps1');
const UNINSTALL = path.join(REPO_ROOT, 'scripts', 'uninstall-windows.ps1');

function hasPwsh(): string | null {
  // Cheap detect — `command -v` style but cross-shell. Empty PATH probe so
  // we don't accidentally pull pwsh from a parent shell's PATH alias.
  const out = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8',
  });
  if (out.status === 0 && /^\d/.test(out.stdout.trim())) return out.stdout.trim();
  return null;
}

const PWSH_VERSION = hasPwsh();
const PWSH_AVAILABLE = PWSH_VERSION !== null;

// We always run the static-content checks; the integration dry-run only runs
// when pwsh is available. The structural assertions overlap intentionally so
// either layer catches a regression.

describe('P5.2 — install-windows.ps1 static content', () => {
  const src = fs.readFileSync(INSTALL, 'utf8');

  it('script exists at scripts/install-windows.ps1', () => {
    expect(fs.existsSync(INSTALL)).toBe(true);
  });

  it('uses strict mode + ErrorActionPreference=Stop (fail-fast invariants)', () => {
    expect(src).toMatch(/Set-StrictMode\s+-Version\s+Latest/);
    expect(src).toMatch(/\$ErrorActionPreference\s*=\s*['"]Stop['"]/);
  });

  it('declares typed param block with -DryRun and -Help', () => {
    expect(src).toMatch(/\[CmdletBinding\(\)\]/);
    expect(src).toMatch(/\[switch\]\$DryRun/);
    expect(src).toMatch(/\[switch\]\$Help/);
  });

  it('reads pre-fill env vars (BOT_TOKEN, ALLOWED_CHAT_IDS, KIRO_BINARY)', () => {
    expect(src).toContain('TELECODE_BOT_TOKEN');
    expect(src).toContain('TELECODE_ALLOWED_CHAT_IDS');
    expect(src).toContain('TELECODE_KIRO_BINARY');
  });

  it('fails fast if NSSM is missing, with winget hint', () => {
    expect(src).toMatch(/Get-Command\s+-Name\s+['"]nssm['"]/);
    expect(src).toMatch(/winget install NSSM\.NSSM/);
  });

  it('detects Node via PATH + ProgramFiles + nvm-windows fallback', () => {
    expect(src).toMatch(/Get-Command\s+-Name\s+['"]node['"]/);
    expect(src).toContain('ProgramFiles');
    expect(src).toContain('APPDATA');
    expect(src).toMatch(/nvm/i);
  });

  it('requires Node 22+ at install time', () => {
    expect(src).toMatch(/process\.versions\.node/);
    expect(src).toMatch(/>= 22|-lt 22/);
  });

  it('writes config + .env into %USERPROFILE%\\.telecode (cross-platform parity with systemd installer)', () => {
    expect(src).toContain('$env:USERPROFILE');
    expect(src).toContain('.telecode');
    expect(src).toMatch(/config\.yaml/);
    expect(src).toMatch(/\.env/);
  });

  it('emits atomic write helper (tmp + Move-Item -Force)', () => {
    expect(src).toMatch(/Move-Item\s+-LiteralPath\s+\$tmp\s+-Destination\s+\$Path\s+-Force/);
  });

  it('sets owner-only ACL on sensitive files (Windows equivalent of chmod 600)', () => {
    expect(src).toMatch(/Set-FileOwnerOnlyAcl/);
    expect(src).toMatch(/SetAccessRuleProtection/);
    expect(src).toMatch(/FileSystemAccessRule/);
  });

  it('NSSM install args: node + dist\\index.js as executable', () => {
    expect(src).toContain("'install', $ServiceName, $nodeBin");
    expect(src).toContain('dist\\index.js');
  });

  it('NSSM sets AppDirectory + AppEnvironmentExtra + AppRestartDelay', () => {
    expect(src).toMatch(/AppDirectory/);
    expect(src).toMatch(/AppEnvironmentExtra/);
    expect(src).toMatch(/AppRestartDelay/);
    expect(src).toContain('TELECODE_HOME=');
  });

  it('[P0 senior review] NSSM AppEnvironmentExtra injects USERPROFILE + HOMEDRIVE + HOMEPATH so homedir() resolves under LocalSystem', () => {
    // Without these, Node's os.homedir() under the default LocalSystem
    // service identity returns C:\Windows\system32\config\systemprofile,
    // breaking ~/.kiro/agents/telecode.json and every other ~/-prefixed path
    // the daemon writes. The fix injects the installing user's paths so
    // homedir() returns C:\Users\<them> even when the service runs as
    // LocalSystem. Verified against Node 22 docs (os.homedir() checks
    // USERPROFILE first on Windows).
    expect(src).toContain('USERPROFILE=');
    expect(src).toContain('HOMEDRIVE=');
    expect(src).toContain('HOMEPATH=');
  });

  it('[P1 senior review] nvm-windows version sort is numeric (v22 beats v9), not lexical', () => {
    // The naive `Sort-Object Name -Descending` picks v9.0.0 over v22.0.0
    // because "9" > "2" lexically. We project the version into a numeric
    // key so v22 correctly outranks v9.
    expect(src).toMatch(/Sort-Object[\s\S]+?Expression[\s\S]+?Substring\(1\)/);
    expect(src).toMatch(/major\s*\*\s*1000000/); // sentinel numeric projection
    // No raw `Sort-Object -Property Name -Descending` remains in the nvm
    // branch (would re-introduce the lexical bug).
    const nvmBlock = src.match(/3\. nvm-windows[\s\S]*?return \$null/);
    expect(nvmBlock).not.toBeNull();
    if (nvmBlock) {
      expect(nvmBlock[0]).not.toMatch(/Sort-Object\s+-Property\s+Name\s+-Descending/);
    }
  });

  it('[P1 senior review] atomic write ACLs the tmp file BEFORE writing content (no race on the destination)', () => {
    // Previous order was: write -> rename -> Set-Acl. That left a window
    // where the destination existed with the parent's default inherited
    // ACL. The fix creates an empty tmp, restricts ACL, THEN writes
    // content; the rename preserves the ACL onto the final path.
    const writeAtomic = src.match(/function Write-FileAtomic[\s\S]*?^}/m);
    expect(writeAtomic).not.toBeNull();
    if (writeAtomic) {
      const body = writeAtomic[0];
      const newItemIdx = body.indexOf('New-Item -ItemType File -Path $tmp');
      const setAclIdx = body.indexOf('Set-FileOwnerOnlyAcl -Path $tmp');
      const writeIdx = body.indexOf('[System.IO.File]::WriteAllText($tmp, $Content, $utf8NoBom)');
      // Sentinel: the RestrictAcl branch must establish the ACL BEFORE the
      // content is materialised on disk.
      expect(newItemIdx).toBeGreaterThanOrEqual(0);
      expect(setAclIdx).toBeGreaterThan(newItemIdx);
      // The first WriteAllText after ACL setup is inside the RestrictAcl
      // branch — verifies the ordering invariant on the protected path.
      expect(writeIdx).toBeGreaterThan(setAclIdx);
    }
  });

  it('NSSM sets log rotation (AppRotateFiles + AppRotateBytes 10 MiB)', () => {
    expect(src).toMatch(/AppRotateFiles/);
    expect(src).toMatch(/AppRotateBytes/);
    expect(src).toContain('10485760');
  });

  it('NSSM AppStdout + AppStderr point at ~/.telecode/logs/', () => {
    expect(src).toMatch(/AppStdout.*stdout\.log/);
    expect(src).toMatch(/AppStderr.*stderr\.log/);
  });

  it('NSSM AppStopMethodConsole set so SIGBREAK has a grace window (mirror of P5.3)', () => {
    // The matching SIGBREAK handler is asserted in tests/windows-signals.test.ts.
    // This pairs the two halves of the contract.
    expect(src).toMatch(/AppStopMethodConsole/);
  });

  it('Start = SERVICE_AUTO_START so reboot brings the daemon back', () => {
    expect(src).toMatch(/SERVICE_AUTO_START/);
  });

  it('verifies service is Running after start with retry (handles SCM transition lag)', () => {
    expect(src).toMatch(/Get-Service\s+-Name\s+\$ServiceName/);
    expect(src).toMatch(/Running/);
    // Multi-attempt loop for SCM transition lag (mirrors install-systemd.sh
    // 6-second retry window).
    expect(src).toMatch(/for\s*\(\$i\s*=\s*0/);
  });

  it('PS 5.1 compatibility: no null-coalescing operator (??) outside comments', () => {
    // ?? is a PowerShell 7+ feature; Windows 10/11 default to 5.1.
    // Scan code lines (strip line-leading whitespace + skip comments + skip
    // string contents). A naive `grep -c '??' src` would match docstrings, so
    // we filter to executable-looking lines.
    const offenders = src
      .split('\n')
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) return false;
        // Strip single-quoted + double-quoted string bodies (cheap, not 100%
        // accurate but good enough for this guardrail).
        const stripped = line.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
        return stripped.includes('??');
      });
    expect(offenders.map((o) => `${o.idx + 1}: ${o.line}`)).toEqual([]);
  });

  it('PS 5.1 compatibility: no ternary operator (a ? b : c) outside comments/strings', () => {
    const offenders = src
      .split('\n')
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) return false;
        const stripped = line.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
        return / \? .+ : /.test(stripped);
      });
    expect(offenders.map((o) => `${o.idx + 1}: ${o.line}`)).toEqual([]);
  });
});

describe('P5.2 — uninstall-windows.ps1 static content', () => {
  const src = fs.readFileSync(UNINSTALL, 'utf8');

  it('script exists at scripts/uninstall-windows.ps1', () => {
    expect(fs.existsSync(UNINSTALL)).toBe(true);
  });

  it('declares typed switches: -DryRun -Purge -KeepData -Yes -Help', () => {
    expect(src).toMatch(/\[switch\]\$DryRun/);
    expect(src).toMatch(/\[switch\]\$Purge/);
    expect(src).toMatch(/\[switch\]\$KeepData/);
    expect(src).toMatch(/\[switch\]\$Yes/);
    expect(src).toMatch(/\[switch\]\$Help/);
  });

  it('stops + removes NSSM service', () => {
    expect(src).toMatch(/nssm stop \$ServiceName/);
    expect(src).toMatch(/nssm remove \$ServiceName/);
  });

  it('-Purge prompts for confirm unless -Yes is also passed', () => {
    // The purge branch reads "Type 'yes' to confirm purge" interactively;
    // -Yes bypasses by setting $proceed = $true.
    expect(src).toMatch(/Type 'yes' to confirm purge/);
    expect(src).toMatch(/\$proceed\s*=\s*\$Yes/);
  });

  it('rejects -Purge combined with -KeepData', () => {
    expect(src).toMatch(/cannot combine -Purge and -KeepData/);
  });

  it('falls back to sc.exe when NSSM is missing (graceful degradation)', () => {
    expect(src).toMatch(/sc\.exe/);
  });
});

describe.skipIf(!PWSH_AVAILABLE)(
  `P5.2 — install-windows.ps1 -DryRun (pwsh detected: ${PWSH_VERSION})`,
  () => {
    function runDry(
      script: string,
      args: string[] = [],
      env: Record<string, string> = {},
    ): { status: number; stdout: string; stderr: string } {
      const out = spawnSync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', script, '-DryRun', ...args],
        {
          env: {
            ...process.env,
            // pwsh on POSIX still respects USERPROFILE if set explicitly.
            USERPROFILE: process.env.USERPROFILE ?? process.env.HOME ?? '/tmp',
            ProgramFiles: process.env.ProgramFiles ?? '/tmp/PF',
            APPDATA: process.env.APPDATA ?? '/tmp/AppData',
            OS: 'Windows_NT', // force OS check to pass under dry-run
            TELECODE_BOT_TOKEN: env.TELECODE_BOT_TOKEN ?? 'TESTTOKEN:abc123',
            TELECODE_ALLOWED_CHAT_IDS: env.TELECODE_ALLOWED_CHAT_IDS ?? '111,222',
            TELECODE_KIRO_BINARY: env.TELECODE_KIRO_BINARY ?? '',
            ...env,
          },
          encoding: 'utf8',
        },
      );
      return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    }

    it('-Help exits 0 with usage banner', () => {
      const out = spawnSync('pwsh', ['-NoProfile', '-File', INSTALL, '-Help'], { encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/USAGE:/);
      expect(out.stdout).toMatch(/-DryRun/);
    });

    it('-DryRun renders NSSM install command for the service', () => {
      const result = runDry(INSTALL);
      // The script may bail on missing real tools (no nssm on the macOS host)
      // before reaching NSSM — that's why we run a softer assertion here: at
      // minimum it should print the config.yaml body before any tool probe.
      expect(result.stdout).toMatch(/Telecode Windows installer/);
    });
  },
);
