/**
 * Convert standard Markdown (as emitted by LLM agents) to Telegram MarkdownV2.
 *
 * Handles: **bold**, *italic*, `inline code`, ```fenced blocks```, # headers,
 * - bullet lists. All other text is escaped for MarkdownV2 safety.
 *
 * Design:
 *  - Line-by-line processing for headers/lists (block-level).
 *  - Inline pass for bold/italic/code within each line.
 *  - Unclosed inline markers are auto-closed at line end.
 *  - Fenced code blocks pass through with only backtick/backslash escaping
 *    (per Telegram spec, no other escaping needed inside ```).
 *  - Performance: single pass, no AST, regex-based. Sub-ms for typical
 *    agent responses (< 4KB).
 */

const MDV2_ESCAPE_RE = /[_*[\]()~`>#+=|{}.!-]/g;

/** Escape a string for MarkdownV2 (outside code spans/blocks). */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(MDV2_ESCAPE_RE, '\\$&');
}

/** Escape content inside a code span/block (only backticks + backslashes). */
function escCode(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

/**
 * Process inline markdown within a single line (no fenced blocks).
 * Converts **bold**, *italic*, `code` to Telegram MarkdownV2 equivalents.
 */
function convertInline(line: string): string {
  const parts: string[] = [];
  let i = 0;

  while (i < line.length) {
    // Inline code: `...`
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end !== -1) {
        parts.push('`' + escCode(line.slice(i + 1, end)) + '`');
        i = end + 1;
        continue;
      }
      // Unclosed backtick — escape it
      parts.push(esc('`'));
      i++;
      continue;
    }

    // Markdown link: [text](url)
    if (line[i] === '[') {
      const closeBracket = line.indexOf(']', i + 1);
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const text = line.slice(i + 1, closeBracket);
          const url = line.slice(closeBracket + 2, closeParen);
          parts.push('[' + esc(text) + '](' + url + ')');
          i = closeParen + 1;
          continue;
        }
      }
      // Not a valid link — escape the bracket
      parts.push(esc('['));
      i++;
      continue;
    }

    // Bold: **...**
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2);
      if (end !== -1) {
        parts.push('*' + convertInline(line.slice(i + 2, end)) + '*');
        i = end + 2;
        continue;
      }
      // Unclosed ** — escape both asterisks
      parts.push(esc('*') + esc('*'));
      i += 2;
      continue;
    }

    // Italic: *...* (single, not followed by another *)
    if (line[i] === '*' && line[i + 1] !== '*') {
      const end = findClosingSingle(line, '*', i + 1);
      if (end !== -1) {
        parts.push('_' + convertInline(line.slice(i + 1, end)) + '_');
        i = end + 1;
        continue;
      }
      // Unclosed * — escape it
      parts.push(esc('*'));
      i++;
      continue;
    }

    // Escape normal character
    const ch = line[i]!;
    parts.push(esc(ch));
    i++;
  }

  return parts.join('');
}

/** Find closing single marker that isn't doubled. */
function findClosingSingle(s: string, marker: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === marker && s[j + 1] !== marker && (j === from || s[j - 1] !== marker)) {
      return j;
    }
  }
  return -1;
}

/**
 * Convert standard Markdown text to Telegram MarkdownV2.
 *
 * This is the main entry point. Handles fenced code blocks at the top level,
 * then delegates line-by-line for headers, lists, and inline formatting.
 */
export function mdToTelegramV2(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: ```lang ... ```
    if (line.trimStart().startsWith('```')) {
      const langMatch = line.trimStart().match(/^```(\w*)/);
      const lang = langMatch?.[1] || '';
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        blockLines.push(lines[i]!);
        i++;
      }
      // Skip closing ```
      if (i < lines.length) i++;
      const content = escCode(blockLines.join('\n'));
      out.push(lang ? '```' + lang + '\n' + content + '\n```' : '```\n' + content + '\n```');
      continue;
    }

    // Header: # ... → bold
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      out.push('*' + convertInline(headerMatch[2]!) + '*');
      i++;
      continue;
    }

    // Bullet list: - item or * item
    const bulletMatch = line.match(/^(\s*)[*-]\s+(.+)/);
    if (bulletMatch) {
      out.push(esc('• ') + convertInline(bulletMatch[2]!));
      i++;
      continue;
    }

    // Numbered list: 1. item
    const numMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (numMatch) {
      out.push(esc('• ') + convertInline(numMatch[2]!));
      i++;
      continue;
    }

    // Regular line
    out.push(convertInline(line));
    i++;
  }

  return out.join('\n');
}
