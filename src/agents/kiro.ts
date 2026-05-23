import { execa } from 'execa';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentStartOpts, AdapterMetadata } from './types.js';
import { logger } from '../util/logger.js';
import { stripAnsi } from '../util/ansi.js';
import { normalizeModelForAgent } from './model-normalize.js';

/**
 * UI metadata for the Kiro adapter (plan P1.1).
 * Picker / dashboard read this — do NOT inline these strings in callers.
 */
export const kiroMetadata: AdapterMetadata = {
  kind: 'kiro',
  displayName: 'Kiro',
  badge: '⚡',
  description: 'Kiro CLI (AWS) via app-server',
};

/**
 * Build a PATH that lets kiro-cli's MCP subprocess servers find their
 * launchers (npx, uvx, bun, pnpm) regardless of how the daemon itself was
 * launched. launchd's plist hard-codes PATH to `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
 * which excludes user-installed runtimes — so an MCP server defined as
 * `{ command: "npx", args: [...] }` in `~/.kiro/settings/mcp.json` would fail
 * with "No such file or directory" even though `npx` works fine from the
 * user's terminal. Symptom: `Error loading server context7: No such file
 * or directory (os error 2)` in `$TMPDIR/kiro-log/kiro-chat.log`.
 *
 * We prepend the most common user-runtime directories (filtered to ones that
 * actually exist on disk) to the existing PATH. For nvm we pick the highest
 * version directory by lexical sort — same heuristic nvm's own shell wrapper
 * uses when no `.nvmrc` is present.
 *
 * Cross-platform (plan P1.2): the delimiter is `path.delimiter` (`:` POSIX,
 * `;` Windows) and the candidate set forks on `process.platform`. Windows
 * paths use Win-native env layout (AppData / LocalAppData) so the user's
 * `npm`, `nvm-windows`, `cargo`, `pyenv-win` installations are reachable.
 *
 * Pure & idempotent — called once per kiro-cli spawn.
 */
/**
 * Compare two nvm-style version strings (e.g. `v22.10.0`, `v9.5.2`) numerically.
 * P5 senior review (Opus 4.7) [P1]: the previous `[..].sort().reverse()` did a
 * lexical comparison and ranked `v9.0.0` ABOVE `v22.0.0` because "9" > "2".
 * Real-world impact: an nvm-windows / nvm-posix install that retains an old
 * Node 8 alongside Node 22 would silently pick the unsupported (<22) install
 * and the daemon would refuse to start with a confusing "Node too old" error
 * even though node 22 is on disk.
 */
function compareNvmVersionsDesc(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const trimmed = v.startsWith('v') ? v.slice(1) : v;
    const parts = trimmed.split('.');
    const major = Number.parseInt(parts[0] ?? '0', 10) || 0;
    const minor = Number.parseInt(parts[1] ?? '0', 10) || 0;
    const patch = Number.parseInt(parts[2] ?? '0', 10) || 0;
    return [major, minor, patch];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return bMaj - aMaj;
  if (aMin !== bMin) return bMin - aMin;
  return bPat - aPat;
}

