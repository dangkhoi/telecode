/**
 * Verbosity modes (Phase B — plan §5).
 *
 * v1.0 streamed every adapter event firehose-style to Telegram — fine on
 * desktop but visually noisy on phones. v1.1 introduces 4 persona-tuned modes
 * with a default of `summary` (on-the-go user: approval + done + errors only).
 * Power users can opt back into the v1.0 firehose via `/mode verbose`.
 *
 * The mode is stored per-session (`sessions.verbosity_mode`) with a per-chat
 * default fallback (`chat_settings.default_mode`). Resolution order at
 * dispatch time:
 *
 *   1. session-level override (set via `/mode <name>`)        → if non-null
 *   2. chat-level default      (set via `/settings mode <n>`) → always non-null
 *   3. baked-in default `summary`                              → final fallback
 *
 * This module is intentionally UI-free: it exposes the enum, runtime metadata
 * (icon + label + description per mode), and the dispatch filter table. The
 * Telegram command surface lives in `src/bot/commands/index.ts` and the
 * storage helpers live next door in `src/session/store.ts`.
 */
import type { AgentEvent } from '../agents/types.js';

/**
 * The four supported verbosity modes. Adding a new mode means:
 *   1. Add a literal here.
 *   2. Add it to {@link VERBOSITY_MODES} so the runtime iterator + validator
 *      pick it up.
 *   3. Add a metadata row in {@link MODE_METADATA} (icon + label + description).
 *   4. Add a filter row in {@link shouldEmit} (decide which events leak through).
 *   5. Add a slash-menu / inline-keyboard button if exposed to the user.
 */
export type VerbosityMode = 'summary' | 'normal' | 'thinking' | 'verbose';

/**
 * Runtime-iterable list of all supported modes — keeps `/mode <name>`
 * validation in lockstep with the type union. Frozen so callers can't mutate
 * it accidentally (we hand it to keyboard builders and command parsers).
 */
export const VERBOSITY_MODES: readonly VerbosityMode[] = Object.freeze([
  'summary',
  'normal',
  'thinking',
  'verbose',
]);

/**
 * Baked-in default — used when neither the session NOR the chat has a stored
 * preference. Matches the persona-50% bucket (on-the-go glance user) per
 * plan §2.1.
 */
export const DEFAULT_VERBOSITY_MODE: VerbosityMode = 'summary';

/**
 * User-facing metadata per mode. Surfaced by `/mode` (current + inline kbd
 * buttons), `/settings` (chat default), and the v1.1 boot announcement.
 *
 * Display strings are bilingual-friendly: icon first so the same string reads
 * well on iOS, Android, and desktop. Descriptions are short Vietnamese — the
 * project is single-language (see commands-registry.ts for the same choice).
 */
export interface ModeMetadata {
  /** Single emoji used as the visual prefix in keyboards + messages. */
  icon: string;
  /** Capitalised English name shown in keyboard buttons + status text. */
  displayName: string;
  /** Short Vietnamese description shown in `/mode` and `/settings`. */
  description: string;
}

export const MODE_METADATA: Readonly<Record<VerbosityMode, ModeMetadata>> = Object.freeze({
  summary: {
    icon: '🎯',
    displayName: 'Summary',
    description: 'approval + done + errors only',
  },
  normal: {
    icon: '📝',
    displayName: 'Normal',
    description: '+ tool calls + results',
  },
  thinking: {
    icon: '🧠',
    displayName: 'Thinking',
    description: '+ thinking blocks',
  },
  verbose: {
    icon: '🔬',
    displayName: 'Verbose',
    description: '+ raw chunks + status',
  },
});

/**
 * Type guard — returns `true` when `s` is a known mode string. Used by
 * `/mode <name>` to validate user input without throwing.
 */
export function isVerbosityMode(s: unknown): s is VerbosityMode {
  return typeof s === 'string' && (VERBOSITY_MODES as readonly string[]).includes(s);
}

/**
 * Dispatch filter — decides whether an event reaches Telegram given the
 * current effective mode.
 *
 * Matrix (per plan §B.4):
 *
 *   event \ mode    | summary | normal | thinking | verbose
 *   ----------------|---------|--------|----------|--------
 *   approval        |   ✅    |   ✅   |    ✅    |   ✅    (always — handled outside)
 *   error           |   ✅    |   ✅   |    ✅    |   ✅
 *   done            |   ✅    |   ✅   |    ✅    |   ✅
 *   tool_use        |   ❌    |   ✅   |    ✅    |   ✅
 *   tool_result ok  |   ❌    |   ✅   |    ✅    |   ✅
 *   tool_result err |   ✅    |   ✅   |    ✅    |   ✅
 *   text            |   ❌    |   ✅   |    ✅    |   ✅
 *   thinking        |   ❌    |   ❌   |    ✅    |   ✅
 *   status          |   ❌    |   ❌   |    ❌    |   ✅
 *   session         |   ✅    |   ✅   |    ✅    |   ✅    (housekeeping)
 *
 * Note: `approval` events are NOT a current variant of {@link AgentEvent} —
 * they flow through the {@link ApprovalBroker}, not the agent event stream.
 * We default to "emit" for safety so any future addition doesn't accidentally
 * get suppressed by `summary`.
 */
export function shouldEmit(event: AgentEvent, mode: VerbosityMode): boolean {
  switch (event.type) {
    case 'error':
    case 'done':
    case 'session':
      // Critical/lifecycle events: ALWAYS surface — independent of mode.
      return true;
    case 'tool_use':
      // Summary suppresses tool_use (replaced by done-summary in Phase D);
      // every other mode shows it (Phase A friendly render preserved).
      return mode !== 'summary';
    case 'tool_result':
      // Summary: only failures (errors are always shown — successes are noise).
      // Other modes: show all (so the dispatch tool_result merger can edit
      // the tool_use message in place).
      if (mode === 'summary') return !event.ok;
      return true;
    case 'text':
      // Summary suppresses streaming text — Phase D done-summary will replace
      // the user-facing surface here.
      return mode !== 'summary';
    case 'status':
      // Adapter spawn/turn lifecycle ticks — only verbose users want this.
      return mode === 'verbose';
    default: {
      // Defensive default — future event variants are emitted in every mode
      // EXCEPT pure summary (where we'd rather under-surface than spam).
      // TypeScript's exhaustiveness check would normally catch this but the
      // `AgentEvent` union is open to future additions.
      const _exhaustive: never = event as never;
      void _exhaustive;
      return mode !== 'summary';
    }
  }
}

/**
 * Resolve the effective mode for a session given the cached session + chat
 * preferences. Caller is expected to have already read these from storage.
 *
 *   sessionMode → chatDefault → DEFAULT_VERBOSITY_MODE
 */
export function resolveMode(
  sessionMode: VerbosityMode | null | undefined,
  chatDefault: VerbosityMode | null | undefined,
): VerbosityMode {
  return sessionMode ?? chatDefault ?? DEFAULT_VERBOSITY_MODE;
}
