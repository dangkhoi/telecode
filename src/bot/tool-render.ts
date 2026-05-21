/**
 * Friendly tool-call renderers (Phase A.4).
 *
 * Pure functions — no Telegram / SDK imports. Consumed by the dispatch
 * tool_use branch in {@link ./commands/index.ts} to replace the v1.0
 * "🔧 Read — {"file_path":"/Users/koi/Documents/workspaces/.../notifier.ts"}"
 * raw JSON dump with a glance-readable form like
 *   `Read · notifier.ts`
 *   `Edit · notifier.ts`
 *   `Bash · npm test`
 *   `Grep "AgentEvent" in src/`
 *   `Glob **\/*.ts`
 *   `Write · notifier.ts (1.2 KB)`
 *
 * Path collapsing follows the rules in §A.4 of the plan:
 *   1. If the path lives under the session's project cwd → `./relative/...`
 *   2. Else if under the user's home dir → `~/relative/...`
 *   3. Else absolute (unchanged)
 *   4. After 1-3, if total length still exceeds {@link MAX_PATH_DISPLAY},
 *      fall back to `.../<last-2-segments>` so the message stays readable
 *      on a phone screen.
 *
 * Cross-platform: we lean on `node:path` (posix + win32 aware via the default
 * export) and {@link os.homedir} — no hardcoded `/`. Tests cover Linux/macOS
 * style absolute paths AND Windows drive-letter paths.
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';

/**
 * Maximum displayed length for a collapsed path. Past this the helper drops
 * down to a "…/last-2-segments" form. 50 was picked by eyeballing typical
 * Telegram mobile widths — long enough to keep a useful prefix, short enough
 * that the line still fits on iPhone SE-ish viewports.
 */
const MAX_PATH_DISPLAY = 50;

/** Truncate to `max` chars + ellipsis; idempotent when already short. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Collapse an absolute path to a glance-readable form.
 *
 * Phase A (initial): collapses to `./relative` for paths under projectCwd,
 * `~/relative` for paths under $HOME, leaves out-of-tree absolute paths
 * unchanged, and falls back to "…/last-2-segments" past
 * {@link MAX_PATH_DISPLAY} chars.
 *
 * Phase C.5 extension: when `projectCwd` is provided AND lives inside a
 * git repository, paths under the git-root (but outside `projectCwd`) ALSO
 * collapse via the project name: `<project-name>/relative/path`. This
 * surfaces paths that live in sibling packages of a monorepo without
 * losing the cross-package context. Git-root lookup is cached per cwd to
 * avoid syscall storms.
 *
 * Cross-platform: Windows drive-letter paths (`C:\Users\X\…`) collapse via
 * the same `homedir()` branch — `path.isAbsolute` handles both shapes.
 * The display always uses forward slashes after collapse for visual
 * consistency on mixed-OS chats.
 *
 * @param absPath  Path emitted by the tool call. May already be relative —
 *                 in which case we return it as-is (only nudging with the
 *                 length guard).
 * @param projectCwd  Optional active project working directory; paths under
 *                    it collapse to `./…`.
 */
