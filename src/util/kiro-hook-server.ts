import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { SessionStore } from '../session/store.js';
import type { PolicyEngine } from '../approval/policy.js';
import type { ApprovalBroker } from '../approval/broker.js';
import { logger } from './logger.js';

export interface KiroHookServerOpts {
  /** Bind port on 127.0.0.1. 0 = ephemeral; the chosen port is exposed via `address()`. */
  port: number;
  store: SessionStore;
  policy: PolicyEngine;
  broker: ApprovalBroker;
}

interface KiroHookPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string; // kiro-cli's session id
  tool_name?: string;
  tool_input?: unknown;
}

/**
 * Pull a short, human-readable preview of the tool input. Used in Telegram
 * messages so the user can recognise what they're about to approve.
 */
function previewInput(input: unknown, max = 200): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, max);
  try {
    return JSON.stringify(input).slice(0, max);
  } catch {
    return String(input).slice(0, max);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let data = '';
  req.setEncoding('utf8');
  for await (const chunk of req) data += chunk as string;
  return data;
}

function sendDecision(res: ServerResponse, decision: 'allow' | 'deny', reason?: string): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('x-telecode-decision', decision);
  if (reason) res.setHeader('x-telecode-reason', reason);
  res.end(reason ?? decision);
}

export class KiroHookServer {
  private server: Server | null = null;
  private boundPort = 0;

  constructor(private readonly opts: KiroHookServerOpts) {}

  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          logger.error({ err: String(err) }, 'kiro hook handler crashed');
          res.statusCode = 500;
          res.end('internal error');
        });
      });
      srv.on('error', reject);
      srv.listen(this.opts.port, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.boundPort = addr.port;
        }
        this.server = srv;
        logger.info({ port: this.boundPort }, 'kiro hook server listening on loopback');
        resolve(this.boundPort);
      });
    });
  }

  url(path = '/kiro-hook'): string {
    return `http://127.0.0.1:${this.boundPort}${path}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
      this.server = null;
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/kiro-hook') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const telecodeSessionId = req.headers['x-telecode-session'];
    if (typeof telecodeSessionId !== 'string' || !telecodeSessionId) {
      res.statusCode = 400;
      res.end('missing x-telecode-session');
      return;
    }
    const session = this.opts.store.getSession(telecodeSessionId);
    if (!session) {
      logger.warn({ telecodeSessionId }, 'kiro hook for unknown session — denying');
      sendDecision(res, 'deny', 'unknown telecode session');
      return;
    }

    let payload: KiroHookPayload = {};
    try {
      const raw = await readBody(req);
      payload = raw ? (JSON.parse(raw) as KiroHookPayload) : {};
    } catch (err) {
      logger.warn({ err: String(err) }, 'kiro hook body parse failed');
      sendDecision(res, 'deny', 'malformed hook payload');
      return;
    }

    const toolName = payload.tool_name ?? 'unknown';
    const projectDir = this.opts.store.getProject(session.project_id)?.path;
    const policyResult = this.opts.policy.decide(toolName, payload.tool_input, { projectDir });

    this.opts.store.logTool({
      session_id: telecodeSessionId,
      tool_name: toolName,
      input_preview: previewInput(payload.tool_input),
      decision: `kiro_${policyResult.decision}` + (policyResult.matched ? `:${policyResult.matched}` : ''),
      duration_ms: null,
    });

    if (policyResult.decision === 'allow') {
      sendDecision(res, 'allow');
      return;
    }
    if (policyResult.decision === 'deny') {
      sendDecision(res, 'deny', `denied by policy (${policyResult.matched ?? toolName})`);
      return;
    }

    // ASK — push to broker, await Telegram tap.
    this.opts.store.updateSession(telecodeSessionId, { status: 'waiting_approval' });
    try {
      const decision = await this.opts.broker.ask({
        sessionId: telecodeSessionId,
        chatId: session.chat_id,
        toolName,
        input: payload.tool_input,
        inputPreview: previewInput(payload.tool_input),
        sessionLabel: session.label,
      });
      this.opts.store.updateSession(telecodeSessionId, { status: 'running' });
      if (decision === 'allow_once' || decision === 'allow_always') {
        if (decision === 'allow_always') {
          try {
            this.opts.policy.appendAllow(toolName);
          } catch (err) {
            logger.warn({ err: String(err) }, 'appendAllow failed (kiro)');
          }
        }
        sendDecision(res, 'allow');
        return;
      }
      const reason = decision === 'timeout' ? 'approval timed out' : 'user denied';
      sendDecision(res, 'deny', reason);
    } catch (err) {
      logger.error({ err: String(err) }, 'kiro broker.ask failed');
      sendDecision(res, 'deny', 'approval broker error');
    }
  }
}
