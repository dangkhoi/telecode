import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  watchFile as fsWatchFile,
  unwatchFile as fsUnwatchFile,
} from 'node:fs';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { POLICY_PATH } from '../util/paths.js';
import { logger } from '../util/logger.js';

export type PolicyDecision = 'allow' | 'deny' | 'ask';

interface PolicyShape {
  allow: string[];
  deny: string[];
}

interface CompiledRule {
  raw: string;
  tool: string;        // e.g. "Bash", "Edit", "*" or "Read"
  argMatcher: ((s: string) => boolean) | null;
}

function globToRegex(glob: string): RegExp {
  // Lightweight glob: '**' → '.*', '*' → '.*' (matches across separators — args are
  // command-style strings, not paths). '?' → '.'. Special regex chars escaped.
  // Use the `s` (dotAll) flag so multiline Bash heredocs etc. still match.
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '.*';
      }
    } else if (c === '?') {
      re += '.';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 's');
}

function expandPatternHome(pattern: string): string {
  // Expand a leading `~` or `~/` inside a glob pattern body to the user's home dir.
  // Without this, deny rules like `Edit(~/.ssh/**)` silently no-op because Claude
  // passes absolute file paths (e.g. /Users/foo/.ssh/id_rsa).
  if (pattern.startsWith('~/')) return homedir() + pattern.slice(1);
  if (pattern === '~') return homedir();
  return pattern;
}

function compileRule(raw: string): CompiledRule {
  // Forms: "Read", "Bash(npm test*)", "Edit({{project_dir}}/**)"
  const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*$/);
  if (!m) return { raw, tool: raw, argMatcher: null };
  const tool = m[1] ?? raw;
  const arg = m[2];
  if (arg === undefined) return { raw, tool, argMatcher: null };
  const re = globToRegex(expandPatternHome(arg));
  return { raw, tool, argMatcher: (s: string) => re.test(s) };
}

function renderInputForMatch(toolName: string, input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    // Claude tools
    if (toolName === 'Bash' && typeof o.command === 'string') return o.command;
    if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && typeof o.file_path === 'string') {
      return o.file_path;
    }
    // Kiro-CLI tools (preToolUse hook payload uses lowercase names)
    if (toolName === 'shell' && typeof o.command === 'string') return o.command;
    if ((toolName === 'execute_bash') && typeof o.command === 'string') return o.command;
    // Kiro's `read` / `fs_read` / `fs_write` payloads are: { operations: [{ mode, path, ... }, ...] }.
    // Match against the first operation's path (the policy engine evaluates each
    // rule against a single string; if a future tool batches multiple paths we
    // can extend to per-op matching, but in practice kiro-cli batches reads of
    // the SAME file at multiple line ranges — a single path is sufficient).
    if (toolName === 'read' || toolName === 'write' || toolName === 'fs_read' || toolName === 'fs_write') {
      if (typeof o.path === 'string') return o.path;
      const ops = (o as { operations?: unknown }).operations;
      if (Array.isArray(ops) && ops.length > 0) {
        const first = ops[0] as Record<string, unknown> | undefined;
        if (first && typeof first.path === 'string') return first.path;
      }
    }
    if (typeof o.path === 'string') return o.path;
    try {
      return JSON.stringify(o);
    } catch {
      return String(o);
    }
  }
  return String(input ?? '');
}

export class PolicyEngine {
  private allow: CompiledRule[] = [];
  private deny: CompiledRule[] = [];
  private watching = false;
  private readonly path: string;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(path = POLICY_PATH) {
    this.path = path;
    this.load();
  }

  load(): void {
    if (!existsSync(this.path)) {
      this.allow = [];
      this.deny = [];
      return;
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = (parseYaml(raw) ?? {}) as Partial<PolicyShape>;
      this.allow = (parsed.allow ?? []).map(compileRule);
      this.deny = (parsed.deny ?? []).map(compileRule);
      logger.info(
        { allow: this.allow.length, deny: this.deny.length, path: this.path },
        'policy loaded',
      );
    } catch (err) {
      logger.error({ err: String(err) }, 'policy load failed');
    }
  }

