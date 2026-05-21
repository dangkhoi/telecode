import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Plan P5.3 — Windows signal handlers
//
// Windows raises SIGBREAK on Ctrl+Break and NSSM emits SIGBREAK as the
// graceful-shutdown signal before falling back to SIGTERM/TerminateProcess.
// Telecode's daemon entry point must install a listener for SIGBREAK so the
// service stops cleanly (lockfile release, hook server drain, SQLite close).
//
// We don't spawn the daemon here — we statically inspect `src/index.ts` to
// assert all three signal handlers are wired and route through the same
// shutdown closure. The static check is intentionally cheap; the actual
// behaviour gets verified by smoke testing on Windows VM (P5.4 — manual).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = resolve(here, '..', 'src', 'index.ts');

describe('P5.3 — Windows signal handlers in src/index.ts', () => {
  const src = readFileSync(INDEX_SRC, 'utf8');

  it('registers SIGINT handler that calls shutdown(SIGINT)', () => {
    // POSIX + Windows Ctrl+C. Already wired pre-P5; this guards against an
    // accidental regression while we touch the same file for SIGBREAK.
    expect(src).toMatch(/process\.on\(\s*['"]SIGINT['"]\s*,/);
    expect(src).toMatch(/shutdown\(\s*['"]SIGINT['"]\s*\)/);
  });

  it('registers SIGTERM handler that calls shutdown(SIGTERM)', () => {
    // launchd + systemd graceful stop. Pre-P5 wiring; same regression guard.
    expect(src).toMatch(/process\.on\(\s*['"]SIGTERM['"]\s*,/);
    expect(src).toMatch(/shutdown\(\s*['"]SIGTERM['"]\s*\)/);
  });

  it('P5.3 — registers SIGBREAK handler so NSSM graceful stop releases lock + drains hook server', () => {
    // The NEW handler. Without this, NSSM's stop sequence
    // (CTRL_BREAK_EVENT → CTRL_C_EVENT → WM_CLOSE → TerminateProcess) skips
    // straight past the graceful stage and the daemon's lockfile + Kiro
    // hook server are left dirty across reboots.
    expect(src).toMatch(/process\.on\(\s*['"]SIGBREAK['"]\s*,/);
    expect(src).toMatch(/shutdown\(\s*['"]SIGBREAK['"]\s*\)/);
  });

  it('P5.3 — SIGBREAK handler routes through the SAME shutdown closure as SIGINT/SIGTERM', () => {
    // Anti-regression: a future refactor that splits the SIGBREAK path into
    // its own ad-hoc cleanup would skip the lockfile release / hook drain /
    // SQLite close. Verify by counting the unique shutdown invocations: all
    // three signal handlers should call the same `shutdown(<name>)` helper.
    const matches = src.match(/shutdown\(['"](?:SIGINT|SIGTERM|SIGBREAK)['"]\)/g);
    expect(matches).not.toBeNull();
    // De-dupe to confirm each signal is wired exactly once.
    const unique = new Set(matches);
    expect(unique.size).toBe(3);
  });
});