export function collapsePath(absPath: string, projectCwd?: string): string {
  if (!absPath) return absPath;
  // Pass through non-absolute paths unchanged (still apply the length guard
  // at the end). path.isAbsolute is platform-aware on Node — `/foo` is
  // absolute on posix, `C:\foo` and `\foo` are absolute on win32.
  let display = absPath;
  let collapsed = false;

  if (path.isAbsolute(absPath)) {
    if (projectCwd && pathStartsWith(absPath, projectCwd)) {
      const rel = path.relative(projectCwd, absPath);
      // path.relative('/a', '/a') === '' — treat as the project root itself.
      display = rel === '' ? './' : './' + toDisplaySep(rel);
      collapsed = true;
    } else if (projectCwd) {
      // Phase C.5 — try git-root collapse first (sibling packages of a
      // monorepo). Falls through to home-dir collapse if not in a git
      // workspace OR target is outside the git-root.
      const gitRoot = findGitRootCached(projectCwd);
      if (gitRoot && pathStartsWith(absPath, gitRoot)) {
        const rel = path.relative(gitRoot, absPath);
        const projectName = path.basename(gitRoot);
        display = rel === '' ? projectName : projectName + '/' + toDisplaySep(rel);
        collapsed = true;
      } else {
        const home = homedir();
        if (home && pathStartsWith(absPath, home)) {
          const rel = path.relative(home, absPath);
          display = rel === '' ? '~' : '~/' + toDisplaySep(rel);
          collapsed = true;
        }
      }
    } else {
      const home = homedir();
      if (home && pathStartsWith(absPath, home)) {
        const rel = path.relative(home, absPath);
        display = rel === '' ? '~' : '~/' + toDisplaySep(rel);
        collapsed = true;
      }
    }
  }

  // Length guard — even after collapse a `~/Documents/…/deeply/nested/path.ts`
  // can balloon. Fall back to "…/last-2-segments" so the column stays sane.
  if (display.length > MAX_PATH_DISPLAY) {
    // Split on whichever separator is in the string — posix `/` after our
    // toDisplaySep normalization, OR whatever the original passed in if we
    // never touched it (e.g. native Windows path went through path.relative).
    const sep = display.includes('/') ? '/' : path.sep;
    const segs = display.split(sep).filter(Boolean);
    if (segs.length >= 2) {
      display = '…/' + segs.slice(-2).join('/');
    } else {
      // Single segment that's just very long — basename + ellipsis.
      display = truncate(path.basename(display), MAX_PATH_DISPLAY);
    }
  }

  // Suppress "collapsed" warning lint; keep var for future telemetry hooks.
  void collapsed;
  return display;
}

/* ────────────────────────── git-root cache ────────────────────────── */

/**
 * Phase C.5 — cache git-root lookup keyed by starting directory.
 * TTL 5 min so a `git init` or workspace switch eventually re-detects.
 * Bounded at 32 entries; oldest evicted when over capacity. Walking the
 * tree looking for `.git` involves `existsSync` per ancestor — caching
 * avoids the syscall storm on every tool_use event during a busy turn.
 */
const GIT_ROOT_CACHE_TTL_MS = 5 * 60_000;
const GIT_ROOT_CACHE_MAX = 32;
interface GitCacheEntry {
  /** Absolute path to git-root, or `null` when no `.git` found on the chain. */
  gitRoot: string | null;
  /** ms-since-epoch of last refresh. */
  tsMs: number;
}
const gitRootCache = new Map<string, GitCacheEntry>();

function findGitRootCached(startDir: string): string | null {
  const cached = gitRootCache.get(startDir);
  const now = Date.now();
  if (cached && now - cached.tsMs <= GIT_ROOT_CACHE_TTL_MS) {
    return cached.gitRoot;
  }
  const fresh = findGitRoot(startDir);
  // Bound the cache size by evicting the oldest entry when full. We don't
  // need true LRU here — git roots don't churn.
  if (gitRootCache.size >= GIT_ROOT_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of gitRootCache) {
      if (v.tsMs < oldestTs) {
        oldestTs = v.tsMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) gitRootCache.delete(oldestKey);
  }
  gitRootCache.set(startDir, { gitRoot: fresh, tsMs: now });
  return fresh;
}

/**
 * Walk up the directory tree looking for a `.git` entry (file OR directory
 * — `.git` files are used by `git worktree` linked workspaces). Returns
 * the directory containing `.git`, or `null` if the search hits the
 * filesystem root without finding one.
 *
 * Cross-platform: uses `path.parse(p).root` to detect the FS root, which
 * is `'/'` on posix and `'C:\\'` (or similar) on win32.
 */
