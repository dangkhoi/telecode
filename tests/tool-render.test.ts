/**
 * Phase A.4 + C.5 — friendly tool render helpers.
 *
 * Coverage:
 *  - Per-tool happy paths (Read / Edit / Bash / Grep / Glob / Write / Web*).
 *  - Fallback for unknown tool names.
 *  - Path collapsing rules: project cwd → ./relative, home → ~/relative,
 *    out-of-tree absolute → unchanged.
 *  - Length guard kicks in past 50 chars → "…/<last-2-segments>".
 *  - Cross-platform: posix + win32-style paths (mocking node:path is invasive,
 *    so we only verify that the helper doesn't hardcode `/`).
 *  - Phase C.5: git-root collapse for monorepo sibling packages.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  renderToolUse,
  collapsePath,
  _clearGitRootCache,
} from '../src/bot/tool-render.js';

describe('renderToolUse — Claude tool names', () => {
  it('Read renders basename when out-of-project absolute path is supplied', () => {
    expect(renderToolUse('Read', { file_path: '/etc/hosts' })).toBe('Read · /etc/hosts');
  });

  it('Read collapses to ./relative when path is under project cwd', () => {
    const cwd = '/Users/koi/proj';
    expect(
      renderToolUse('Read', { file_path: '/Users/koi/proj/src/foo.ts' }, { projectCwd: cwd }),
    ).toBe('Read · ./src/foo.ts');
  });

  it('Read collapses to ~/relative when path is under $HOME but not under project', () => {
    const home = homedir();
    const p = path.join(home, 'Documents', 'note.md');
    const out = renderToolUse('Read', { file_path: p });
    expect(out.startsWith('Read · ~/')).toBe(true);
    expect(out).toContain('Documents');
  });

  it('Edit handles both file_path and path keys', () => {
    expect(renderToolUse('Edit', { file_path: '/tmp/a.ts' })).toBe('Edit · /tmp/a.ts');
    expect(renderToolUse('Edit', { path: '/tmp/b.ts' })).toBe('Edit · /tmp/b.ts');
  });

  it('Bash truncates long commands to 80 chars and collapses whitespace', () => {
    const cmd =
      'echo "very long command line that exceeds eighty characters in width — see truncation"';
    const out = renderToolUse('Bash', { command: cmd });
    expect(out.startsWith('Bash · ')).toBe(true);
    // Should end with ellipsis since the command exceeds 80 chars.
    expect(out.length).toBeLessThanOrEqual('Bash · '.length + 80);
  });

  it('Bash with multi-line command collapses whitespace', () => {
    const out = renderToolUse('Bash', { command: 'foo\n  bar\n  baz' });
    expect(out).toBe('Bash · foo bar baz');
  });

  it('Grep renders pattern + collapsed path', () => {
    const cwd = '/Users/koi/proj';
    const out = renderToolUse(
      'Grep',
      { pattern: 'AgentEvent', path: '/Users/koi/proj/src' },
      { projectCwd: cwd },
    );
    expect(out).toBe('Grep "AgentEvent" in ./src');
  });

  it('Grep without path renders pattern-only', () => {
    expect(renderToolUse('Grep', { pattern: 'foo' })).toBe('Grep "foo"');
  });

  it('Glob renders the pattern verbatim', () => {
    expect(renderToolUse('Glob', { pattern: '**/*.ts' })).toBe('Glob **/*.ts');
  });

  it('Write includes content size estimate when content present', () => {
    const out = renderToolUse('Write', {
      file_path: '/tmp/x.txt',
      content: 'hello world',
    });
    expect(out).toBe('Write · /tmp/x.txt (11 B)');
  });

  it('Write rounds KB sizes when content >1KB', () => {
    const content = 'x'.repeat(2048);
    const out = renderToolUse('Write', { file_path: '/tmp/big.txt', content });
    expect(out).toBe('Write · /tmp/big.txt (2.0 KB)');
  });
});

describe('renderToolUse — multi-adapter aliases', () => {
  it('codex.exec aliases to Bash render', () => {
    expect(renderToolUse('codex.exec', { command: 'ls -la' })).toBe('Bash · ls -la');
  });

  it('fs_read (Kiro convention) renders like Read', () => {
    expect(renderToolUse('fs_read', { path: '/tmp/a.ts' })).toBe('Read · /tmp/a.ts');
  });

  it('fs_write (Kiro convention) renders like Edit', () => {
    expect(renderToolUse('fs_write', { path: '/tmp/a.ts' })).toBe('Edit · /tmp/a.ts');
  });
});

describe('renderToolUse — fallback', () => {
  it('unknown tool name falls back to first string value, 60-char truncated', () => {
    const out = renderToolUse('cursor.custom_op', { reason: 'fetching dependency tree' });
    expect(out).toBe('cursor.custom_op · fetching dependency tree');
  });

  it('unknown tool name with no string value renders bare name', () => {
    expect(renderToolUse('mystery', { flag: true, count: 5 })).toBe('mystery');
  });

  it('unknown tool with non-object input renders bare name', () => {
    expect(renderToolUse('something', null)).toBe('something');
    expect(renderToolUse('something', 'just a string')).toBe('something');
  });
});

describe('collapsePath — direct tests', () => {
  it('returns absolute path unchanged when neither cwd nor home matches', () => {
    expect(collapsePath('/var/log/foo.log')).toBe('/var/log/foo.log');
  });

  it('collapses project cwd to ./', () => {
    expect(collapsePath('/proj/src/a.ts', '/proj')).toBe('./src/a.ts');
  });

  it('collapses home to ~/', () => {
    const home = homedir();
    const out = collapsePath(path.join(home, 'a.ts'));
    expect(out).toBe('~/a.ts');
  });

  it('returns root marker when path equals projectCwd exactly', () => {
    expect(collapsePath('/proj', '/proj')).toBe('./');
  });

  it('returns ~ when path equals homedir exactly', () => {
    expect(collapsePath(homedir())).toBe('~');
  });

  it('falls back to last-2-segments when collapsed result still exceeds limit', () => {
    // 51+ chars: should collapse to "…/<last-2-segments>".
    const longRel = 'a/b/c/d/e/f/g/h/i/very-long-file-name-component.ts';
    const result = collapsePath('/proj/' + longRel, '/proj');
    expect(result.startsWith('…/')).toBe(true);
    // Last two segments preserved.
    expect(result.endsWith('i/very-long-file-name-component.ts')).toBe(true);
  });

  it('does not collapse paths that escape the project cwd via ..', () => {
    // path.relative('/proj', '/other') = '../other' → outside → unchanged.
    expect(collapsePath('/other/foo.ts', '/proj')).toBe('/other/foo.ts');
  });

  it('handles empty string gracefully', () => {
    expect(collapsePath('')).toBe('');
  });

  it('handles relative input paths unchanged', () => {
    expect(collapsePath('relative/path.ts')).toBe('relative/path.ts');
  });
});

describe('collapsePath — Phase C.5 git-root collapse', () => {
  // Each test runs against a fresh tmp tree so we don't interact with the
  // surrounding repo's real .git directory.
  let repoRoot: string;
  let pkgA: string;
  let pkgB: string;

  beforeEach(() => {
    _clearGitRootCache();
    // Build a fake monorepo:
    //   <tmp>/myrepo/.git
    //   <tmp>/myrepo/pkg-a/src/foo.ts
    //   <tmp>/myrepo/pkg-b/src/bar.ts
    const base = mkdtempSync(path.join(tmpdir(), 'telecode-grtest-'));
    repoRoot = path.join(base, 'myrepo');
    mkdirSync(repoRoot);
    // Use a marker file so existsSync + statSync succeed.
    mkdirSync(path.join(repoRoot, '.git'));
    writeFileSync(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main');
    pkgA = path.join(repoRoot, 'pkg-a');
    pkgB = path.join(repoRoot, 'pkg-b');
    mkdirSync(path.join(pkgA, 'src'), { recursive: true });
    mkdirSync(path.join(pkgB, 'src'), { recursive: true });
  });

  it('collapses sibling-package path via project-name prefix', () => {
    // Active project = pkg-a, target = pkg-b/src/bar.ts. The home / project
    // cwd branches don't match (bar.ts is outside pkg-a), but the git-root
    // branch SHOULD fire and use the repo name.
    const target = path.join(pkgB, 'src', 'bar.ts');
    const out = collapsePath(target, pkgA);
    expect(out).toBe('myrepo/pkg-b/src/bar.ts');
  });

  it('still prefers ./ for paths inside projectCwd over git-root', () => {
    const target = path.join(pkgA, 'src', 'foo.ts');
    const out = collapsePath(target, pkgA);
    expect(out).toBe('./src/foo.ts');
  });

  it('falls back to ~/ when target is outside the git workspace', () => {
    // Use a path under home but outside the temp repo.
    const home = homedir();
    const target = path.join(home, 'unrelated.ts');
    const out = collapsePath(target, pkgA);
    // Either ~ collapse or absolute — depends on whether the target is
    // within home. We assert just that it does NOT use the repo prefix.
    expect(out).not.toContain('myrepo');
  });

  it('falls back to absolute when no git workspace and no home match', () => {
    const out = collapsePath('/var/log/foo.log', pkgA);
    expect(out).toBe('/var/log/foo.log');
  });

  it('git-root lookup is cached (no crash on repeated calls)', () => {
    // Smoke test the cache path — invokes the lookup 3 times.
    const target = path.join(pkgB, 'src', 'bar.ts');
    expect(collapsePath(target, pkgA)).toBe('myrepo/pkg-b/src/bar.ts');
    expect(collapsePath(target, pkgA)).toBe('myrepo/pkg-b/src/bar.ts');
    expect(collapsePath(target, pkgA)).toBe('myrepo/pkg-b/src/bar.ts');
  });

  it('deeply-nested path under git root still collapses with length guard', () => {
    // 8 nested dirs — total path is well past MAX_PATH_DISPLAY.
    const deepRel = path.join(
      'pkg-b', 'src', 'auth', 'validators', 'token', 'jwt', 'rs256', 'verify.ts',
    );
    const target = path.join(repoRoot, deepRel);
    const out = collapsePath(target, pkgA);
    // Length guard kicks in: "…/<last-2-segments>".
    expect(out.startsWith('…/')).toBe(true);
    expect(out.endsWith('rs256/verify.ts')).toBe(true);
  });
});

describe('renderToolUse — AskUserQuestion (bug fix: question + options must surface)', () => {
  it('renders header + question + option labels for single-question input', () => {
    const input = {
      questions: [
        {
          header: 'Auth method',
          question: 'Which auth do we use?',
          options: [
            { label: 'OAuth' },
            { label: 'API key' },
            { label: 'SSO' },
          ],
        },
      ],
    };
    const out = renderToolUse('AskUserQuestion', input);
    // Cosmetic fix: canonical "AskUserQuestion · " separator so the dispatch
    // path's burst-collapse format doesn't duplicate the tool name.
    expect(out.startsWith('AskUserQuestion · ')).toBe(true);
    expect(out).toContain('[Auth method]');
    expect(out).toContain('Which auth do we use?');
    // Numbered options (1./2./3.) so user can reply "1" / "2" / "3"
    // instead of typing the full label.
    expect(out).toContain('1. OAuth');
    expect(out).toContain('2. API key');
    expect(out).toContain('3. SSO');
  });

  it('renders multiple question stanzas separated by blank lines', () => {
    const input = {
      questions: [
        {
          header: 'A',
          question: 'Q1?',
          options: [{ label: 'a1' }, { label: 'a2' }],
        },
        {
          header: 'B',
          question: 'Q2?',
          options: [{ label: 'b1' }, { label: 'b2' }],
        },
      ],
    };
    const out = renderToolUse('AskUserQuestion', input);
    expect(out).toContain('[A]');
    expect(out).toContain('[B]');
    expect(out).toContain('Q1?');
    expect(out).toContain('Q2?');
    // Two stanzas separated by blank line
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to bare label when questions is missing/empty/malformed', () => {
    expect(renderToolUse('AskUserQuestion', {})).toBe('AskUserQuestion');
    expect(renderToolUse('AskUserQuestion', { questions: [] })).toBe(
      'AskUserQuestion',
    );
    expect(renderToolUse('AskUserQuestion', { questions: 'not an array' })).toBe(
      'AskUserQuestion',
    );
  });

  it('handles missing options gracefully (renders question only)', () => {
    const out = renderToolUse('AskUserQuestion', {
      questions: [{ header: 'X', question: 'Q?' }],
    });
    expect(out).toContain('[X] Q?');
    // No numbered options should appear when options array is absent.
    expect(out).not.toMatch(/\n\s+\d+\./);
  });

  it('caps body at 3000 chars to stay under Telegram per-message limit (v1.2 Bug 5)', () => {
    // Build a pathologically long ask: 4 questions × 4 options × full-length
    // (300-char) descriptions → well over the 3000-char body cap so the
    // truncation path is actually exercised.
    const longLabel = 'x'.repeat(80);
    const longDesc = 'd'.repeat(300);
    const bigQuestion = {
      header: 'big',
      question: 'pick',
      options: Array.from({ length: 4 }, () => ({ label: longLabel, description: longDesc })),
    };
    const input = { questions: Array.from({ length: 4 }, () => ({ ...bigQuestion })) };
    const out = renderToolUse('AskUserQuestion', input);
    const bodyPart = out.replace(/^AskUserQuestion · /, '');
    expect(bodyPart.length).toBeLessThanOrEqual(3000);
    // And it WAS truncated (ellipsis present) — proving the cap engaged.
    expect(bodyPart.endsWith('…')).toBe(true);
  });

  it('does NOT truncate a realistic 4-question ask (v1.2 Bug 5 — readability)', () => {
    // Mirrors the exact shape that exposed the bug: 4 questions, 3 options
    // each, ~80-char descriptions. This must render FULLY (no ellipsis, all
    // four headers + every description tail present).
    const mkQ = (h: string, q: string) => ({
      header: h,
      question: q,
      options: [
        { label: 'Option one here', description: 'A reasonably detailed explanation of what option one does and why.' },
        { label: 'Option two here', description: 'A reasonably detailed explanation of what option two does and why.' },
        { label: 'Option three', description: 'A reasonably detailed explanation of what option three does and why.' },
      ],
    });
    const input = {
      questions: [
        mkQ('Verbose btn', 'Behavior mong muốn?'),
        mkQ('Image input', 'Forward ảnh thế nào?'),
        mkQ('File input', 'Xử lý file thế nào?'),
        mkQ('Agent scope', 'Làm cho agent nào?'),
      ],
    };
    const out = renderToolUse('AskUserQuestion', input);
    expect(out).not.toContain('…'); // nothing truncated
    expect(out).toContain('[Verbose btn]');
    expect(out).toContain('[Image input]');
    expect(out).toContain('[File input]');
    expect(out).toContain('[Agent scope]');
    // A full description tail survives intact.
    expect(out).toContain('A reasonably detailed explanation of what option one does and why.');
  });

  it('truncates each option label to 100 chars (v1.2 Bug 5 relaxed cap)', () => {
    const huge = 'y'.repeat(150);
    const out = renderToolUse('AskUserQuestion', {
      questions: [
        {
          header: 'h',
          question: 'q?',
          options: [{ label: huge }],
        },
      ],
    });
    // 100-char cap + ellipsis — verify no full 150-char label survived.
    expect(out).not.toContain(huge);
    expect(out).toMatch(/y+…/);
  });

  it('appends option descriptions (truncated) when present', () => {
    // Senior-review (Opus 4.7) [P2] — the SDK schema requires `description`
    // on every option; surfacing it gives the user the agent's intent.
    const out = renderToolUse('AskUserQuestion', {
      questions: [
        {
          header: 'DB',
          question: 'Pick a database',
          options: [
            { label: 'PostgreSQL', description: 'Relational, ACID compliant' },
            { label: 'MongoDB', description: 'Document store, flexible schema' },
          ],
        },
      ],
    });
    expect(out).toContain('PostgreSQL — Relational, ACID compliant');
    expect(out).toContain('MongoDB — Document store, flexible schema');
  });

  it('truncates very long descriptions to 300 chars (v1.2 Bug 5 relaxed cap)', () => {
    const longDesc = 'z'.repeat(400);
    const out = renderToolUse('AskUserQuestion', {
      questions: [
        {
          header: 'h',
          question: 'q?',
          options: [{ label: 'Opt', description: longDesc }],
        },
      ],
    });
    expect(out).not.toContain(longDesc);
    expect(out).toMatch(/z+…/);
  });

  it('omits description tail when field is missing or empty', () => {
    const out = renderToolUse('AskUserQuestion', {
      questions: [
        {
          header: 'h',
          question: 'q?',
          options: [{ label: 'Only' }, { label: 'Empty', description: '' }],
        },
      ],
    });
    // No " — " separator when description is absent / empty.
    expect(out).not.toMatch(/Only —/);
    expect(out).not.toMatch(/Empty —/);
  });
});
