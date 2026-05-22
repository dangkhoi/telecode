/**
 * Phase C.2 — Auto code-fence detection.
 *
 * Coverage:
 *  - Per-heuristic happy paths (JSON, diff, shell, stack trace, fallback).
 *  - Conservative thresholds: edge inputs that look like they MIGHT match
 *    but should not trigger (single-line inline prose, single +/- bullet,
 *    naked `$variable` reference, short text with one newline).
 *  - maybeWrapCodeBlock end-to-end: wraps on detection, passes through on
 *    no detection.
 *  - Defensive: empty string, all-whitespace, non-string inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  detectCodeBlock,
  maybeWrapCodeBlock,
  wrapCodeBlockChunked,
} from '../src/bot/code-fence.js';
import { escapeMd } from '../src/bot/markdown.js';

describe('detectCodeBlock — JSON', () => {
  it('detects object-style JSON with quoted key', () => {
    const txt = '{"name": "foo", "count": 3}';
    expect(detectCodeBlock(txt)).toEqual({ lang: 'json', isCode: true });
  });

  it('detects multi-line object JSON', () => {
    const txt = '{\n  "a": 1,\n  "b": [2, 3]\n}';
    expect(detectCodeBlock(txt)).toEqual({ lang: 'json', isCode: true });
  });

  it('detects array-of-objects JSON', () => {
    const txt = '[{"k": 1}, {"k": 2}]';
    expect(detectCodeBlock(txt)).toEqual({ lang: 'json', isCode: true });
  });

  it('does NOT detect inline blurb with curly braces', () => {
    // No "key": pair — just braces inside prose.
    expect(detectCodeBlock('user said {hello world}')).toBeNull();
  });

  it('does NOT detect bare numeric array (no key:value pair)', () => {
    // Technically valid JSON but rendering as `json` adds no value.
    expect(detectCodeBlock('[1, 2, 3]')).toBeNull();
  });

  it('does NOT detect lone brace at start without matching close', () => {
    expect(detectCodeBlock('{ start of something else')).toBeNull();
  });
});

describe('detectCodeBlock — diff', () => {
  it('detects unified diff with @@ hunk header', () => {
    const txt = [
      '@@ -1,3 +1,3 @@',
      ' context',
      '-removed',
      '+added',
    ].join('\n');
    expect(detectCodeBlock(txt)).toEqual({ lang: 'diff', isCode: true });
  });

  it('detects unified diff with --- / +++ file headers', () => {
    const txt = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '-old',
      '+new',
    ].join('\n');
    expect(detectCodeBlock(txt)).toEqual({ lang: 'diff', isCode: true });
  });

  it('does NOT detect markdown bullets starting with -', () => {
    // 2 `-` lines but no hunk header.
    const txt = ['- bullet one', '- bullet two', '- bullet three'].join('\n');
    expect(detectCodeBlock(txt)).toBeNull();
  });

  it('does NOT detect single +/- line even with hunk header', () => {
    // Edge: only 1 +/- line; threshold requires ≥ 2.
    const txt = '@@ -1 +1 @@\n+only one';
    expect(detectCodeBlock(txt)).toBeNull();
  });
});

describe('detectCodeBlock — shell transcript', () => {
  it('detects multi-line shell prompt with $', () => {
    const txt = ['$ npm install', '$ npm test'].join('\n');
    expect(detectCodeBlock(txt)).toEqual({ lang: 'bash', isCode: true });
  });

  it('detects multi-line prompt with > (PowerShell style)', () => {
    const txt = ['> ls', '> Get-Process'].join('\n');
    expect(detectCodeBlock(txt)).toEqual({ lang: 'bash', isCode: true });
  });

  it('does NOT detect inline $variable references', () => {
    // No space after $ — naked variable, not a prompt.
    expect(detectCodeBlock('use $HOME and $PATH together')).toBeNull();
  });

  it('does NOT detect single $ prompt line', () => {
    expect(detectCodeBlock('$ echo hi')).toBeNull();
  });
});

describe('detectCodeBlock — stack trace', () => {
  it('detects Node-style "    at X" stack lines', () => {
    const txt = [
      'TypeError: x is not a function',
      '    at Foo.bar (/tmp/foo.js:10:5)',
      '    at Object.<anonymous> (/tmp/foo.js:1:1)',
    ].join('\n');
    expect(detectCodeBlock(txt)).toEqual({ lang: null, isCode: true });
  });

  it('detects JVM-style stack lines', () => {
    const txt = [
      'java.lang.NullPointerException',
      '    at com.example.Foo.bar(Foo.java:42)',
      '    at com.example.Foo.main(Foo.java:10)',
    ].join('\n');
    expect(detectCodeBlock(txt)).toEqual({ lang: null, isCode: true });
  });

  it('does NOT detect a single "at" line', () => {
    expect(detectCodeBlock('    at Foo.bar (file.js:1:1)')).toBeNull();
  });

  it('does NOT detect prose containing the word "at" mid-sentence', () => {
    expect(
      detectCodeBlock('look at this and look at that please'),
    ).toBeNull();
  });
});

describe('detectCodeBlock — generic monospace fallback', () => {
  it('detects long text with indented multi-line block', () => {
    // > 200 chars + has indented (2+ spaces) lines.
    const txt = [
      'Here is the layout of the table I described earlier in some detail:',
      '  column1   column2   column3',
      '  alpha     beta      gamma',
      '  delta     epsilon   zeta',
      'And below it some more padding to push beyond the 200-char threshold easily.',
    ].join('\n');
    expect(detectCodeBlock(txt)?.lang).toBeNull();
    expect(detectCodeBlock(txt)?.isCode).toBe(true);
  });

  it('does NOT detect short prose even with a newline', () => {
    expect(detectCodeBlock('one line\nanother line')).toBeNull();
  });

  it('does NOT detect long flowing prose without alignment cues', () => {
    // > 200 chars, has newlines, but no indentation and no tabular runs.
    const lorem = (
      'Hello world. This is a long stretch of flowing prose with no ' +
      'columnar alignment or indentation cues. It contains newlines\n' +
      'and reads like a normal paragraph that an agent might emit when\n' +
      'explaining a concept to the user in Vietnamese or English alike.'
    );
    expect(detectCodeBlock(lorem)).toBeNull();
  });
});

describe('detectCodeBlock — defensive', () => {
  it('returns null for empty string', () => {
    expect(detectCodeBlock('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(detectCodeBlock('   \n  \t  ')).toBeNull();
  });

  it('returns null for non-string', () => {
    expect(detectCodeBlock(null as unknown as string)).toBeNull();
    expect(detectCodeBlock(undefined as unknown as string)).toBeNull();
  });
});

describe('maybeWrapCodeBlock', () => {
  it('wraps detected JSON in ```json fence', () => {
    const txt = '{"a": 1}';
    expect(maybeWrapCodeBlock(txt)).toBe('```json\n{"a": 1}\n```');
  });

  it('wraps detected diff in ```diff fence', () => {
    const txt = '@@ -1 +1 @@\n-foo\n+bar';
    expect(maybeWrapCodeBlock(txt)).toBe('```diff\n@@ -1 +1 @@\n-foo\n+bar\n```');
  });

  it('wraps detected shell in ```bash fence', () => {
    const txt = '$ ls\n$ pwd';
    expect(maybeWrapCodeBlock(txt)).toBe('```bash\n$ ls\n$ pwd\n```');
  });

  it('wraps detected stack trace in language-less ``` fence', () => {
    const txt = 'Error\n    at Foo.bar (x.js:1:1)\n    at Object.<anonymous> (x.js:2:2)';
    expect(maybeWrapCodeBlock(txt)).toBe(
      '```\nError\n    at Foo.bar (x.js:1:1)\n    at Object.<anonymous> (x.js:2:2)\n```',
    );
  });

  it('passes through non-detected text unchanged', () => {
    const txt = 'Hello, how are you today?';
    expect(maybeWrapCodeBlock(txt)).toBe(txt);
  });
});

describe('wrapCodeBlockChunked — v1.3 long code-block fix', () => {
  // Per-chunk budget reserves headroom below sendMarkdownV2's internal
  // clip(3500) for the label prefix prepended to chunk[0] (see [P1] fix).
  const BUDGET = 3500 - 96;
  // sendMarkdownV2 clip threshold — chunk[0] + label prefix MUST stay under it.
  const SEND_CLIP = 3500;

  it('returns a single wrapped chunk when it fits', () => {
    const out = wrapCodeBlockChunked('const x = 1;', 'ts');
    expect(out).toEqual(['```ts\nconst x = 1;\n```']);
  });

  it('splits a long multi-line block into multiple valid fenced chunks', () => {
    // ~9000 chars of code over many lines → must split.
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'a'.repeat(20)}`);
    const raw = lines.join('\n');
    const chunks = wrapCodeBlockChunked(raw, null);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Each chunk is an independently-valid fenced block under the limit.
      expect(c.length).toBeLessThanOrEqual(BUDGET);
      expect(c.startsWith('```')).toBe(true);
      expect(c.endsWith('```')).toBe(true);
      // Balanced fences: exactly two ``` markers (open + close).
      expect((c.match(/```/g) ?? []).length).toBe(2);
    }

    // No content lost: strip fences from every chunk, rejoin, compare lines.
    const recovered = chunks
      .map((c) => c.replace(/^```[^\n]*\n/, '').replace(/\n```$/, ''))
      .join('\n');
    // Every original line must be present in order.
    for (const ln of lines) expect(recovered).toContain(ln);
  });

  it('chunk[0] + label prefix stays under sendMarkdownV2 clip (no fence chop)', () => {
    // [P1] regression — the dispatch path prepends `escapeMd("[label] ")+"\n"`
    // to chunk[0] then sends via sendMarkdownV2, which clip()s at 3500. If the
    // composed first message exceeds 3500 the closing ``` fence gets chopped
    // and MarkdownV2 parsing breaks. Use a long-ish label to stress headroom.
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'a'.repeat(20)}`);
    const chunks = wrapCodeBlockChunked(lines.join('\n'), 'typescript');
    const labelPrefix = '[a-very-long-session-label-name] ';
    const composed0 = escapeMd(labelPrefix) + '\n' + chunks[0];
    expect(composed0.length).toBeLessThanOrEqual(SEND_CLIP);
    // Fence still intact after the prefix is glued on.
    expect(chunks[0]!.endsWith('```')).toBe(true);
  });

  it('hard-splits a single line longer than the budget', () => {
    const giant = 'z'.repeat(9000); // no newlines
    const chunks = wrapCodeBlockChunked(giant, null);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(BUDGET);
      expect((c.match(/```/g) ?? []).length).toBe(2);
    }
    const totalZ = chunks
      .map((c) => (c.match(/z/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(totalZ).toBe(9000);
  });

  it('keeps every chunk within budget even for worst-case 2× escape expansion', () => {
    // Senior-review (Opus 4.7) [P2] regression — a single line of pure
    // backslashes (or backticks) escapes to 2× its raw length. The hard-split
    // slice size must reserve room for BOTH the escape doubling AND the fence
    // wrapper, otherwise a chunk overshoots CODE_CHUNK_BUDGET. With a `lang`
    // hint present the wrapper is longest, so test both escape chars + a lang.
    for (const { raw, lang } of [
      { raw: '\\'.repeat(9000), lang: 'json' },
      { raw: '`'.repeat(9000), lang: null as string | null },
      { raw: '\\'.repeat(9000), lang: null as string | null },
    ]) {
      const chunks = wrapCodeBlockChunked(raw, lang);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(BUDGET);
        // Telegram's hard ceiling is 4096 — never even close to breaching it.
        expect(c.length).toBeLessThanOrEqual(4096);
      }
      // No raw char lost: every escaped char round-trips back.
      const escapedChar = raw[0] === '\\' ? '\\\\' : '\\`';
      const totalEscaped = chunks
        .map((c) => (c.match(new RegExp(escapedChar.replace(/[\\`]/g, '\\$&'), 'g')) ?? []).length)
        .reduce((a, b) => a + b, 0);
      expect(totalEscaped).toBe(9000);
    }
  });
});
