import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import type { Conversation } from '@grammyjs/conversations';
import type { SessionStore } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { AgentKind, SessionRow } from '../../session/store.js';
import type { AdapterMetadata } from '../../agents/types.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { buildPersistentKeyboard } from '../reply-builders.js';
import { logger } from '../../util/logger.js';
import { tStatic as _wizardT } from '../../i18n/index.js';

/**
 * Dependencies injected into the conversation builder. Router curries these in
 * via `createConversation((conv, ctx) => newSession(conv, ctx, deps), 'newSession')`
 * so the wizard stays a pure async function (easy to unit-test) without
 * reaching for a module-level singleton.
 *
 * Only `store` + `manager` are required — everything else (chat-state, project
 * listing) flows through those two surfaces.
 */
export interface WizardDeps {
  store: SessionStore;
  manager: SessionManager;
  /**
   * Adapter registry — plan P1.1. Wizard reads `registry.list()` to render
   * the agent picker dynamically; built-in adapters AND any future plugin
   * register at boot and surface here without a wizard-side edit.
   */
  registry: AgentRegistry;
  /**
   * Phase 3 — i18n handle. Optional so existing tests that construct a bare
   * deps don't have to wire it; the wizard falls back to EN catalog when
   * absent.
   */
  i18n?: import('../../i18n/index.js').I18n;
}

/** Projects per page in the picker step. Plan §5.1 step 3 calls for paginate-if->8. */
export const PROJECTS_PER_PAGE = 8;

const LABEL_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

/**
 * Look up the user-facing label for an agent kind. Falls back to the kind
 * string itself if the adapter is no longer registered (defensive — should
 * never happen because we only show registered kinds in the picker).
 */
function labelFor(meta: ReadonlyArray<AdapterMetadata>, kind: AgentKind): string {
  return meta.find((m) => m.kind === kind)?.displayName ?? kind;
}

/**
 * Light shape we only need from grammY's CallbackQueryContext. Lets us mock
 * the conversation handle in unit tests without rebuilding the full Context.
 */
type CbCtx = {
  callbackQuery: { data: string };
  answerCallbackQuery: (
    opts?: string | { text?: string; show_alert?: boolean },
  ) => Promise<unknown>;
  editMessageText: (
    text: string,
    other?: { reply_markup?: InlineKeyboard },
  ) => Promise<unknown>;
};

/**
 * Render the agent-picker keyboard. Dynamic — one button per registered
 * adapter (plan P1.1) plus a Cancel row. Callback data is namespaced under
 * `wizard:new-*` so the default CallbackRouter ignores them — they are
 * consumed inside the conversation via `waitFor('callback_query:data')`.
 *
 * Layout: up to 3 adapters per row (so 2-6 adapters fit on two rows on
 * mobile) followed by the Cancel row.
 *
 * Exported for tests.
 */
export function agentKeyboard(metadata: ReadonlyArray<AdapterMetadata>): InlineKeyboard {
  const kb = new InlineKeyboard();
  let perRow = 0;
  for (const m of metadata) {
    kb.text(`${m.badge} ${m.displayName}`, `wizard:new-agent:${m.kind}`);
    perRow++;
    if (perRow >= 3) {
      kb.row();
      perRow = 0;
    }
  }
  if (perRow > 0) kb.row();
  kb.text('✖ Cancel', 'wizard:new-cancel');
  return kb;
}

/**
 * Render the project-picker keyboard for a given page. Each project gets its
 * own row (cleanest tap target on mobile). Pagination row (← Prev / Next →)
 * appears only when projects exceed `PROJECTS_PER_PAGE`. Final row is always
 * `[← Back] [✖ Cancel]`.
 *
 * Callback data scheme:
 *   wizard:new-project:<id>     pick a project
 *   wizard:new-page:<n>         jump to page n (1-indexed)
 *   wizard:new-back             go back to agent step
 *   wizard:new-cancel           abort wizard
 */
function projectKeyboard(
  projects: ReadonlyArray<{ id: number; name: string }>,
  page: number,
): { kb: InlineKeyboard; totalPages: number; slice: ReadonlyArray<{ id: number; name: string }> } {
  const total = projects.length;
  const totalPages = Math.max(1, Math.ceil(total / PROJECTS_PER_PAGE));
  const clamped = Math.min(totalPages, Math.max(1, page));
  const start = (clamped - 1) * PROJECTS_PER_PAGE;
  const slice = projects.slice(start, start + PROJECTS_PER_PAGE);

  const kb = new InlineKeyboard();
  for (const p of slice) {
    kb.text(`📁 ${p.name}`, `wizard:new-project:${p.id}`).row();
  }
  if (totalPages > 1) {
    if (clamped > 1) kb.text('← Prev', `wizard:new-page:${clamped - 1}`);
    kb.text(`page ${clamped}/${totalPages}`, 'wizard:new-page:current');
    if (clamped < totalPages) kb.text('Next →', `wizard:new-page:${clamped + 1}`);
    kb.row();
  }
  kb.text('← Back', 'wizard:new-back').text('✖ Cancel', 'wizard:new-cancel');
  return { kb, totalPages, slice };
}