  watch(onReload?: () => void): void {
    if (this.watching) return;
    try {
      // fs.watchFile (poll-based) survives atomic rename-replace, which is exactly
      // how both this daemon and most editors (vim, VS Code) save policy.yaml.
      // fs.watch would silently orphan after the first replace.
      fsWatchFile(this.path, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.load();
          onReload?.();
        }, 150);
      });
      this.watching = true;
    } catch (err) {
      logger.warn({ err: String(err) }, 'policy watch failed');
    }
  }

  stop(): void {
    if (this.watching) {
      try {
        fsUnwatchFile(this.path);
      } catch {
        /* ignore */
      }
      this.watching = false;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  decide(toolName: string, input: unknown, ctx?: { projectDir?: string }): { decision: PolicyDecision; matched?: string } {
    const argStr = renderInputForMatch(toolName, input);
    const substitute = (s: string): string =>
      ctx?.projectDir ? s.replaceAll('{{project_dir}}', ctx.projectDir) : s;

    for (const r of this.deny) {
      if (r.tool !== toolName && r.tool !== '*') continue;
      if (r.argMatcher === null) return { decision: 'deny', matched: r.raw };
      const expanded = substitute(r.raw);
      const exp = compileRule(expanded);
      if (exp.argMatcher && exp.argMatcher(argStr)) return { decision: 'deny', matched: r.raw };
    }
    for (const r of this.allow) {
      if (r.tool !== toolName && r.tool !== '*') continue;
      if (r.argMatcher === null) return { decision: 'allow', matched: r.raw };
      const expanded = substitute(r.raw);
      const exp = compileRule(expanded);
      if (exp.argMatcher && exp.argMatcher(argStr)) return { decision: 'allow', matched: r.raw };
    }
    return { decision: 'ask' };
  }

  appendAllow(pattern: string): void {
    this.appendList('allow', pattern);
  }
  appendDeny(pattern: string): void {
    this.appendList('deny', pattern);
  }

  /**
   * Build a glob-style pattern string `Tool(<args>)` from a tool name + raw
   * input the way the policy DSL expects. The input is rendered through the
   * same {@link renderInputForMatch} pipeline used for `decide`, then escaped
   * by replacing literal `*`/`?` with `\*`/`\?` so an exact-match rule is
   * emitted. Returns the bare tool name when input unwraps to an empty
   * string — matches the "Read" / "Bash" plain-form rule shape.
   *
   * Exported for {@link appendRule} and for tests that want to verify the
   * exact pattern that will be persisted.
   */
  static buildPattern(toolName: string, input: unknown): string {
    const rawArg = renderInputForMatch(toolName, input).trim();
    // `renderInputForMatch` falls back to `JSON.stringify(o)` for inputs that
    // don't match a known tool-arg shape, producing `"{}"` for an empty
    // object. Treat that case (and other obvious no-arg shapes) as bare.
    if (rawArg === '' || rawArg === '{}' || rawArg === 'null' || rawArg === 'undefined') {
      return toolName;
    }
    // Escape glob metacharacters in the arg so we ALWAYS persist a literal
    // match (UX promise of "Forever" — exact same call, not a wildcard).
    // The closing paren is not a meta in our glob but must not appear
    // unescaped inside our `Tool(arg)` syntax; escape it defensively too.
    const escaped = rawArg
      .replaceAll('\\', '\\\\')
      .replaceAll('*', '\\*')
      .replaceAll('?', '\\?')
      .replaceAll(')', '\\)');
    return `${toolName}(${escaped})`;
  }

  /**
   * Persist a forever-allow rule for a specific tool + input. Triggered by
   * the [📌 Forever] approval button (plan P0.4): on user confirmation we
   * write a rule into `policy.yaml` so the same call will auto-allow on
   * every future session (even after daemon restart).
   *
   * Atomic — writes via tmpfile + rename (inherited from {@link appendList}).
   *
   * @param toolName  Tool name as surfaced in the approval prompt (e.g.
   *                  `"Bash"`, `"fs_write"`).
   * @param input     The raw tool input the broker received. Pattern is
   *                  derived via {@link buildPattern}.
   * @param decision  Only `'allow_always'` is supported today — accepted as
   *                  parameter so future deny-forever can share the path.
   */
  appendRule(
    toolName: string,
    input: unknown,
    decision: 'allow_always',
  ): void {
    if (decision !== 'allow_always') {
      throw new Error(`appendRule: unsupported decision "${String(decision)}"`);
    }
    const pattern = PolicyEngine.buildPattern(toolName, input);
    this.appendList('allow', pattern);
  }

  private appendList(kind: 'allow' | 'deny', pattern: string): void {
    const current: PolicyShape = existsSync(this.path)
      ? (parseYaml(readFileSync(this.path, 'utf8')) as PolicyShape) ?? { allow: [], deny: [] }
      : { allow: [], deny: [] };
    current.allow ??= [];
    current.deny ??= [];
    if (!current[kind].includes(pattern)) {
      current[kind].push(pattern);
    }
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, stringifyYaml(current), { mode: 0o600 });
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      // Rename can fail on rare cross-FS scenarios or on Windows when the
      // target is locked. Clean up the tmp file so the directory doesn't
      // accumulate stragglers, then rethrow so the caller surfaces the
      // error (e.g. apvForeverConfirm shows a "lỗi ghi policy" toast).
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
    this.load();
  }
}
