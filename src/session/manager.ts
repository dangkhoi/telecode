import { randomUUID } from 'node:crypto';
import { Mutex } from 'async-mutex';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentEvent, AgentKind } from '../agents/types.js';
import type { SessionStore, SessionRow } from './store.js';
import { logger } from '../util/logger.js';

export interface SessionRuntime {
  mutex: Mutex;
  abort: AbortController | null;
}

export interface DispatchOpts {
  sessionId: string;
  prompt: string;
  onEvent: (e: AgentEvent) => void;
}

export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();

  constructor(
    private readonly store: SessionStore,
    private readonly registry: AgentRegistry,
  ) {}

  private rt(id: string): SessionRuntime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = { mutex: new Mutex(), abort: null };
      this.runtimes.set(id, r);
    }
    return r;
  }

  createSession(opts: {
    chatId: number;
    agent: AgentKind;
    label: string;
    projectId: number | null;
  }): SessionRow {
    const id = randomUUID();
    return this.store.createSession({
      id,
      label: opts.label,
      agent: opts.agent,
      project_id: opts.projectId,
      chat_id: opts.chatId,
      sdk_session_id: null,
      status: 'idle',
    });
  }

  isBusy(sessionId: string): boolean {
    return this.rt(sessionId).mutex.isLocked();
  }

  interrupt(sessionId: string): boolean {
    const r = this.runtimes.get(sessionId);
    if (!r?.abort) return false;
    r.abort.abort(new Error('user_stop'));
    return true;
  }

  async dispatch(opts: DispatchOpts & { cwd: string; agent: AgentKind; sessionLabel: string; chatId: number; resumeId: string | null }): Promise<void> {
    const rt = this.rt(opts.sessionId);
    if (rt.mutex.isLocked()) {
      opts.onEvent({
        type: 'error',
        error: '⏳ session busy — /stop to interrupt or wait.',
      });
      return;
    }
    await rt.mutex.runExclusive(async () => {
      rt.abort = new AbortController();
      this.store.updateSession(opts.sessionId, { status: 'running' });
      const adapter = this.registry.get(opts.agent);
      try {
        await adapter.run({
          sessionId: opts.sessionId,
          sessionLabel: opts.sessionLabel,
          chatId: opts.chatId,
          cwd: opts.cwd,
          resumeId: opts.resumeId,
          initialPrompt: opts.prompt,
          onEvent: (e) => {
            try {
              opts.onEvent(e);
            } catch (err) {
              logger.warn({ err: String(err) }, 'onEvent throw');
            }
          },
          abortSignal: rt.abort.signal,
        });
      } finally {
        rt.abort = null;
        this.store.updateSession(opts.sessionId, { status: 'idle' });
      }
    });
  }
}
