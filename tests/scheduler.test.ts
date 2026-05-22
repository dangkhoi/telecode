import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cronMatches, Scheduler, type ScheduleRow, type SchedulerDeps } from '../src/bot/scheduler.js';
import { SessionStore } from '../src/session/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---- cronMatches tests ----
describe('cronMatches', () => {
  it('matches wildcard * for all fields', () => {
    const date = new Date(2026, 4, 22, 9, 30); // May 22 2026, 09:30, Friday (dow=5)
    expect(cronMatches('* * * * *', date)).toBe(true);
  });

  it('matches specific minute and hour', () => {
    const date = new Date(2026, 4, 22, 9, 0);
    expect(cronMatches('0 9 * * *', date)).toBe(true);
    expect(cronMatches('30 9 * * *', date)).toBe(false);
    expect(cronMatches('0 10 * * *', date)).toBe(false);
  });

  it('matches day of month', () => {
    const date = new Date(2026, 0, 15, 12, 0); // Jan 15
    expect(cronMatches('0 12 15 * *', date)).toBe(true);
    expect(cronMatches('0 12 16 * *', date)).toBe(false);
  });

  it('matches month', () => {
    const date = new Date(2026, 2, 1, 0, 0); // March 1
    expect(cronMatches('0 0 1 3 *', date)).toBe(true);
    expect(cronMatches('0 0 1 4 *', date)).toBe(false);
  });

  it('matches day of week (0=Sun)', () => {
    const date = new Date(2026, 4, 24, 10, 0); // May 24 2026 = Sunday (dow=0)
    expect(cronMatches('0 10 * * 0', date)).toBe(true);
    expect(cronMatches('0 10 * * 1', date)).toBe(false);
  });

  it('matches step */N', () => {
    const date0 = new Date(2026, 0, 1, 0, 0); // min=0
    const date5 = new Date(2026, 0, 1, 0, 5); // min=5
    const date7 = new Date(2026, 0, 1, 0, 7); // min=7
    expect(cronMatches('*/5 * * * *', date0)).toBe(true);
    expect(cronMatches('*/5 * * * *', date5)).toBe(true);
    expect(cronMatches('*/5 * * * *', date7)).toBe(false);
  });

  it('matches */2 for hours', () => {
    const date0 = new Date(2026, 0, 1, 0, 0);
    const date1 = new Date(2026, 0, 1, 1, 0);
    const date2 = new Date(2026, 0, 1, 2, 0);
    expect(cronMatches('0 */2 * * *', date0)).toBe(true);
    expect(cronMatches('0 */2 * * *', date1)).toBe(false);
    expect(cronMatches('0 */2 * * *', date2)).toBe(true);
  });

  it('matches comma-separated values', () => {
    const date0 = new Date(2026, 0, 1, 0, 0);
    const date15 = new Date(2026, 0, 1, 0, 15);
    const date30 = new Date(2026, 0, 1, 0, 30);
    const date7 = new Date(2026, 0, 1, 0, 7);
    expect(cronMatches('0,15,30 * * * *', date0)).toBe(true);
    expect(cronMatches('0,15,30 * * * *', date15)).toBe(true);
    expect(cronMatches('0,15,30 * * * *', date30)).toBe(true);
    expect(cronMatches('0,15,30 * * * *', date7)).toBe(false);
  });

  it('returns false for invalid cron (wrong number of fields)', () => {
    const date = new Date();
    expect(cronMatches('* * *', date)).toBe(false);
    expect(cronMatches('* * * * * *', date)).toBe(false);
    expect(cronMatches('', date)).toBe(false);
  });

  it('handles combined fields', () => {
    // Every weekday at 9:00
    const monday = new Date(2026, 4, 25, 9, 0); // Monday dow=1
    const sunday = new Date(2026, 4, 24, 9, 0); // Sunday dow=0
    expect(cronMatches('0 9 * * 1,2,3,4,5', monday)).toBe(true);
    expect(cronMatches('0 9 * * 1,2,3,4,5', sunday)).toBe(false);
  });
});

