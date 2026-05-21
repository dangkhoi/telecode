/**
 * Codex CLI adapter (plan v1.0 P3).
 *
 * Spawns `codex app-server` and speaks JSON-RPC over its stdio. Each adapter
 * instance is single-use (per AgentStartOpts.run) — we spawn, initialize,
 * create a thread, run a single turn, then shut down gracefully.
 *
 * Protocol verified via Context7 (`/openai/codex`, rust-v0.75.0):
 *   - Client → server requests: `initialize`, `thread/start`, `turn/start`,
 *     `turn/cancel`, `initialized` (notification).
 *   - Server → client notifications: `turn/started`, `item/started`,
 *     `item/agentMessage/delta`, `item/completed`, `turn/completed`,
 *     `command/exec/outputDelta`, `thread/started`.
 *   - Server → client requests (we respond): `item/permissions/requestApproval`
 *     (we route through `ApprovalBroker.ask()`).
 *
 * Auth (plan D1 — native): we do NOT read OPENAI_API_KEY, NOT trigger any auth
 * flow, NOT open a browser. The user must `codex login` (or set env vars in
 * their shell) BEFORE the daemon spawns the binary. If the binary surfaces an
 * unauthenticated error, we surface it back as an AgentEvent error with a hint.
 */
import { execa, type ResultPromise, type Subprocess } from 'execa';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { AgentAdapter, AgentStartOpts, AdapterMetadata } from './types.js';
import type { ApprovalBroker, ApprovalDecision } from '../approval/broker.js';
import { logger } from '../util/logger.js';
import { stripAnsi } from '../util/ansi.js';

/**
 * UI metadata for the Codex adapter. Picker / dashboard / reply-builders read
 * this — do NOT inline these strings in callers.
 */
export const codexMetadata: AdapterMetadata = {
  kind: 'codex',
  displayName: 'Codex',
  badge: '🅒',
  description: 'OpenAI Codex CLI (app-server JSON-RPC)',
};

/**
 * Codex CLI effort levels accepted by `turn/start.effort`. Defaults to
 * 'medium' per Codex 0.75 docs.
 */
export type CodexEffort = 'low' | 'medium' | 'high';

/**
 * Per-adapter configuration parsed from `config.agents.codex` (see
 * `src/config.ts` codexOverlay).
 */
export interface CodexAdapterOpts {
  /** Path to the codex binary (default 'codex' — picked up from PATH). */
  command: string;
  /** Model identifier passed to turn/start (default 'gpt-5.1-codex'). */
  model: string;
  /** Reasoning effort level (default 'medium'). */
  effort: CodexEffort;
  /** Required deps. */
  broker: ApprovalBroker;
  /**
   * Optional transport override — used by tests to inject a fake JSON-RPC
   * server without spawning a real subprocess. Production code omits this.
   */
  transport?: CodexTransportFactory;
}

/**
 * JSON-RPC message envelope. We tolerate either spec-compliant `jsonrpc: '2.0'`
 * or bare objects (older Codex builds omit the field on notifications). The
 * `id` field is present only on requests + responses; notifications omit it.
 */
export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Codex `item/permissions/requestApproval` payload (subset Telecode cares about).
 * The full schema is broader; we only key on the fields we route to the broker.
 */
interface PermissionRequestParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  cwd?: string;
  reason?: string;
  permissions?: unknown;
}

/**
 * Transport contract — a single bidirectional channel between the adapter and
 * the codex app-server. Production builds spawn a real subprocess via execa;
 * tests inject a fake.
 */
export interface CodexTransport {
  /** Send a single JSON-RPC message (line-delimited). */
  send(msg: JsonRpcMessage): Promise<void>;
  /** Register a listener for incoming messages. */
  onMessage(fn: (msg: JsonRpcMessage) => void): void;
  /** Register a listener for fatal stderr text (auth errors, crash). */
  onStderr(fn: (chunk: string) => void): void;
  /** Register a listener for child exit (code may be null on signal). */
  onExit(fn: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /**
   * Graceful close: close stdin so the server flushes + exits naturally.
   * After `timeoutMs` with no exit, force-kill. Returns when the child has
   * fully exited or been killed.
   */
  close(timeoutMs: number): Promise<void>;
  /**
   * Force-kill immediately (used after abort). Idempotent.
   */
  kill(): void;
}

export type CodexTransportFactory = (opts: { command: string; cwd: string }) => CodexTransport;

/**
 * Default transport — spawns `codex app-server` via execa and wires stdio to
 * a readline interface. Each JSON-RPC line is parsed and dispatched.
 */
function defaultTransport(opts: { command: string; cwd: string }): CodexTransport {
  const child: ResultPromise<{
    cwd: string;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    reject: false;
    buffer: false;
    encoding: 'utf8';
  }> = execa(opts.command, ['app-server'], {
    cwd: opts.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    buffer: false,
    encoding: 'utf8',
  });

  const subprocess = child as unknown as Subprocess;
  const messageListeners: Array<(m: JsonRpcMessage) => void> = [];
  const stderrListeners: Array<(s: string) => void> = [];
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  let rl: ReadlineInterface | null = null;
  if (subprocess.stdout) {
    subprocess.stdout.setEncoding('utf8');
    rl = createInterface({ input: subprocess.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage;
      } catch (err) {
        logger.warn({ err: String(err), line: trimmed.slice(0, 200) }, 'codex: bad JSON line');
        return;
      }
      for (const fn of messageListeners) {
        try {
          fn(parsed);
        } catch (err) {
          logger.error({ err: String(err) }, 'codex: message listener threw');
        }
      }
    });
  }

