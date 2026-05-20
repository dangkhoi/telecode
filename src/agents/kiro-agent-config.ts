import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { KIRO_AGENTS_DIR, KIRO_TELECODE_AGENT } from '../util/paths.js';
import { logger } from '../util/logger.js';

export interface KiroAgentConfigOpts {
  /** Absolute path to the compiled kiro-gate.js shipped with this daemon. */
  gateScriptPath: string;
  /** Timeout in ms for kiro-cli to wait on the preToolUse hook. */
  approvalTimeoutMs: number;
  /** Optional model override. */
  model?: string;
}

/**
 * Generate (or refresh) `~/.kiro/agents/telecode.json`. The agent grants
 * unrestricted tool surface (so the model isn't pre-censored) but funnels every
 * tool call through our `preToolUse` hook, which calls back to the running
 * daemon for policy + Telegram approval. This is the bridge that gives Kiro
 * Claude-like interactive permissions.
 *
 * MCP inheritance: `includeMcpJson: true` makes the agent pick up the global
 * `~/.kiro/settings/mcp.json` server list (e.g. ai-dlc, context7, fetch) just
 * like the user's default desktop Kiro agent does. Without this flag, custom
 * agents start with an empty MCP server set and the user gets confused why
 * their tools "disappeared" when prompting via Telegram. Bug discovered post
 * v0.8 when ai-dlc tools were unreachable from Telecode-driven Kiro sessions.
 *
 * Tools field: kiro-cli docs (https://kiro.dev/docs/cli/custom-agents/configuration-reference)
 * declare `"*"` as the wildcard that covers BOTH built-in tools AND every MCP
 * tool from servers loaded via `includeMcpJson`. The undocumented `"@*"` was
 * tried first as a belt-and-braces but produces no extra effect — `["*"]`
 * alone is the canonical spelling.
 */
export function writeKiroTelecodeAgent(opts: KiroAgentConfigOpts): void {
  mkdirSync(KIRO_AGENTS_DIR, { recursive: true });

  const config: Record<string, unknown> = {
    name: 'telecode',
    description: 'Telecode-managed agent. preToolUse calls back to the Telecode daemon for policy + Telegram approval.',
    // No `prompt` override — fall through to kiro-cli default behaviour.
    tools: ['*'],
    allowedTools: ['*'],
    includeMcpJson: true,
    hooks: {
      preToolUse: [
        {
          command: opts.gateScriptPath,
          timeout_ms: opts.approvalTimeoutMs,
        },
      ],
    },
  };
  if (opts.model) config.model = opts.model;

  const next = JSON.stringify(config, null, 2) + '\n';
  if (existsSync(KIRO_TELECODE_AGENT)) {
    try {
      const prev = readFileSync(KIRO_TELECODE_AGENT, 'utf8');
      if (prev === next) return;
    } catch {
      /* fall through to write */
    }
  }
  // Atomic write to survive concurrent kiro-cli reads.
  const tmp = `${KIRO_TELECODE_AGENT}.tmp.${process.pid}`;
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, KIRO_TELECODE_AGENT);
  logger.info({ path: KIRO_TELECODE_AGENT }, 'kiro telecode agent config written');
}
