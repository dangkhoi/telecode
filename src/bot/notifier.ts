import type { Bot, Context } from 'grammy';
import { scrubSecrets } from '../util/scrub.js';
import { logger } from '../util/logger.js';

/**
 * Notifier only touches `bot.api.*` (no context-dependent helpers), so it
 * tolerates any context flavor. Typing the field as `Bot<Context>` would force
 * callers using `Bot<BotContext>` (e.g. router.ts after the conversations
 * plugin landed in v0.7) to cast — instead we accept any flavor here.
 */
export interface NotifierOpts {
  chatId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot: Bot<any>;
  /**
   * Debounce window (ms) for `appendStream` flushes. v0.8 default jumps from
   * 700 → 3000 to reduce spam now that streams are silent (plan R2).
   */
  debounceMs?: number;
}

interface Stream {
  /** Prepended to every flush; '' if unset. Set once when the stream is created. */
  prefix: string;
  /** Telegram `disable_notification`. Set once when the stream is created. */
  silent: boolean;
  messageId: number | null;
  buffer: string;
  edits: number;
  charsSinceRotate: number;
  startedAt: number;
  pending: boolean;
  flushTimer: NodeJS.Timeout | null;
}

const MAX_MSG_CHARS = 3500;
const ROTATE_EDITS = 50;
const ROTATE_CHARS = 3500;
const ROTATE_MS = 5 * 60_000;
const DEFAULT_DEBOUNCE_MS = 3000;

interface TokenBucket {
  tokens: number;
  last: number;
}

/**
 * Extra options accepted by {@link Notifier.sendPlain}. The shape is mostly
 * passed through to grammY's `sendMessage`, with two convenience extras:
 *
 *  - `silent: true`  → maps to Telegram `disable_notification: true` (push
 *    notification is suppressed but the message still arrives).
 *  - `disable_notification: true` — also honored if the caller already speaks
 *    Telegram's vocabulary.
 *
 * The `silent` key is stripped before forwarding to grammY so we don't pollute
 * the upstream signature.
 */
export type SendPlainExtra = Record<string, unknown> & { silent?: boolean };

export class Notifier {
  private readonly streams = new Map<string, Stream>();
  private readonly bucket: TokenBucket = { tokens: 3, last: Date.now() };
  private readonly debounceMs: number;
  // 1 token/sec, burst 3.
  private readonly fillRatePerMs = 1 / 1000;
  private readonly burst = 3;