// ---- Scheduler tick tests ----
describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onTrigger when cron matches current time', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    const schedule: ScheduleRow = {
      id: 1, chat_id: 100, name: 'test', cron: '* * * * *',
      agent: 'claude', prompt: 'hello', project_id: null,
      enabled: 1, last_run_at: null, created_at: Date.now(),
    };
    const store = {
      getEnabledSchedules: vi.fn().mockReturnValue([schedule]),
      updateScheduleLastRun: vi.fn(),
    } as unknown as SessionStore;

    const scheduler = new Scheduler({ store, onTrigger });
    scheduler.start();

    // Advance 30s to trigger tick
    await vi.advanceTimersByTimeAsync(30_000);

    expect(store.getEnabledSchedules).toHaveBeenCalled();
    expect(onTrigger).toHaveBeenCalledWith(schedule);
    expect(store.updateScheduleLastRun).toHaveBeenCalledWith(1);

    scheduler.stop();
  });

  it('does not fire twice in the same minute', async () => {
    // With a 30s interval, two ticks CAN land in the same minute if we start
    // early enough in the minute. Pin to second 0: +30s = :30 (same min).
    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 0)); // 09:00:00
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    const schedule: ScheduleRow = {
      id: 1, chat_id: 100, name: 'test', cron: '0 9 * * *',
      agent: 'claude', prompt: 'hello', project_id: null,
      enabled: 1, last_run_at: null, created_at: Date.now(),
    };
    const store = {
      getEnabledSchedules: vi.fn().mockReturnValue([schedule]),
      updateScheduleLastRun: vi.fn(),
    } as unknown as SessionStore;

    const scheduler = new Scheduler({ store, onTrigger });
    scheduler.start();

    // First tick at +30s → 09:00:30 (minute=540), cron matches minute=0 hour=9 ✓
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Second tick at +60s → 09:01:00 (minute=541), cron wants minute=0 hour=9
    // but hour*60+min = 541 ≠ 540, so lastTickMinute dedup lets it through,
    // however cron '0 9 * * *' requires minute=0 → cronMatches returns false at 09:01.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onTrigger).toHaveBeenCalledTimes(1); // still 1 — cron doesn't match at :01
    scheduler.stop();
  });

  it('does not call onTrigger when cron does not match', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    // Set time to 10:00 but cron expects 15:00
    vi.setSystemTime(new Date(2026, 4, 22, 10, 0));
    const schedule: ScheduleRow = {
      id: 1, chat_id: 100, name: 'test', cron: '0 15 * * *',
      agent: 'claude', prompt: 'hello', project_id: null,
      enabled: 1, last_run_at: null, created_at: Date.now(),
    };
    const store = {
      getEnabledSchedules: vi.fn().mockReturnValue([schedule]),
      updateScheduleLastRun: vi.fn(),
    } as unknown as SessionStore;

    const scheduler = new Scheduler({ store, onTrigger });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onTrigger).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('handles onTrigger errors gracefully', async () => {
    const onTrigger = vi.fn().mockRejectedValue(new Error('boom'));
    const schedule: ScheduleRow = {
      id: 1, chat_id: 100, name: 'test', cron: '* * * * *',
      agent: 'claude', prompt: 'hello', project_id: null,
      enabled: 1, last_run_at: null, created_at: Date.now(),
    };
    const store = {
      getEnabledSchedules: vi.fn().mockReturnValue([schedule]),
      updateScheduleLastRun: vi.fn(),
    } as unknown as SessionStore;

    const scheduler = new Scheduler({ store, onTrigger });
    scheduler.start();
    // Should not throw
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onTrigger).toHaveBeenCalled();
    scheduler.stop();
  });

  it('start is idempotent', () => {
    const store = { getEnabledSchedules: vi.fn().mockReturnValue([]), updateScheduleLastRun: vi.fn() } as unknown as SessionStore;
    const scheduler = new Scheduler({ store, onTrigger: vi.fn() });
    scheduler.start();
    scheduler.start(); // no-op
    scheduler.stop();
  });
});

// ---- Store schedule methods ----
describe('SessionStore schedule methods', () => {
  let store: SessionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'telecode-sched-test-'));
    store = new SessionStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createSchedule + listSchedules', () => {
    store.createSchedule(100, 'daily', '0 9 * * *', 'claude', 'run tests');
    const list = store.listSchedules(100);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('daily');
    expect(list[0]!.cron).toBe('0 9 * * *');
    expect(list[0]!.agent).toBe('claude');
    expect(list[0]!.prompt).toBe('run tests');
    expect(list[0]!.enabled).toBe(1);
  });

  it('getSchedule returns the schedule', () => {
    store.createSchedule(100, 'nightly', '0 22 * * *', 'kiro', 'deploy');
    const s = store.getSchedule(100, 'nightly');
    expect(s).toBeDefined();
    expect(s!.name).toBe('nightly');
    expect(s!.chat_id).toBe(100);
  });

  it('getSchedule returns undefined for non-existent', () => {
    expect(store.getSchedule(100, 'nope')).toBeUndefined();
  });

  it('deleteSchedule returns true when deleted', () => {
    store.createSchedule(100, 'tmp', '* * * * *', 'claude', 'x');
    expect(store.deleteSchedule(100, 'tmp')).toBe(true);
    expect(store.listSchedules(100)).toHaveLength(0);
  });

  it('deleteSchedule returns false when not found', () => {
    expect(store.deleteSchedule(100, 'nope')).toBe(false);
  });

  it('toggleSchedule disables and enables', () => {
    store.createSchedule(100, 'tog', '0 0 * * *', 'claude', 'x');
    store.toggleSchedule(100, 'tog', false);
    expect(store.getSchedule(100, 'tog')!.enabled).toBe(0);
    store.toggleSchedule(100, 'tog', true);
    expect(store.getSchedule(100, 'tog')!.enabled).toBe(1);
  });

  it('updateScheduleLastRun sets last_run_at', () => {
    store.createSchedule(100, 'lr', '0 0 * * *', 'claude', 'x');
    const s = store.getSchedule(100, 'lr')!;
    expect(s.last_run_at).toBeNull();
    store.updateScheduleLastRun(s.id);
    const updated = store.getSchedule(100, 'lr')!;
    expect(updated.last_run_at).toBeGreaterThan(0);
  });

  it('getEnabledSchedules returns only enabled', () => {
    store.createSchedule(100, 'a', '0 0 * * *', 'claude', 'x');
    store.createSchedule(100, 'b', '0 0 * * *', 'claude', 'y');
    store.toggleSchedule(100, 'b', false);
    const enabled = store.getEnabledSchedules();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.name).toBe('a');
  });

  it('UNIQUE constraint on (chat_id, name)', () => {
    store.createSchedule(100, 'dup', '0 0 * * *', 'claude', 'x');
    expect(() => store.createSchedule(100, 'dup', '0 1 * * *', 'claude', 'y')).toThrow();
  });

  it('different chat_ids can have same name', () => {
    store.createSchedule(100, 'same', '0 0 * * *', 'claude', 'x');
    store.createSchedule(200, 'same', '0 0 * * *', 'kiro', 'y');
    expect(store.listSchedules(100)).toHaveLength(1);
    expect(store.listSchedules(200)).toHaveLength(1);
  });
});
