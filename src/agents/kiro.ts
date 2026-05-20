import { execa } from 'execa';
import type { AgentAdapter, AgentStartOpts } from './types.js';
import { logger } from '../util/logger.js';

export interface KiroAdapterOpts {
  binary: string;
  defaultMode: 'ask' | 'edit' | 'agent';
}

export class KiroAdapter implements AgentAdapter {
  readonly kind = 'kiro' as const;
  constructor(private readonly opts: KiroAdapterOpts) {}

  async run(start: AgentStartOpts): Promise<void> {
    const args = ['chat', '--mode', this.opts.defaultMode, '--reuse-window', start.initialPrompt];
    try {
      start.onEvent({ type: 'status', status: 'kiro_spawning' });
      const child = execa(this.opts.binary, args, {
        cwd: start.cwd,
        timeout: 30_000,
        reject: false,
        cancelSignal: start.abortSignal,
      });
      const result = await child;
      if (result.failed) {
        start.onEvent({
          type: 'error',
          error: `kiro CLI exit ${result.exitCode ?? '?'}: ${result.stderr?.toString().slice(0, 500) ?? ''}`,
        });
        return;
      }
      start.onEvent({
        type: 'text',
        text:
          '✉️ Sent to Kiro IDE (mode `' +
          this.opts.defaultMode +
          '`). Open the Kiro window to watch the agent run. ' +
          '(Phase 1: no stdout stream-back — see plan §9 M4.)',
        final: true,
      });
      start.onEvent({ type: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'kiro run failed');
      start.onEvent({ type: 'error', error: msg });
    }
  }
}
