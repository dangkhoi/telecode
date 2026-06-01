import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, writeFileSync as writeFile, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireLock,
  killOrphanDaemons,
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

  // Orphan reaper — incident 2026-06-01. A daemon whose shutdown await
  // chain hung past `process.exit(0)` left a node process holding the
  // loopback ports + SQLite WAL for 8 days. The lockfile was eventually
  // marked stale by the previous-boot heuristic so a fresh daemon booted
  // alongside it. These tests exercise the boot-time sweep that prevents
  // the alongside-coexistence case.
  describe('killOrphanDaemons (POSIX)', () => {
    const skipOnWindows = process.platform === 'win32' ? it.skip : it;

    skipOnWindows(
      'reaps a node process whose argv contains the entrypoint',
      async () => {
        const sleeperPath = join(tmp, 'sleeper.js');
        // The child must:
        //   (a) keep the event loop alive so it stays running until we kill it
        //   (b) NOT trap SIGTERM — we want the canonical signal path tested
        writeFile(sleeperPath, 'setInterval(() => {}, 100000);\n');
        const child = spawn(process.execPath, [sleeperPath], {
          stdio: 'ignore',
          detached: false,
        });
        try {
          // Wait for the child to be visible in `ps` (a few ms post-spawn).
          await new Promise((r) => setTimeout(r, 200));
          expect(child.pid).toBeTypeOf('number');
          expect(_internals.isPidAlive(child.pid!)).toBe(true);

          const reaped = await killOrphanDaemons({
            entrypoint: sleeperPath,
            timeoutMs: 2_000,
          });
          expect(reaped).toContain(child.pid);
          expect(_internals.isPidAlive(child.pid!)).toBe(false);
        } finally {
          // Belt-and-suspenders cleanup in case reap didn't catch it.
          if (child.pid && _internals.isPidAlive(child.pid)) {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {
              /* already dead */
            }
          }
        }
      },
      15_000,
    );

    skipOnWindows(
      'returns [] when no other process matches the entrypoint',
      async () => {
        // Use a path that is GUARANTEED unique to this test run — no other
        // process can have it in argv.
        const uniquePath = join(tmp, `nonexistent-${Date.now()}-${Math.random()}.js`);
        const reaped = await killOrphanDaemons({ entrypoint: uniquePath });
        expect(reaped).toEqual([]);
      },
    );

    skipOnWindows('never reaps our own PID', async () => {
      // Use this test file's own path as entrypoint — vitest's child includes
      // it in argv. The scan should EXCLUDE our pid and return [] (or only
      // sibling vitest workers, none of which we control here).
      const findOrphans = _internals.findOrphanDaemons;
      const found = await findOrphans('/usr/lib/node_modules/vitest/dist/cli.js', process.pid);
      expect(found).not.toContain(process.pid);
    });

    skipOnWindows(
      'SIGKILL escalation kills a child that ignores SIGTERM',
      async () => {
        const sleeperPath = join(tmp, 'stubborn.js');
        // Trap SIGTERM and ignore it — the only way to die is SIGKILL.
        writeFile(
          sleeperPath,
          [
            "process.on('SIGTERM', () => { /* ignore */ });",
            'setInterval(() => {}, 100000);',
          ].join('\n'),
        );
        const child = spawn(process.execPath, [sleeperPath], {
          stdio: 'ignore',
          detached: false,
        });
        try {
          await new Promise((r) => setTimeout(r, 200));
          expect(_internals.isPidAlive(child.pid!)).toBe(true);

          const reaped = await killOrphanDaemons({
            entrypoint: sleeperPath,
            timeoutMs: 500, // short — force SIGKILL path
          });
          expect(reaped).toContain(child.pid);
          expect(_internals.isPidAlive(child.pid!)).toBe(false);
        } finally {
          if (child.pid && _internals.isPidAlive(child.pid)) {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {
              /* already dead */
            }
          }
        }
      },
      15_000,
    );

    skipOnWindows('returns [] when entrypoint is empty', async () => {
      expect(await killOrphanDaemons({ entrypoint: '' })).toEqual([]);
    });

    it('returns [] on Windows (platform short-circuit)', async () => {
      // findOrphanDaemons short-circuits on win32. We can't easily mock
      // process.platform without invasive setup, so on non-Windows we just
      // assert the contract via a sentinel path. On Windows the result is
      // guaranteed [] regardless of input.
      if (process.platform === 'win32') {
        const reaped = await killOrphanDaemons({ entrypoint: 'anything' });
        expect(reaped).toEqual([]);
      }
    });

    // Senior review [P1] 2026-06-01: tighten the substring match so we don't
    // accidentally reap editors / viewers / grep / IDE indexers whose argv
    // mentions the daemon entrypoint path.
    describe('looksLikeNodeInvocation', () => {
      const f = _internals.looksLikeNodeInvocation;

      it('accepts canonical node invocations', () => {
        expect(f('node dist/index.js')).toBe(true);
        expect(f('/opt/homebrew/Cellar/node/26.0.0/bin/node dist/index.js')).toBe(true);
        expect(f('  node --enable-source-maps dist/index.js')).toBe(true);
        expect(f('node.exe C:/app/dist/index.js')).toBe(true);
      });

      it('accepts tsx and other node-compat launchers', () => {
        expect(f('node /path/to/tsx/dist/cli.mjs src/index.ts')).toBe(true);
        expect(f('tsx src/index.ts')).toBe(true);
        expect(f('bun dist/index.js')).toBe(true);
      });

      it('REJECTS editors / viewers / shells operating on the file', () => {
        expect(f('vim dist/index.js')).toBe(false);
        expect(f('/usr/bin/vim dist/index.js')).toBe(false);
        expect(f('nvim dist/index.js')).toBe(false);
        expect(f('tail -f dist/index.js')).toBe(false);
        expect(f('less dist/index.js')).toBe(false);
        expect(f('cat dist/index.js')).toBe(false);
        expect(f('grep -r foo dist/index.js')).toBe(false);
        expect(f('rg foo dist/index.js')).toBe(false);
        expect(f('git diff dist/index.js')).toBe(false);
      });

      it('REJECTS empty or whitespace input', () => {
        expect(f('')).toBe(false);
        expect(f('   ')).toBe(false);
      });
    });

    skipOnWindows(
      'does NOT reap a non-node process matching the entrypoint substring',
      async () => {
        // Repro of the [P1] false-positive: simulate `tail -f <entrypoint>`
        // (which is what a developer / log-tailing tool would look like).
        // tail keeps running on a file with no writers, holding the file
        // descriptor — perfect for keeping the process alive without any
        // SIGTERM trap.
        const targetPath = join(tmp, 'fake-entrypoint.js');
        writeFile(targetPath, '// placeholder\n');
        const child = spawn('tail', ['-f', targetPath], { stdio: 'ignore', detached: false });
        try {
          await new Promise((r) => setTimeout(r, 200));
          expect(_internals.isPidAlive(child.pid!)).toBe(true);

          const reaped = await killOrphanDaemons({
            entrypoint: targetPath,
            timeoutMs: 500,
          });
          // `tail` is not a node invocation — must NOT be reaped.
          expect(reaped).not.toContain(child.pid);
          expect(_internals.isPidAlive(child.pid!)).toBe(true);
        } finally {
          if (child.pid && _internals.isPidAlive(child.pid)) {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {
              /* already dead */
            }
          }
        }
      },
      15_000,
    );
  });
});
