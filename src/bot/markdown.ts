/**
 * Telegram MarkdownV2 helpers (Phase C.1).
 *
 * Telegram's MarkdownV2 parser is strict: every character in the set
 * `_ * [ ] ( ) ~ \` > # + - = | { } . !` MUST be escaped with a leading `\`
 * outside of code blocks, OR the entire `sendMessage` request fails with HTTP
 * 400 ("can't parse entities"). The legacy `Markdown` parser is more
 * forgiving but is deprecated by Telegram and known to break on real-world
 * inputs (e.g. dots inside file names, asterisks inside log lines).
 *
 * Phase C migrates the streaming surface to MarkdownV2 so we can render
 * inline code (file paths, commands), bold (tool labels), and fenced code
 * blocks (auto-detected JSON/diff/bash — see {@link ./code-fence.ts}). All
 * user-supplied content (paths, command strings, agent text) flows through
 * {@link escapeMd} before composition. Static template chrome
 * (`{escaped} \\* done`) is hand-escaped at the call site.
 *
 * Source of truth for the escape set is the grammY parse-mode reference
 * (verified via Context7 query against `/websites/grammy_dev` on 2026-05-21):
 *   > "In MarkdownV2, special characters like '_', '*', '[', ']', '(', ')',
 *   >  '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!' must be
 *   >  escaped with a preceding '\\' character."
 *   > "Within `pre` and `code` entities, all backtick (`) and backslash (\\)
 *   >  characters must be escaped with a preceding backslash."
 *
 * Pure-functions module — no Telegram or grammY imports. Consumed by
 * {@link ../bot/commands/index.ts} and the auto code-fence helper.
 */

/**
 * The MarkdownV2 special-character set per Telegram spec (verified via
 * Context7 against grammY's parse-mode reference).
 *
 * NOTE: the `\\` character itself ALSO needs escaping per the Telegram spec
 * — we handle that separately below so the regex stays readable.
 */
const MDV2_SPECIAL_CHARS = '_*[]()~`>#+-=|{}.!';

/**
 * Pre-compiled escape regex. Built character-by-character (escape every
 * char) instead of via character class because `+-=` inside `[]` would
 * create a `+-=` RANGE (covering ASCII 43–61: digits, `,`, `.`, `/`, etc.)
 * which would mangle innocent characters like digits and `,`. The
 * alternation form is unambiguous.
 *
 * Kept module-level so we don't allocate a fresh RegExp on every event
 * (escapeMd is called per tool-render line — many times per dispatch turn).
 *
 * We escape `\\` separately in a first pass so the second pass's leading
 * `\\` substitutions don't double up.
 */
const MDV2_ESCAPE_RE = new RegExp(
  MDV2_SPECIAL_CHARS.split('')
    .map((c) => '\\' + c)
    .join('|'),
  'g',
);

/**
 * Escape a string for safe insertion into a MarkdownV2 message body.
 *
 *   escapeMd('Hello (world)!')    → 'Hello \\(world\\)\\!'
 *   escapeMd('use `bash` here')   → 'use \\`bash\\` here'
 *   escapeMd('path\\to\\file')    → 'path\\\\to\\\\file'
 *
 * Idempotency: NOT idempotent — calling twice produces escape-of-escapes.
 * Callers must escape exactly once, at the point where untrusted text is
 * embedded into the final composed message.
 *
 * Empty / non-string inputs return '' so the helper is safe in template
 * literals (`escapeMd(maybe ?? '')`).
 */
export function escapeMd(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  // Two-pass escape:
  //   1. Backslashes themselves (so the next pass's added backslashes don't
  //      get re-escaped into '\\\\').
  //   2. All other MarkdownV2 specials.
  return s.replace(/\\/g, '\\\\').replace(MDV2_ESCAPE_RE, '\\$&');
}

/**
 * Wrap `content` in a fenced code block. Per the grammY MarkdownV2 spec,
 * inside ``` fences only backticks and backslashes need escaping — every
 * other character is rendered literally.
 *
 *   codeBlock('hello')              → '```\\nhello\\n```'
 *   codeBlock('hello', 'json')      → '```json\\nhello\\n```'
 *   codeBlock('with ``` literal')   → '```\\nwith \\`\\`\\` literal\\n```'
 *
 * The `lang` hint is appended right after the opening fence with no space,
 * matching how Telegram's clients highlight code (`pre.language-json`).
 * Unknown languages are accepted but render as plain monospace on most
 * clients — Telegram doesn't error.
 *
 * If `lang` is provided we don't escape it (it MUST be alphanumeric; we
 * sanitise just enough to prevent ``` injection in the language slug).
 *
 * Senior-review note: we DO NOT add an outer newline before/after the
 * fence — that's the caller's job when composing multi-part messages. The
 * single internal `\n` around `content` is required by the parser even
 * when content is already newline-terminated.
 */
export function codeBlock(content: string, lang?: string): string {
  // Escape backticks + backslashes per spec. Order matters: backslash first.
  const safeContent = (content ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`');
  if (lang) {
    // Defence-in-depth: a language slug with backticks or newlines would
    // break out of the fence. Strip both — Telegram only accepts a single
    // word here anyway. Other non-alphanumerics (`+`, `-`, `_`, `.`) are
    // legal in language tags (`c++`, `objective-c`).
    const safeLang = lang.replace(/[`\n\r]/g, '');
    return '```' + safeLang + '\n' + safeContent + '\n```';
  }
  return '```\n' + safeContent + '\n```';
}

/**
 * Wrap `s` in an inline code span. Per the spec, only backticks and
 * backslashes need escaping inside `` ` `` spans.
 *
 *   inlineCode('foo.ts')         → '`foo.ts`'
 *   inlineCode('echo `hi`')      → '`echo \\`hi\\``'
 */
export function inlineCode(s: string): string {
  const safe = (s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`');
  return '`' + safe + '`';
}

/**
 * Bold wrapper. Content is escaped via {@link escapeMd} so the inner text
 * can contain arbitrary user input (file paths, agent output) without
 * breaking the parser.
 *
 *   bold('Hello (world)')        → '*Hello \\(world\\)*'
 */
export function bold(s: string): string {
  return '*' + escapeMd(s) + '*';
}

/**
 * Italic wrapper. Same escape semantics as {@link bold}. Uses single `_` per
 * the v2 spec (the legacy `Markdown` parser also accepts `*_*` but v2 is
 * strict).
 */
export function italic(s: string): string {
  return '_' + escapeMd(s) + '_';
}

/**
 * Strikethrough wrapper. Telegram's v2 spec uses `~text~` (single tilde).
 * Per the same query against grammY's MarkdownV2 docs.
 */
export function strikethrough(s: string): string {
  return '~' + escapeMd(s) + '~';
}

/**
 * Internal helpers exposed for tests. Not part of the public API — callers
 * should use the named exports above.
 */
export const _internals = { MDV2_SPECIAL_CHARS };
