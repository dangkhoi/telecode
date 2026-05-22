import { fileURLToPath } from 'node:url';
import path, { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
// IMPORTANT: install the stdout/stderr scrubber BEFORE any other import that
// might write to console (notably grammY / node-fetch error logging which
// includes the full bot-token-bearing URL on network failures).
import { installConsoleScrub } from './util/console-scrub.js';
installConsoleScrub();
import { loadConfig, validateConfigAgainstRegistry } from './config.js';
import { SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { AgentRegistry } from './agents/registry.js';
import { registerBuiltinAdapters } from './agents/index.js';
import { ApprovalBroker } from './approval/broker.js';
import { PolicyEngine } from './approval/policy.js';
import { scanWorkspaces } from './util/workspace-scanner.js';
import { startBot } from './bot/router.js';
import { configureAdapterMetadata } from './bot/reply-builders.js';
import { logger } from './util/logger.js';
import { POLICY_PATH } from './util/paths.js';
import { KiroHookServer } from './util/kiro-hook-server.js';
import { writeKiroTelecodeAgent } from './agents/kiro-agent-config.js';
import { generateGateToken } from './util/hmac.js';
import { acquireLock, LockfileError } from './daemon/lockfile.js';

function resolveGateScript(): string {
  // Find the compiled cli/kiro-gate.js next to this file (dist/) or fall back
  // to the source path when running via tsx. Fail loudly if NEITHER exists —
  // a missing gate script would make every Kiro tool call fail-closed with a
  // confusing 'daemon unreachable' deny, masking the root cause.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, 'cli/kiro-gate.js'), resolve(here, '../src/cli/kiro-gate.ts')];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `kiro-gate script not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Run `npm run build` (which chmods dist/cli/kiro-gate.js) before starting the daemon.',
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ allowed: config.telegram.allowed_user_ids }, 'telecode booting');

  // P6.3 — Single-instance lock. Acquire BEFORE any other side-effecting init
  // (SessionStore opens SQLite WAL, hook server binds a port, agent JSON
  // gets rewritten). On conflict the message includes the live PID + the
  // lockfile path so the user can recover with a single `kill` or `rm`.
  let releaseLock: () => void;
  try {
    const lock = acquireLock();
    releaseLock = lock.release;
  } catch (err) {
    if (err instanceof LockfileError) {
      // Friendly Vietnamese message already baked into LockfileError.message.
      // Print to stderr so launchd/systemd journals capture it.
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  const store = new SessionStore();
  const policy = new PolicyEngine(POLICY_PATH);
  policy.watch(() => logger.info('policy reloaded'));

  const broker = new ApprovalBroker({ timeoutMs: config.daemon.approval_timeout_sec * 1000 });

  // Pre-flight: resolve kiro binary on disk so we don't fail at first
  // session-creation with a confusing ENOENT. The binary often lives outside
  // launchd's default PATH (e.g. `kiro-cli` ships at ~/.local/bin/), so the
  // user is expected to use an absolute path in config.yaml.
  const kiroBinary = config.agents.kiro?.binary ?? 'kiro-cli';
  // Plan P1.2: `path.isAbsolute` is portable — on Windows it accepts both
  // `C:\foo` and `\\server\share` while still treating `kiro-cli.exe` as
  // relative; `startsWith('/')` was a POSIX-only heuristic.
  if (!path.isAbsolute(kiroBinary)) {
    logger.warn(
      { binary: kiroBinary, path: process.env.PATH },
      'kiro binary is relative — daemon PATH may not include it (try absolute path in config.yaml)',
    );
  } else if (!existsSync(kiroBinary)) {
    logger.warn(
      { binary: kiroBinary },
      'kiro binary does not exist at configured path — Kiro sessions will fail until fixed',
    );
  }

  // P6.1 — generate per-boot gate token before starting the hook server so
  // the server, kiro-cli env, and the agent JSON file all observe the same
  // value. Token never persists to disk; it lives in process memory + the
  // child kiro-cli's environment until shutdown.
  const gateToken = generateGateToken();

  // Kiro hook bridge: HTTP loopback receiver + write the custom agent so
  // kiro-cli's preToolUse routes here for policy + Telegram approval.
  const kiroHookServer = new KiroHookServer({
    port: config.daemon.kiro_hook_port,
    store,
    policy,
    broker,
    token: gateToken,
  });
  const kiroHookPort = await kiroHookServer.start();
  const gateScriptPath = resolveGateScript();
  writeKiroTelecodeAgent({
    gateScriptPath,
    // Give kiro-cli's hook 10s extra grace beyond the broker's own timeout so
    // the broker is always the one that "expires" first, cleans up its pending
    // map, and writes a tool_log row — instead of kiro-cli SIGKILL'ing the
    // hook process mid-await and orphaning a Telegram button.
    approvalTimeoutMs: config.daemon.approval_timeout_sec * 1000 + 10_000,
    model: config.agents.kiro?.model,
  });

  // Plan P1.1: open-set registry. `registerBuiltinAdapters` is the single
  // place where built-in adapters are bound; adding a new built-in adapter
  // means editing src/agents/index.ts (and src/config.ts for its option
  // schema) — never this file.
  const registry = new AgentRegistry();
  registerBuiltinAdapters(registry, {
    claude: config.agents.claude
      ? {
          broker,
          policy,
          store,
          settingSources: config.agents.claude.setting_sources,
        }
      : undefined,
    kiro: config.agents.kiro
      ? {
          binary: config.agents.kiro.binary,
          agent: config.agents.kiro.agent ?? 'telecode',
          model: config.agents.kiro.model,
          gateUrl: kiroHookServer.url(),
          // P6.1 — propagate the per-boot token so kiro-cli's preToolUse
          // hook can authenticate with the loopback server.
          gateToken,
        }
      : undefined,
    // Plan P3: Codex adapter is on by default — overlays always materialize
    // defaults (command='codex', model='gpt-5.1-codex', effort='medium'). The
    // binary itself is resolved off PATH; if missing the adapter surfaces a
    // spawn error at first use (no boot-time gate, since users with no Codex
    // installed should still be able to run Claude/Kiro sessions).
    codex: config.agents.codex
      ? {
          command: config.agents.codex.command,
          model: config.agents.codex.model,
          effort: config.agents.codex.effort,
          broker,
        }
      : undefined,
    // Plan P4: Cursor adapter — same lazy-binary policy as Codex. Overlays
    // always materialize defaults (command='cursor-agent', model='auto'),
    // so the kind shows up in the wizard regardless of install state; the
    // adapter emits a spawn / auth error at first use if cursor-agent is
    // missing or the user hasn't run `cursor-agent login`.
    cursor: config.agents.cursor
      ? {
          command: config.agents.cursor.command,
          model: config.agents.cursor.model,
          broker,
        }
      : undefined,
  });

  // Plan P1.1: cross-check the loaded config against the live registry. The
  // schema-level `z.record` accepts any kind name (intentional — preserves
  // unknown plugin configs), but at boot time we want a friendly fail-fast
  // error if the user references an adapter that nobody registered (typo,
  // missing build step, removed adapter). This is the "knownKinds" gate the
  // plan promises (§4 P1.1) — implemented here because the registry can only
  // be built AFTER `loadConfig` (overlays surface settings the registry needs).
  validateConfigAgainstRegistry(config, registry.kinds());

  // Plan P1.1: feed the registry-derived metadata into reply-builders so
  // session lists, strips, and dashboards render with the correct badge for
  // every kind including future plugins.
  configureAdapterMetadata(registry.list());

  const manager = new SessionManager(store, registry, {
    bufferCapBytes: config.notifier.buffer_cap_bytes,
  });

  // Workspace scan → auto-register projects
  const scanned = scanWorkspaces({
    roots: config.daemon.workspace_scan.roots,
    maxDepth: config.daemon.workspace_scan.max_depth,
    exclude: config.daemon.workspace_scan.exclude,
  });
  for (const w of scanned) store.upsertProject(w.name, w.path);
  logger.info({ count: scanned.length }, 'workspace scan complete');

  // Crash-recovery: mark stale sessions interrupted, notify.
  const stale = store.markRunningAsInterrupted();

  const started = await startBot({ config, store, manager, broker, policy, registry });

  // v1.2 D9 — Timeline HTTP server (loopback only).
  const { startTimelineServer } = await import('./bot/timeline.js');
  const timeline = await startTimelineServer({ store, port: config.daemon.timeline_port });
  (globalThis as any).__telecode_timeline_port = timeline.port;

  // Phase B (plan §B.5) — first-boot of v1.1 announcement per allowed chat.
  //
  // Detection rule: chat has NO row in `chat_settings` yet. This is the
  // cleanest "haven't seen v1.1 boot before for this chat" marker — schema
  // change (v1.1 added the table), and the migration helpers never auto-
  // insert rows on read. After sending, we INSERT the default `summary` row
  // so the message fires exactly once even across daemon restarts.
  //
  // Failure handling: a Telegram send error must NOT block boot. We log
  // and skip — the announcement is helpful, not critical, and the user can
  // discover the mode system via the slash menu (`/mode`, `/settings`).
  for (const chatId of config.telegram.allowed_user_ids) {
    if (store.chatSettingsExists(chatId)) continue;
    try {
      await started.bot.api.sendMessage(
        chatId,
        '📢 *Telecode v1.1* — verbosity modes\n\n' +
          'Mode mặc định giờ là 🎯 *Summary* — chỉ show approval + done + errors.\n\n' +
          'Muốn behavior cũ (verbose firehose):\n' +
          '  • `/mode verbose`           — chỉ áp dụng cho session active\n' +
          '  • `/settings mode verbose`  — đặt làm default cho cả chat\n\n' +
          'Đổi mode bất kỳ lúc nào qua slash menu (`/mode`, `/settings`).',
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      logger.warn(
        { err: String(err), chatId },
        'v1.1 announcement send failed — continuing without it',
      );
    }
    // Mark sent: insert the default row so we don't re-spam on restart.
    // Idempotent (ON CONFLICT updates) — safe if a race somehow created the
    // row between the existence check and now.
    store.setChatDefaultMode(chatId, 'summary');
  }

  for (const s of stale) {
    try {
      const n = (started as unknown as { notifier: { sendPlain: (s: string) => Promise<unknown> } }).notifier;
      // notify on the actual chat the session belonged to
      const bot = started.bot;
      await bot.api.sendMessage(
        s.chat_id,
        `⚠️ Daemon restarted — session [${s.label}] was interrupted.`,
      );
      void n; // satisfy ts
    } catch (err) {
      logger.warn({ err: String(err) }, 'crash-recovery notify failed');
    }
  }

  // Periodic prune of tool_log (7 days)
  const pruneTimer = setInterval(
    () => {
      const removed = store.pruneToolLog(7 * 24 * 60 * 60 * 1000);
      if (removed) logger.info({ removed }, 'pruned tool_log');
    },
    60 * 60 * 1000,
  );

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutdown');
    clearInterval(pruneTimer);
    policy.stop();
    timeline.server.close();
    await kiroHookServer.stop();
    await started.stop();
    store.close();
    // P6.3 — release the lockfile AFTER everything else so a concurrent boot
    // attempt during shutdown sees us as still running until the dust settles.
    try {
      releaseLock();
    } catch (err) {
      logger.warn({ err: String(err) }, 'lockfile release failed during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // P5.3 — Windows raises SIGBREAK on Ctrl+Break (and NSSM sends SIGBREAK
  // before SIGTERM during the configured AppStopMethodConsole window). On
  // POSIX SIGBREAK isn't a real signal — process.on still installs the
  // listener but it just never fires, so this line is safe cross-platform.
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  process.on('uncaughtException', (err) => {
    logger.error({ err: String(err) }, 'uncaught');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err: String(err) }, 'unhandledRejection');
  });

  logger.info('telecode ready');
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
