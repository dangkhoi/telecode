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
  /**
   * Optional platform override for testing. Production callers omit this and
   * the function picks up `process.platform`. Tests inject `'win32'` or
   * `'linux'` to snapshot-assert the rendered command without monkey-patching
   * the global `process` object.
   */
  platform?: NodeJS.Platform;
}

/**
 * P5.3 — Render the preToolUse hook `command` string for the current
 * platform.
 *
 * Kiro CLI's agent JSON schema (verified via Context7 against
 * /websites/kiro_dev_cli) only accepts a SINGLE `command` string per hook —
 * unlike MCP servers which support a separate `args` array. The documented
 * examples include shell-style brace groups and `>>` redirection, so we know
 * the hook command is executed via a shell.
 *
 *   - POSIX (darwin / linux): the gate script is built with a
 *     `#!/usr/bin/env node` shebang and chmod +x'd by the build step, so the
 *     absolute path alone is a valid executable for any POSIX shell to run.
 *   - Windows: shebangs are ignored; the shell (cmd.exe / PowerShell) does
 *     not know to invoke `node`. We MUST emit `node "<absolute-path>"` and
 *     rely on `node` being on the spawned kiro-cli's PATH. Paths are
 *     double-quoted so spaces in user profile folders (`C:\Users\First Last`)
 *     don't truncate the command at the first space.
 *
 * Single-quote escaping inside the path is the only attack vector — we
 * defensively escape embedded double quotes by doubling them, which is what
 * cmd.exe's `\"` rule reduces to inside a quoted argument when the binary
 * (node) re-tokenises the command line.
 */
export function renderHookCommand(gateScriptPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // Escape embedded double quotes to keep `node "..."` parse-safe for cmd.exe.
    const escaped = gateScriptPath.replace(/"/g, '""');
    return `node "${escaped}"`;
  }
  return gateScriptPath;
}

/**
 * Generate (or refresh) `~/.kiro/agents/telecode.json`. The agent grants
 * unrestricted tool surface (so the model isn't pre-censored) but funnels every
 * tool call through our `preToolUse` hook, which calls back to the running
 * daemon for policy + Telegram approval. This is the bridge that gives Kiro
 * Claude-like interactive permissions.
 *
 * MCP inheritance: `includeMcpJson: true` makes the agent pick up the global
 * `~/.kiro/settings/mcp.json` server list (e.g. context7, fetch, and any custom
 * MCPs the user has configured) just like the user's default desktop Kiro agent
 * does. Without this flag, custom agents start with an empty MCP server set and
 * the user gets confused why their tools "disappeared" when prompting via
 * Telegram. Bug discovered post v0.8 when user MCP tools were unreachable from
 * Telecode-driven Kiro sessions.
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
          command: renderHookCommand(opts.gateScriptPath, opts.platform),
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
  // Plan P1.2: `mode: 0o600` is honoured on POSIX. On Windows Node ignores the
  // mode bits (NTFS uses ACLs, not POSIX permission bits). Securing this file
  // on Windows is the user's responsibility — typical defaults (per-user
  // profile folder under %USERPROFILE%) already restrict to the owning user.
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, KIRO_TELECODE_AGENT);
  logger.info({ path: KIRO_TELECODE_AGENT }, 'kiro telecode agent config written');
}
