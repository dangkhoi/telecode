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
      const sendOpts = s.silent ? ({ disable_notification: true } as never) : undefined;
      let composed = s.prefix ? `${s.prefix}${s.buffer}` : s.buffer;

      // Bug fix (P0) — long-response truncation. The previous code did
      // `clip(composed)`, keeping only the first 3500 chars; since `s.buffer`
      // is never trimmed, every subsequent flush re-clipped the SAME prefix and
      // silently dropped everything past the cap (a 6000-char story arrived as
      // ~3500 chars with a trailing "…"). Fix: when the running text overflows
      // a single Telegram message, peel the full leading chunks off as
      // finalized standalone messages, then reduce the live buffer to the final
      // chunk and fall through to the normal send/edit path so streaming
      // edit-in-place continues for the tail. No content is lost.
      //
      // Ordering note: the committed-chunk loop runs BEFORE we shrink
      // `s.buffer`. A transient throw inside the loop bubbles to the outer
      // `handleSendError` retry, which re-runs flush from the full buffer — the
      // same non-transactional rotation risk the original code carried. We rely
      // on `takeToken()` pre-waiting the rate limit so mid-loop 429s are rare.
      if (composed.length > MAX_MSG_CHARS) {
        const parts = splitForTelegram(composed);
        const heads = parts.slice(0, -1);
        for (let i = 0; i < heads.length; i++) {
          const chunk = heads[i]!;
          await this.takeToken();
          if (i === 0 && s.messageId) {
            // Finalize the in-flight running message as the first full chunk.
            try {
              await this.opts.bot.api.editMessageText(this.opts.chatId, s.messageId, chunk);
            } catch (err) {
              const handled = await this.handleEditError(err);
              if (!handled) {
                await this.opts.bot.api.sendMessage(this.opts.chatId, chunk, sendOpts);
              }
            }
          } else {
            await this.opts.bot.api.sendMessage(this.opts.chatId, chunk, sendOpts);
          }
        }
        // Carry the final chunk forward as a fresh running message. The prefix
        // was already emitted inside the first committed chunk, so blank it to
        // avoid duplicating it on the tail (set-once prefix is intentionally
        // mutated here — documented exception).
        s.buffer = parts[parts.length - 1]!;
        s.prefix = '';
        s.messageId = null;
        s.edits = 0;
        s.charsSinceRotate = 0;
        s.startedAt = Date.now();
        composed = s.buffer;
      }

      const text = composed;
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

  /**
   * Bug fix (P1): one-shot send for long messages that respects Telegram's
   * 4096-char per-message limit by splitting at line boundaries.
   *
   * Returns the array of message IDs created (one per chunk). The previous
   * approach — silently `clip()`-ing past `MAX_MSG_CHARS` with an ellipsis —
   * dropped real content (long summaries, large diff outputs, multi-line
   * tool_result previews) without the user noticing.
   *
   * Chunking rules:
   *   - Split on `\n` so logical paragraphs stay intact; long single lines
   *     are hard-split at the char cap as a last resort.
   *   - First chunk: text as-is (the caller's prefix / header survives).
   *   - Subsequent chunks: prepend `↪ (cont. N/M)\n` so the user knows the
   *     parts belong together.
   *   - Cap per chunk: {@link MAX_MSG_CHARS} (3500) — leaves margin for the
   *     continuation header and any Telegram-side overhead.
   *
   * Errors mid-stream: log + return the partial list of IDs. We do NOT abort
   * remaining chunks because the user is more hurt by missing content than
   * by an extra failed-send retry on a transient 429.
   */
  async sendChunked(text: string, extra?: SendPlainExtra): Promise<number[]> {
    const safe = scrubSecrets(text);
    const parts = splitForTelegram(safe);
    const ids: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const body = parts.length > 1 && i > 0
        ? `↪ (cont. ${i + 1}/${parts.length})\n${parts[i]}`
        : parts[i]!;
      const id = await this.sendPlain(body, extra);
      if (id != null) ids.push(id);
    }
    return ids;
  }

  /**
   * Bug fix (P1): edit the first chunk of a previously-sent message, then
   * send any overflow as new continuation messages. Used by callers that
   * built a message ID via `sendPlain` and want to upgrade its body to a
   * longer value (e.g. auto-done summary appending agent text to the `✅ Done`
   * card) without losing content past 4096 chars.
   *
   * Returns the array of NEW message IDs created (excludes `messageId`
   * itself). Empty array means everything fit in the edit.
   */
  async editPlainChunked(
    messageId: number,
    text: string,
    extra?: { reply_markup?: unknown },
  ): Promise<number[]> {
    const safe = scrubSecrets(text);
    const parts = splitForTelegram(safe);
    // First part replaces the original message.
    await this.editPlain(messageId, parts[0]!, extra);
    const extraIds: number[] = [];
    for (let i = 1; i < parts.length; i++) {
      const body = `↪ (cont. ${i + 1}/${parts.length})\n${parts[i]}`;
      const id = await this.sendPlain(body);
      if (id != null) extraIds.push(id);
    }
    return extraIds;
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
 * Bug fix (P1): split text into Telegram-safe chunks at line boundaries.
 *
 * Returns at least one element (input as-is when it fits in a single chunk).
 * Lines longer than {@link MAX_MSG_CHARS} are hard-split at the char cap
 * (rare — happens only with no-line-break blobs like minified JSON in a tool
 * preview).
 *
 * Continuation header `↪ (cont. N/M)\n` is left to the caller — the splitter
 * reserves headroom (`CHUNK_HEADROOM`) so callers can prepend up to that
 * many chars without the chunk ever blowing 4096.
 */
const CHUNK_HEADROOM = 32;
const CHUNK_BUDGET = MAX_MSG_CHARS - CHUNK_HEADROOM;

export function splitForTelegram(text: string): string[] {
  if (text.length <= MAX_MSG_CHARS) return [text];
  const lines = text.split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf.join('\n'));
      buf = [];
      bufLen = 0;
    }
  };
  for (const lineRaw of lines) {
    let line = lineRaw;
    // Hard-split unusually long single lines.
    while (line.length > CHUNK_BUDGET) {
      flush();
      out.push(line.slice(0, CHUNK_BUDGET));
      line = line.slice(CHUNK_BUDGET);
    }
    const add = (buf.length === 0 ? 0 : 1) + line.length;
    if (bufLen + add > CHUNK_BUDGET && buf.length > 0) {
      flush();
    }
    buf.push(line);
    bufLen += (buf.length === 1 ? 0 : 1) + line.length;
  }
  flush();
  return out.length === 0 ? [text] : out;
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
