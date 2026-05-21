import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CONFIG_PATH } from './util/paths.js';
import { expandEnv, loadEnvFile } from './util/env.js';
import { ENV_PATH } from './util/paths.js';

/**
 * Per-adapter config schema (plan P1.1).
 *
 * Each adapter's options are loosely-typed at the top level — a string `binary`
 * + arbitrary extras. The strict per-adapter schema (e.g. Claude's
 * `setting_sources`, Kiro's `agent`/`model`) lives below as overlay schemas
 * that we apply ONLY when the kind is recognised, so unknown adapters can ship
 * without breaking the loader.
 *
 * `passthrough()` keeps unrecognised keys in the parsed object so plugins can
 * read their own custom fields (e.g. `effort`/`sandboxPolicy` for the future
 * Codex adapter) without us having to update the global schema for every
 * adapter.
 */
const agentConfigBase = z
  .object({
    binary: z.string().optional(),
  })
  .passthrough();

/**
 * Claude adapter overlay schema. Validated post-parse so the open-set
 * `z.record` doesn't have to know about Claude-specific fields.
 */
const claudeOverlay = z.object({
  binary: z.string().default('claude'),
  setting_sources: z
    .array(z.enum(['user', 'project', 'local']))
    .default(['user', 'project', 'local']),
});

/**
 * Kiro adapter overlay schema. Same rationale as claudeOverlay.
 */
const kiroOverlay = z.object({
  // kiro-cli binary (separate from the `kiro` IDE launcher). Supports
  // headless `chat --no-interactive` with stdout streaming + resume-id.
  binary: z.string().default('kiro-cli'),
  // Optional kiro-cli agent override. Default = `telecode` (the agent the
  // daemon writes to ~/.kiro/agents/telecode.json on startup). Override
  // only if you want to point at a different custom agent.
  agent: z.string().optional(),
  // Optional model override (--model).
  model: z.string().optional(),
});

/**
 * Codex adapter overlay schema (plan P3.1). Defaults track Codex CLI 0.75 as
 * verified via Context7 (/openai/codex). Adapter is OFF by default — the user
 * must add `agents.codex: {}` (or override fields) to opt in.
 *
 * Authentication is `native` (plan D1): we do NOT read API keys here. The
 * user is expected to `codex login` outside Telecode.
 */
const codexOverlay = z.object({
  // Path or name of the `codex` binary. Default 'codex' so the daemon picks
  // it up from PATH (the recommended Codex install path).
  command: z.string().default('codex'),
  // Model passed via `turn/start.model`. 'gpt-5.1-codex' is the latest
  // documented Codex coding model (per Codex 0.75 docs).
  model: z.string().default('gpt-5.1-codex'),
  // Reasoning effort — Codex accepts 'low' | 'medium' | 'high'.
  effort: z.enum(['low', 'medium', 'high']).default('medium'),
});

/**
 * Cursor adapter overlay schema (plan P4.1). Defaults track the Cursor CLI
 * docs at https://cursor.com/docs/cli (verified via Context7
 * `/websites/cursor_cli`). Adapter is OFF by default in the sense that the
 * binary is only spawned when a session of kind='cursor' is created.
 *
 * Authentication is `native` (plan D1): we do NOT read API keys here. The
 * user is expected to run `cursor-agent login` outside Telecode.
 */
const cursorOverlay = z.object({
  // Path or name of the cursor-agent binary. Default 'cursor-agent' — the
  // disambiguated official name. The docs alternate between `agent` and
  // `cursor-agent`; we pick the latter because installers (Homebrew, curl)
  // emit a `cursor-agent` symlink that is stable across versions.
  command: z.string().default('cursor-agent'),
  // Model passed via `session/new` / `session/prompt`. 'auto' lets the
  // Cursor server pick the latest available model (the recommended default
  // per Cursor docs — model identifiers like 'gpt-5.2' change frequently).
  model: z.string().default('auto'),
});

/**
 * Known overlay map. Adapters get strict validation; unknown kinds just keep
 * their raw fields (validated only as "object with optional string binary").
 *
 * To add a new built-in adapter overlay: append a key here AND extend
 * `TelecodeConfig['agents']` with the strict type.
 */
const overlays = {
  claude: claudeOverlay,
  kiro: kiroOverlay,
  codex: codexOverlay,
  cursor: cursorOverlay,
} as const;

