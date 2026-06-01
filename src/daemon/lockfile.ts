import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TELECODE_HOME } from '../util/paths.js';
import { logger } from '../util/logger.js';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * P6.3 — Single-instance daemon lockfile.
 *
 * Problem: two daemons running at once (typical accident: launchd boot AND a
 * dev `npm start`) race over `~/.kiro/agents/telecode.json` (rewrites stomp on
 * each other), both bind ephemeral hook-server ports, and both poll Telegram.
 * The second login wins on Telegram's side so the first daemon goes silent
 * but keeps writing logs — symptom hard to diagnose.
 *
 * Decision (plan §9 P6.3): roll-our-own lockfile under `~/.telecode/daemon.lock`.
 * We considered `proper-lockfile` (npm) which is mature and handles edge cases
 * (clock skew, retries, stale detection) — but:
 *
 *   - the dependency adds ~6 KB unminified + 1 transitive (`signal-exit`)
 *   - we only need a one-shot acquire-on-boot, release-on-shutdown — not the
 *     retry-loop locking semantics that justify `proper-lockfile`'s complexity
 *   - rolling our own keeps the cross-platform contract crystal clear: PID
 *     liveness via `process.kill(pid, 0)` (Context7 verified to work on
 *     Windows — Node sends a "0 signal" that just checks the handle), atomic
 *     create via `openSync(…, 'wx')` (returns EEXIST if file exists)
 *
 * Cross-platform notes:
 *   - POSIX: `kill -0` is the canonical liveness probe.
 *   - Windows: Node's `process.kill(pid, 0)` does NOT send a signal; it opens
 *     a process handle with PROCESS_QUERY_INFORMATION and closes it. Returns
 *     true if the PID maps to a live process, throws ESRCH otherwise. Same
 *     observable behaviour as POSIX → no platform branch needed here.
 *   - `openSync('wx')` is atomic on every fs Node ships with (NTFS / APFS /
 *     ext4 / btrfs / zfs) — the OS-level open(2) `O_CREAT|O_EXCL` does the
 *     work. We do NOT need flock(2) (POSIX-only, and Windows mandatory locks
 *     are uglier than O_EXCL).
 *
 * Caveats documented in code:
 *   - PID reuse race: if the daemon is killed and the OS recycles its PID to
 *     an unrelated process within seconds, our liveness check sees the new
 *     process and refuses to boot. Mitigation: the lockfile records the
 *     daemon's start time; we compare it to current system boot time
 *     (`os.uptime()`) and treat any lockfile written BEFORE this boot as
 *     stale unconditionally — after a reboot, ALL old PIDs are gone even if
 *     the kernel has now reused those numbers for new processes. This fully
 *     covers the reboot case (the common one — launchd boots us early and
 *     low PIDs like 862 are often reused by system daemons). Mid-uptime PID
 *     reuse without reboot remains best-effort but is vanishingly rare in
 *     practice (max_pid is 4M on Linux, 99999 on macOS).
 */

const LOCK_PATH = path.join(TELECODE_HOME, 'daemon.lock');

interface LockfileContents {
  pid: number;
  /** Wall-clock ms when the daemon booted. Used to break PID-reuse ties. */
  startedAtMs: number;
  /** Hostname for diagnostics on shared filesystems (rare for ~/.telecode). */
  host?: string;
}

export class LockfileError extends Error {
  constructor(
    message: string,
    public readonly heldByPid?: number,
  ) {
    super(message);
    this.name = 'LockfileError';
  }
}

/**
 * Returns `true` if `startedAtMs` is older than the current system boot.
 * Such a lockfile cannot belong to a still-running process — every PID was
 * wiped at boot. We allow a small slop window (5s) to absorb measurement
 * variance between `Date.now()` (wall-clock, can jump with NTP) and
 * `os.uptime()` (monotonic since boot; fractional on POSIX, integer-only on
 * Windows per the Node v24 docs — the 5s slop comfortably covers both).
 *
 * Known limitation: if the system clock jumps FORWARD by more than 5s AFTER
 * a daemon writes its lockfile (e.g. NTP correcting a wildly-wrong RTC at
 * first boot), a still-running daemon's lock can be misclassified as
 * previous-boot. This is acceptable because:
 *   (a) the alternative — PID reuse after reboot booting launchd into a
 *       restart loop — is the bug we're actively fixing;
 *   (b) the affected daemon is single-instance under launchd/systemd which
 *       will restart it, and the new acquireLock will succeed cleanly.
 *
 * Exposed via `_internals` for tests.
 */
function isFromPreviousBoot(startedAtMs: number, nowMs = Date.now(), uptimeSec = os.uptime()): boolean {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(uptimeSec) || uptimeSec < 0) {
    return false;
  }
  const systemBootMs = nowMs - uptimeSec * 1000;
  const SLOP_MS = 5_000;
  return startedAtMs < systemBootMs - SLOP_MS;
}

