import { execa } from 'execa';
import type { AgentAdapter, AgentStartOpts } from './types.js';
import { logger } from '../util/logger.js';

export interface KiroAdapterOpts {
  binary: string;
  trustTools: string[]; // tool names trusted at the kiro-cli layer (e.g. fs_read, fs_write)
  agent?: string;
  model?: string;
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const CURSOR_HIDE_SHOW_RE = /\x1b\[\?25[hl]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(CURSOR_HIDE_SHOW_RE, '');
}

// kiro-cli `--list-sessions` lines look like:
//   Chat SessionId: <uuid>
const SESSION_ID_RE = /Chat SessionId:\s*([0-9a-f-]{36})/i;

export class KiroAdapter implements AgentAdapter {
  readonly kind = 'kiro' as const;
  constructor(private readonly opts: KiroAdapterOpts) {}

  async run(start: AgentStartOpts): Promise<void> {
    try {
      start.onEvent({ type: 'status', status: 'kiro_spawning' });

      const args = ['chat', '--no-interactive'];
      if (start.resumeId) args.push('--resume-id', start.resumeId);
      if (this.opts.agent) args.push('--agent', this.opts.agent);
      if (this.opts.model) args.push('--model', this.opts.model);
      // `--trust-tools=` (empty) means trust nothing; otherwise comma-separated names.
      args.push(`--trust-tools=${this.opts.trustTools.join(',')}`);
      args.push(start.initialPrompt);

      const child = execa(this.opts.binary, args, {
        cwd: start.cwd,
        reject: false,
        cancelSignal: start.abortSignal,
        buffer: { stdout: false, stderr: true },
        encoding: 'utf8',
      });

      let buf = '';
      let leftover = '';
      const flushChunk = (chunk: string): void => {
        const combined = leftover + chunk;
        const lastNl = combined.lastIndexOf('\n');
        let emit: string;
        if (lastNl === -1) {
          leftover = combined;
          return;
        }
        emit = combined.slice(0, lastNl + 1);
        leftover = combined.slice(lastNl + 1);
        const clean = stripAnsi(emit).replace(/\r/g, '');
        if (!clean.trim()) return;
        buf += clean;
        start.onEvent({ type: 'text', text: clean });
      };

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        for await (const chunk of child.stdout as AsyncIterable<string>) {
          flushChunk(chunk);
        }
      }
      if (leftover) {
        const clean = stripAnsi(leftover).replace(/\r/g, '');
        if (clean.trim()) {
          buf += clean;
          start.onEvent({ type: 'text', text: clean });
        }
      }

      const result = await child;
      if (result.failed && result.exitCode !== 0) {
        const stderr = result.stderr?.toString().slice(0, 500) ?? '';
        start.onEvent({
          type: 'error',
          error: `kiro-cli exit ${result.exitCode ?? '?'}: ${stripAnsi(stderr)}`,
        });
        return;
      }

      // Capture latest session id for this directory so subsequent prompts can
      // pass --resume-id explicitly (kiro-cli persists by cwd; we record the
      // UUID to remain robust if multiple sessions share a directory).
      try {
        const list = await execa(this.opts.binary, ['chat', '--list-sessions'], {
          cwd: start.cwd,
          reject: false,
          timeout: 5000,
        });
        const m = stripAnsi(String(list.stdout ?? '')).match(SESSION_ID_RE);
        if (m?.[1]) {
          start.onEvent({ type: 'session', sdkSessionId: m[1] });
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'kiro --list-sessions failed (non-fatal)');
      }

      start.onEvent({
        type: 'done',
        result: buf.slice(-200).trim() || undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'kiro run failed');
      start.onEvent({ type: 'error', error: msg });
    }
  }
}