  constructor(private readonly opts: NotifierOpts) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  private async takeToken(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.bucket.last;
      this.bucket.tokens = Math.min(this.burst, this.bucket.tokens + elapsed * this.fillRatePerMs);
      this.bucket.last = now;
      if (this.bucket.tokens >= 1) {
        this.bucket.tokens -= 1;
        return;
      }
      const wait = Math.ceil((1 - this.bucket.tokens) / this.fillRatePerMs);
      await sleep(wait);
    }
  }

  async sendPlain(text: string, extra?: SendPlainExtra): Promise<number | null> {
    const safe = clip(scrubSecrets(text));
    const apiOpts = normalizeExtra(extra);
    try {
      await this.takeToken();
      const msg = await this.opts.bot.api.sendMessage(this.opts.chatId, safe, apiOpts as never);
      return msg.message_id;
    } catch (err) {
      return this.handleSendError(err, () => this.sendPlain(text, extra));
    }
  }

  /**
   * Phase C.1 — send a MarkdownV2-formatted message with a graceful fallback
   * to plain text on parser-rejection (HTTP 400 "can't parse entities").
   * Telegram's MarkdownV2 is strict; a single un-escaped `.` or `+` makes the
   * whole send fail. The streaming pipeline's `maybeWrapCodeBlock` is
   * conservative but never 100% safe against pathological input. If MarkdownV2
   * fails we strip `parse_mode` and retry with the raw text — the user still
   * sees the content, just unstyled. Logs a warn so we can spot patterns that
   * trip the escape helper.
   *
   * NOTE: the fallback strips ALL MarkdownV2 markup including code fences —
   * the goal is "always deliver the content", not "always render code." Most
   * agents already paste structured snippets verbatim, so the plain render is
   * still usable.
   *
   * 429 is handled by {@link handleSendError} same as `sendPlain`.
   */
  async sendMarkdownV2(text: string, extra?: SendPlainExtra): Promise<number | null> {
    const safe = clip(scrubSecrets(text));
    const apiOpts = normalizeExtra({ ...(extra ?? {}), parse_mode: 'MarkdownV2' });
    try {
      await this.takeToken();
      const msg = await this.opts.bot.api.sendMessage(
        this.opts.chatId,
        safe,
        apiOpts as never,
      );
      return msg.message_id;
    } catch (err) {
      const e = err as {
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      };
      // 429 — same backoff as `sendPlain`, but retry the MarkdownV2 path so
      // the styled rendering survives a transient rate limit.
      if (e?.error_code === 429 && e.parameters?.retry_after) {
        const waitMs = e.parameters.retry_after * 1000 + 100;
        logger.warn({ waitMs }, 'tg 429 on MarkdownV2 send, backing off');
        await sleep(waitMs);
        return this.sendMarkdownV2(text, extra);
      }
      // 400 with parse-mode complaint — fall back to plain so the content
      // still lands. We INTENTIONALLY don't re-wrap or sanitise further;
      // dropping parse_mode is a complete circuit-break.
      const isParseError =
        e?.error_code === 400 &&
        typeof e.description === 'string' &&
        /can't parse entities|parse_mode|MARKDOWN_PARSE_ERROR/i.test(e.description);
      if (isParseError) {
        logger.warn(
          { description: e.description },
          'MarkdownV2 parse failed — falling back to plain text',
        );
        // Strip parse_mode from extra and retry through the plain path.
        const plainExtra: SendPlainExtra | undefined = extra ? { ...extra } : undefined;
        if (plainExtra && 'parse_mode' in plainExtra) delete plainExtra.parse_mode;
        return this.sendPlain(text, plainExtra);
      }
      // Other errors — same as `sendPlain` (log + null).
      logger.error({ err: String(err) }, 'tg MarkdownV2 send failed');
      return null;
    }
  }

  async send(text: string, extra?: SendPlainExtra): Promise<number | null> {
    return this.sendPlain(text, extra);
  }

  /**
   * Streaming text append with debounce + rotation. `key` groups appends into
   * a single running message. `opts` are honored only on first append for a
   * given key — `prefix` and `silent` are set-once for the lifetime of the
   * stream so later chunks can't accidentally toggle them.
   *
   * The buffer stores the raw chunk only; `prefix` is composed at flush time.
   */
  appendStream(
    key: string,
    chunk: string,
    opts?: { prefix?: string; silent?: boolean },
  ): void {
    const safe = scrubSecrets(chunk);
    let s = this.streams.get(key);
    if (!s) {
      s = {
        prefix: opts?.prefix ?? '',
        silent: opts?.silent ?? false,
        messageId: null,
        buffer: '',
        edits: 0,
        charsSinceRotate: 0,
        startedAt: Date.now(),
        pending: false,
        flushTimer: null,
      };
      this.streams.set(key, s);
    }
    // opts on subsequent calls are intentionally ignored — set once.
    s.buffer += safe;
    s.charsSinceRotate += safe.length;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => {
      void this.flush(key);
    }, this.debounceMs);
  }

  async flush(key: string): Promise<void> {
    const s = this.streams.get(key);
    if (!s || s.pending || !s.buffer) return;
    s.pending = true;
    try {
      const composed = s.prefix ? `${s.prefix}${s.buffer}` : s.buffer;
      const text = clip(composed);
      const sendOpts = s.silent ? ({ disable_notification: true } as never) : undefined;
      await this.takeToken();
      const needRotate =
        !s.messageId ||
        s.edits >= ROTATE_EDITS ||
        s.charsSinceRotate >= ROTATE_CHARS ||
        Date.now() - s.startedAt >= ROTATE_MS;

      if (needRotate || !s.messageId) {
        const msg = await this.opts.bot.api.sendMessage(this.opts.chatId, text, sendOpts);
        s.messageId = msg.message_id;
        s.edits = 0;
        s.charsSinceRotate = text.length;
        s.startedAt = Date.now();
      } else {
        try {
          await this.opts.bot.api.editMessageText(this.opts.chatId, s.messageId, text);
          s.edits++;
        } catch (err) {
          // fall back to new message
          const handled = await this.handleEditError(err);
          if (!handled) {
            const msg = await this.opts.bot.api.sendMessage(this.opts.chatId, text, sendOpts);
            s.messageId = msg.message_id;
            s.edits = 0;
            s.charsSinceRotate = text.length;
            s.startedAt = Date.now();
          }
        }
      }
    } catch (err) {
      await this.handleSendError(err, async () => this.flush(key));
    } finally {
      s.pending = false;
    }
  }

  async closeStream(key: string): Promise<void> {
    const s = this.streams.get(key);
    if (!s) return;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    await this.flush(key);
    this.streams.delete(key);
  }

  private async handleEditError(err: unknown): Promise<boolean> {
    const e = err as { error_code?: number; parameters?: { retry_after?: number }; description?: string };
    if (e?.error_code === 429 && e.parameters?.retry_after) {
      const waitMs = e.parameters.retry_after * 1000 + 100;
      logger.warn({ waitMs }, 'tg 429 on edit, backing off');
      await sleep(waitMs);
      return true;
    }
    if (typeof e?.description === 'string' && /message is not modified/i.test(e.description)) {
      return true;
    }
    return false;
  }

  private async handleSendError(err: unknown, retry: () => Promise<number | null | void>): Promise<number | null> {
    const e = err as { error_code?: number; parameters?: { retry_after?: number } };
    if (e?.error_code === 429 && e.parameters?.retry_after) {
      const waitMs = e.parameters.retry_after * 1000 + 100;
      logger.warn({ waitMs }, 'tg 429, backing off');
      await sleep(waitMs);
      const r = await retry();
      return typeof r === 'number' ? r : null;
    }
    logger.error({ err: String(err) }, 'tg send failed');
    return null;
  }

  async answerCallback(ctx: Context, text?: string): Promise<void> {
    try {
      await ctx.answerCallbackQuery(text ? { text } : undefined);
    } catch (err) {
      logger.warn({ err: String(err) }, 'answerCallback failed');
    }
  }

  /**
   * Phase A.5 helper — replace the inline keyboard attached to an existing
   * message. Used to retrofit the follow-up suggestion row once the matching
   * `tool_result` arrives (or the 2-second defer timer fires for adapters
   * that don't emit tool_result).
   *
   * Silently ignores the "message is not modified" 400 because grammY raises
   * when the keyboard hasn't changed — harmless in our flow (defer + result
   * could race for the same message). Logs other errors but never throws —
   * the caller cannot meaningfully recover.
   */
  async editReplyMarkup(messageId: number, replyMarkup?: unknown): Promise<void> {
    try {
      await this.takeToken();
      await this.opts.bot.api.editMessageReplyMarkup(
        this.opts.chatId,
        messageId,
        replyMarkup ? ({ reply_markup: replyMarkup } as never) : undefined,
      );
    } catch (err) {
      const e = err as { description?: string; error_code?: number };
      if (typeof e?.description === 'string' && /message is not modified/i.test(e.description)) {
        return;
      }
      logger.warn({ err: String(err), messageId }, 'editReplyMarkup failed');
    }
  }

  /**
   * Phase A.5 helper — edit the text of a previously-sent plain message
   * (e.g. tool_use announcement → upgrade to tool_use + result line). Wraps
   * grammY's `editMessageText` with the same 429 / not-modified tolerance as
   * the streaming path. Optionally replaces the reply markup in the same
   * call (saves one round trip).
   */
  async editPlain(
    messageId: number,
    text: string,
    extra?: { reply_markup?: unknown },
  ): Promise<void> {
    const safe = clip(scrubSecrets(text));
    try {
      await this.takeToken();
      await this.opts.bot.api.editMessageText(
        this.opts.chatId,
        messageId,
        safe,
        extra ? (extra as never) : undefined,
      );
    } catch (err) {
      const handled = await this.handleEditError(err);
      if (!handled) {
        logger.warn({ err: String(err), messageId }, 'editPlain failed');
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clip(s: string): string {
  if (s.length <= MAX_MSG_CHARS) return s;
  return s.slice(0, MAX_MSG_CHARS - 1) + '…';
}

/**
 * Translate Notifier's `SendPlainExtra` (which carries the convenience
 * `silent` flag) into the raw payload grammY's `sendMessage` accepts. The
 * `silent` key is stripped after being mapped to `disable_notification`.
 * Returns `undefined` when the resulting payload would be empty so we never
 * send `{}` upstream (grammY accepts it, but tests asserting argument count
 * are tidier this way).
 */
function normalizeExtra(extra?: SendPlainExtra): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const { silent, ...rest } = extra;
  const out: Record<string, unknown> = { ...rest };
  if (silent) {
    out.disable_notification = true;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
