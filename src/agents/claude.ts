import { query, type CanUseTool, type HookCallbackMatcher, type SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentStartOpts, AgentEvent } from './types.js';
import type { ApprovalBroker } from '../approval/broker.js';
import type { PolicyEngine } from '../approval/policy.js';
import type { SessionStore } from '../session/store.js';
import { logger } from '../util/logger.js';

export interface ClaudeAdapterOpts {
  broker: ApprovalBroker;
  policy: PolicyEngine;
  store: SessionStore;
  settingSources: SettingSource[];
}

function previewInput(input: unknown, max = 240): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = 'claude' as const;

  constructor(private readonly opts: ClaudeAdapterOpts) {}

  async run(start: AgentStartOpts): Promise<void> {
    const { broker, policy, store } = this.opts;

    const canUseTool: CanUseTool = async (toolName, input, _options) => {
      const decision = policy.decide(toolName, input, { projectDir: start.cwd });
      const preview = previewInput(input);
      if (decision.decision === 'allow') {
        store.logTool({
          session_id: start.sessionId,
          tool_name: toolName,
          input_preview: preview,
          decision: `policy_allow:${decision.matched ?? ''}`,
          duration_ms: null,
        });
        start.onEvent({ type: 'tool_use', tool: toolName, input });
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
      }
      if (decision.decision === 'deny') {
        store.logTool({
          session_id: start.sessionId,
          tool_name: toolName,
          input_preview: preview,
          decision: `policy_deny:${decision.matched ?? ''}`,
          duration_ms: null,
        });
        return { behavior: 'deny', message: `denied by policy (${decision.matched ?? toolName})` };
      }
      // Otherwise ask via Telegram.
      store.updateSession(start.sessionId, { status: 'waiting_approval' });
      const result = await broker.ask({
        sessionId: start.sessionId,
        chatId: start.chatId,
        toolName,
        input,
        inputPreview: preview,
        sessionLabel: start.sessionLabel,
      });
      store.updateSession(start.sessionId, { status: 'running' });
      store.logTool({
        session_id: start.sessionId,
        tool_name: toolName,
        input_preview: preview,
        decision: `user_${result}`,
        duration_ms: null,
      });
      if (result === 'allow_always') {
        // persist as allow pattern: ToolName only (broad; user can refine in YAML)
        try {
          policy.appendAllow(toolName);
        } catch (err) {
          logger.warn({ err: String(err) }, 'appendAllow failed');
        }
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
      }
      if (result === 'allow_once') {
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
      }
      return { behavior: 'deny', message: `user ${result}` };
    };

    const hooks: Partial<Record<string, HookCallbackMatcher[]>> = {
      PreToolUse: [
        {
          hooks: [
            async (event: unknown) => {
              const ev = event as { tool_name?: string; tool_input?: unknown };
              if (ev?.tool_name) {
                start.onEvent({ type: 'tool_use', tool: ev.tool_name, input: ev.tool_input });
              }
              return { continue: true };
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            async () => {
              start.onEvent({ type: 'status', status: 'stop' });
              return { continue: true };
            },
          ],
        },
      ],
    };

    let sdkSessionId: string | null = null;
    // Forward the parent abort signal into a real AbortController instance — the
    // SDK expects a full controller (it may call .abort() internally on errors).
    // Passing a bare { signal } object risks runtime "abortController.abort is not
    // a function" when the SDK tries to clean up.
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort(start.abortSignal.reason);
    if (start.abortSignal.aborted) ac.abort(start.abortSignal.reason);
    else start.abortSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const q = query({
        prompt: start.initialPrompt,
        options: {
          cwd: start.cwd,
          canUseTool,
          hooks: hooks as never,
          settingSources: this.opts.settingSources,
          permissionMode: 'default',
          ...(start.resumeId ? { resume: start.resumeId } : {}),
          abortController: ac,
        } as never,
      });

      for await (const message of q as AsyncIterable<unknown>) {
        if (start.abortSignal.aborted) break;
        await this.handleMessage(message, start, (id) => {
          if (id && id !== sdkSessionId) {
            sdkSessionId = id;
            store.updateSession(start.sessionId, { sdk_session_id: id });
            start.onEvent({ type: 'session', sdkSessionId: id });
          }
        });
      }
      start.onEvent({ type: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      start.onEvent({ type: 'error', error: msg });
      logger.error({ err: msg, sessionId: start.sessionId }, 'claude run failed');
    } finally {
      start.abortSignal.removeEventListener('abort', onParentAbort);
    }
  }

  private async handleMessage(
    message: unknown,
    start: AgentStartOpts,
    captureSession: (id: string | null | undefined) => void,
  ): Promise<void> {
    const m = message as {
      type?: string;
      subtype?: string;
      session_id?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
    };
    if (m.session_id) captureSession(m.session_id);

    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          start.onEvent({ type: 'text', text: block.text });
        }
      }
    } else if (m.type === 'result') {
      start.onEvent({
        type: 'done',
        durationMs: m.duration_ms,
        totalCostUsd: m.total_cost_usd,
        result: m.result,
      });
    }
  }
}
