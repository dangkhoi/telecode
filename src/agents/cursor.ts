/**
 * Cursor CLI adapter (plan v1.0 P4).
 *
 * Spawns `cursor-agent acp` and speaks the Agent Client Protocol (ACP) — a
 * JSON-RPC 2.0 envelope over newline-delimited stdio. Each adapter instance
 * is single-use (per AgentStartOpts.run) — we spawn, initialize, create a
 * session, run a single prompt turn, then shut down gracefully.
 *
 * Protocol verified via Context7 (`/websites/cursor_cli` — Cursor CLI docs):
 *   - Client → server requests: `initialize`, `session/new`, `session/prompt`.
 *   - Server → client notifications: `session/update` with `sessionUpdate`
 *     discriminator — `agent_message_chunk` (text deltas) and `tool_call`
 *     (tool start / update / completion).
 *   - Server → client requests (we respond): `session/request_permission`
 *     (routed through `ApprovalBroker.ask()`).
 *
 * Auth (plan D1 — native): we do NOT trigger `authenticate`, NOT open a
 * browser, NOT store credentials. The user must `cursor-agent login` BEFORE
 * the daemon spawns the binary. If the binary surfaces an auth error (either
 * via a JSON-RPC error response or an `initialize` failure), we emit an
 * AgentEvent error with a Vietnamese hint.
 *
 * Why a separate adapter (vs reusing Codex)?
 *   - Codex uses its own custom JSON-RPC schema (`thread/start`, `turn/start`,
 *     `item/permissions/requestApproval`).
 *   - Cursor uses standardised ACP (`session/new`, `session/prompt`,
 *     `session/request_permission`). The message shapes, permission outcome
 *     envelope (`{ outcome: { outcome: 'selected', optionId: '...' } }`), and
 *     update discriminator (`sessionUpdate` field) all differ. Mixing the two
 *     would muddy the per-protocol mapping; keeping them split mirrors the
 *     upstream contracts.
 */
import { execa, type ResultPromise, type Subprocess } from 'execa';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { AgentAdapter, AgentStartOpts, AdapterMetadata } from './types.js';
import type { ApprovalBroker, ApprovalDecision } from '../approval/broker.js';
import { logger } from '../util/logger.js';

/**
 * UI metadata for the Cursor adapter. Picker / dashboard / reply-builders
 * read this — do NOT inline these strings in callers.
 */
export const cursorMetadata: AdapterMetadata = {
  kind: 'cursor',
  displayName: 'Cursor',
  badge: '✦',
  description: 'Cursor CLI agent (ACP protocol)',
};

/**
 * Per-adapter configuration parsed from `config.agents.cursor` (see
 * `src/config.ts` cursorOverlay).
 */
export interface CursorAdapterOpts {
  /**
   * Path to the cursor-agent binary. Default 'cursor-agent' — Cursor CLI's
   * official entry point per https://cursor.com/docs/cli. Some older docs /
   * snippets reference plain `agent`; we default to the disambiguated name
   * which works in every documented install path (Homebrew, curl installer,
   * Windows installer).
   */
  command: string;
  /**
   * Model identifier passed to `session/new` / `session/prompt` if the
   * server accepts it. Default 'auto' — the Cursor team's recommended value
   * that lets the server pick the latest model. Override to pin a specific
   * model (e.g. 'gpt-5.2'); telecode does not validate against a model list
   * because Cursor adds/retires models out-of-band.
   */
  model: string;
  /** Required deps. */
  broker: ApprovalBroker;
  /**
   * Optional transport override — used by tests to inject a fake ACP server
   * without spawning a real subprocess. Production code omits this.
   */
  transport?: CursorTransportFactory;
}

/**
 * JSON-RPC 2.0 message envelope. ACP requires `jsonrpc: '2.0'` on every
 * frame, but we keep the field optional in the type so test fixtures and
 * non-conforming server messages can be tolerated when they only differ in
 * that header.
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
 * `session/request_permission` payload (subset Telecode cares about). The
 * full ACP schema is broader; we only key on the fields we route to the
 * broker and echo back into the response `optionId`.
 */
interface PermissionRequestParams {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options?: Array<{ optionId?: string; name?: string; kind?: string }>;
  /** Some Cursor builds put the human-readable reason here. */
  title?: string;
}

/**
 * Transport contract — a single bidirectional channel between the adapter
 * and the cursor-agent ACP server. Production builds spawn a real subprocess
 * via execa; tests inject a fake.
 */