/**
 * Verify a PID is currently alive. Returns `false` for PIDs <= 0 (defensive
 * — `process.kill(0, 0)` would send a signal to every process in the
 * process group on POSIX, which is not what we want) or PIDs that don't
 * exist (ESRCH). EPERM on POSIX means "process exists but you can't signal
 * it" — that's still "alive" for our purpose.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // process exists, just not ours to signal
    // Anything else (EINVAL, etc.) — be conservative, treat as alive so we
    // don't stomp another daemon by mistake. The caller can override via the
    // explicit "remove the lockfile" message.
    return true;
  }
}

function readLockfile(path: string): LockfileContents | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockfileContents>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    if (typeof parsed.startedAtMs !== 'number') return undefined;
    return parsed as LockfileContents;
  } catch {
    return undefined;
  }
}

/**
 * Acquire the singleton lock. Throws `LockfileError` if another live daemon
 * already holds it; overwrites silently if the lockfile is stale (dead PID
 * or malformed).
 *
 * Returns a `release()` thunk that the caller wires to SIGINT/SIGTERM. The
 * release is idempotent — calling it twice is safe (a removed-then-recreated
 * lockfile from a NEW boot won't be clobbered because we re-read the PID
 * before unlinking).
 */
export function acquireLock(opts: { lockPath?: string } = {}): { release: () => void; path: string } {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  mkdirSync(dirname(lockPath), { recursive: true });

  const ownPid = process.pid;
  const ownStart = Date.now();

  // Probe existing lockfile FIRST so we can give a friendly message before
  // racing on O_EXCL.
  if (existsSync(lockPath)) {
    const prev = readLockfile(lockPath);
    if (prev && isFromPreviousBoot(prev.startedAtMs)) {
      // Lockfile predates current boot — every PID from then is gone, even
      // if the kernel now reuses that number for a system daemon (the bug
      // that caused the launchd restart loop after reboot).
      logger.info(
        { lockPath, prev, reason: 'previous-boot' },
        'removing stale daemon lockfile (predates current system boot)',
      );
    } else if (prev && isPidAlive(prev.pid) && prev.pid !== ownPid) {
      logger.warn(
        { heldByPid: prev.pid, lockPath },
        'daemon lockfile already held by a live process — refusing to boot',
      );
      throw new LockfileError(
        `Telecode daemon đã chạy với PID ${prev.pid}. Dừng tiến trình đó trước, ` +
          `hoặc xóa lockfile ${lockPath} nếu bạn chắc nó là stale.`,
        prev.pid,
      );
    } else {
      // Stale (no parseable PID, or dead PID): remove and continue. We log
      // so ops can see it in the rare case it happens.
      logger.info({ lockPath, prev }, 'removing stale daemon lockfile');
    }
    try {
      unlinkSync(lockPath);
    } catch (err) {
      logger.warn({ err: String(err), lockPath }, 'failed to remove stale lockfile (will retry write)');
    }
  }

  // Atomic create — if a peer slipped in between the existsSync check and
  // here, O_EXCL fails with EEXIST and we surface the same friendly error.
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const prev = readLockfile(lockPath);
      throw new LockfileError(
        `Telecode daemon đã chạy${prev ? ` với PID ${prev.pid}` : ''}. Dừng tiến trình đó trước, ` +
          `hoặc xóa lockfile ${lockPath} nếu bạn chắc nó là stale.`,
        prev?.pid,
      );
    }
    throw err;
  }
  // P5 senior review (Opus 4.7) [P2]: Windows doesn't set HOSTNAME; use
  // COMPUTERNAME as fallback so the diagnostic field isn't always blank on
  // Win11 hosts. The field is best-effort metadata for shared-fs scenarios
  // (extremely rare for ~/.telecode), so any non-null name is fine.
  const contents: LockfileContents = {
    pid: ownPid,
    startedAtMs: ownStart,
    host: process.env.HOSTNAME ?? process.env.COMPUTERNAME,
  };
  writeSync(fd, JSON.stringify(contents) + '\n');
  closeSync(fd);
  logger.info({ pid: ownPid, lockPath }, 'daemon lockfile acquired');

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const current = readLockfile(lockPath);
      // Only delete if it's still OUR lock — protects against the edge case
      // where the file was removed + recreated by another daemon during a
      // signal-handler race.
      if (current && current.pid === ownPid && current.startedAtMs === ownStart) {
        unlinkSync(lockPath);
      }
    } catch (err) {
      logger.warn({ err: String(err), lockPath }, 'lockfile release failed (non-fatal)');
    }
  };
  return { release, path: lockPath };
}