function findGitRoot(startDir: string): string | null {
  let cur = startDir;
  const root = path.parse(cur).root;
  // Bound the walk at 32 ancestors so a pathological symlink loop can't
  // hang the dispatcher.
  for (let i = 0; i < 32; i++) {
    const candidate = path.join(cur, '.git');
    try {
      if (existsSync(candidate)) {
        // Confirm it's a real entry (existsSync follows symlinks).
        const s = statSync(candidate);
        if (s.isDirectory() || s.isFile()) return cur;
      }
    } catch {
      // Permission / EIO — treat as miss, keep walking.
    }
    if (cur === root || cur === '') return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Exported for tests — clears the git-root cache so each test starts
 * from a known state. Not part of the public API.
 */
export function _clearGitRootCache(): void {
  gitRootCache.clear();
}

/**
 * Normalise a relative path produced by `path.relative` (which uses the host
 * separator) to forward slashes for display. Telegram renders both fine, but
 * mixing native `\` + `/` looks janky on Windows.
 */
function toDisplaySep(rel: string): string {
  return rel.split(path.sep).join('/');
}

/**
 * Cross-platform "does `p` live under `base`?" check. We rely on
 * `path.relative` and reject results that start with `..` (escape) or that
 * include a drive-letter change (Windows `path.relative('C:\\a','D:\\b')`
 * returns the absolute target — we treat that as not-under-base).
 */
function pathStartsWith(p: string, base: string): boolean {
  if (!base) return false;
  const rel = path.relative(base, p);
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Render a tool_use event as a one-line glance-friendly string.
 *
 * @param toolName  The tool identifier as emitted by the adapter
 *                  (Claude: `Read|Edit|Bash|Grep|Glob|Write|…`,
 *                  Codex: `codex.exec|codex.tool`,
 *                  Cursor: `cursor.tool|<title>`,
 *                  Kiro: usually a tool name from its custom-agent config).
 * @param input     The raw input record passed to the tool. Heterogeneous —
 *                  every adapter has slightly different conventions. Renderer
 *                  must handle missing keys gracefully (return a sane fallback).
 * @param ctx       Optional context (active project cwd for path collapsing).
 */
export interface RenderContext {
  /** Active project root. Used to collapse absolute paths to `./relative`. */
  projectCwd?: string;
}

export function renderToolUse(
  toolName: string,
  input: unknown,
  ctx?: RenderContext,
): string {
  const o = isRecord(input) ? input : {};

  // The tool names we recognise are case-sensitive — Claude emits PascalCase
  // (`Read`, `Edit`), Codex emits dotted lower-case (`codex.exec`), Cursor
  // emits whatever `tool_call.title` was. We branch on Claude's set since the
  // friendly-render plan in §A.4 targets exactly those.
  switch (toolName) {
    case 'Read':
    case 'fs_read': {
      const p = pickString(o, 'file_path', 'path');
      return p ? `Read · ${collapsePath(p, ctx?.projectCwd)}` : `Read · ?`;
    }
    case 'Edit':
    case 'fs_write':
    case 'apply_patch':
    case 'NotebookEdit': {
      const p = pickString(o, 'file_path', 'path');
      // Phase C.3 — diff stats. When the input carries both `old_string`
      // and `new_string` (Claude Edit / Codex apply_patch convention), append
      // `(-X +Y)` so the user sees the shape of the edit at a glance. Edge:
      // `old == new` → "(no change)" so the dispatch line still differentiates
      // from a real edit (callers shouldn't drop it — adapters occasionally
      // emit no-op edits when the LLM regenerated identical text).
      const oldStr = pickString(o, 'old_string', 'oldString');
      const newStr = pickString(o, 'new_string', 'newString');
      let stats = '';
      if (oldStr !== null && newStr !== null) {
        if (oldStr === newStr) {
          stats = ' (no change)';
        } else {
          const removed = oldStr.split('\n').length;
          const added = newStr.split('\n').length;
          stats = ` (-${removed} +${added})`;
        }
      }
      const displayPath = p ? collapsePath(p, ctx?.projectCwd) : '?';
      return `Edit · ${displayPath}${stats}`;
    }
    case 'Write': {
      const p = pickString(o, 'file_path', 'path');
      const content = pickString(o, 'content', 'text', 'data');
      const sizeHint = content ? ` (${formatBytes(Buffer.byteLength(content, 'utf8'))})` : '';
      return p ? `Write · ${collapsePath(p, ctx?.projectCwd)}${sizeHint}` : `Write · ?${sizeHint}`;
    }
    case 'Bash':
    case 'shell':
    case 'execute_bash':
    case 'codex.exec': {
      const cmdRaw = pickString(o, 'command', 'cmd');
      const cmd = cmdRaw ? truncate(collapseWhitespace(cmdRaw), 80) : '?';
      return `Bash · ${cmd}`;
    }
    case 'Grep': {
      const pattern = pickString(o, 'pattern', 'query') ?? '?';
      const where = pickString(o, 'path', 'directory', 'glob');
      const rel = where ? collapsePath(where, ctx?.projectCwd) : '';
      return rel ? `Grep "${pattern}" in ${rel}` : `Grep "${pattern}"`;
    }
    case 'Glob': {
      const pattern = pickString(o, 'pattern', 'glob') ?? '?';
      return `Glob ${pattern}`;
    }
    case 'WebFetch': {
      const url = pickString(o, 'url', 'href') ?? '?';
      return `WebFetch · ${truncate(url, 80)}`;
    }
    case 'WebSearch': {
      const q = pickString(o, 'query', 'q') ?? '?';
      return `WebSearch · ${truncate(q, 80)}`;
    }
    default: {
      // Fallback: render the first string-valued key, truncated to 60 chars.
      const first = pickFirstStringValue(o);
      if (first) {
        return `${toolName} · ${truncate(collapseWhitespace(first), 60)}`;
      }
      return toolName;
    }
  }
}

/* ────────────────────────── small helpers ────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pickString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickFirstStringValue(o: Record<string, unknown>): string | null {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Collapse runs of whitespace (incl. newlines) to single spaces. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Pretty byte size — only KB/MB granularity, integer-rounded. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Map an adapter-emitted tool name to the same friendly canonical label that
 * {@link renderToolUse} produces. Used in the tool_result dispatch branch so
 * `🔧 Bash · ls` is followed by `✅ Bash ok` instead of `✅ codex.exec ok` —
 * consistent vocabulary between use + result for one logical call.
 *
 * Returns the input unchanged when no canonical form is known (Cursor's
 * adapter-specific titles, unknown adapters) so we don't accidentally hide a
 * tool name.
 *
 * Senior-review (Opus 4.7) [P1] — added when tool_result merging started
 * surfacing raw `codex.exec` / `fs_write` labels that mismatched the
 * tool_use header.
 */
export function friendlyToolLabel(rawTool: string): string {
  switch (rawTool) {
    case 'Read':
    case 'fs_read':
      return 'Read';
    case 'Edit':
    case 'fs_write':
    case 'apply_patch':
    case 'NotebookEdit':
      return 'Edit';
    case 'Write':
      return 'Write';
    case 'Bash':
    case 'shell':
    case 'execute_bash':
    case 'codex.exec':
      return 'Bash';
    case 'Grep':
      return 'Grep';
    case 'Glob':
      return 'Glob';
    case 'WebFetch':
      return 'WebFetch';
    case 'WebSearch':
      return 'WebSearch';
    default:
      return rawTool;
  }
}

/**
 * Phase C integration helper — strip the canonical "ToolName · " (or
 * "ToolName ") prefix from a {@link renderToolUse} output so the trailing
 * "item" can be appended to a collapse-burst list without repeating the
 * tool name.
 *
 *   renderToolUse('Read', {file_path:'foo.ts'}) → 'Read · foo.ts'
 *   extractToolItem('Read · foo.ts', 'Read')    → 'foo.ts'
 *
 * Handles both forms that {@link renderToolUse} produces:
 *   - `ToolName · item`        (Read, Edit, Bash, Write, WebFetch, WebSearch)
 *   - `ToolName item-prose`    (Grep `Grep "pat" in src/`, Glob `Glob **\/*.ts`)
 *
 * Returns the full rendered string when the prefix doesn't match — keeps
 * the helper a safe no-op for adapters with unusual tool labels.
 *
 * Stable as a pure function. Called by the collapse-burst integration in
 * `src/bot/commands/index.ts` per tool_use event.
 */
export function extractToolItem(rendered: string, friendlyTool: string): string {
  // First try "ToolName · item" — the most common shape.
  const dotted = friendlyTool + ' · ';
  if (rendered.startsWith(dotted)) {
    return rendered.slice(dotted.length);
  }
  // Fallback: "ToolName item" — Grep/Glob style. Use a single space.
  const spaced = friendlyTool + ' ';
  if (rendered.startsWith(spaced)) {
    return rendered.slice(spaced.length);
  }
  // Default: hand back the rendered string unchanged. The collapse list
  // will read slightly redundantly ("🔧 Read ×2 · Read · a, b") rather than
  // wrong; preferred over dropping content silently.
  return rendered;
}

/** Exported for test seam — lets test inspect collapse thresholds. */
export const _internals = { MAX_PATH_DISPLAY };
