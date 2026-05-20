import type { Bot, Context, Filter } from 'grammy';
import { logger } from '../util/logger.js';

/**
 * Context passed to {@link CallbackHandler}. Equivalent to grammY's
 * `Filter<C, 'callback_query:data'>` — i.e. the context shape inside
 * `bot.on('callback_query:data', ...)`. `ctx.callbackQuery.data` is
 * guaranteed non-undefined here. We deliberately do NOT use
 * `CallbackQueryContext<C>`, which is reserved for regex-matched callback
 * handlers (it adds `ctx.match`, which we don't supply).
 */
export type CallbackRouterContext<C extends Context = Context> = Filter<
  C,
  'callback_query:data'
>;

/**
 * Handler invoked by {@link CallbackRouter} when a callback_query matches a
 * registered `ns:action` key. `payload` is the remainder of the
 * `ns:action:...payload` data string (joined back with `:` if the payload
 * itself contained colons, e.g. a UUID with colons).
 */
export type CallbackHandler<C extends Context = Context> = (
  ctx: CallbackRouterContext<C>,
  payload: string,
) => Promise<void>;

/**
 * Namespaced dispatcher for Telegram `callback_query:data` updates.
 *
 * Callback data follows the convention `ns:action[:...payload]`, e.g.
 *   - `apv:once:abc-123`     → ns=`apv`,     action=`once`,   payload=`abc-123`
 *   - `ses:switch:uuid:x:y`  → ns=`ses`,     action=`switch`, payload=`uuid:x:y`
 *   - `wizard:new:agent:claude` → ns=`wizard`, action=`new`, payload=`agent:claude`
 *
 * Handlers register chainably via {@link on}; a single grammY middleware is
 * installed on the bot by {@link attach}. Unknown keys are logged at WARN and
 * the loading spinner cleared via `answerCallbackQuery()`. Thrown errors are
 * caught, logged, and surfaced to the user as a non-fatal alert.
 */
export class CallbackRouter<C extends Context = Context> {
  private readonly handlers = new Map<string, CallbackHandler<C>>();

  /**
   * Register a handler for `${ns}:${action}`. Returns `this` for chaining.
   * Subsequent registrations for the same key overwrite the previous handler.
   */
  on(ns: string, action: string, handler: CallbackHandler<C>): this {
    this.handlers.set(`${ns}:${action}`, handler);
    return this;
  }

  /**
   * Install the dispatch middleware on the given bot. Must be called exactly
   * once per bot instance. Safe to call before {@link on} registrations as
   * lookup happens lazily at update time.
   */
  attach(bot: Bot<C>): void {
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const parts = data.split(':');
      const ns = parts[0] ?? '';
      const action = parts[1] ?? '';
      const payload = parts.slice(2).join(':');
      const key = `${ns}:${action}`;
      const handler = this.handlers.get(key);
      if (!handler) {
        logger.warn({ data }, 'callback_router: no handler');
        try {
          await ctx.answerCallbackQuery();
        } catch (err) {
          logger.error({ err: String(err), data }, 'callback_router: ack failed');
        }
        return;
      }
      try {
        await handler(ctx, payload);
      } catch (err) {
        logger.error({ err: String(err), data }, 'callback_router: handler failed');
        try {
          await ctx.answerCallbackQuery({
            text: '⚠️ Lỗi xử lý, thử lại sau',
            show_alert: true,
          });
        } catch (ackErr) {
          logger.error(
            { err: String(ackErr), data },
            'callback_router: error-ack failed',
          );
        }
      }
    });
  }
}