/**
 * POSIX-only orphan scan: enumerate live processes whose command line is a
 * node-family invocation AND contains `entrypoint` as a substring, excluding
 * our own PID. Returns [] on Windows.
 *
 * Why this exists (incident 2026-06-01): the launchd-managed daemon
 * received SIGTERM during a network outage; grammY's stop() was awaiting
 * a Telegram `getUpdates` request that never resolved, so the shutdown
 * `await` chain hung and `process.exit(0)` was never reached. The process
 * stayed alive holding loopback ports + SQLite WAL for 8 days; the
 * lockfile was eventually marked stale by the previous-boot heuristic,
 * and a fresh daemon booted alongside it — two daemons polling the same
 * bot token caused intermittent 409 Conflict and bot "freeze". The hard
 * exit timer in index.ts prevents new orphans; this function reaps any
 * that already exist at boot.
 *
 * Safety [senior review 2026-06-01, P1]: bare substring match would
 * happily reap any process whose argv mentions the entrypoint path —
 * `vim dist/index.js`, `tail -f dist/index.js`, `grep -r 'foo' dist/`,
 * an IDE language-server indexing the file, even a backup tool. We
 * additionally require the FIRST whitespace-delimited token (the
 * executable) to look like a node interpreter (`node`, `node.exe`) or a
 * known node-launcher (`tsx`). Editors and viewers fail this check.
 */
function looksLikeNodeInvocation(commandLine: string): boolean {
  // First whitespace-delimited token = the executable path as exec'd. We
  // can't perfectly handle paths with embedded spaces (exec preserves them
  // but ps' rendering is space-separated), but node binaries practically
  // never live at such paths, so basename matching on the first token is a
  // sound heuristic.
  const trimmed = commandLine.trimStart();
  const firstSpace = trimmed.search(/\s/);
  const exe = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  // Strip any trailing parens macOS sometimes adds for process states.
  const base = exe.split('/').pop() ?? exe;
  // Match: node, node.exe, node-<version>, tsx, tsx.cmd, bun (also acceptable
  // as a node-compat runtime), deno (less common, future-proof).
  return /^(node(\.exe)?|tsx(\.cmd)?|bun|deno)(\b|$|-)/.test(base);
}

async function findOrphanDaemons(entrypoint: string, ownPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  if (!entrypoint) return [];
  try {
    // `ps -A`: all processes. `-ww`: don't truncate the command field on
    // macOS (default truncates to terminal width, which would chop long
    // node entrypoint paths and break our substring match). `-o pid=,command=`:
    // suppress headers, output "pid command" per line.
    const { stdout } = await execFileAsync('ps', ['-Awwo', 'pid=,command='], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const pids: number[] = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!m || m[1] === undefined || m[2] === undefined) continue;
      const pid = Number(m[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === ownPid) continue;
      const command = m[2];
      if (!command.includes(entrypoint)) continue;
      if (!looksLikeNodeInvocation(command)) {
        logger.debug(
          { pid, command: command.slice(0, 200) },
          'orphan scan: skipping non-node match (editor/viewer/etc.)',
        );
        continue;
      }
      pids.push(pid);
    }
    return pids;
  } catch (err) {
    logger.warn({ err: String(err) }, 'orphan-daemon scan failed (skipping)');
    return [];
  }
}

async function sigtermThenSigkill(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    logger.warn({ pid, err: String(err) }, 'SIGTERM to orphan failed');
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Escalate: SIGKILL cannot be caught — guarantees the process dies even
  // if its SIGTERM handler is stuck in a hung await (the exact failure mode
  // the original orphan exhibited).
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
  await new Promise((r) => setTimeout(r, 200));
  return !isPidAlive(pid);
}

/**
 * Boot-time orphan reaper. Call AFTER `acquireLock()` so this process is
 * the legitimate lockfile holder by construction — any other live process
 * matching `entrypoint` is by definition an orphan (not a sibling daemon
 * we'd otherwise refuse to displace).
 *
 * Returns the PIDs successfully reaped (dead by SIGTERM or SIGKILL).
 */
export async function killOrphanDaemons(
  opts: { entrypoint?: string; timeoutMs?: number } = {},
): Promise<number[]> {
  const entrypoint = opts.entrypoint ?? process.argv[1];
  if (!entrypoint) return [];
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const candidates = await findOrphanDaemons(entrypoint, process.pid);
  if (candidates.length === 0) return [];
  logger.warn({ candidates, entrypoint }, 'orphan daemon(s) detected — reaping');
  const reaped: number[] = [];
  for (const pid of candidates) {
    if (await sigtermThenSigkill(pid, timeoutMs)) reaped.push(pid);
  }
  return reaped;
}

/** Exposed for tests — production code uses the default path. */
export const _internals = {
  isPidAlive,
  readLockfile,
  isFromPreviousBoot,
  findOrphanDaemons,
  looksLikeNodeInvocation,
};
