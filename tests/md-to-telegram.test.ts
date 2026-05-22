/**
 * Tests for md-to-telegram.ts — standard Markdown → Telegram MarkdownV2 conversion.
 */
import { describe, it, expect } from 'vitest';
import { mdToTelegramV2 } from '../src/bot/md-to-telegram.js';

describe('mdToTelegramV2', () => {
  it('returns empty string for empty input', () => {
    expect(mdToTelegramV2('')).toBe('');
    expect(mdToTelegramV2(null as unknown as string)).toBe('');
  });

  it('passes plain text through with MarkdownV2 escaping', () => {
    expect(mdToTelegramV2('hello world')).toBe('hello world');
    expect(mdToTelegramV2('file.txt')).toBe('file\\.txt');
    expect(mdToTelegramV2('a (b)')).toBe('a \\(b\\)');
  });

  it('converts **bold** to Telegram bold (*text*)', () => {
    expect(mdToTelegramV2('hello **world**')).toBe('hello *world*');
  });

  it('converts *italic* to Telegram italic (_text_)', () => {
    expect(mdToTelegramV2('hello *world*')).toBe('hello _world_');
  });

  it('preserves `inline code`', () => {
    expect(mdToTelegramV2('use `npm install`')).toBe('use `npm install`');
  });

  it('converts fenced code blocks', () => {
    const input = '```json\n{"key": "value"}\n```';
    const expected = '```json\n{"key": "value"}\n```';
    expect(mdToTelegramV2(input)).toBe(expected);
  });

  it('converts # headers to bold', () => {
    expect(mdToTelegramV2('# Hello')).toBe('*Hello*');
    expect(mdToTelegramV2('## Sub heading')).toBe('*Sub heading*');
  });

  it('converts bullet lists (- item)', () => {
    expect(mdToTelegramV2('- first item')).toBe('• first item');
  });

  it('converts bullet lists (* item)', () => {
    expect(mdToTelegramV2('* first item')).toBe('• first item');
  });

  it('converts numbered lists', () => {
    expect(mdToTelegramV2('1. first')).toBe('• first');
  });

  it('handles mixed content', () => {
    const input = '# Title\n\nSome **bold** and *italic* text.\n\n- item 1\n- item 2';
    const result = mdToTelegramV2(input);
    expect(result).toContain('*Title*');
    expect(result).toContain('*bold*');
    expect(result).toContain('_italic_');
    expect(result).toContain('• item 1');
    expect(result).toContain('• item 2');
  });

  it('escapes MarkdownV2 specials in plain text', () => {
    expect(mdToTelegramV2('version 1.0.0')).toBe('version 1\\.0\\.0');
    expect(mdToTelegramV2('a + b = c')).toBe('a \\+ b \\= c');
  });

  it('handles unclosed bold gracefully', () => {
    // Unclosed ** should be escaped, not treated as bold
    const result = mdToTelegramV2('hello **world');
    expect(result).toBe('hello \\*\\*world');
  });

  it('handles Vietnamese text', () => {
    expect(mdToTelegramV2('Xin chào **bạn**')).toBe('Xin chào *bạn*');
  });

  it('handles code blocks with backticks inside', () => {
    const input = '```\necho `hello`\n```';
    const result = mdToTelegramV2(input);
    expect(result).toContain('\\`');
  });

  it('does not escape inside inline code', () => {
    // Dots inside inline code should NOT be escaped with MarkdownV2 rules
    expect(mdToTelegramV2('run `file.ts`')).toBe('run `file.ts`');
  });

  it('converts markdown links [text](url)', () => {
    expect(mdToTelegramV2('See [docs](https://example.com)'))
      .toBe('See [docs](https://example.com)');
  });

  it('escapes brackets that are not links', () => {
    expect(mdToTelegramV2('array[0]')).toBe('array\\[0\\]');
  });
});