function buildKiroMcpPath(): string {
  const home = homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    // Windows native candidates. AppData and LocalAppData are normally set,
    // but we fall back to env-less defaults under HOME to keep things sane
    // when the daemon runs under an unusual service identity (LocalSystem
    // launched without a user profile).
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

    // nvm-windows installs node versions under %APPDATA%\nvm\v<version>
    // (no `versions/node/` subdir like POSIX nvm). Symlinks the current
    // version to %APPDATA%\nvm\current\node.exe.
    const nvmWin = path.join(appData, 'nvm');
    try {
      if (existsSync(nvmWin)) {
        const versions = readdirSync(nvmWin)
          .filter((v) => /^v\d/.test(v))
          .sort(compareNvmVersionsDesc);
        if (versions[0]) candidates.push(path.join(nvmWin, versions[0]));
      }
    } catch {
      /* ignore — no nvm-windows */
    }

    for (const p of [
      path.join(appData, 'npm'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.volta', 'bin'),
      // pyenv-win shims (separate install path from POSIX pyenv).
      path.join(home, '.pyenv', 'pyenv-win', 'shims'),
      // Default Python user-scope from official installer.
      path.join(localAppData, 'Programs', 'Python', 'Python313', 'Scripts'),
      path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
      path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts'),
    ]) {
      if (existsSync(p)) candidates.push(p);
    }
  } else {
    // POSIX (darwin / linux) candidates.
    try {
      const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
      if (existsSync(nvmRoot)) {
        // P5 senior review (Opus 4.7) [P1]: numeric (not lexical) version sort.
        const versions = readdirSync(nvmRoot)
          .filter((v) => /^v\d/.test(v))
          .sort(compareNvmVersionsDesc);
        if (versions[0]) candidates.push(path.join(nvmRoot, versions[0], 'bin'));
      }
    } catch {
      /* ignore — no nvm */
    }

    for (const p of [
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.pyenv', 'shims'),
      path.join(home, '.volta', 'bin'),
    ]) {
      if (existsSync(p)) candidates.push(p);
    }
  }

  const existing = process.env.PATH ?? '';
  if (candidates.length === 0) return existing;
  // Use platform-correct PATH delimiter (':' POSIX, ';' Windows).
  return `${candidates.join(path.delimiter)}${path.delimiter}${existing}`;
}

/** Exported for unit tests — production code calls `buildKiroMcpPath` via spawn. */
export const _internalsBase = { buildKiroMcpPath, compareNvmVersionsDesc };

export interface KiroAdapterOpts {
  binary: string;
  /** kiro-cli custom agent name. Telecode generates one called `telecode` whose preToolUse hook bridges to the daemon. */
  agent: string;
  model?: string;
  /** HTTP URL the preToolUse hook should POST to (e.g. http://127.0.0.1:8787/kiro-hook). */
  gateUrl: string;
  /**
   * P6.1 — Per-boot shared-secret token. Propagated to kiro-cli via the
   * `TELECODE_GATE_TOKEN` env var; the `kiro-gate` shim sends it back as a
   * Bearer header so the hook server can authenticate the caller. Optional
   * so tests that don't wire the full security path still compile.
   */
  gateToken?: string;
}

// kiro-cli `--list-sessions` lines look like:
//   Chat SessionId: <uuid>
const SESSION_ID_RE = /Chat SessionId:\s*([0-9a-f-]{36})/i;

/**
 * P6.4 — Per-cwd TTL cache for `kiro-cli chat --list-sessions`. Each spawn
 * costs 200-500ms (Rust binary cold start + JSON parse); calling it after
 * every prompt was a noticeable lag for users who fire short prompts in
 * succession. The cache hits when the same cwd runs another prompt within
 * `KIRO_SESSIONS_TTL_MS`.
 *
 * Why TTL (not invalidation): kiro-cli persists sessions to disk by cwd;
 * external mutators (the user running `kiro-cli chat` from a terminal)
 * would invalidate any cache we held, so we rely on the short TTL to bound
 * staleness rather than wire a filesystem watcher.
 *
 * The cache stores only the EXTRACTED sdk session id (string), not the full
 * stdout — that's all we ever consume. Test seam: `_internals.clearKiroSessionsCache()`.
 */
const KIRO_SESSIONS_TTL_MS = 30_000;
interface KiroSessionsCacheEntry {
  sdkSessionId: string | null;
  expiresAt: number;
}
const kiroSessionsCache = new Map<string, KiroSessionsCacheEntry>();
/**
 * P6.4 hardening — single-flight de-dup of concurrent cache misses for the
 * same cwd. Two parallel `KiroAdapter.run` calls in the same workspace would
 * each see a cache miss and spawn their own `kiro-cli --list-sessions`
 * process; both spawns hit the same Rust binary cold start (~200-500 ms) and
 * both racing writes to the cache. The in-flight map ensures the SECOND
 * caller awaits the FIRST spawn's promise instead.
 */
const kiroSessionsInflight = new Map<string, Promise<string | null>>();

function clearKiroSessionsCache(): void {
  kiroSessionsCache.clear();
  kiroSessionsInflight.clear();
}

function readKiroSessionsCache(cwd: string, now: number): KiroSessionsCacheEntry | undefined {
  const hit = kiroSessionsCache.get(cwd);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    kiroSessionsCache.delete(cwd);
    return undefined;
  }
  return hit;
}

