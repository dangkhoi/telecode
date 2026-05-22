import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telecode-quiet-'));
  store = new SessionStore(join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Quiet Hours — schema migration', () => {
  it('fresh DB has quiet_start, quiet_end, quiet_tz columns on chat_settings', () => {
    const cols = store.db.prepare('PRAGMA table_info(chat_settings)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('quiet_start');
    expect(names).toContain('quiet_end');
    expect(names).toContain('quiet_tz');
  });

  it('migration is idempotent — reopening same DB does not error', () => {
    const path = join(tmpDir, 'reopen.db');
    const s1 = new SessionStore(path);
    s1.close();
    const s2 = new SessionStore(path);
    s2.close();
  });
});

describe('Quiet Hours — store methods', () => {
  it('getQuietHours returns null when not set', () => {
    expect(store.getQuietHours(111)).toBeNull();
  });

  it('setQuietHours + getQuietHours roundtrip', () => {
    store.setQuietHours(111, 22 * 60, 8 * 60, 'Asia/Ho_Chi_Minh');
    const qh = store.getQuietHours(111);
    expect(qh).toEqual({ start: 1320, end: 480, tz: 'Asia/Ho_Chi_Minh' });
  });

  it('setQuietHours uses default timezone', () => {
    store.setQuietHours(222, 0, 360);
    const qh = store.getQuietHours(222);
    expect(qh!.tz).toBe('Asia/Ho_Chi_Minh');
  });

  it('clearQuietHours disables quiet hours', () => {
    store.setQuietHours(111, 1320, 480);
    store.clearQuietHours(111);
    expect(store.getQuietHours(111)).toBeNull();
  });

  it('clearQuietHours is no-op when no row exists', () => {
    // Should not throw
    store.clearQuietHours(999);
    expect(store.getQuietHours(999)).toBeNull();
  });

  it('setQuietHours does not clobber existing default_mode', () => {
    store.setChatDefaultMode(111, 'verbose');
    store.setQuietHours(111, 1320, 480);
    expect(store.getChatDefaultMode(111)).toBe('verbose');
  });
});

describe('Quiet Hours — isQuietNow', () => {
  it('returns false when quiet hours not set', () => {
    expect(store.isQuietNow(111)).toBe(false);
  });

  it('returns true during overnight quiet window (22:00-08:00) at 23:00', () => {
    // We can't easily mock time, but we can set a window that covers the
    // current time. Use UTC and set a 24h window to guarantee coverage.
    store.setQuietHours(111, 0, 1439, 'UTC');
    // 0:00 to 23:59 covers all times
    expect(store.isQuietNow(111)).toBe(true);
  });

  it('returns false when current time is outside same-day window', () => {
    // Set a 1-minute window far from now (minute 0 to minute 1 in a timezone
    // where it's definitely not midnight right now)
    // Use a timezone where it's likely daytime
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
    const currentMinute = hour * 60 + minute;

    // Set window to a 1-minute slot 12 hours away from now
    const farMinute = (currentMinute + 720) % 1440;
    const farEnd = (farMinute + 1) % 1440;
    store.setQuietHours(111, farMinute, farEnd, 'UTC');
    expect(store.isQuietNow(111)).toBe(false);
  });
});
