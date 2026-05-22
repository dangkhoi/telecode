import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { logger } from '../util/logger.js';

const execAsync = promisify(exec);

/**
 * Numeric nvm version comparator (descending). Matches the fix in
 * src/agents/kiro.ts — lexical sort ranks `v9.0.0` above `v22.0.0`.
 */
function compareNvmVersionsDesc(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const trimmed = v.startsWith('v') ? v.slice(1) : v;
    const parts = trimmed.split('.');
    return [
      Number.parseInt(parts[0] ?? '0', 10) || 0,
      Number.parseInt(parts[1] ?? '0', 10) || 0,
      Number.parseInt(parts[2] ?? '0', 10) || 0,
    ];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return bMaj - aMaj;
  if (aMin !== bMin) return bMin - aMin;
  return bPat - aPat;
}

/** Build enriched PATH so launchd/systemd/NSSM spawned shells find node/pnpm/npm. */
function enrichedPath(): string {
  const home = homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    // nvm-windows
    const nvmWin = path.join(appData, 'nvm');
    try {
      const versions = readdirSync(nvmWin).filter((v) => /^v\d/.test(v)).sort(compareNvmVersionsDesc);
      if (versions[0]) candidates.push(path.join(nvmWin, versions[0]));
    } catch { /* no nvm-windows */ }
    for (const p of [
      path.join(appData, 'npm'),
      path.join(localAppData, 'pnpm'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.pyenv', 'pyenv-win', 'shims'),
    ]) { if (existsSync(p)) candidates.push(p); }
  } else {
    // POSIX (macOS / Linux)
    // nvm
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    try {
      const versions = readdirSync(nvmDir).filter((d) => /^v\d/.test(d)).sort(compareNvmVersionsDesc);
      if (versions[0]) candidates.push(path.join(nvmDir, versions[0], 'bin'));
    } catch { /* no nvm */ }
    for (const p of [
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, 'Library', 'pnpm'),  // macOS corepack pnpm
      path.join(home, '.pyenv', 'shims'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]) { if (existsSync(p)) candidates.push(p); }
  }

  const existing = process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin');
  if (candidates.length === 0) return existing;
  return `${candidates.join(path.delimiter)}${path.delimiter}${existing}`;
}

export interface AutoVerifyOpts {
  command: string;
  maxRetries: number;
  agents: string[];  // empty = all agents
}

export interface VerifyResult {
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run the verify command in the given cwd.
 * Returns structured result — never throws.
 */
export async function runVerifyCommand(
  command: string,
  cwd: string,
  timeoutMs = 60_000,
): Promise<VerifyResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, PATH: enrichedPath() },
    });
    return { passed: true, stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      passed: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.code ?? null,
    };
  }
}

/**
 * Check if auto-verify should run for this agent kind.
 */
export function shouldAutoVerify(opts: AutoVerifyOpts, agent: string): boolean {
  if (opts.agents.length === 0) return true;
  return opts.agents.includes(agent);
}

/**
 * Build the follow-up prompt when verification fails.
 * Includes the test command, exit code, and truncated output.
 */
export function buildRetryPrompt(
  command: string,
  result: VerifyResult,
  attempt: number,
  maxRetries: number,
): string {
  const output = (result.stdout + '\n' + result.stderr).trim();
  // Truncate to last 2000 chars to avoid blowing up context
  const truncated = output.length > 2000 ? '…' + output.slice(-2000) : output;
  return (
    `⚠️ Auto-verify failed (attempt ${attempt}/${maxRetries}).\n` +
    `Command: \`${command}\`\n` +
    `Exit code: ${result.exitCode}\n\n` +
    `Output (last 2000 chars):\n\`\`\`\n${truncated}\n\`\`\`\n\n` +
    `Please fix the failing tests and try again.`
  );
}
