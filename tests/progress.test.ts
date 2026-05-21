/**
 * Phase E — ProgressManager unit tests.
 *
 * Verifies the lifecycle + throttle + idle-ping ladder + mode awareness +
 * Telegram error tolerance for the rolling progress message.
 *
 * We stub the {@link ProgressApi} as a vi.fn() trio so we can assert on
 * the exact calls without spinning up grammY. Fake timers drive both the
 * 1500ms throttle gate and the 30s/60s/.../5m idle ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressManager } from '../src/bot/progress.js';
import type { ProgressApi } from '../src/bot/progress.js';
import type { VerbosityMode } from '../src/session/verbosity.js';

function mkApi(): ProgressApi & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 42 })),
    editMessageText: vi.fn(async () => ({})),
    deleteMessage: vi.fn(async () => ({})),
  };
}

function fixedMode(mode: VerbosityMode): (sid: string, cid: number) => VerbosityMode {
  return () => mode;
}

describe('ProgressManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start sends initial message and stores state', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ Starting…');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(100, '⏳ Starting…', {
      disable_notification: true,
    });
    expect(mgr.has('s1')).toBe(true);
  });

  it('start re-entry on existing state finalizes old before starting new', async () => {
    const api = mkApi();
    // First start returns msg 42; second start should attempt a delete on 42
    // (default finalize behaviour) before sending msg 43.
    let next = 42;
    api.sendMessage.mockImplementation(async () => ({ message_id: next++ }));
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ first');
    await mgr.start('s1', 100, '⏳ second');
    expect(api.deleteMessage).toHaveBeenCalledWith(100, 42);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('update edits only when text changed AND throttle gate passed', async () => {
    const t0 = 1_000_000;
    let clock = t0;
    const api = mkApi();
    const mgr = new ProgressManager({
      api,
      modeResolver: fixedMode('summary'),
      now: () => clock,
    });
    await mgr.start('s1', 100, '⏳ a');
    // Immediate update — throttle blocks (1500ms gate).
    clock += 100;
    await mgr.update('s1', '⏳ b');
    expect(api.editMessageText).not.toHaveBeenCalled();
    // After 1500ms — passes throttle.
    clock += 1500;
    await mgr.update('s1', '⏳ c');
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).toHaveBeenCalledWith(100, 42, '⏳ c');
  });

  it('update no-op when text identical to last rendered', async () => {
    let clock = 1_000_000;
    const api = mkApi();
    const mgr = new ProgressManager({
      api,
      modeResolver: fixedMode('summary'),
      now: () => clock,
    });
    await mgr.start('s1', 100, '⏳ same');
    clock += 2000;
    await mgr.update('s1', '⏳ same');
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it('update no-op when no state exists', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.update('s1', '⏳ orphan');
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it('finalize with text edits message and clears state', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ run');
    await mgr.finalize('s1', '❌ failed');
    expect(api.editMessageText).toHaveBeenCalledWith(100, 42, '❌ failed');
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(mgr.has('s1')).toBe(false);
  });

  it('finalize without text deletes message and clears state', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ run');
    await mgr.finalize('s1');
    expect(api.deleteMessage).toHaveBeenCalledWith(100, 42);
    expect(mgr.has('s1')).toBe(false);
  });

  it('clear is synchronous and skips Telegram calls', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ run');
    mgr.clear('s1');
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(mgr.has('s1')).toBe(false);
  });

  it('edit failure with message_to_edit_not_found drops state silently', async () => {
    let clock = 1_000_000;
    const api = mkApi();
    api.editMessageText.mockRejectedValueOnce({
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    const mgr = new ProgressManager({
      api,
      modeResolver: fixedMode('summary'),
      now: () => clock,
    });
    await mgr.start('s1', 100, '⏳ run');
    clock += 2000;
    await mgr.update('s1', '⏳ next');
    expect(mgr.has('s1')).toBe(false);
  });

  it('verbose mode skips all operations', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('verbose') });
    await mgr.start('s1', 100, '⏳ run');
    await mgr.update('s1', '⏳ next');
    await mgr.finalize('s1', 'tombstone');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it('idle ping fires "Working… (30s)" after 30s of silence', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ start');
    expect(api.editMessageText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.editMessageText).toHaveBeenCalledWith(100, 42, '⏳ Working… (30s)');
  });

  it('idle ladder caps at 5m+ and stops re-scheduling', async () => {
    const api = mkApi();
    const mgr = new ProgressManager({ api, modeResolver: fixedMode('summary') });
    await mgr.start('s1', 100, '⏳ start');
    // Six steps: 30s, 30s, 60s, 60s, 60s, 60s → 5m total to reach "(5m+)".
    await vi.advanceTimersByTimeAsync(30_000); // 30s
    await vi.advanceTimersByTimeAsync(30_000); // 60s
    await vi.advanceTimersByTimeAsync(60_000); // 2m
    await vi.advanceTimersByTimeAsync(60_000); // 3m
    await vi.advanceTimersByTimeAsync(60_000); // 4m
    await vi.advanceTimersByTimeAsync(60_000); // 5m+ (cap)
    const lastCall = api.editMessageText.mock.calls.at(-1);
    expect(lastCall?.[2]).toBe('⏳ Working… (5m+)');
    const callsAtCap = api.editMessageText.mock.calls.length;
    // Advance further — no NEW pings beyond cap.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.editMessageText.mock.calls.length).toBe(callsAtCap);
  });

  it('update resets idle ladder so 30s ping triggers fresh after activity', async () => {
    let clock = 1_000_000;
    const api = mkApi();
    const mgr = new ProgressManager({
      api,
      modeResolver: fixedMode('summary'),
      now: () => clock,
    });
    await mgr.start('s1', 100, '⏳ a');
    // 20s in → activity. Idle ping NOT yet fired.
    await vi.advanceTimersByTimeAsync(20_000);
    clock += 20_000;
    await mgr.update('s1', '⏳ b');
    expect(api.editMessageText).toHaveBeenCalledWith(100, 42, '⏳ b');
    api.editMessageText.mockClear();
    // 25s later (15s total since the rescheduled ping target) → no ping yet.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(api.editMessageText).not.toHaveBeenCalled();
    // 5 more seconds → 30s ping fires.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.editMessageText).toHaveBeenCalledWith(100, 42, '⏳ Working… (30s)');
  });
});