/**
 * Trailing inline buttons rendered on the wizard's "session created" message.
 *
 * Plan P0.2: the [📋 Tail logs] callback used to be the bare opaque key
 * `session:logs-trigger` (no payload) which left the router unable to know
 * WHICH session's logs the user wanted. We now embed the just-created session
 * id so the router can dispatch the equivalent of `/status logs 30` for that
 * specific session — even after the user has switched away.
 *
 * The [🔀 Switch khác] button intentionally carries NO payload; it always
 * renders the chat's full session list (plan P0.1).
 *
 * Phase 3 i18n: button labels go through `t()` so the keyboard renders in the
 * user's chosen language. `t` is the wizard-local helper (see `newSession`).
 */
export function successKeyboard(
  sessionId: string,
  t: (key: import('../../i18n/index.js').MessageKey) => string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('wizard.success.switch'), 'session:list-trigger')
    .text(t('wizard.success.tailLogs'), `session:logs-trigger:${sessionId}`);
}

/** Acknowledge the callback so Telegram clears the spinner. Swallows errors. */
async function safeAck(ctx: CbCtx, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch (err) {
    logger.warn({ err: String(err) }, 'wizard: answerCallbackQuery failed');
  }
}

/**
 * Conversation builder for the `/new` session wizard.
 *
 * Flow (plan §5.1):
 *   1. Agent     — inline `[🤖 Claude] [⚡ Kiro]` + `[✖ Cancel]`
 *   2. Project   — inline list (paginated) + `[← Back] [✖ Cancel]`
 *   3. Label     — text input, validated by `LABEL_PATTERN`; user may type
 *                  `/cancel` to abort. Loops on invalid input.
 *   4. Create    — `manager.createSession(...)` via `conversation.external`,
 *                  set as active, confirm message with T3 hook buttons.
 *
 * The wizard exits cleanly on `[✖ Cancel]` at any step (editMessageText
 * → "❌ Wizard hủy" and `return`). The grammy/conversations plugin handles
 * out-of-band exits (e.g. user types `/start` mid-flow) by dropping the
 * conversation; bot.ts later replies "wizard hủy, dùng /new" via the
 * plugin's `onExit` hook (B4 scope).
 *
 * Deps are curried in by the caller (router.ts) so this function stays a
 * direct mock target in tests — no module-level state, no DI container.
 */
