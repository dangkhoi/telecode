import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  LockfileError,
  _internals,
} from '../src/daemon/lockfile.js';

describe('P6.3 daemon lockfile', () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'telecode-lockfile-test-'));
    lockPath = join(tmp, 'daemon.lock');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(_internals.isPidAlive(process.pid)).toBe(true);
    });

    it('returns false for a (vanishingly-likely-dead) high PID', () => {
      // PID 2_147_483_646 is just below INT_MAX — extremely unlikely to be live.
      // Linux max_pid defaults to 4M, macOS defaults to 99999.
      expect(_internals.isPidAlive(2_147_483_646)).toBe(false);
    });

    it('returns false for non-positive / non-integer / zero pids', () => {
      expect(_internals.isPidAlive(0)).toBe(false);
      expect(_internals.isPidAlive(-1)).toBe(false);
      expect(_internals.isPidAlive(1.5)).toBe(false);
      expect(_internals.isPidAlive(Number.NaN)).toBe(false);
    });
  });

  describe('acquireLock', () => {
    it('writes a lockfile with our PID and start time', () => {
      const { release, path } = acquireLock({ lockPath });
      expect(path).toBe(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(process.pid);
      expect(typeof contents.startedAtMs).toBe('number');
      release();
    });

    it('removes the lockfile on release', () => {
      const { release } = acquireLock({ lockPath });
      expect(existsSync(lockPath)).toBe(true);
      release();
      expect(existsSync(lockPath)).toBe(false);
    });

    it('is idempotent — second release() is a no-op', () => {
      const { release } = acquireLock({ lockPath });
      release();
      release(); // should not throw
      expect(existsSync(lockPath)).toBe(false);
    });

    it('overwrites a STALE lockfile (dead PID)', () => {
      // Stale lock from a previous crashed daemon — pid points at a process
      // that no longer exists.
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 2_147_483_646, startedAtMs: 1, host: 'stale' }),
      );
      const { release } = acquireLock({ lockPath });
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(process.pid);
      release();
    });

    it('overwrites a MALFORMED lockfile (unparseable JSON)', () => {
      writeFileSync(lockPath, 'not json at all');
      const { release } = acquireLock({ lockPath });
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(process.pid);
      release();
    });

    it('overwrites a lockfile with a non-numeric PID', () => {
      writeFileSync(lockPath, JSON.stringify({ pid: 'oops', startedAtMs: 0 }));
      const { release } = acquireLock({ lockPath });
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(process.pid);
      release();
    });

    it('treats a lockfile from BEFORE current boot as stale, even if PID is live', () => {
      // Repro of the launchd restart loop bug: machine reboots, kernel
      // reassigns the old daemon's PID (e.g. 862) to a system process like
      // swtransparencyd. The lockfile's startedAtMs predates the current
      // boot, so we must NOT trust the PID liveness check.
      //
      // Pick a PID that is alive (our own ppid) AND a startedAtMs from
      // ~10 years ago. Without the fix this would throw LockfileError.
      //
      // Note: this test couples to host clock + uptime. It assumes the test
      // runner has been booted within the last 10 years (always true in
      // practice — max observed continuous uptime is ~6 months on prod
      // servers, weeks on dev laptops, minutes on CI runners). The pure-unit
      // test below (`isFromPreviousBoot returns true for ancient
      // startedAtMs`) covers the helper deterministically via injection.
      const livePid = process.ppid;
      const ancientMs = Date.now() - 10 * 365 * 24 * 60 * 60 * 1000;
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: livePid, startedAtMs: ancientMs, host: 'old-boot' }),
      );
      const { release } = acquireLock({ lockPath });
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(process.pid);
      expect(contents.startedAtMs).toBeGreaterThan(ancientMs);
      release();
    });

    it('isFromPreviousBoot returns true for ancient startedAtMs', () => {
      // Use injected now/uptime to avoid coupling to host clock state.
      const now = 10_000_000;
      const uptime = 100; // 100s uptime → boot was at 9_900_000
      // 9_894_999 < 9_895_000 (= boot - 5s slop) → previous boot.
      expect(_internals.isFromPreviousBoot(9_894_999, now, uptime)).toBe(true);
      // 9_900_000 = boot time → within slop, NOT previous boot.
      expect(_internals.isFromPreviousBoot(9_900_000, now, uptime)).toBe(false);
      // After boot → definitely not previous.
      expect(_internals.isFromPreviousBoot(9_950_000, now, uptime)).toBe(false);
    });

    it('throws LockfileError when a LIVE process already holds the lock', () => {
      // Simulate a peer daemon by writing a lockfile that names a live PID
      // OTHER than the current one. The current process's own PID would be
      // skipped by the equality check inside acquireLock.
      //
      // Trick: spawn nothing — use the PID of `process.ppid` (the parent
      // shell / vitest runner) which is definitely live but != us.
      const peerPid = process.ppid;
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: peerPid, startedAtMs: Date.now(), host: 'peer' }),
      );
      expect(() => acquireLock({ lockPath })).toThrow(LockfileError);
      try {
        acquireLock({ lockPath });
      } catch (err) {
        expect(err).toBeInstanceOf(LockfileError);
        expect((err as LockfileError).heldByPid).toBe(peerPid);
        expect((err as LockfileError).message).toMatch(/đã chạy/);
        expect((err as LockfileError).message).toContain(String(peerPid));
      }
      // The original peer lockfile should be untouched.
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(peerPid);
    });

    it('release() refuses to clobber a foreign lockfile (PID does not match)', () => {
      const { release } = acquireLock({ lockPath });
      // Simulate a race: another daemon (PID=999999) takes the lock after us
      // — release() should leave their lockfile alone.
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999_999, startedAtMs: 999, host: 'usurper' }),
      );
      release();
      expect(existsSync(lockPath)).toBe(true);
      const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(contents.pid).toBe(999_999);
    });

    it('creates the parent directory on first acquire', () => {
      const nestedPath = join(tmp, 'nested', 'subdir', 'daemon.lock');
      const { release } = acquireLock({ lockPath: nestedPath });
      expect(existsSync(nestedPath)).toBe(true);
      release();
    });
  });
});
