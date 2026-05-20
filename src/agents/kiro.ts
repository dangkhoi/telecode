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
    try {
      start.onEvent({ type: 'status', status: 'kiro_spawning' });

      // Step 1: ensure the project workspace is open in a Kiro window.
      // `kiro -r <path>` opens or focuses an existing window on that workspace.
      // Without this, `kiro chat --reuse-window` may target a window that has a
      // different workspace open (or no workspace), and the prompt is dropped.
      const openWin = await execa(this.opts.binary, ['-r', start.cwd], {
        cwd: start.cwd,
        timeout: 10_000,
        reject: false,
        cancelSignal: start.abortSignal,
      });
      if (openWin.failed) {
        logger.warn(
          { exit: openWin.exitCode, stderr: openWin.stderr?.toString().slice(0, 300) },
          'kiro workspace open warning',
        );
      }

      // Step 2: send the chat prompt into the (now-correct) window.
      const args = [
        'chat',
        '--mode',
        this.opts.defaultMode,
        '--reuse-window',
        '--maximize',
        start.initialPrompt,
      ];
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
          '`, workspace `' +
          start.cwd +
          '`). Open Kiro to watch the agent run. ' +
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
