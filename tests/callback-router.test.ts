import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot, CallbackQueryContext, Context } from 'grammy';
import { CallbackRouter } from '../src/bot/callback-router.js';
import { logger } from '../src/util/logger.js';

// Minimal mock ctx — we only exercise the fields CallbackRouter touches.
// Cast to CallbackQueryContext<Context> at the boundary so handler signatures
// stay honest without recreating grammY's full Context shape.
type MockCtx = {
  callbackQuery: { data: string };
  answerCallbackQuery: ReturnType<typeof vi.fn>;
};

function makeCtx(data: string): MockCtx {
  return {
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Capture the handler registered via `bot.on('callback_query:data', ...)` so
 * each test can dispatch synthetic updates without spinning up a real Bot.
 */
function makeBotSpy(): {
  bot: Bot;
  invoke: (ctx: MockCtx) => Promise<void>;
} {
  let captured: ((ctx: CallbackQueryContext<Context>) => Promise<void>) | null = null;
  const bot = {
    on: vi.fn((event: string, handler: (ctx: CallbackQueryContext<Context>) => Promise<void>) => {
      expect(event).toBe('callback_query:data');
      captured = handler;
      return bot;
    }),
  } as unknown as Bot;
  return {
    bot,
    invoke: async (ctx) => {
      if (!captured) throw new Error('handler not registered yet — call router.attach(bot) first');
      await captured(ctx as unknown as CallbackQueryContext<Context>);
    },
  };
}

describe('CallbackRouter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches by ns:action and forwards remaining payload', async () => {
    const router = new CallbackRouter();
    const handler = vi.fn().mockResolvedValue(undefined);
    router.on('apv', 'once', handler);

    const { bot, invoke } = makeBotSpy();
    router.attach(bot);

    const ctx = makeCtx('apv:once:req-123');
    await invoke(ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![1]).toBe('req-123');
  });

  it('preserves payload colons when the payload itself contains ":"', async () => {
    const router = new CallbackRouter();
    const handler = vi.fn().mockResolvedValue(undefined);
    router.on('apv', 'once', handler);

    const { bot, invoke } = makeBotSpy();
    router.attach(bot);

    const ctx = makeCtx('apv:once:uuid:with:colons');
    await invoke(ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![1]).toBe('uuid:with:colons');
  });

  it('chainable on() — returns the same router instance', () => {
    const router = new CallbackRouter();
    const noop = async () => undefined;
    const chained = router.on('a', 'b', noop).on('c', 'd', noop);
    expect(chained).toBe(router);
  });

  it('unknown ns:action → logger.warn + answerCallbackQuery (no throw)', async () => {
    const router = new CallbackRouter();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    const { bot, invoke } = makeBotSpy();
    router.attach(bot);

    const ctx = makeCtx('unknown:action:payload');
    await expect(invoke(ctx)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ data: 'unknown:action:payload' });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
  });

  it('handler throws → ctx.answerCallbackQuery called with show_alert+vi text', async () => {
    const router = new CallbackRouter();
    const boom = vi.fn().mockRejectedValue(new Error('boom'));
    router.on('ses', 'switch', boom);
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    const { bot, invoke } = makeBotSpy();
    router.attach(bot);

    const ctx = makeCtx('ses:switch:sess-1');
    await expect(invoke(ctx)).resolves.toBeUndefined();

    expect(boom).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: '⚠️ Lỗi xử lý, thử lại sau',
      show_alert: true,
    });
  });

  it('attach() registers exactly one callback_query:data middleware', () => {
    const router = new CallbackRouter();
    const { bot } = makeBotSpy();
    router.attach(bot);
    expect((bot.on as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((bot.on as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('callback_query:data');
  });

  it('empty payload when data has only ns:action (no trailing colon)', async () => {
    const router = new CallbackRouter();
    const handler = vi.fn().mockResolvedValue(undefined);
    router.on('ses', 'new', handler);

    const { bot, invoke } = makeBotSpy();
    router.attach(bot);

    await invoke(makeCtx('ses:new'));
    expect(handler).toHaveBeenCalledWith(expect.anything(), '');
  });
});