export interface CursorTransport {
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

export type CursorTransportFactory = (opts: { command: string; cwd: string }) => CursorTransport;

/**
 * Default transport — spawns `cursor-agent acp` via execa and wires stdio to
 * a readline interface. Each JSON-RPC line is parsed and dispatched.
 */
function defaultTransport(opts: { command: string; cwd: string }): CursorTransport {
  const child: ResultPromise<{
    cwd: string;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    reject: false;
    buffer: false;
    encoding: 'utf8';
  }> = execa(opts.command, ['acp'], {
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
        logger.warn({ err: String(err), line: trimmed.slice(0, 200) }, 'cursor: bad JSON line');
        return;
      }
      for (const fn of messageListeners) {
        try {
          fn(parsed);
        } catch (err) {
          logger.error({ err: String(err) }, 'cursor: message listener threw');
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
          logger.error({ err: String(err) }, 'cursor: stderr listener threw');
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
      logger.error({ err: String(err) }, 'cursor: child promise rejected');
    });

  return {
    async send(msg) {
      if (!subprocess.stdin || subprocess.stdin.destroyed) {
        throw new Error('cursor: stdin closed');
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

/**
 * Recognise common Cursor / ACP authentication errors so we can surface a
 * friendly Vietnamese hint instead of dumping raw JSON-RPC errors. We catch
 * both spellings ("authenticated"/"authenticate"), missing-token messages,
 * and the explicit "cursor-agent login" CTA the binary itself emits.
 */
const AUTH_ERR_RE =
  /(unauthenticated|not\s+authenticat|please\s+(run\s+)?cursor[- ]agent\s+login|please\s+(run\s+)?(`)?login|no\s+(api\s+)?(auth\s+)?token|sign[- ]in\s+required|login\s+required)/i;

/**
 * Map an `ApprovalDecision` to the ACP `optionId` string we send back in the
 * `session/request_permission` response. ACP convention (per Cursor docs +
 * the @blowmage/cursor-agent-acp reference impl) is kebab-case option ids:
 * `allow-once`, `allow-always`, `deny`. Cursor's own UI uses exactly these
 * ids when surfaced to the user, so echoing them keeps the agent's policy
 * cache (allow-always) coherent.
 */
function decisionToOptionId(decision: ApprovalDecision): string {
  switch (decision) {
    case 'allow_once':
      return 'allow-once';
    case 'allow_always':
      return 'allow-always';
    default:
      // 'deny' and 'timeout' both map to deny — server treats them the same.
      return 'deny';
  }
}

/**
 * Bounded queue of inbound JSON-RPC messages. The handler runs sequentially
 * so approval callbacks (which await broker.ask) don't race with subsequent
 * notifications on the same stream — important for ordered output rendering.
 *
 * Identical shape to the Codex MessageQueue (DRY would mean lifting both
 * into a shared helper; we keep one-per-adapter because each adapter's
 * `handler` closes over per-adapter mutable state and lives entirely
 * inside that adapter's `run()` — sharing across files would force us to
 * widen the API to inject the handler/logger pair, with no win).
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
          logger.error({ err: String(err) }, 'cursor: handler threw');
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export class CursorAdapter implements AgentAdapter {
  readonly kind = 'cursor' as const;
  private readonly transportFactory: CursorTransportFactory;

  constructor(private readonly opts: CursorAdapterOpts) {
    this.transportFactory = opts.transport ?? defaultTransport;
  }

  async run(start: AgentStartOpts): Promise<void> {
    let nextId = 1;
    const pending = new Map<number, (msg: JsonRpcMessage) => void>();
    let transport: CursorTransport | null = null;
    let sessionId: string | null = null;
    let inPrompt = false;
    let authErrorSurfaced = false;
    let aborted = false;
    let exitErrorEmitted = false;
    let resolveRun: (() => void) | null = null;
    let runPromise: Promise<void> | null = null;
    const stderrBuf: string[] = [];

    const surfaceAuthError = (raw: string): void => {
      if (authErrorSurfaced) return;
      authErrorSurfaced = true;
      start.onEvent({
        type: 'error',
        error:
          "Cursor CLI chưa login. Chạy 'cursor-agent login' trước khi dùng adapter này. " +
          `Chi tiết: ${raw.trim().slice(0, 200)}`,
      });
    };

    const request = <T = unknown>(method: string, params: unknown): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => {
          if (msg.error) {
            reject(new Error(`cursor ${method} failed: ${msg.error.message ?? 'unknown'}`));
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
        logger.warn({ err: String(err), method }, 'cursor: notification send failed');
      }
    };

    const respond = async (id: number | string, result: unknown): Promise<void> => {
      try {
        await transport!.send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        logger.warn({ err: String(err), id }, 'cursor: response send failed');
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

      // Server-initiated request — must respond by id.
      if (msg.method === 'session/request_permission' && msg.id !== undefined && msg.id !== null) {
        await handlePermissionRequest(msg.id as number | string, msg.params as PermissionRequestParams);
        return;
      }

      // Notifications.
      switch (msg.method) {
        case 'session/update': {
          const p = msg.params as { update?: SessionUpdate; sessionId?: string } | undefined;
          if (!p?.update) return;
          handleSessionUpdate(p.update);
          return;
        }
        default:
          return;
      }
    };

    const handleSessionUpdate = (update: SessionUpdate): void => {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text =
            !Array.isArray(update.content) ? update.content?.text : undefined;
          if (typeof text === 'string' && text.length > 0) {
            start.onEvent({ type: 'text', text });
          }
          return;
        }
        case 'agent_thought_chunk': {
          // Internal reasoning — we forward it as text so users see what the
          // agent is "thinking". Cursor sends this for plan/ask modes.
          const text =
            !Array.isArray(update.content) ? update.content?.text : undefined;
          if (typeof text === 'string' && text.length > 0) {
            start.onEvent({ type: 'text', text });
          }
          return;
        }
        case 'tool_call': {
          // Tool starting — emit tool_use so the dashboard / approval UI
          // can render a row even before the call completes.
          start.onEvent({
            type: 'tool_use',
            tool: update.title ?? update.kind ?? 'cursor.tool',
            input: update.rawInput ?? update,
          });
          return;
        }
        case 'tool_call_update': {
          // Status change (running/completed/failed). Only emit a result
          // event when the call terminates so we don't spam the UI.
          const status = update.status;
          if (status === 'completed' || status === 'failed') {
            const preview = (() => {
              const c = update.content;
              if (Array.isArray(c) && c.length > 0) {
                const first = c[0] as { content?: { text?: string }; text?: string };
                return (
                  first?.content?.text ??
                  first?.text ??
                  undefined
                );
              }
              return undefined;
            })();
            start.onEvent({
              type: 'tool_result',
              tool: update.title ?? update.kind ?? 'cursor.tool',
              ok: status === 'completed',
              preview: typeof preview === 'string' ? preview.slice(0, 240) : undefined,
            });
          }
          return;
        }
        case 'plan': {
          // Plan/checklist update — surface as a status so dashboards can
          // render a separate "current plan" panel if they want.
          start.onEvent({ type: 'status', status: 'cursor_plan_update' });
          return;
        }
        default:
          return;
      }
    };

    const handlePermissionRequest = async (
      id: number | string,
      params: PermissionRequestParams,
    ): Promise<void> => {
      const toolName = params.toolCall?.title ?? params.toolCall?.kind ?? 'cursor.permissions';
      const inputPreview = (() => {
        try {
          return JSON.stringify(params).slice(0, 240);
        } catch {
          return params.title ?? '(no preview)';
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
        logger.error({ err: String(err) }, 'cursor: broker.ask threw');
        decision = 'deny';
      }
      const optionId = decisionToOptionId(decision);
      await respond(id, { outcome: { outcome: 'selected', optionId } });
    };

    try {
      transport = this.transportFactory({ command: this.opts.command, cwd: start.cwd });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'cursor: spawn failed');
      start.onEvent({ type: 'error', error: `cursor spawn failed: ${msg}` });
      return;
    }

    const queue = new MessageQueue(handleMessage);
    transport.onMessage((m) => queue.push(m));
    transport.onStderr((chunk) => {
      stderrBuf.push(chunk);
      if (AUTH_ERR_RE.test(chunk)) surfaceAuthError(chunk);
    });
    transport.onExit((code, signal) => {
      // Reject every in-flight request so the await chain in run() unwinds
      // promptly — otherwise a crash mid-handshake would hang the adapter
      // until the abort signal (or never, if the caller isn't watching).
      if (pending.size > 0) {
        for (const [, fn] of pending) {
          fn({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32099, message: `cursor exited (code=${code ?? 'null'})` },
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
              error: `cursor exited with code ${code}${signal ? ` (signal ${signal})` : ''}${tail ? `: ${tail}` : ''}`,
            });
          }
          exitErrorEmitted = true;
        }
        resolveRun();
      }
    });

    const onAbort = (): void => {
      aborted = true;
      // Best-effort cancellation: send the ACP cancel notification, then
      // close stdin + kill on timeout. ACP defines `session/cancel` as a
      // notification (no id, no response).
      if (inPrompt && sessionId) {
        void sendNotification('session/cancel', { sessionId });
      }
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
    // Local ref the type-narrower can't lose track of inside the try/catch.
    // TS5 narrows `resolveRun` to `never` at certain control-flow points
    // (the let was initialized to null, then re-assigned only inside a
    // Promise constructor's callback, which the narrower can't prove ran);
    // calling through this helper sidesteps the narrowing without changing
    // semantics.
    const callResolveRun = (): void => {
      if (resolveRun) resolveRun();
    };

    try {
      start.onEvent({ type: 'status', status: 'cursor_spawning' });

      // 1. initialize — negotiate capabilities. Per ACP spec the client
      // declares `protocolVersion: 1` + which client-side methods it will
      // honour. We declare a minimal capability set: no client-side
      // filesystem reads/writes, no terminal — Cursor runs tools server-side
      // and the daemon doesn't expose host fs/terminal to the agent.
      const initRes = await request<{
        protocolVersion?: number;
        agentCapabilities?: Record<string, unknown>;
        authMethods?: Array<{ id?: string; name?: string }>;
      }>('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'telecode', version: '1.0' },
      });
      // Plan D1 — native auth. If Cursor reports authMethods but no session
      // is reachable, we surface a hint instead of opening a browser. The
      // happy path is: user already ran `cursor-agent login` previously, the
      // token is on disk, initialize returns 200 OK, we skip authenticate
      // entirely. If the server reports it needs interactive auth (no token
      // on disk), `session/new` below will fail and we treat that as an
      // auth error.
      void initRes;

      // 2. session/new — create a new ACP session for this cwd.
      const sessionRes = await request<{ sessionId?: string }>('session/new', {
        cwd: start.cwd,
        mcpServers: [],
      });
      sessionId = sessionRes?.sessionId ?? null;
      if (!sessionId) {
        throw new Error('cursor session/new returned no sessionId');
      }

      // 3. session/prompt — send the user input as a single text block.
      // The response (when received) carries `stopReason` and signals the
      // end of this turn. We do NOT resolve runPromise from here — the
      // request promise resolves and we then resolve runPromise so the
      // shutdown finally block runs.
      inPrompt = true;
      const promptRes = await request<{ stopReason?: string }>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: start.initialPrompt }],
      });
      inPrompt = false;

      const stopReason = promptRes?.stopReason ?? 'end_turn';
      start.onEvent({ type: 'done', result: stopReason });
      callResolveRun();

      // 4. Wait for the runPromise to settle (it already has via the line
      // above, but in case onExit triggered first we await defensively).
      await runPromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip the catch-emit when the exit handler already surfaced an error
      // event — otherwise a crash mid-handshake would produce two errors
      // (one from onExit emitting "exited with code N", and a duplicate one
      // here from the request's rejection cascade).
      if (!aborted && !exitErrorEmitted) {
        if (AUTH_ERR_RE.test(msg)) {
          surfaceAuthError(msg);
        } else {
          start.onEvent({ type: 'error', error: msg });
        }
      }
      logger.error({ err: msg }, 'cursor run failed');
      callResolveRun();
    } finally {
      start.abortSignal.removeEventListener('abort', onAbort);
      try {
        await transport.close(5_000);
      } catch (err) {
        logger.warn({ err: String(err) }, 'cursor: close failed');
      }
    }
  }
}

/**
 * `session/update` discriminated union (subset). The ACP spec defines more
 * variants (`current_mode_update`, `available_commands_update`, …) but we
 * only consume the ones with user-visible side effects.
 *
 * `content` is overloaded across update variants — `*_chunk` uses
 * `{ type: 'text', text: '…' }` while `tool_call_update` uses an array of
 * blocks. We model both shapes as optional fields and let the handler dis-
 * ambiguate by the `sessionUpdate` tag.
 */
interface SessionUpdate {
  sessionUpdate: string;
  /** For *_chunk variants: `{ type: 'text', text: '...' }`; for tool_call_update: array of content blocks. */
  content?: { type?: string; text?: string } | Array<{ type?: string; text?: string; content?: { text?: string } }>;
  /** For tool_call(_update): the user-facing tool label. */
  title?: string;
  /** Tool kind (e.g. 'fetch', 'edit', 'execute'). */
  kind?: string;
  /** Raw tool input for tool_call. */
  rawInput?: unknown;
  /** Status for tool_call_update: 'pending' | 'in_progress' | 'completed' | 'failed'. */
  status?: string;
}

// Exported for unit tests.
export const _internals = { AUTH_ERR_RE, MessageQueue, decisionToOptionId };
