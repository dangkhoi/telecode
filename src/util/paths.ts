import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

export const TELECODE_HOME = expandHome('~/.telecode');
export const CONFIG_PATH = `${TELECODE_HOME}/config.yaml`;
export const POLICY_PATH = `${TELECODE_HOME}/policy.yaml`;
export const ENV_PATH = `${TELECODE_HOME}/.env`;
export const DB_PATH = `${TELECODE_HOME}/state.db`;
export const LOG_DIR = `${TELECODE_HOME}/logs`;

// Kiro CLI global agents directory and our generated agent file.
export const KIRO_AGENTS_DIR = expandHome('~/.kiro/agents');
export const KIRO_TELECODE_AGENT = `${KIRO_AGENTS_DIR}/telecode.json`;