export async function newSession(
  conversation: Conversation,
  ctx: Context,
  deps: WizardDeps,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    logger.warn('newSession wizard entered without chat id; aborting');
    return;
  }

  /**
   * Phase 3 i18n shorthand. Resolves through `deps.i18n` if present, else
   * falls back to EN via `tStatic` (test seam).
   */
  const t = (
    key: import('../../i18n/index.js').MessageKey,
    vars?: Record<string, string | number>,
  ): string => {
    if (deps.i18n) return deps.i18n.t(chatId, key, vars);
    return _wizardT('en', key, vars);
  };

  // ---- Step 1: agent (plan P1.1 — picker dynamic from registry) ----
  const adapterMetadata = deps.registry.list();
  if (adapterMetadata.length === 0) {
    // Defensive: should never happen at runtime (daemon registers built-ins
    // at boot), but tests that construct a bare registry would surface here.
    await ctx.reply(t('wizard.new.noAdapters'));
    return;
  }
  const validKinds = new Set(adapterMetadata.map((m) => m.kind));
  const agentCbPrefix = 'wizard:new-agent:';

  await ctx.reply(t('wizard.new.pickAgent'), {
    reply_markup: agentKeyboard(adapterMetadata),
  });

  let agent: AgentKind | null = null;
  while (!agent) {
    const cbCtx = (await conversation.waitFor('callback_query:data')) as unknown as CbCtx;
    const data = cbCtx.callbackQuery.data;
    if (data === 'wizard:new-cancel') {
      await safeAck(cbCtx);
      await cbCtx.editMessageText(t('wizard.new.cancel'));
      return;
    }
    if (data.startsWith(agentCbPrefix)) {
      const kind = data.slice(agentCbPrefix.length);
      if (validKinds.has(kind)) {
        agent = kind;
        await safeAck(cbCtx);
        continue;
      }
    }
    // Stray button (e.g. user tapped pagination on a stale screen). Ack
    // and keep waiting on this same step rather than crash.
    await safeAck(cbCtx);
  }

  // ---- Step 2: project ----
  // Load projects once via `external` so the read is not replayed on every
  // resume. Returning a small plain array is JSON-safe.
  const projects = await conversation.external(() =>
    deps.store.listProjects().map((p) => ({ id: p.id, name: p.name })),
  );

  if (projects.length === 0) {
    // No project registered yet — exit gracefully and tell the user how to
    // add one. Skipping straight to label with project_id=null is allowed by
    // the schema, but the plan §5.1 step 3 always shows a picker; if the
    // picker is empty, the wizard has nothing to render. Easier to bail.
    await ctx.reply(t('wizard.new.noProjects'));
    return;
  }

  let page = 1;
  let projectId: number | null = null;
  // Initial render — uses editMessageText on the agent-step bubble so the
  // wizard occupies one in-place message thread, not a wall of replies.
  // (We use ctx.editMessageText only inside callback handlers; for the
  // first paint we *edit* via the cb ctx that selected the agent above.)
  // Build the first project payload using ctx.reply so non-cb resume paths
  // (rare) still surface UI; subsequent paints reuse cb ctx editMessageText.
  await ctx.reply(t('wizard.new.pickProject', { agent: labelFor(adapterMetadata, agent) }), {
    reply_markup: projectKeyboard(projects, page).kb,
  });

  while (projectId === null) {
    const cbCtx = (await conversation.waitFor('callback_query:data')) as unknown as CbCtx;
    const data = cbCtx.callbackQuery.data;
    if (data === 'wizard:new-cancel') {
      await safeAck(cbCtx);
      await cbCtx.editMessageText(t('wizard.new.cancel'));
      return;
    }
    if (data === 'wizard:new-back') {
      // Cheapest "back" is to abort and ask user to restart — replaying the
      // agent step inside the same conversation needs a checkpoint/rewind
      // dance that's overkill for v0.7. Acceptable per plan §5.1: "back:
      // simpler — just cancel and restart".
      await safeAck(cbCtx);
      await cbCtx.editMessageText(t('wizard.new.cancelRestart'));
      return;
    }
    if (data === 'wizard:new-page:current') {
      // No-op page indicator.
      await safeAck(cbCtx);
      continue;
    }
    const pageMatch = /^wizard:new-page:(\d+)$/.exec(data);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      await safeAck(cbCtx);
      try {
        await cbCtx.editMessageText(
          t('wizard.new.pickProject', { agent: labelFor(adapterMetadata, agent) }),
          { reply_markup: projectKeyboard(projects, page).kb },
        );
      } catch (err) {
        logger.warn({ err: String(err) }, 'wizard: page editMessageText failed');
      }
      continue;
    }
    const projMatch = /^wizard:new-project:(\d+)$/.exec(data);
    if (projMatch) {
      const candidate = Number(projMatch[1]);
      if (!projects.some((p) => p.id === candidate)) {
        await safeAck(cbCtx, t('wizard.new.invalidProject'));
        continue;
      }
      projectId = candidate;
      await safeAck(cbCtx);
      continue;
    }
    // Unknown button on this step — ack + keep waiting.
    await safeAck(cbCtx);
  }

  const project = projects.find((p) => p.id === projectId)!;

  // ---- Step 3: label ----
  await ctx.reply(
    t('wizard.new.askLabel', {
      agent: labelFor(adapterMetadata, agent),
      project: project.name,
    }),
  );

  let label: string | null = null;
  while (label === null) {
    const text = await conversation.form.text({
      otherwise: async (otherwiseCtx) => {
        await otherwiseCtx.reply(t('wizard.new.labelInvalid'));
      },
    });
    const trimmed = text.trim();
    if (trimmed === '/cancel') {
      await ctx.reply(t('wizard.new.cancel'));
      return;
    }
    if (!LABEL_PATTERN.test(trimmed)) {
      await ctx.reply(t('wizard.new.labelInvalid'));
      continue;
    }
    // Reject duplicate labels at this stage so we don't surface an opaque
    // DB error after createSession. We snapshot via `external` because the
    // store call must not be replayed on resume.
    const taken = await conversation.external(
      () => deps.store.findSessionByLabel(chatId, trimmed) !== undefined,
    );
    if (taken) {
      await ctx.reply(t('wizard.new.labelTaken', { label: trimmed }));
      continue;
    }
    label = trimmed;
  }

  // ---- Step 4: create ----
  const finalAgent = agent;
  const finalLabel = label;
  const finalProjectId = projectId;
  let created: SessionRow;
  try {
    created = await conversation.external(() =>
      deps.manager.createSession({
        chatId,
        agent: finalAgent,
        label: finalLabel,
        projectId: finalProjectId,
      }),
    );
  } catch (err) {
    logger.error({ err: String(err) }, 'wizard: createSession failed');
    await ctx.reply(t('wizard.new.createFailed', { error: String(err).slice(0, 160) }));
    return;
  }

  await conversation.external(() => {
    deps.store.setActiveSession(chatId, created.id);
  });

  await ctx.reply(
    t('wizard.new.created', {
      label: created.label,
      agent: labelFor(adapterMetadata, finalAgent),
      project: project.name,
    }),
    { reply_markup: successKeyboard(created.id, t) },
  );

  // Restore the 6-button persistent reply keyboard (plan §4.2 "khôi phục sau
  // khi exit"). Telegram allows only one `reply_markup` per message and the
  // success message above already carries the inline [Switch khác / Tail
  // logs] keyboard. Send a separate trailing message whose sole purpose is to
  // re-attach the persistent keyboard. Failure here is non-fatal — log and
  // continue. The user's next /start would re-send it anyway.
  try {
    await ctx.reply('✓ Sẵn sàng nhận prompt', {
      reply_markup: buildPersistentKeyboard(),
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'wizard: restore persistent keyboard failed');
  }
}
