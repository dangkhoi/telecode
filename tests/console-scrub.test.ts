import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installConsoleScrub } from '../src/util/console-scrub.js';

describe('console scrub', () => {
  let captured = '';
  let origStderrWrite: typeof process.stderr.write;

  beforeAll(() => {
    // Install the capture stub FIRST so the scrub layer wraps it.
    // installConsoleScrub binds the existing write at install time, so order
    // matters: capture stub → scrub → end user write.
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      if (typeof chunk === 'string') captured += chunk;
      else if (chunk instanceof Uint8Array) captured += Buffer.from(chunk).toString('utf8');
      if (typeof cb === 'function') (cb as () => void)();
      return true;
    }) as typeof process.stderr.write;
    installConsoleScrub();
  });

  afterAll(() => {
    process.stderr.write = origStderrWrite;
  });

  it('redacts Telegram bot token in error URLs (the grammy leak shape)', () => {
    captured = '';
    // Shape stolen verbatim from a real stderr.log leak.
    const leak =
      "FetchError: request to https://api.telegram.org/bot8822552947:AAHvFVSv4t-NZwrH18yDaR0UqxZj1Qzr6xg/getUpdates failed";
    process.stderr.write(leak + '\n');
    expect(captured).not.toContain('AAHvFVSv4t-NZwrH18yDaR0UqxZj1Qzr6xg');
    expect(captured).toContain('[REDACTED-TG]');
  });

  it('redacts Anthropic key in plain text', () => {
    captured = '';
    process.stderr.write('Error: invalid key sk-ant-api03-AAAA-BBBB-CCCC-DDDD-EEEE\n');
    expect(captured).not.toContain('sk-ant-api03');
    expect(captured).toContain('[REDACTED-ANTHROPIC]');
  });

  it('passes through clean text unchanged', () => {
    captured = '';
    process.stderr.write('hello world\n');
    expect(captured).toBe('hello world\n');
  });

  it('handles Buffer writes', () => {
    captured = '';
    const buf = Buffer.from(
      'request to https://api.telegram.org/bot1234567:abcdefghijklmnopqrstuvwxyz0123456789/getMe failed',
    );
    process.stderr.write(buf);
    expect(captured).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(captured).toContain('[REDACTED-TG]');
  });
});
