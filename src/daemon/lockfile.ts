import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { TELECODE_HOME } from '../util/paths.js';
import { logger } from '../util/logger.js';
import path from 'node:path';

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

/** Exposed for tests — production code uses the default path. */
export const _internals = { isPidAlive, readLockfile, isFromPreviousBoot };