  if (subprocess.stderr) {
    subprocess.stderr.setEncoding('utf8');
    subprocess.stderr.on('data', (chunk: string) => {
      for (const fn of stderrListeners) {
        try {
          fn(chunk);
        } catch (err) {
          logger.error({ err: String(err) }, 'codex: stderr listener threw');
        }
      }
    });
  }

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child
    .then(
      (res) => {
        exited = true;
        exitCode = res.exitCode ?? null;
        exitSignal = (res.signal as NodeJS.Signals | undefined) ?? null;
        for (const fn of exitListeners) fn(exitCode, exitSignal);
      },
      (err: unknown) => {
        exited = true;
        const e = err as { exitCode?: number | null; signal?: NodeJS.Signals };
        exitCode = e?.exitCode ?? null;
        exitSignal = e?.signal ?? null;
        for (const fn of exitListeners) fn(exitCode, exitSignal);
      },
    )
    .catch((err: unknown) => {
      logger.error({ err: String(err) }, 'codex: child promise rejected');
    });

  return {
    async send(msg) {
      if (!subprocess.stdin || subprocess.stdin.destroyed) {
        throw new Error('codex: stdin closed');
      }
      const line = JSON.stringify(msg) + '\n';
      const ok = subprocess.stdin.write(line, 'utf8');
      if (!ok) {
        await new Promise<void>((resolve) => subprocess.stdin!.once('drain', () => resolve()));
      }
    },
    onMessage(fn) {
      messageListeners.push(fn);
    },
    onStderr(fn) {
      stderrListeners.push(fn);
    },
    onExit(fn) {
      if (exited) fn(exitCode, exitSignal);
      else exitListeners.push(fn);
    },
    async close(timeoutMs) {
      if (exited) return;
      try {
        subprocess.stdin?.end();
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        const t = setTimeout(() => {
          try {
            subprocess.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, timeoutMs);
        exitListeners.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      try {
        rl?.close();
      } catch {
        /* ignore */
      }
    },
    kill() {
      if (exited) return;
      try {
        subprocess.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
  };
}

const AUTH_ERR_RE = /(unauthenticated|not\s+authenticat|please\s+(run\s+)?codex\s+login|no\s+api\s+key)/i;

/**
 * Bounded queue of inbound JSON-RPC messages. The handler runs sequentially so
 * approval callbacks (which await broker.ask) don't race with subsequent
 * notifications on the same stream — important for ordered output rendering.
 */
class MessageQueue {
  private readonly q: JsonRpcMessage[] = [];
  private draining = false;
  constructor(private readonly handler: (m: JsonRpcMessage) => Promise<void>) {}
  push(m: JsonRpcMessage): void {
    this.q.push(m);
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.q.length > 0) {
        const m = this.q.shift()!;
        try {
          await this.handler(m);
        } catch (err) {
          logger.error({ err: String(err) }, 'codex: handler threw');
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex' as const;
  private readonly transportFactory: CodexTransportFactory;

  constructor(private readonly opts: CodexAdapterOpts) {
    this.transportFactory = opts.transport ?? defaultTransport;
  }

  async run(start: AgentStartOpts): Promise<void> {
    let nextId = 1;
    const pending = new Map<number, (msg: JsonRpcMessage) => void>();
    let transport: CodexTransport | null = null;
    let threadId: string | null = null;
    let inTurn = false;
    let currentTurnId: string | null = null;
    let authErrorSurfaced = false;
    let aborted = false;
    let resolveRun: (() => void) | null = null;
    let runPromise: Promise<void> | null = null;
    const stderrBuf: string[] = [];

    const surfaceAuthError = (raw: string): void => {
      if (authErrorSurfaced) return;
      authErrorSurfaced = true;
      start.onEvent({
        type: 'error',
        error:
          "Codex CLI chưa login. Chạy 'codex login' (hoặc set env var) trước khi dùng adapter này. " +
          `Chi tiết: ${raw.trim().slice(0, 200)}`,
      });
    };

    const request = <T = unknown>(method: string, params: unknown): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg.error) {
            reject(new Error(`codex ${method} failed: ${msg.error.message ?? 'unknown'}`));
            return;
          }
          resolve(msg.result as T);
        });
        transport!
          .send({ jsonrpc: '2.0', id, method, params })
          .catch((err: unknown) => {
            pending.delete(id);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    };

    const sendNotification = async (method: string, params: unknown): Promise<void> => {
      try {
        await transport!.send({ jsonrpc: '2.0', method, params });
      } catch (err) {
        logger.warn({ err: String(err), method }, 'codex: notification send failed');
      }
    };

    const respond = async (id: number | string, result: unknown): Promise<void> => {
      try {
        await transport!.send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        logger.warn({ err: String(err), id }, 'codex: response send failed');
      }
    };

    const handleMessage = async (msg: JsonRpcMessage): Promise<void> => {
      // Response to one of our requests?
      if (msg.id !== undefined && msg.id !== null && pending.has(Number(msg.id))) {
        const fn = pending.get(Number(msg.id))!;
        pending.delete(Number(msg.id));
        fn(msg);
        return;
      }

      // Server-initiated request that we must respond to (permission flow).
      if (msg.method === 'item/permissions/requestApproval' && msg.id !== undefined && msg.id !== null) {
        await handlePermissionRequest(Number(msg.id), msg.params as PermissionRequestParams);
        return;
      }

      // Notifications.
      switch (msg.method) {
        case 'thread/started': {
          // Per Codex 0.75 docs the payload is `params: { thread: { id, … } }`.
          // Older / experimental builds occasionally surface `params: { threadId }`
          // at the top level — accept both so the adapter doesn't lose its
          // thread id across protocol drift.
          const p = msg.params as
            | { threadId?: string; thread?: { id?: string } }
            | undefined;
          const tid = p?.thread?.id ?? p?.threadId;
          if (tid && !threadId) threadId = tid;
          return;
        }
        case 'turn/started': {
          inTurn = true;
          const p = msg.params as { turnId?: string } | undefined;
          if (p?.turnId) currentTurnId = p.turnId;
          start.onEvent({ type: 'status', status: 'codex_turn_started' });
          return;
        }
        case 'item/started': {
          const p = msg.params as { item?: { type?: string; id?: string; name?: string; tool?: string; command?: unknown } } | undefined;
          const it = p?.item;
          if (!it) return;
          if (it.type === 'commandExecution' || it.type === 'commandExec' || it.type === 'command_exec') {
            start.onEvent({
              type: 'tool_use',
              tool: 'codex.exec',
              input: it.command ?? {},
            });
          } else if (it.type === 'toolCall' || it.type === 'tool_call') {
            start.onEvent({
              type: 'tool_use',
              tool: it.tool ?? it.name ?? 'codex.tool',
              input: it,
            });
          }
          return;
        }
        case 'item/agentMessage/delta':
        case 'item/updated': {
          const p = msg.params as { delta?: string; text?: string; item?: { text?: string; delta?: string } } | undefined;
          const text = p?.delta ?? p?.text ?? p?.item?.delta ?? p?.item?.text;
          if (typeof text === 'string' && text.length > 0) {
            start.onEvent({ type: 'text', text });
          }
          return;
        }
        case 'item/completed': {
          const p = msg.params as { item?: { type?: string; tool?: string; success?: boolean; output?: unknown; text?: string } } | undefined;
          const it = p?.item;
          if (!it) return;
          if (it.type === 'commandExecution' || it.type === 'commandExec' || it.type === 'command_exec' || it.type === 'toolCall' || it.type === 'tool_call') {
            const preview = typeof it.output === 'string' ? it.output.slice(0, 240) : undefined;
            start.onEvent({
              type: 'tool_result',
              tool: it.tool ?? 'codex.exec',
              ok: it.success !== false,
              preview,
            });
          } else if (typeof it.text === 'string' && it.text.length > 0) {
            // Final agent message text (some Codex builds emit text only at completion).
            start.onEvent({ type: 'text', text: it.text, final: true });
          }
          return;
        }
        case 'command/exec/outputDelta': {
          const p = msg.params as { deltaBase64?: string; stream?: string } | undefined;
          if (typeof p?.deltaBase64 === 'string' && p.deltaBase64.length > 0) {
            try {
              const decoded = Buffer.from(p.deltaBase64, 'base64').toString('utf8');
              // Phase A.3 — strip ANSI escape sequences before forwarding.
              // Codex `command/exec/outputDelta` carries raw stdout/stderr from
              // the user's shell command, which routinely contains SGR colour
              // codes + cursor show/hide (npm spinners, pytest, cargo, …).
              // Without this, Telegram users see `\x1b[31mfailed\x1b[0m` noise.
              const clean = stripAnsi(decoded);
              if (clean.length > 0) start.onEvent({ type: 'text', text: clean });
            } catch {
              /* ignore decode errors */
            }
          }
          return;
        }
        case 'turn/completed': {
          inTurn = false;
          const p = msg.params as { turn?: { error?: { message?: string }; finalResponse?: string } } | undefined;
          const err = p?.turn?.error?.message;
          if (err) {
            start.onEvent({ type: 'error', error: `codex turn failed: ${err}` });
          }
          start.onEvent({
            type: 'done',
            result: typeof p?.turn?.finalResponse === 'string' ? p.turn.finalResponse.slice(-200) : undefined,
          });
          resolveRun?.();
          return;
        }
        case 'turn/exited': {
          // Some Codex builds emit this in addition to/instead of turn/completed.
          inTurn = false;
          start.onEvent({ type: 'status', status: 'codex_turn_exited' });
          resolveRun?.();
          return;
        }
        default:
          return;
      }
    };

    const handlePermissionRequest = async (id: number, params: PermissionRequestParams): Promise<void> => {
      // Map Codex permission request → ApprovalBroker.ask().
      const toolName = 'codex.permissions';
      const inputPreview = (() => {
        try {
          return JSON.stringify(params).slice(0, 240);
        } catch {
          return params.reason ?? '(no preview)';
        }
      })();
      let decision: ApprovalDecision;
      try {
        decision = await this.opts.broker.ask({
          sessionId: start.sessionId,
          chatId: start.chatId,
          toolName,
          input: params,
          inputPreview,
          sessionLabel: start.sessionLabel,
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'codex: broker.ask threw');
        decision = 'deny';
      }

      if (decision === 'allow_once' || decision === 'allow_always') {
        // Grant the full requested permission set. Scope=session for
        // allow_always, scope=turn (omitted) for allow_once — per Codex docs.
        await respond(id, {
          scope: decision === 'allow_always' ? 'session' : 'turn',
          permissions: params.permissions ?? {},
        });
      } else {
        // 'deny' or 'timeout' — grant an EMPTY permission set, meaning all
        // requested permissions are treated as denied. Codex docs explicitly
        // state "any permissions omitted are treated as denied".
        await respond(id, { permissions: {} });
      }
    };

    try {
      transport = this.transportFactory({ command: this.opts.command, cwd: start.cwd });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'codex: spawn failed');
      start.onEvent({ type: 'error', error: `codex spawn failed: ${msg}` });
      return;
    }

    const queue = new MessageQueue(handleMessage);
    transport.onMessage((m) => queue.push(m));
    transport.onStderr((chunk) => {
      stderrBuf.push(chunk);
      if (AUTH_ERR_RE.test(chunk)) surfaceAuthError(chunk);
    });
    let exitErrorEmitted = false;
    transport.onExit((code, signal) => {
      // Reject every in-flight request so the await chain in run() unwinds
      // promptly — otherwise a crash mid-handshake (e.g. between
      // `initialize` and the response, or while turn/start is pending) would
      // leave the request promise resolving never. Mirrors the same fix in
      // cursor.ts (P3+P4 senior review).
      if (pending.size > 0) {
        for (const [, fn] of pending) {
          fn({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32099, message: `codex exited (code=${code ?? 'null'})` },
          });
        }
        pending.clear();
      }
      if (resolveRun) {
        if (!aborted && code !== 0 && code !== null) {
          const tail = stderrBuf.join('').trim().slice(-400);
          if (AUTH_ERR_RE.test(tail)) {
            surfaceAuthError(tail);
          } else {
            start.onEvent({
              type: 'error',
              error: `codex exited with code ${code}${signal ? ` (signal ${signal})` : ''}${tail ? `: ${tail}` : ''}`,
            });
          }
          exitErrorEmitted = true;
        }
        resolveRun();
      }
    });

    const onAbort = (): void => {
      aborted = true;
      // Best-effort cancellation: send `turn/interrupt` (a REQUEST per Codex
      // 0.75 docs — `turn/cancel` is not a valid method). The server replies
      // with `{}` then emits `turn/completed` with status='interrupted'. We
      // do NOT await the response because:
      //   1) close(2_000) is about to tear stdin down regardless;
      //   2) we want abort latency bounded by the close timeout, not by
      //      whatever the server takes to acknowledge the interrupt.
      // We use `request()` so the message carries an `id` (notifications get
      // dropped by app-server validation), but the returned promise is
      // intentionally orphaned — failures are logged, not surfaced.
      if (inTurn && currentTurnId && threadId) {
        void request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(
          (err: unknown) => {
            logger.warn({ err: String(err) }, 'codex: turn/interrupt failed');
          },
        );
      }
      // Close async — caller's finally block awaits the runPromise.
      void transport!.close(2_000);
    };
    if (start.abortSignal.aborted) {
      onAbort();
    } else {
      start.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    // Local helper that keeps TS5's narrower from collapsing `resolveRun` to
    // `never` inside the try/catch — same pattern as cursor.ts.
    const callResolveRun = (): void => {
      if (resolveRun) resolveRun();
    };

    try {
      start.onEvent({ type: 'status', status: 'codex_spawning' });

      // 1. initialize — negotiate capabilities. We do NOT opt into experimental
      // APIs; sticking to stable surface keeps the adapter portable across
      // Codex versions.
      await request('initialize', {
        clientInfo: { name: 'telecode', title: 'Telecode', version: '1.0.0' },
        capabilities: {},
      });
      // 2. initialized notification per spec.
      await sendNotification('initialized', {});

      // 3. thread/start — create a new thread for this session's cwd. The plan
      // §6 P3.2 calls this `thread/new`; Codex 0.75 docs use `thread/start`.
      // We use the documented name (verified via Context7).
      const threadRes = await request<{ threadId?: string; thread?: { id?: string } }>('thread/start', {
        cwd: start.cwd,
      });
      // Per docs the canonical response is `result.thread.id`. Older / mocked
      // builds may surface `result.threadId` at the top level — accept both.
      // If the response somehow omits the id entirely, the `thread/started`
      // notification handler will fill it in when the server emits it on the
      // stream (rare but documented as part of the standard sequence).
      threadId = threadRes?.threadId ?? threadRes?.thread?.id ?? null;

      // 4. turn/start — fire the user prompt with sandbox + approval policy.
      // Sandbox writableRoots = the session cwd; networkAccess=true per plan
      // decision D5 (UX for fetching deps).
      const turnRes = await request<{ turn?: { id?: string } }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: start.initialPrompt }],
        cwd: start.cwd,
        approvalPolicy: 'unlessTrusted',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [start.cwd],
          networkAccess: true,
        },
        model: this.opts.model,
        effort: this.opts.effort,
      });
      // Per Codex 0.75 docs the response is `result: { turn: { id, status,
      // items, error } }`. We capture the id here as a fallback in case the
      // `turn/started` notification hasn't arrived yet by the time abort fires
      // (turn/interrupt requires both threadId + turnId to take effect).
      if (turnRes?.turn?.id && !currentTurnId) currentTurnId = turnRes.turn.id;
      inTurn = true;

      // 5. Wait for turn/completed (or abort/exit).
      await runPromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip the catch-emit when onExit already surfaced an error event —
      // otherwise a crash mid-handshake would produce two errors (one from
      // onExit's "exited with code N" branch, plus the duplicate cascade from
      // every pending request rejecting). Mirrors cursor.ts.
      if (!aborted && !exitErrorEmitted) {
        // If the failure was driven by auth (server emitted an error response
        // with the well-known string), surface the auth hint instead of the
        // raw JSON-RPC error.
        if (AUTH_ERR_RE.test(msg)) {
          surfaceAuthError(msg);
        } else {
          start.onEvent({ type: 'error', error: msg });
        }
      }
      logger.error({ err: msg }, 'codex run failed');
      // Defensive: a thrown error before `await runPromise` was reached would
      // leave it unresolved; on the normal exit path resolveRun was already
      // called via onExit. Idempotent because resolveRun is a Promise resolver.
      callResolveRun();
    } finally {
      start.abortSignal.removeEventListener('abort', onAbort);
      try {
        await transport.close(5_000);
      } catch (err) {
        logger.warn({ err: String(err) }, 'codex: close failed');
      }
    }
  }
}

// Exported for unit tests.
export const _internals = { AUTH_ERR_RE, MessageQueue };
