/**
 * Regression — Bug 2: long messages get silently clipped by `clip()`.
 *
 * Before the fix, `sendPlain`/`editPlain` truncated any input over 3500 chars
 * with `…`, dropping the tail silently. Now we expose `sendChunked` +
 * `editPlainChunked` that split at line boundaries and emit continuation
 * messages with `↪ (cont. N/M)` headers.
 *
 * These tests assert:
 *   - `splitForTelegram` produces chunks under the per-message char cap.
 *   - `sendChunked` emits one Telegram sendMessage per chunk and returns all IDs.
 *   - `editPlainChunked` edits the first chunk then sends overflow as new
 *     messages.
 *   - Continuation headers are present on parts 2..N (not on part 1).
 *   - Pathologically long single line is hard-split.
 *   - Short input is sent once with no continuation header.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Bot } from 'grammy';
import { Notifier, splitForTelegram } from '../src/bot/notifier.js';

interface MockApi {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
}

function makeBot(): { bot: Bot; api: MockApi } {
  let nextId = 1000;
  const api: MockApi = {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async () => true),
  };
  return { bot: { api } as unknown as Bot, api };
}

const CHAT_ID = 7;

describe('splitForTelegram', () => {
  it('returns single-element array when input fits in one chunk', () => {
    const out = splitForTelegram('hello\nworld');
    expect(out).toEqual(['hello\nworld']);
  });

  it('splits at line boundaries when over the cap', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const parts = splitForTelegram(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3500);
    }
    // Re-join with newlines reconstructs the original (we split, never lose).
    expect(parts.join('\n')).toBe(long);
  });

  it('hard-splits a single line longer than the cap', () => {
    const huge = 'x'.repeat(8000);
    const parts = splitForTelegram(huge);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3500);
    }
    expect(parts.join('')).toBe(huge);
  });

  it('preserves blank lines within chunks', () => {
    const input = `header\n\nbody1\n\nbody2`;
    expect(splitForTelegram(input)).toEqual([input]);
  });
});

describe('Notifier.sendChunked', () => {
  let bot: Bot;
  let api: MockApi;
  let notifier: Notifier;

  beforeEach(() => {
    ({ bot, api } = makeBot());
    notifier = new Notifier({ bot, chatId: CHAT_ID });
  });

  it('sends a single message and returns one ID for short input', async () => {
    const ids = await notifier.sendChunked('short text');
    expect(ids.length).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = api.sendMessage.mock.calls[0]!;
    // No continuation header on a single-chunk send.
    expect(text).toBe('short text');
  });

  it('sends multiple messages for long input and returns all IDs', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
    const ids = await notifier.sendChunked(long);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(api.sendMessage).toHaveBeenCalledTimes(ids.length);

    // First message has no continuation header.
    const [, firstText] = api.sendMessage.mock.calls[0]!;
    expect(firstText).not.toMatch(/^↪ \(cont\. \d+\/\d+\)/);

    // Subsequent messages each carry the header.
    for (let i = 1; i < ids.length; i++) {
      const [, text] = api.sendMessage.mock.calls[i]!;
      expect(text).toMatch(new RegExp(`^↪ \\(cont\\. ${i + 1}/${ids.length}\\)\n`));
    }
  });

  it('content from all chunks together reconstructs the original (no silent loss)', async () => {
    const long = Array.from({ length: 250 }, (_, i) => `L${i}:${'z'.repeat(15)}`).join('\n');
    await notifier.sendChunked(long);
    const rendered = api.sendMessage.mock.calls
      .map((c) => c[1] as string)
      .map((s) => s.replace(/^↪ \(cont\. \d+\/\d+\)\n/, ''))
      .join('\n');
    expect(rendered).toBe(long);
  });
});

describe('Notifier.editPlainChunked', () => {
  let bot: Bot;
  let api: MockApi;
  let notifier: Notifier;

  beforeEach(() => {
    ({ bot, api } = makeBot());
    notifier = new Notifier({ bot, chatId: CHAT_ID });
  });

  it('edits the only message in place when input fits in one chunk', async () => {
    const extras = await notifier.editPlainChunked(42, 'short body');
    expect(extras).toEqual([]);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('edits first chunk + sends overflow as new messages for long input', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${'w'.repeat(20)}`).join('\n');
    const extras = await notifier.editPlainChunked(99, long);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(extras.length).toBe(api.sendMessage.mock.calls.length);

    // First call edits message 99.
    const [chatId, msgId] = api.editMessageText.mock.calls[0]!;
    expect(chatId).toBe(CHAT_ID);
    expect(msgId).toBe(99);

    // Overflow messages have continuation headers.
    for (let i = 0; i < extras.length; i++) {
      const [, text] = api.sendMessage.mock.calls[i]!;
      expect(text).toMatch(/^↪ \(cont\. \d+\/\d+\)\n/);
    }
  });
});
