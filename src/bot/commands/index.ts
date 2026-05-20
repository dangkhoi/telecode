import type { Bot, Context } from 'grammy';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { InputFile } from 'grammy';
import type { TelecodeConfig } from '../../config.js';
import type { SessionStore, SessionRow, AgentKind } from '../../session/store.js';
import type { SessionManager } from '../../session/manager.js';
import type { ApprovalBroker } from '../../approval/broker.js';
import type { PolicyEngine } from '../../approval/policy.js';
import type { Notifier } from '../notifier.js';
import { expandHome } from '../../util/paths.js';
import { scrubSecrets } from '../../util/scrub.js';
import { sessionPickKeyboard } from '../keyboards.js';
import { logger } from '../../util/logger.js';

export interface CommandDeps {
  config: TelecodeConfig;
  store: SessionStore;
  manager: SessionManager;
  broker: ApprovalBroker;
  policy: PolicyEngine;
  notifierFor: (chatId: number) => Notifier;
}

function activeSession(ctx: Context, store: SessionStore): SessionRow | null {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const st = store.getChatState(chatId);
  if (!st.active_session_id) return null;
  return store.getSession(st.active_session_id) ?? null;
}

function projectPathOf(session: SessionRow, store: SessionStore, fallback: string): string {
  if (session.project_id) {
    const p = store.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(session.project_id) as { path: string } | undefined;
    if (p?.path) return p.path;
  }
  return fallback;
}

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const { store, manager, policy, config, notifierFor } = deps;

  bot.command('start', async (ctx) => {
    const chatId = ctx.chat!.id;
    const sessions = store.listSessions(chatId);
    const active = activeSession(ctx, store);
    const lines = [
      '👋 *Telecode* online',
      '',
      `Active: ${active ? '`' + active.label + '`' : '(none — `/session new`)'}`,
      `Sessions: ${sessions.length}`,
      '',
      'Commands: `/session`, `/projects`, `/cd`, `/stop`, `/status`, `/allow`, `/deny`, `/screenshot`',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // ----- /session ... -----
  bot.command('session', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] ?? '').toLowerCase();
    switch (sub) {
      case 'new': {
        const agent = (args[1] as AgentKind) || config.defaults.agent;
        const label = args[2];
        const pathArg = args[3];
        if (!label) return ctx.reply('Usage: /session new <agent> <label> [path]');
        if (agent !== 'claude' && agent !== 'kiro') return ctx.reply('agent must be claude or kiro');
        if (store.findSessionByLabel(chatId, label)) return ctx.reply(`session "${label}" already exists`);

        let projectId: number | null = null;
        if (pathArg) {
          const p = expandHome(pathArg);
          if (!existsSync(p)) return ctx.reply(`path not found: ${p}`);
          const row = store.upsertProject(basename(p), p);
          projectId = row.id;
        } else {
          const st = store.getChatState(chatId);
          projectId = st.active_project_id;
        }
        const row = manager.createSession({ chatId, agent, label, projectId });
        store.setActiveSession(chatId, row.id);
        await ctx.reply(`📍 [${label}] — agent=\`${agent}\``, { parse_mode: 'Markdown' });
        break;
      }
      case 'list': {
        const rows = store.listSessions(chatId);
        if (!rows.length) return ctx.reply('no sessions');
        const lines = rows.map(
          (r) => `• \`${r.label}\` — ${r.agent} · ${r.status}${r.sdk_session_id ? ' · resumable' : ''}`,
        );
        await ctx.reply(lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: sessionPickKeyboard(rows.map((r) => ({ id: r.id, label: r.label }))),
        });
        break;
      }
      case 'switch': {
        const label = args[1];
        if (!label) return ctx.reply('Usage: /session switch <label>');
        const row = store.findSessionByLabel(chatId, label);
        if (!row) return ctx.reply(`unknown: ${label}`);
        store.setActiveSession(chatId, row.id);
        const tail = (row.transcript_tail ?? '')
          .split('\n')
          .slice(-config.session_switch_preview_lines)
          .join('\n');
        await ctx.reply(`📍 [${row.label}]\n${tail || '(no transcript yet)'}`);
        break;
      }
      case 'rename': {
        const newLabel = args[1];
        const cur = activeSession(ctx, store);
        if (!newLabel || !cur) return ctx.reply('Usage: /session rename <new-label>');
        if (store.findSessionByLabel(chatId, newLabel)) return ctx.reply('label taken');
        store.updateSession(cur.id, { label: newLabel });
        await ctx.reply(`✏️ ${cur.label} → ${newLabel}`);
        break;
      }
      case 'close': {
        const label = args[1];
        const target = label ? store.findSessionByLabel(chatId, label) : activeSession(ctx, store);
        if (!target) return ctx.reply('no session');
        manager.interrupt(target.id);
        store.updateSession(target.id, { status: 'closed' });
        const st = store.getChatState(chatId);
        if (st.active_session_id === target.id) store.setActiveSession(chatId, null);
        await ctx.reply(`🗑 closed [${target.label}]`);
        break;
      }
      case 'reset': {
        const cur = activeSession(ctx, store);
        if (!cur) return ctx.reply('no active session');
        store.updateSession(cur.id, { sdk_session_id: null, transcript_tail: '' });
        await ctx.reply(`🔄 reset [${cur.label}]`);
        break;
      }
      default:
        await ctx.reply(
          'session subcommands: new <agent> <label> [path] | list | switch <label> | rename <label> | close [label] | reset',
        );
    }
  });

  // ----- projects -----
  bot.command('projects', async (ctx) => {
    const rows = store.listProjects();
    if (!rows.length) return ctx.reply('no projects — /add <path>');
    await ctx.reply(rows.map((p) => `• \`${p.name}\` → ${p.path}`).join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('add', async (ctx) => {
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (!args[0]) return ctx.reply('Usage: /add <path> [name]');
    const p = expandHome(args[0]);
    if (!existsSync(p)) return ctx.reply(`path not found: ${p}`);
    const name = args[1] ?? basename(p);
    const row = store.upsertProject(name, p);
    await ctx.reply(`📁 ${row.name} → ${row.path}`);
  });

  bot.command('cd', async (ctx) => {
    const chatId = ctx.chat!.id;
    const arg = ctx.match.trim();
    if (!arg) return ctx.reply('Usage: /cd <name|path>');
    let proj = store.findProject(arg);
    if (!proj) {
      const p = expandHome(arg);
      if (existsSync(p)) proj = store.upsertProject(basename(p), p);
    }
    if (!proj) return ctx.reply('not found');
    store.setActiveProject(chatId, proj.id);
    const cur = activeSession(ctx, store);
    if (cur) store.updateSession(cur.id, { project_id: proj.id });
    await ctx.reply(`📁 cwd → ${proj.path}`);
  });

  // ----- control -----
  bot.command('stop', async (ctx) => {
    const cur = activeSession(ctx, store);
    if (!cur) return ctx.reply('no active session');
    const ok = manager.interrupt(cur.id);
    await ctx.reply(ok ? `🛑 stopping [${cur.label}]` : 'nothing to stop');
  });

  bot.command('status', async (ctx) => {
    const chatId = ctx.chat!.id;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (args[0] === 'logs') {
      const n = Math.min(200, Math.max(1, Number(args[1] ?? 20)));
      const cur = activeSession(ctx, store);
      if (!cur) return ctx.reply('no active session');
      const rows = store.tailToolLog(cur.id, n);
      if (!rows.length) return ctx.reply('no logs');
      const txt = rows
        .map(
          (r) =>
            `${new Date(r.created_at).toISOString().slice(11, 19)} ${r.tool_name} ${r.decision ?? ''} ${(r.input_preview ?? '').slice(0, 60)}`,
        )
        .join('\n');
      await ctx.reply('```\n' + scrubSecrets(txt) + '\n```', { parse_mode: 'Markdown' });
      return;
    }
    const cur = activeSession(ctx, store);
    const all = store.listSessions(chatId);
    const lines = [
      `Active: ${cur ? '[' + cur.label + '] ' + cur.agent + ' · ' + cur.status : '(none)'}`,
      `Resume id: ${cur?.sdk_session_id ?? '—'}`,
      `Sessions: ${all.length}`,
    ];
    if (cur) {
      const tools = store.tailToolLog(cur.id, 5);
      if (tools.length) {
        lines.push('Last tools:');
        for (const t of tools) lines.push(`  - ${t.tool_name} ${t.decision ?? ''}`);
      }
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('allow', async (ctx) => {
    const pat = ctx.match.trim();
    if (!pat) return ctx.reply('Usage: /allow <pattern>');
    policy.appendAllow(pat);
    await ctx.reply(`✅ allow += \`${pat}\``, { parse_mode: 'Markdown' });
  });
  bot.command('deny', async (ctx) => {
    const pat = ctx.match.trim();
    if (!pat) return ctx.reply('Usage: /deny <pattern>');
    policy.appendDeny(pat);
    await ctx.reply(`🚫 deny += \`${pat}\``, { parse_mode: 'Markdown' });
  });

  bot.command('screenshot', async (ctx) => {
    const tmp = `/tmp/telecode-screen-${Date.now()}.png`;
    try {
      await execa('screencapture', ['-x', tmp], { timeout: 10_000 });
      await ctx.replyWithPhoto(new InputFile(tmp));
    } catch (err) {
      await ctx.reply(`screencapture failed: ${String(err).slice(0, 200)}`);
    }
  });

  // ---- plain text → dispatch ----
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) return;
    const chatId = ctx.chat!.id;
    const cur = activeSession(ctx, store);
    if (!cur) {
      await ctx.reply('no active session — /session new <agent> <label> [path]');
      return;
    }
    const projPath = projectPathOf(cur, store, process.cwd());
    const notifier = notifierFor(chatId);
    const streamKey = `s:${cur.id}`;
    store.appendTranscript(cur.id, `> ${text.slice(0, 200)}`);
    await ctx.reply(`[${cur.label}] dispatching…`);
    // Fire-and-forget, await inside dispatch.
    void manager
      .dispatch({
        sessionId: cur.id,
        sessionLabel: cur.label,
        chatId,
        cwd: projPath,
        agent: cur.agent,
        resumeId: cur.sdk_session_id,
        prompt: text,
        onEvent: (e) => {
          if (e.type === 'text') {
            notifier.appendStream(streamKey, e.text);
            store.appendTranscript(cur.id, e.text.split('\n').slice(-1)[0] ?? '');
          } else if (e.type === 'tool_use') {
            void notifier.sendPlain(`🔧 ${e.tool} — ${scrubSecrets(JSON.stringify(e.input).slice(0, 200))}`);
          } else if (e.type === 'error') {
            void notifier.sendPlain(`❌ ${e.error}`);
          } else if (e.type === 'done') {
            void notifier.closeStream(streamKey).then(() => {
              const tail = e.result
                ? `✅ done${e.totalCostUsd ? ` · $${e.totalCostUsd.toFixed(4)}` : ''}`
                : '✅ done';
              void notifier.sendPlain(`[${cur.label}] ${tail}`);
            });
          } else if (e.type === 'session') {
            // resume id already persisted in adapter
          }
        },
      })
      .catch((err: unknown) => {
        logger.error({ err: String(err) }, 'dispatch crash');
      });
  });
}
