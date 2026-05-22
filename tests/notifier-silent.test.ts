import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Bot } from 'grammy';
import { Notifier } from '../src/bot/notifier.js';

// ----------------------------------------------------------------------------
// Test scaffolding
// ----------------------------------------------------------------------------
//
// We stub only the subset of `bot.api` the Notifier touches: `sendMessage` and
// `editMessageText`. Each returns a fake message_id so the Notifier can track
// stream messages for rotation/edit logic.

interface MockApi {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
}

function makeBot(): { bot: Bot; api: MockApi } {
  let nextId = 100;
  const api: MockApi = {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async () => true),
  };
  // `Bot` is a heavy class — for tests we only need `.api`.
  return { bot: { api } as unknown as Bot, api };
}

const CHAT_ID = 1;
const DEBOUNCE_MS = 50;

describe('Notifier — silent + prefix (v0.8 A2)', () => {
  let bot: Bot;
  let api: MockApi;
  let notifier: Notifier;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ bot, api } = makeBot());
    notifier = new Notifier({ bot, chatId: CHAT_ID, debounceMs: DEBOUNCE_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // sendPlain
  // --------------------------------------------------------------------------

  describe('sendPlain', () => {
    it('passes disable_notification:true when silent:true', async () => {
      await notifier.sendPlain('hi', { silent: true });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(chatId).toBe(CHAT_ID);
      expect(text).toBe('hi');
      expect(opts).toEqual({ disable_notification: true });
    });

    it('does not set disable_notification when no extra given', async () => {
      await notifier.sendPlain('hi');
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      expect(opts).toBeUndefined();
    });

    it('does not set disable_notification when silent omitted from extra', async () => {
      await notifier.sendPlain('hi', { parse_mode: 'Markdown' });
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      expect(opts).toEqual({ parse_mode: 'Markdown' });
      expect((opts as Record<string, unknown>).disable_notification).toBeUndefined();
    });

    it('strips silent key before forwarding to grammY', async () => {
      await notifier.sendPlain('hi', { silent: true, parse_mode: 'Markdown' });
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      expect(opts).toEqual({ parse_mode: 'Markdown', disable_notification: true });
      // The convenience key itself must never leak through.
      expect((opts as Record<string, unknown>).silent).toBeUndefined();
    });

    it('honors disable_notification:true even without silent flag', async () => {
      await notifier.sendPlain('hi', { disable_notification: true });
      const [, , opts] = api.sendMessage.mock.calls[0]!;
      expect(opts).toEqual({ disable_notification: true });
    });
  });

  // --------------------------------------------------------------------------
  // appendStream — prefix + silent
  // --------------------------------------------------------------------------

  describe('appendStream', () => {
    it('flushes after debounce with prefix prepended and silent flag', async () => {
      notifier.appendStream('k', 'chunk1', { prefix: '[A] ', silent: true });
      expect(api.sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      await vi.runAllTimersAsync();

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [chatId, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(chatId).toBe(CHAT_ID);
      expect(text).toBe('[A] chunk1');
      expect(opts).toEqual({ disable_notification: true });
    });

    it('emits chunk only when no prefix supplied', async () => {
      notifier.appendStream('k', 'hello');

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      await vi.runAllTimersAsync();

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(text).toBe('hello');
      // No silent → no disable_notification set.
      expect(opts).toBeUndefined();
    });

    it('preserves prefix from first call when later append omits opts', async () => {
      // First append seeds prefix + silent.
      notifier.appendStream('k', 'one', { prefix: '[A] ', silent: true });
      // Second append passes no opts and must NOT clear the prefix.
      notifier.appendStream('k', 'two');

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      await vi.runAllTimersAsync();

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      const [, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(text).toBe('[A] onetwo');
      expect(opts).toEqual({ disable_notification: true });
    });

    it('ignores conflicting opts on subsequent calls (set-once semantics)', async () => {
      notifier.appendStream('k', 'a', { prefix: '[A] ', silent: true });
      // Try to change prefix + silent → must be ignored.
      notifier.appendStream('k', 'b', { prefix: '[B] ', silent: false });

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      await vi.runAllTimersAsync();

      const [, text, opts] = api.sendMessage.mock.calls[0]!;
      expect(text).toBe('[A] ab');
      expect(opts).toEqual({ disable_notification: true });
    });

    it('splits an over-limit buffer into multiple messages without losing content (v1.3)', () => {
      // v1.3 long-response fix: a buffer larger than MAX_MSG_CHARS (3500) used
      // to be clip()-ped — everything past 3500 was silently dropped. Now the
      // overflow is split into a head message (carrying the prefix) plus a tail
      // message, with NO content lost.
      const big = 'x'.repeat(4000);
      notifier.appendStream('k', big, { prefix: '[A] ', silent: false });

      return (async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
        await vi.runAllTimersAsync();

        // Overflow → ≥2 messages (head + tail), no edit (fresh sends).
        expect(api.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);

        // Prefix rides on the FIRST message only.
        const firstText = api.sendMessage.mock.calls[0]![1] as string;
        expect(firstText.startsWith('[A] ')).toBe(true);

        // Every 'x' is preserved across the messages: concatenate all sent
        // bodies, strip the one-time prefix, and count the x's.
        const allBodies = api.sendMessage.mock.calls
          .map((c) => c![1] as string)
          .join('');
        const xCount = (allBodies.match(/x/g) ?? []).length;
        expect(xCount).toBe(4000);
        // No truncation ellipsis anywhere.
        expect(allBodies).not.toContain('…');
      })();
    });
  });
});