/**
 * Top-level config schema (plan P1.1).
 *
 * `agents` is now `z.record(z.string(), <base>)` — an open map. Validation
 * details:
 *
 *   1. zod's `z.record` enforces the value shape for every entry, but the
 *      `passthrough()` base means each entry just needs to be an object.
 *   2. The post-parse pass (below) applies a strict overlay schema for any
 *      built-in adapter (`claude`, `kiro`, future `codex`/`cursor`) so the
 *      strong typing the daemon code already relies on is preserved.
 *   3. The post-parse pass ALSO checks every key against the live adapter
 *      registry — `agents:` config with a kind nobody registered surfaces a
 *      friendly error at boot time ("did you forget to register 'foo'?").
 */
const ConfigSchema = z.object({
  telegram: z.object({
    bot_token: z.string().min(10),
    allowed_user_ids: z.array(z.number().int()).min(1),
  }),
  daemon: z.object({
    log_dir: z.string(),
    approval_timeout_sec: z.number().int().positive().default(300),
    /** Loopback port for the Kiro preToolUse hook server. 0 = ephemeral (recommended). */
    kiro_hook_port: z.number().int().min(0).max(65535).default(0),
    workspace_scan: z
      .object({
        roots: z.array(z.string()).default([]),
        max_depth: z.number().int().min(1).max(5).default(1),
        exclude: z.array(z.string()).default(['node_modules', '.git', 'dist', 'build']),
      })
      .default({ roots: [], max_depth: 1, exclude: ['node_modules', '.git', 'dist', 'build'] }),
  }),
  agents: z.record(z.string(), agentConfigBase).default({}),
  defaults: z
    .object({ agent: z.string().default('claude') })
    .default({ agent: 'claude' }),
  session_switch_preview_lines: z.number().int().min(0).max(20).default(3),
  notifier: z
    .object({
      debounce_ms: z.number().int().positive().default(3000),
      buffer_cap_bytes: z.number().int().positive().default(50_000),
    })
    .default({ debounce_ms: 3000, buffer_cap_bytes: 50_000 }),
});

/**
 * Strict (overlay-applied) config type exposed to the daemon. Built-in
 * adapter entries carry their typed shape; unknown adapters keep the loose
 * base shape so plugins can still read their own fields.
 *
 * `_userAgentKinds` is a private, non-enumerable surface (see below) that
 * tracks which `agents.<kind>` entries were user-authored (vs synthesized by
 * overlay defaults). The boot-time `validateConfigAgainstRegistry` consults
 * it so an overlay-synthesized `agents.claude` default does NOT trigger an
 * "unknown kind" error in deployments where Claude was deliberately not
 * registered.
 */
export interface TelecodeConfig extends Omit<z.infer<typeof ConfigSchema>, 'agents'> {
  agents: {
    claude?: z.infer<typeof claudeOverlay>;
    kiro?: z.infer<typeof kiroOverlay>;
    codex?: z.infer<typeof codexOverlay>;
    cursor?: z.infer<typeof cursorOverlay>;
  } & Record<string, Record<string, unknown> | undefined>;
  /**
   * INTERNAL — kinds explicitly authored in the YAML (or `_applyOverlays`
   * caller). Consumed by {@link validateConfigAgainstRegistry}; safe to
   * ignore in daemon code paths.
   */
  readonly _userAgentKinds: ReadonlyArray<string>;
}

/**
 * Apply the strict per-adapter overlays after `z.record` parsing.
 * Throws (`z.ZodError`) if any overlay fails — keeps validation messages
 * homogeneous with the rest of the schema.
 *
 * Optional `knownKinds` lets callers (the daemon at boot) cross-check that
 * every configured agent has a registered adapter. Tests can omit it.
 */
