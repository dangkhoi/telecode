import type { Bot, Context } from 'grammy';
import { scrubSecrets } from '../util/scrub.js';
import { logger } from '../util/logger.js';

export interface NotifierOpts {
  chatId: number;
  bot: Bot;
}

interface Stream {
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
const DEBOUNCE_MS = 700;

interface TokenBucket {
  tokens: number;
  last: number;
}

export class Notifier {
  private readonly streams = new Map<string, Stream>();
  private readonly bucket: TokenBucket = { tokens: 3, last: Date.now() };
  // 1 token/sec, burst 3.
  private readonly fillRatePerMs = 1 / 1000;
  private readonly burst = 3;

  constructor(private readonly opts: NotifierOpts) {}

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

  async sendPlain(text: string, extra?: Record<string, unknown>): Promise<number | null> {
    const safe = clip(scrubSecrets(text));
    try {
      await this.takeToken();
      const msg = await this.opts.bot.api.sendMessage(this.opts.chatId, safe, extra as never);
      return msg.message_id;
    } catch (err) {
      return this.handleSendError(err, () => this.sendPlain(text, extra));
    }
  }

  async send(text: string, extra?: Record<string, unknown>): Promise<number | null> {
    return this.sendPlain(text, extra);
  }

  /** Streaming text append with debounce + rotation. Identifier `key` groups appends into one running message. */
  appendStream(key: string, chunk: string): void {
    const safe = scrubSecrets(chunk);
    let s = this.streams.get(key);
    if (!s) {
      s = {
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
    s.buffer += safe;
    s.charsSinceRotate += safe.length;
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => {
      void this.flush(key);
    }, DEBOUNCE_MS);
  }

  async flush(key: string): Promise<void> {
    const s = this.streams.get(key);
    if (!s || s.pending || !s.buffer) return;
    s.pending = true;
    try {
      const text = clip(s.buffer);
      await this.takeToken();
      const needRotate =
        !s.messageId ||
        s.edits >= ROTATE_EDITS ||
        s.charsSinceRotate >= ROTATE_CHARS ||
        Date.now() - s.startedAt >= ROTATE_MS;

      if (needRotate || !s.messageId) {
        const msg = await this.opts.bot.api.sendMessage(this.opts.chatId, text);
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
            const msg = await this.opts.bot.api.sendMessage(this.opts.chatId, text);
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clip(s: string): string {
  if (s.length <= MAX_MSG_CHARS) return s;
  return s.slice(0, MAX_MSG_CHARS - 1) + '…';
}
