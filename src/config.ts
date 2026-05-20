import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CONFIG_PATH } from './util/paths.js';
import { expandEnv, loadEnvFile } from './util/env.js';
import { ENV_PATH } from './util/paths.js';

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
  agents: z.object({
    claude: z.object({
      binary: z.string().default('claude'),
      setting_sources: z
        .array(z.enum(['user', 'project', 'local']))
        .default(['user', 'project', 'local']),
    }),
    kiro: z.object({
      // kiro-cli binary (separate from the `kiro` IDE launcher). Supports
      // headless `chat --no-interactive` with stdout streaming + resume-id.
      binary: z.string().default('kiro-cli'),
      // Optional kiro-cli agent override. Default = `telecode` (the agent the
      // daemon writes to ~/.kiro/agents/telecode.json on startup). Override
      // only if you want to point at a different custom agent.
      agent: z.string().optional(),
      // Optional model override (--model).
      model: z.string().optional(),
    }),
  }),
  defaults: z
    .object({ agent: z.enum(['claude', 'kiro']).default('claude') })
    .default({ agent: 'claude' }),
  session_switch_preview_lines: z.number().int().min(0).max(20).default(3),
});

export type TelecodeConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path = CONFIG_PATH): TelecodeConfig {
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
  return result.data;
}
