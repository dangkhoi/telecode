import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { SessionStore } from '../session/store.js';
import type { PolicyEngine } from '../approval/policy.js';
import type { ApprovalBroker } from '../approval/broker.js';
import { logger } from './logger.js';
import { verifyGateToken, extractBearerToken } from './hmac.js';

export interface KiroHookServerOpts {
  /** Bind port on 127.0.0.1. 0 = ephemeral; the chosen port is exposed via `address()`. */
  port: number;
  store: SessionStore;
  policy: PolicyEngine;
  broker: ApprovalBroker;
  /**
   * P6.1 — Per-boot shared-secret token. Hex string from `generateGateToken()`.
   * If `undefined`, auth is disabled (legacy behaviour, retained for tests that
   * predate P6.1). Production wiring (src/index.ts) ALWAYS passes a token.
   */
  token?: string;
  /**
   * P6.2 — Drain timeout (ms) for in-flight `broker.ask` waits during
   * `stop()`. Defaults to 30s. Tests override to keep the suite fast.
   */
  drainTimeoutMs?: number;
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
  /**
   * P6.2 — Track in-flight handlers so `stop()` can wait for them before
   * tearing down the listener. Each promise resolves when the handler exits
   * (allow / deny / error path — never throws).
   */
  private readonly inflight = new Set<Promise<void>>();
  /**
   * P6.2 — Once `stop()` is called, new requests are rejected with 503 so we
   * don't grow `inflight` unbounded during shutdown.
   */
  private shuttingDown = false;

  constructor(private readonly opts: KiroHookServerOpts) {}

  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => {
        const p = this.handle(req, res).catch((err: unknown) => {
          logger.error({ err: String(err) }, 'kiro hook handler crashed');
          try {
            res.statusCode = 500;
            res.end('internal error');
          } catch {
            /* response may already be closed */
          }
        });
        this.inflight.add(p);
        // Remove from set on settle — we don't need the result, only the
        // "done" signal so `stop()`'s drain promise resolves.
        void p.finally(() => {
          this.inflight.delete(p);
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

  /**
   * P6.2 — Graceful shutdown:
   *
   *   1. Flip `shuttingDown` so new requests get 503 immediately (and don't
   *      enter `broker.ask`).
   *   2. Wait `Promise.race([allDrained, sleep(drainTimeoutMs)])`.
   *   3. After timeout / drain, close the listener. Any handlers still
   *      pending (because the broker.ask outlasted us) will eventually
   *      observe the broker auto-reject and exit cleanly — but their
   *      socket is already closed by then, so the gate-side fetch returns
   *      'daemon unreachable' which kiro-gate treats as fail-closed deny.
   *      That's the safe default the plan calls for.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    this.shuttingDown = true;
    const drainTimeoutMs = this.opts.drainTimeoutMs ?? 30_000;

    if (this.inflight.size > 0) {
      logger.info({ inflight: this.inflight.size, drainTimeoutMs }, 'kiro hook server draining');
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = (): void => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        const timer = setTimeout(() => {
          if (this.inflight.size > 0) {
            logger.warn(
              { remaining: this.inflight.size },
              'kiro hook server drain timed out — proceeding with close',
            );
          }
          finish();
        }, drainTimeoutMs);
        // Allow the process to exit even if the timer is still pending.
        timer.unref?.();
        // Settle a snapshot of the current set; new requests during drain are
        // rejected by `shuttingDown` so the set only shrinks.
        Promise.allSettled([...this.inflight]).then(() => {
          clearTimeout(timer);
          finish();
        });
      });
    }

    return new Promise((resolve) => {
      const srv = this.server!;
      // Order matters: per Node 22 docs (verified via Context7
      // `/websites/nodejs_latest-v22_x_api`), call `close()` FIRST so the
      // listener stops accepting new TCP connections, THEN
      // `closeAllConnections()` to force-close keep-alive sockets that
      // would otherwise keep `close()` callback pending forever. Calling
      // them in the reverse order leaves a race window where a new socket
      // can land between `closeAllConnections` and `close`. `close` also
      // accepts the callback that fires once every connection is torn down.
      srv.close(() => resolve());
      try {
        // Added in Node 18.2; we require >=22 via engines so the wrap is
        // belt-and-braces.
        srv.closeAllConnections();
      } catch {
        /* closeAllConnections is Node 18.2+; older runtimes ignore */
      }
      this.server = null;
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.shuttingDown) {
      // P6.2 — refuse new work during drain so the inflight set only shrinks.
      res.statusCode = 503;
      res.end('shutting down');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/kiro-hook') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    // P6.1 — token verification (BEFORE any side-effecting work). When a
    // token is configured (production path), missing or wrong bearer →
    // 401 + decision=deny. We log at WARN with redacted token so ops can
    // see token mismatch attempts without leaking the secret.
    if (this.opts.token) {
      const presented = extractBearerToken(req.headers['authorization']);
      if (!presented || !verifyGateToken(this.opts.token, presented)) {
        logger.warn(
          { remoteAddress: req.socket.remoteAddress, hasHeader: !!req.headers['authorization'] },
          'kiro hook rejected — invalid or missing gate token',
        );
        res.statusCode = 401;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        // RFC 7235 §3.1 — a 401 response MUST include a `WWW-Authenticate`
        // challenge. We use the `Bearer` scheme with a constant realm so
        // strict HTTP clients (and security scanners) don't reject the
        // response shape. The realm is opaque to the gate; it exists solely
        // to satisfy the protocol contract.
        res.setHeader('www-authenticate', 'Bearer realm="telecode-kiro-gate"');
        res.setHeader('x-telecode-decision', 'deny');
        // HTTP header values must be 7-bit ASCII per RFC 7230 §3.2 — avoid
        // unicode dashes ('—') which Node's http module rejects with
        // ERR_INVALID_CHAR. The Vietnamese message goes through the body
        // and the logger; the header stays terse + ASCII.
        res.setHeader('x-telecode-reason', 'unauthorized: bad gate token');
        res.end('unauthorized');
        return;
      }
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
