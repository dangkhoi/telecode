/**
 * Phase C.1 — Telegram MarkdownV2 escape helpers.
 *
 * Coverage:
 *  - Every spec-mandated special character is escaped.
 *  - Backslash handling (double-escape avoidance).
 *  - Code-block backtick / language-slug sanitisation.
 *  - Inline-code escape rules.
 *  - Wrapper helpers (bold/italic/strikethrough) compose escapeMd correctly.
 *  - Adversarial inputs: empty string, unicode, RTL marks, embedded fences.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeMd,
  codeBlock,
  inlineCode,
  bold,
  italic,
  strikethrough,
  _internals,
} from '../src/bot/markdown.js';

describe('escapeMd — character coverage', () => {
  it('escapes every spec-mandated MarkdownV2 special character', () => {
    // From grammY ref + Telegram Bot API docs.
    const specials = _internals.MDV2_SPECIAL_CHARS.split('');
    for (const ch of specials) {
      const out = escapeMd(`x${ch}y`);
      expect(out).toBe(`x\\${ch}y`);
    }
  });

  it('escapes backslashes by doubling them', () => {
    expect(escapeMd('path\\to')).toBe('path\\\\to');
  });

  it('does NOT double-escape an already-escaped backslash', () => {
    // Two passes simulate: input contains literal "\\", which after one
    // escapeMd becomes "\\\\\\\\" (four backslashes — each input \\ → \\\\).
    expect(escapeMd('\\')).toBe('\\\\');
    expect(escapeMd('\\\\')).toBe('\\\\\\\\');
  });

  it('handles strings containing ALL specials simultaneously', () => {
    const adversarial = '_*[]()~`>#+-=|{}.!';
    const out = escapeMd(adversarial);
    // Every character in the string should be preceded by exactly one
    // backslash in the output. Output length = 2 × input length.
    expect(out.length).toBe(adversarial.length * 2);
    for (let i = 0; i < adversarial.length; i++) {
      expect(out.slice(i * 2, i * 2 + 2)).toBe(`\\${adversarial[i]}`);
    }
  });

  it('preserves non-special characters verbatim', () => {
    expect(escapeMd('Hello world')).toBe('Hello world');
    expect(escapeMd('abc 123 XYZ')).toBe('abc 123 XYZ');
  });

  it('returns empty string for empty / non-string input', () => {
    expect(escapeMd('')).toBe('');
    // Defensive: caller passes null/undefined via `?? ''`. Type-wise we
    // require string but the runtime guard is part of the contract.
    expect(escapeMd(null as unknown as string)).toBe('');
    expect(escapeMd(undefined as unknown as string)).toBe('');
  });

  it('handles unicode (Vietnamese, emoji, CJK) without mangling', () => {
    expect(escapeMd('Xin chào (bạn)')).toBe('Xin chào \\(bạn\\)');
    expect(escapeMd('🎯 done.')).toBe('🎯 done\\.');
    expect(escapeMd('日本語')).toBe('日本語');
  });

  it('preserves RTL marks and zero-width joiners', () => {
    // U+200F RIGHT-TO-LEFT MARK — not a MarkdownV2 special.
    const rtl = 'foo‏bar';
    expect(escapeMd(rtl)).toBe(rtl);
    // ZWJ in emoji sequences ("man" + ZWJ + "rocket") must survive.
    const zwj = '\u{1F468}‍\u{1F680}';
    expect(escapeMd(zwj)).toBe(zwj);
  });
});

describe('codeBlock', () => {
  it('wraps plain content in fenced block with trailing newline before close', () => {
    expect(codeBlock('hello')).toBe('```\nhello\n```');
  });

  it('inserts language tag right after opening fence (no space)', () => {
    expect(codeBlock('{"k": 1}', 'json')).toBe('```json\n{"k": 1}\n```');
  });

  it('escapes backticks inside content so embedded ``` does not break out', () => {
    expect(codeBlock('look: ```secret```')).toBe(
      '```\nlook: \\`\\`\\`secret\\`\\`\\`\n```',
    );
  });

  it('escapes backslashes inside content', () => {
    expect(codeBlock('path\\file')).toBe('```\npath\\\\file\n```');
  });

  it('does not escape MarkdownV2 specials inside the block (per spec)', () => {
    // Dots / pluses / brackets are literal inside ```...```.
    expect(codeBlock('a.b+c[d]')).toBe('```\na.b+c[d]\n```');
  });

  it('strips backticks and newlines from the language slug (anti-injection)', () => {
    expect(codeBlock('x', 'json`evil')).toBe('```jsonevil\n' + 'x' + '\n```');
    expect(codeBlock('x', 'json\nbash')).toBe('```jsonbash\n' + 'x' + '\n```');
  });

  it('accepts non-standard but spec-legal language slugs', () => {
    expect(codeBlock('foo', 'c++')).toBe('```c++\nfoo\n```');
    expect(codeBlock('foo', 'objective-c')).toBe('```objective-c\nfoo\n```');
  });

  it('handles empty content gracefully', () => {
    expect(codeBlock('')).toBe('```\n\n```');
    expect(codeBlock('', 'json')).toBe('```json\n\n```');
  });

  it('preserves multi-line content with internal newlines', () => {
    expect(codeBlock('line1\nline2\nline3')).toBe(
      '```\nline1\nline2\nline3\n```',
    );
  });

  it('preserves Vietnamese / emoji in content', () => {
    expect(codeBlock('// chú thích: ✅')).toBe('```\n// chú thích: ✅\n```');
  });
});

describe('inlineCode', () => {
  it('wraps content in single backticks', () => {
    expect(inlineCode('foo.ts')).toBe('`foo.ts`');
  });

  it('escapes backticks inside', () => {
    expect(inlineCode('echo `hi`')).toBe('`echo \\`hi\\``');
  });

  it('escapes backslashes inside', () => {
    expect(inlineCode('a\\b')).toBe('`a\\\\b`');
  });

  it('does not escape MarkdownV2 specials inside (per spec — code span)', () => {
    expect(inlineCode('file.ts (v1)')).toBe('`file.ts (v1)`');
  });

  it('handles empty input', () => {
    expect(inlineCode('')).toBe('``');
  });
});

describe('bold / italic / strikethrough wrappers', () => {
  it('bold wraps with single asterisks + escapes inner specials', () => {
    expect(bold('Hello.')).toBe('*Hello\\.*');
    expect(bold('a (b)')).toBe('*a \\(b\\)*');
  });

  it('italic wraps with single underscores + escapes inner specials', () => {
    expect(italic('foo_bar')).toBe('_foo\\_bar_');
  });

  it('strikethrough wraps with single tildes + escapes inner specials', () => {
    expect(strikethrough('old.value')).toBe('~old\\.value~');
  });

  it('wrappers return well-formed delimiters even on empty input', () => {
    expect(bold('')).toBe('**');
    expect(italic('')).toBe('__');
    expect(strikethrough('')).toBe('~~');
  });
});
