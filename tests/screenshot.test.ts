import { describe, it, expect, vi } from 'vitest';
import { captureScreen } from '../src/bot/commands/index.js';

// ---------------------------------------------------------------------------
// Plan P1.3 — /screenshot platform gate
//
// We inject a fake `execa` and platform so we can exercise all 3 OS branches
// from a single host. captureScreen is pure (modulo execa) — no fs writes
// performed by the test (the real PNG would be created by the underlying
// tool we're mocking out).
// ---------------------------------------------------------------------------

type ExecCall = { cmd: string; args: readonly string[] };

function makeFakeExec(behavior: (cmd: string, args: readonly string[]) => { exitCode: number; stderr?: string }) {
  const calls: ExecCall[] = [];
  const fake = vi.fn(async (cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args: [...args] });
    return behavior(cmd, args);
  });
  return { fake, calls };
}

describe('P1.3 — captureScreen platform branching', () => {
  // -------------------------------------------------------- macOS
  it('darwin uses screencapture -x', async () => {
    const { fake, calls } = makeFakeExec(() => ({ exitCode: 0 }));
    const r = await captureScreen('/tmp/x.png', fake as never, 'darwin');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('screencapture');
    expect(calls[0]?.args).toEqual(['-x', '/tmp/x.png']);
  });

  it('darwin failure surfaces Screen Recording hint', async () => {
    const { fake } = makeFakeExec(() => ({ exitCode: 1, stderr: 'nope' }));
    const r = await captureScreen('/tmp/x.png', fake as never, 'darwin');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Screen Recording/);
  });

  // -------------------------------------------------------- Linux happy paths
  it('linux prefers grim when available', async () => {
    const { fake, calls } = makeFakeExec((cmd, args) => {
      if (cmd === 'grim' && args[0] === '--version') return { exitCode: 0 };
      if (cmd === 'grim') return { exitCode: 0 };
      return { exitCode: 127 };
    });
    const r = await captureScreen('/tmp/x.png', fake as never, 'linux');
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.cmd === 'grim' && c.args[0] !== '--version')).toBeTruthy();
    // gnome-screenshot / scrot never probed
    expect(calls.find((c) => c.cmd === 'gnome-screenshot')).toBeUndefined();
    expect(calls.find((c) => c.cmd === 'scrot')).toBeUndefined();
  });

  it('linux falls through to gnome-screenshot when grim missing', async () => {
    const { fake, calls } = makeFakeExec((cmd, args) => {
      if (cmd === 'grim') return { exitCode: 127 };
      if (cmd === 'gnome-screenshot' && args[0] === '--version') return { exitCode: 0 };
      if (cmd === 'gnome-screenshot') return { exitCode: 0 };
      return { exitCode: 127 };
    });
    const r = await captureScreen('/tmp/x.png', fake as never, 'linux');
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.cmd === 'gnome-screenshot' && c.args[0] === '-f')).toBe(true);
  });

  it('linux falls through to scrot when grim + gnome-screenshot missing', async () => {
    const { fake, calls } = makeFakeExec((cmd) => {
      if (cmd === 'grim' || cmd === 'gnome-screenshot') return { exitCode: 127 };
      if (cmd === 'scrot') return { exitCode: 0 };
      return { exitCode: 127 };
    });
    const r = await captureScreen('/tmp/x.png', fake as never, 'linux');
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.cmd === 'scrot')).toBe(true);
  });

  it('linux with NO tools returns helpful apt install hint', async () => {
    const { fake } = makeFakeExec(() => ({ exitCode: 127 }));
    const r = await captureScreen('/tmp/x.png', fake as never, 'linux');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/apt install/);
    expect(r.message).toMatch(/gnome-screenshot/);
    expect(r.message).toMatch(/scrot/);
    expect(r.message).toMatch(/grim/);
  });

  it('linux first-available tool failure surfaces specific exit code', async () => {
    const { fake } = makeFakeExec((cmd, args) => {
      if (cmd === 'grim' && args[0] === '--version') return { exitCode: 0 };
      if (cmd === 'grim') return { exitCode: 2 }; // capture itself fails (Wayland perm denied)
      return { exitCode: 127 };
    });
    const r = await captureScreen('/tmp/x.png', fake as never, 'linux');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/grim exit 2/);
  });

  // -------------------------------------------------------- Windows
  it('win32 invokes PowerShell with the Save-PNG snippet', async () => {
    const { fake, calls } = makeFakeExec(() => ({ exitCode: 0 }));
    const r = await captureScreen('C:\\Temp\\x.png', fake as never, 'win32');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.cmd).toBe('powershell.exe');
    expect(c.args.includes('-NoProfile')).toBe(true);
    expect(c.args.includes('-NonInteractive')).toBe(true);
    // Inline -Command body must include the System.Drawing.Bitmap call
    const cmdBody = c.args[c.args.length - 1] as string;
    expect(cmdBody).toContain('System.Drawing.Bitmap');
    expect(cmdBody).toContain('CopyFromScreen');
    expect(cmdBody).toContain("'C:\\Temp\\x.png'");
  });

  it("win32 path with single-quote is escaped (doubled)", async () => {
    const { fake, calls } = makeFakeExec(() => ({ exitCode: 0 }));
    await captureScreen("C:\\Temp\\x'y.png", fake as never, 'win32');
    const cmdBody = (calls[0]?.args[calls[0].args.length - 1] as string) ?? '';
    // Single quote in the path should be doubled per PowerShell escape rule.
    expect(cmdBody).toContain("x''y.png");
  });

  it('win32 PowerShell exit non-zero returns error message', async () => {
    const { fake } = makeFakeExec(() => ({ exitCode: 1 }));
    const r = await captureScreen('C:\\Temp\\x.png', fake as never, 'win32');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/PowerShell capture exit 1/);
  });

  // -------------------------------------------------------- Unsupported
  it("unknown platform returns 'chưa được hỗ trợ' message", async () => {
    const { fake } = makeFakeExec(() => ({ exitCode: 0 }));
    const r = await captureScreen('/tmp/x.png', fake as never, 'freebsd' as never);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/chưa được hỗ trợ/);
  });
});
