import {
  existsSync,
  readFileSync,
  renameSync,
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
    // common shapes
    if (toolName === 'Bash' && typeof o.command === 'string') return o.command;
    if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && typeof o.file_path === 'string') {
      return o.file_path;
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
    renameSync(tmp, this.path);
    this.load();
  }
}