function applyOverlays(
  raw: z.infer<typeof ConfigSchema>,
  knownKinds?: ReadonlyArray<string>,
): TelecodeConfig {
  const out: TelecodeConfig['agents'] = {};
  // Snapshot the keys the user actually authored BEFORE we synthesize overlay
  // defaults. The boot-time registry cross-check uses this so a built-in
  // default (e.g. claude when the user never wrote `agents.claude:` in YAML)
  // does NOT count as an "unknown kind" claim against the registry.
  const userAgentKinds = Object.keys(raw.agents);
  // Always feed known overlays through their schema so defaults apply even
  // when the user omitted the section entirely.
  for (const [kind, schema] of Object.entries(overlays)) {
    const v = raw.agents[kind] ?? {};
    const parsed = schema.parse(v);
    (out as Record<string, unknown>)[kind] = parsed;
  }
  // Pass-through any user-configured adapter that doesn't have a strict
  // overlay — keeps the loose base validation already done by z.record.
  for (const [kind, value] of Object.entries(raw.agents)) {
    if (kind in overlays) continue;
    out[kind] = value as Record<string, unknown>;
  }

  // Cross-check against the live registry if the caller provided one.
  if (knownKinds && knownKinds.length > 0) {
    const known = new Set(knownKinds);
    const unknown: string[] = [];
    for (const kind of userAgentKinds) {
      if (!known.has(kind)) unknown.push(kind);
    }
    if (unknown.length > 0) {
      throw new Error(
        `config has unknown agent kinds: ${unknown.join(', ')} ` +
          `(registered: ${[...known].sort().join(', ') || '(none)'})`,
      );
    }
    if (raw.defaults?.agent && !known.has(raw.defaults.agent)) {
      throw new Error(
        `config defaults.agent='${raw.defaults.agent}' is not a registered adapter ` +
          `(registered: ${[...known].sort().join(', ') || '(none)'})`,
      );
    }
  }

  return { ...raw, agents: out, _userAgentKinds: userAgentKinds };
}

/**
 * Load + validate the daemon config (plan P1.1).
 *
 * @param path        Override config file path (tests).
 * @param knownKinds  Optional list of registered adapter kinds — when present,
 *                    every key in `agents:` AND `defaults.agent` is verified
 *                    against this set. Surfaces a friendly error if a user
 *                    config mentions an adapter that isn't built-in or wired.
 */
export function loadConfig(
  path = CONFIG_PATH,
  knownKinds?: ReadonlyArray<string>,
): TelecodeConfig {
  loadEnvFile(ENV_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `config not found at ${path} — run scripts/install-launchd.sh first.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const expanded = expandEnv(raw);
  const parsed: unknown = parseYaml(expanded);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`config validation failed: ${result.error.message}`);
  }
  return applyOverlays(result.data, knownKinds);
}

/**
 * Cross-check an already-loaded {@link TelecodeConfig} against the live set of
 * registered adapter kinds (plan P1.1 §4 boot-time validation).
 *
 * Surface: `loadConfig` must run BEFORE the registry can be built (the daemon
 * needs `config.agents.claude.setting_sources` to wire the Claude adapter), so
 * the registry-aware check cannot be done inside `loadConfig` itself. This
 * helper closes the loop: call it after `registerBuiltinAdapters` to enforce
 * the "unknown agent kinds: …" boot-time error the plan promises.
 *
 * Throws on first violation so the daemon refuses to start with a confused
 * config (better than silently ignoring an `agents.codex:` section the user
 * believes is wired).
 *
 * @param config       Loaded {@link TelecodeConfig}.
 * @param knownKinds   Live registry kinds (e.g. `registry.kinds()`).
 */
export function validateConfigAgainstRegistry(
  config: TelecodeConfig,
  knownKinds: ReadonlyArray<string>,
): void {
  const known = new Set(knownKinds);
  const unknown: string[] = [];
  // Only flag user-authored kinds (captured at load time). Overlay defaults
  // (e.g. claude/kiro synthesized when the YAML omits them) are skipped so a
  // claude-less or kiro-less deployment doesn't false-positive at boot.
  for (const kind of config._userAgentKinds) {
    if (!known.has(kind)) unknown.push(kind);
  }
  if (unknown.length > 0) {
    throw new Error(
      `config has unknown agent kinds: ${unknown.join(', ')} ` +
        `(registered: ${[...known].sort().join(', ') || '(none)'})`,
    );
  }
  // `defaults.agent` is user-facing — always validate. The schema defaults to
  // 'claude' so even a YAML without a `defaults:` section will be checked.
  if (config.defaults?.agent && !known.has(config.defaults.agent)) {
    throw new Error(
      `config defaults.agent='${config.defaults.agent}' is not a registered adapter ` +
        `(registered: ${[...known].sort().join(', ') || '(none)'})`,
    );
  }
}

/** Export for tests that want to validate already-parsed config objects. */
export { applyOverlays as _applyOverlays };
