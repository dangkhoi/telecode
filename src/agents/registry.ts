import type { AgentAdapter, AgentKind } from './types.js';
import { ClaudeAdapter, type ClaudeAdapterOpts } from './claude.js';
import { KiroAdapter, type KiroAdapterOpts } from './kiro.js';

export interface AgentRegistryOpts {
  claude: ClaudeAdapterOpts;
  kiro: KiroAdapterOpts;
}

export class AgentRegistry {
  private readonly map: Record<AgentKind, AgentAdapter>;
  constructor(opts: AgentRegistryOpts) {
    this.map = {
      claude: new ClaudeAdapter(opts.claude),
      kiro: new KiroAdapter(opts.kiro),
    };
  }
  get(kind: AgentKind): AgentAdapter {
    const a = this.map[kind];
    if (!a) throw new Error(`unknown agent kind: ${kind}`);
    return a;
  }
}
