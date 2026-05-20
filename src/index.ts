import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
// IMPORTANT: install the stdout/stderr scrubber BEFORE any other import that
// might write to console (notably grammY / node-fetch error logging which
// includes the full bot-token-bearing URL on network failures).
import { installConsoleScrub } from './util/console-scrub.js';
installConsoleScrub();
import { loadConfig } from './config.js';
import { SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { AgentRegistry } from './agents/registry.js';
import { ApprovalBroker } from './approval/broker.js';
import { PolicyEngine } from './approval/policy.js';
import { scanWorkspaces } from './util/workspace-scanner.js';
import { startBot } from './bot/router.js';
import { logger } from './util/logger.js';
import { POLICY_PATH } from './util/paths.js';
import { KiroHookServer } from './util/kiro-hook-server.js';
import { writeKiroTelecodeAgent } from './agents/kiro-agent-config.js';

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

  const store = new SessionStore();
  const policy = new PolicyEngine(POLICY_PATH);
  policy.watch(() => logger.info('policy reloaded'));

  const broker = new ApprovalBroker({ timeoutMs: config.daemon.approval_timeout_sec * 1000 });

  // Pre-flight: resolve kiro binary on disk so we don't fail at first
  // session-creation with a confusing ENOENT. The binary often lives outside
  // launchd's default PATH (e.g. `kiro-cli` ships at ~/.local/bin/), so the
  // user is expected to use an absolute path in config.yaml.
  const kiroBinary = config.agents.kiro.binary;
  if (!kiroBinary.startsWith('/')) {
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

  // Kiro hook bridge: HTTP loopback receiver + write the custom agent so
  // kiro-cli's preToolUse routes here for policy + Telegram approval.
  const kiroHookServer = new KiroHookServer({ port: config.daemon.kiro_hook_port, store, policy, broker });
  const kiroHookPort = await kiroHookServer.start();
  const gateScriptPath = resolveGateScript();
  writeKiroTelecodeAgent({
    gateScriptPath,
    // Give kiro-cli's hook 10s extra grace beyond the broker's own timeout so
    // the broker is always the one that "expires" first, cleans up its pending
    // map, and writes a tool_log row — instead of kiro-cli SIGKILL'ing the
    // hook process mid-await and orphaning a Telegram button.
    approvalTimeoutMs: config.daemon.approval_timeout_sec * 1000 + 10_000,
    model: config.agents.kiro.model,
  });

  const registry = new AgentRegistry({
    claude: {
      broker,
      policy,
      store,
      settingSources: config.agents.claude.setting_sources,
    },
    kiro: {
      binary: config.agents.kiro.binary,
      agent: config.agents.kiro.agent ?? 'telecode',
      model: config.agents.kiro.model,
      gateUrl: kiroHookServer.url(),
    },
  });

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

  const started = await startBot({ config, store, manager, broker, policy });

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
    await kiroHookServer.stop();
    await started.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
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
