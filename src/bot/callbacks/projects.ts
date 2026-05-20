import type { Context } from 'grammy';
import type { SessionStore } from '../../session/store.js';
import type { CallbackRouter, CallbackRouterContext } from '../callback-router.js';
import { buildProjectList, type ProjectListItem } from '../reply-builders.js';
import { logger } from '../../util/logger.js';

/**
 * Dependencies for the `project:*` callback handlers (B2).
 * Kept narrow on purpose — only the `SessionStore` is touched. This makes the
 * handlers trivially testable: instantiate a {@link CallbackRouter}, call
 * {@link registerProjectCallbacks}, and dispatch synthetic `project:cd`,
 * `project:new`, `project:page` updates against an in-memory store.
 */
export interface ProjectCallbackDeps {
  store: SessionStore;
}

/**
 * Snapshot the current projects table into the `ProjectListItem[]` shape
 * consumed by {@link buildProjectList}. Read lazily inside each handler so
 * pagination reflects newly registered / removed projects without restart.
 */
function listProjectItems(store: SessionStore): ProjectListItem[] {
  return store.listProjects().map((p) => ({ id: p.id, name: p.name, path: p.path }));
}

/**
 * Register the three `project:*` callback handlers on the given router (plan
 * §5.2):
 *
 *  - `project:cd:<id>`   — set active project for the chat, strip the button
 *                          cluster from the originating message, confirm.
 *  - `project:new:<id>`  — B2 placeholder until B3 lands the wizard; replies
 *                          with the pre-filled-project notice.
 *  - `project:page:<n>`  — re-render the picker on page `<n>` via
 *                          `ctx.editMessageText`. The static page-indicator
 *                          button emits `project:page:current` which is a
 *                          deliberate no-op (just clears the spinner).
 */
export function registerProjectCallbacks<C extends Context = Context>(
  router: CallbackRouter<C>,
  deps: ProjectCallbackDeps,
): void {
  router.on('project', 'cd', async (ctx, payload) => {
    await projectCdHandler(ctx, payload, deps);
  });
  router.on('project', 'new', async (ctx, payload) => {
    await projectNewHandler(ctx, payload, deps);
  });
  router.on('project', 'page', async (ctx, payload) => {
    await projectPageHandler(ctx, payload, deps);
  });
}

/**
 * `project:cd:<id>` — switch the chat's active project.
 *
 * Also retargets the chat's active session (if any) to the new project so a
 * follow-up prompt executes under the chosen cwd — matches `/cd` semantics in
 * `src/bot/commands/index.ts`.
 *
 * Exported for direct unit testing without spinning up a CallbackRouter.
 */
export async function projectCdHandler(
  ctx: CallbackRouterContext,
  payload: string,
  deps: ProjectCallbackDeps,
): Promise<void> {
  const { store } = deps;
  const id = Number(payload);
  const chatId = ctx.chat?.id;
  if (!chatId) {
    // Defensive: every callback_query carries the originating chat, but if
    // we ever receive one without (Telegram client bug, replay edge case),
    // avoid polluting chat_state with a chat_id=0 row.
    await ctx.answerCallbackQuery({ text: 'no chat' });
    return;
  }
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.answerCallbackQuery({ text: 'bad project id' });
    return;
  }
  const proj = store.getProject(id);
  if (!proj) {
    await ctx.answerCallbackQuery({ text: 'not found' });
    return;
  }
  store.setActiveProject(chatId, proj.id);
  const st = store.getChatState(chatId);
  if (st.active_session_id) {
    store.updateSession(st.active_session_id, { project_id: proj.id });
  }
  await ctx.answerCallbackQuery({ text: `→ ${proj.name}` });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    /* ignore: message may be too old to edit */
  }
  await ctx.reply(`📁 Active project → \`${proj.name}\``, { parse_mode: 'Markdown' });
}

/**
 * `project:new:<id>` — B2 placeholder. B3 will replace this with the actual
 * wizard entry pre-filling the chosen project.
 */
export async function projectNewHandler(
  ctx: CallbackRouterContext,
  payload: string,
  deps: ProjectCallbackDeps,
): Promise<void> {
  const { store } = deps;
  const id = Number(payload);
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.answerCallbackQuery({ text: 'bad project id' });
    return;
  }
  const proj = store.getProject(id);
  await ctx.answerCallbackQuery();
  const projName = proj ? proj.name : `id=${id}`;
  await ctx.reply(
    `Wizard /new sắp ra mắt với project đã chọn (\`${projName}\`)`,
    { parse_mode: 'Markdown' },
  );
}

/**
 * `project:page:<n>` — re-render the picker on a different page in place.
 * `payload === 'current'` is a no-op (the static page-indicator button).
 *
 * Telegram returns `400 Bad Request: message is not modified` when the new
 * text + markup are byte-identical to the current message (e.g. clamping
 * a too-high page number lands on the same content). We swallow that
 * specific error to keep the callback ack quiet.
 */
export async function projectPageHandler(
  ctx: CallbackRouterContext,
  payload: string,
  deps: ProjectCallbackDeps,
): Promise<void> {
  const { store } = deps;
  if (payload === 'current') {
    await ctx.answerCallbackQuery();
    return;
  }
  const page = Number(payload);
  if (!Number.isInteger(page) || page < 1) {
    await ctx.answerCallbackQuery({ text: 'bad page' });
    return;
  }
  const items = listProjectItems(store);
  const next = buildProjectList(items, { page });
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(next.text, {
      reply_markup: next.reply_markup,
      ...(next.parse_mode ? { parse_mode: next.parse_mode } : {}),
    });
  } catch (err) {
    const msg = String(err);
    if (!/not modified/i.test(msg)) {
      logger.warn({ err: msg }, 'project page edit failed');
    }
  }
}