function writeKiroSessionsCache(cwd: string, sdkSessionId: string | null, now: number): void {
  kiroSessionsCache.set(cwd, { sdkSessionId, expiresAt: now + KIRO_SESSIONS_TTL_MS });
}

/**
 * Exported test seam (declared AFTER the helpers it references so the
 * binding closes over the live values, not undefined). Production code does
 * not import `_internals` — callers use the adapter methods.
 */
export const _internals = {
  ..._internalsBase,
  /** P6.4 — let tests reset the cache between runs. */
  clearKiroSessionsCache,
  /** P6.4 — let tests inspect cache state directly. */
  kiroSessionsCache,
  /** P6.4 hardening — exposed so concurrency tests can observe single-flight. */
  kiroSessionsInflight,
  /** P6.4 — TTL constant exposed for assertions. */
  KIRO_SESSIONS_TTL_MS,
};

export class KiroAdapter implements AgentAdapter {
  readonly kind = 'kiro' as const;
  constructor(private readonly opts: KiroAdapterOpts) {}

  async run(start: AgentStartOpts): Promise<void> {
    try {
      start.onEvent({ type: 'status', status: 'kiro_spawning' });

      const args = ['chat', '--no-interactive', '--agent', this.opts.agent];
      if (start.resumeId) args.push('--resume-id', start.resumeId);
      const model = normalizeModelForAgent(this.kind, start.model ?? this.opts.model);
      if (model) args.push('--model', model);
      // `--trust-all-tools` would bypass kiro-cli's built-in confirmation
      // prompts, BUT the custom agent's preToolUse hook (managed by Telecode)
      // is still invoked for every tool call and can block via exit code 2.
      // So the daemon's PolicyEngine + ApprovalBroker remains the real gate.
      args.push('--trust-all-tools');
      args.push(start.initialPrompt);

      const child = execa(this.opts.binary, args, {
        cwd: start.cwd,
        reject: false,
        cancelSignal: start.abortSignal,
        buffer: { stdout: false, stderr: true },
        encoding: 'utf8',
        env: {
          ...process.env,
          // Enriched PATH so MCP servers configured as `npx`/`uvx`/`bun`/etc.
          // can locate their launcher even when telecode runs under launchd's
          // minimal default PATH. See buildKiroMcpPath() for rationale.
          PATH: buildKiroMcpPath(),
          TELECODE_SESSION_ID: start.sessionId,
          TELECODE_GATE_URL: this.opts.gateUrl,
          // P6.1 — per-boot gate token. Only set when the daemon generated
          // one (production path); tests that omit `gateToken` keep the env
          // var unset and the gate falls back to legacy behaviour (no auth).
          ...(this.opts.gateToken ? { TELECODE_GATE_TOKEN: this.opts.gateToken } : {}),
        },
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
      //
      // P6.4 — Per-cwd 30s TTL cache around `--list-sessions`. The Rust
      // binary spawn dominates the cost; on consecutive short prompts in the
      // same cwd the cache returns the previously-extracted UUID in ~0ms.
      // We also write the cache on miss (including null results) so a cwd
      // with no kiro session yet doesn't repeatedly re-spawn.
      try {
        const now = Date.now();
        const cached = readKiroSessionsCache(start.cwd, now);
        let sdkSessionId: string | null;
        if (cached) {
          sdkSessionId = cached.sdkSessionId;
        } else {
          // P6.4 hardening — single-flight de-dup. If another concurrent run
          // already has a `--list-sessions` spawn outstanding for this cwd,
          // await its promise instead of spawning a redundant Rust binary.
          let inflight = kiroSessionsInflight.get(start.cwd);
          if (!inflight) {
            inflight = (async (): Promise<string | null> => {
              const list = await execa(this.opts.binary, ['chat', '--list-sessions'], {
                cwd: start.cwd,
                reject: false,
                timeout: 5000,
              });
              // Only cache when the spawn actually succeeded — a non-zero
              // exit (kiro-cli crash / auth missing) MUST NOT poison the
              // negative-cache slot for 30 s and block recovery. The plan
              // explicitly flagged this in the review checklist (§9 P6
              // checklist #4: "Negative cache: caching empty result —
              // correct vs harmful (block immediate retry after auth
              // fix)?").
              const okExit = !list.failed && (list.exitCode ?? 0) === 0;
              // kiro-cli ≥2.3 writes --list-sessions output to STDERR (not
              // stdout). Check both streams for robustness.
              const combined = String(list.stdout ?? '') + String(list.stderr ?? '');
              const m = stripAnsi(combined).match(SESSION_ID_RE);
              const extracted = m?.[1] ?? null;
              if (okExit) {
                writeKiroSessionsCache(start.cwd, extracted, Date.now());
              }
              return extracted;
            })();
            kiroSessionsInflight.set(start.cwd, inflight);
            // Always clear the inflight slot, even on rejection, so the next
            // call can retry rather than getting stuck on a poisoned promise.
            void inflight.finally(() => {
              if (kiroSessionsInflight.get(start.cwd) === inflight) {
                kiroSessionsInflight.delete(start.cwd);
              }
            });
          }
          sdkSessionId = await inflight;
        }
        if (sdkSessionId) {
          start.onEvent({ type: 'session', sdkSessionId });
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'kiro --list-sessions failed (non-fatal)');
      }

      // Emit estimated usage so /status can show context window info.
      // kiro-cli --no-interactive doesn't output token counts; estimate from
      // char lengths (~4 chars/token) and known model context windows.
      const effectiveModel = model ?? 'auto';
      const inputChars = start.initialPrompt.length;
      const outputChars = buf.length;
      const estInput = Math.round(inputChars / 4);
      const estOutput = Math.round(outputChars / 4);
      const ctxWindow = resolveContextWindow(effectiveModel);
      start.onEvent({
        type: 'usage',
        inputTokens: estInput,
        outputTokens: estOutput,
        contextWindow: ctxWindow,
        model: effectiveModel,
      });

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

  /**
   * Phase v1.2 — live model discovery via `kiro-cli chat --list-models`.
   *
   * The upstream output looks like:
   *
   *     Available models (* = default):
   *
   *     * auto                 1.00x credits      Models chosen by task ...
   *       claude-opus-4.7      2.20x credits      Experimental preview ...
   *       claude-sonnet-4.6    1.30x credits      The latest Claude Sonnet ...
   *       ...
   *
   * We parse out the first column (the model id) — the credits column and
   * description are dropped because the picker keyboard only has room for
   * the id. The leading `*` marker is stripped.
   *
   * Bounded by a 5s timeout so a hung kiro-cli process can't block the
   * `/model` reply — `null` is returned on timeout / non-zero exit /
   * empty parse so the caller can fall back to the hardcoded list.
   */
  async listModels(): Promise<string[] | null> {
    try {
      const r = await execa(this.opts.binary, ['chat', '--list-models'], {
        timeout: 5_000,
        reject: false,
        encoding: 'utf8',
      });
      if (r.failed || (r.exitCode ?? 0) !== 0) return null;
      const combined = String(r.stdout ?? '') + String(r.stderr ?? '');
      const clean = stripAnsi(combined);
      const ids: string[] = [];
      for (const rawLine of clean.split('\n')) {
        // Strip the leading "* " default marker, then take the first
        // whitespace-separated token. Skip header / blank lines and any
        // line whose first token doesn't look like a model id (lower-case
        // word characters, dots, dashes — no spaces, no parens, no `:`).
        const line = rawLine.replace(/^\s*\*\s*/, '').trim();
        if (!line) continue;
        const first = line.split(/\s+/)[0] ?? '';
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(first)) continue;
        // Filter out common non-model first words from the header.
        if (first === 'available' || first === 'models' || first === 'usage') continue;
        ids.push(first);
      }
      return ids.length > 0 ? ids : null;
    } catch (err) {
      logger.warn({ err: String(err) }, 'kiro listModels failed');
      return null;
    }
  }
}

/** Map known model name fragments to context window sizes (tokens). */
function resolveContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 200_000;
  if (m.includes('haiku')) return 200_000;
  if (m.includes('sonnet')) return 200_000;
  // Default for kiro-cli auto/unknown models — 200K is the standard
  // Anthropic context window as of 2025.
  return 200_000;
}
