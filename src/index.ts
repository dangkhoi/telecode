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

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ allowed: config.telegram.allowed_user_ids }, 'telecode booting');

  const store = new SessionStore();
  const policy = new PolicyEngine(POLICY_PATH);
  policy.watch(() => logger.info('policy reloaded'));

  const broker = new ApprovalBroker({ timeoutMs: config.daemon.approval_timeout_sec * 1000 });

  const registry = new AgentRegistry({
    claude: {
      broker,
      policy,
      store,
      settingSources: config.agents.claude.setting_sources,
    },
    kiro: {
      binary: config.agents.kiro.binary,
      trustTools: config.agents.kiro.trust_tools,
      agent: config.agents.kiro.agent,
      model: config.agents.kiro.model,
    },
  });

  const manager = new SessionManager(store, registry);

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
