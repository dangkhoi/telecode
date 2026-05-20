import { randomUUID } from 'node:crypto';
import { logger } from '../util/logger.js';

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny' | 'timeout';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  chatId: number;
  toolName: string;
  input: unknown;
  inputPreview: string;
  sessionLabel: string;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalPrompter {
  prompt(req: ApprovalRequest): Promise<void>;
  notifyTimeout?(req: ApprovalRequest): Promise<void>;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private prompter: ApprovalPrompter | null = null;

  constructor(opts: { timeoutMs: number }) {
    this.timeoutMs = opts.timeoutMs;
  }

  attach(p: ApprovalPrompter): void {
    this.prompter = p;
  }

  ask(req: Omit<ApprovalRequest, 'id'>): Promise<ApprovalDecision> {
    const id = randomUUID();
    const full: ApprovalRequest = { ...req, id };
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          logger.warn({ id, tool: req.toolName, sessionId: req.sessionId }, 'approval timeout');
          this.prompter?.notifyTimeout?.(full).catch((err: unknown) => {
            logger.error({ err: String(err), id }, 'notifyTimeout failed');
          });
          resolve('timeout');
        }
      }, this.timeoutMs);
      this.pending.set(id, { request: full, resolve, timer });
      if (!this.prompter) {
        logger.error('no approval prompter attached — auto-deny');
        clearTimeout(timer);
        this.pending.delete(id);
        resolve('deny');
        return;
      }
      this.prompter.prompt(full).catch((err: unknown) => {
        logger.error({ err: String(err), id }, 'prompter failed');
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          resolve('deny');
        }
      });
    });
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(decision);
    return true;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request;
  }

  pendingForSession(sessionId: string): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter((p) => p.request.sessionId === sessionId)
      .map((p) => p.request);
  }
}
