import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~` / `~/` segment in `p` to the user's home directory.
 * Returns `p` unchanged if it doesn't start with `~`.
 *
 * NOTE: this is a small ergonomic shortcut for paths read from config /
 * user input. It is NOT a shell-style brace/glob expander — `~user/foo` is
 * intentionally returned as-is (other users' homes are not resolvable
 * portably without `pwd`/`/etc/passwd`).
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.resolve(homedir(), p.slice(2));
  // Windows users may write `~\foo` in config — handle backslash separator too.
  if (p.startsWith('~\\')) return path.resolve(homedir(), p.slice(2));
  return p;
}

/**
 * The Telecode home directory. All persistent daemon state lives under this
 * root; tests override it via env or by overriding individual paths.
 *
 * Plan P1.2 — every child path below MUST be built via `path.join` so the
 * Windows port automatically inherits backslash separators. Avoid raw string
 * concatenation with `/` even for "obvious" cases.
 */
export const TELECODE_HOME = expandHome('~/.telecode');
export const CONFIG_PATH = path.join(TELECODE_HOME, 'config.yaml');
export const POLICY_PATH = path.join(TELECODE_HOME, 'policy.yaml');
export const ENV_PATH = path.join(TELECODE_HOME, '.env');
export const DB_PATH = path.join(TELECODE_HOME, 'state.db');
export const LOG_DIR = path.join(TELECODE_HOME, 'logs');

// Kiro CLI global agents directory and our generated agent file.
export const KIRO_AGENTS_DIR = expandHome('~/.kiro/agents');
export const KIRO_TELECODE_AGENT = path.join(KIRO_AGENTS_DIR, 'telecode.json');
