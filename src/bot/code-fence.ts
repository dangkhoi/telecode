/**
 * Auto code-fence detection (Phase C.2).
 *
 * The streaming pipeline pipes raw text chunks from agent adapters into the
 * Telegram dispatcher. Many agent responses include structured snippets
 * (JSON tool args, diff hunks, stack traces, shell transcripts) that look
 * terrible when rendered as flowing prose — Telegram collapses leading
 * whitespace, breaks line alignment, and uses a proportional font.
 *
 * Phase C wraps those snippets in MarkdownV2 fenced code blocks so the
 * client renders them in monospace with proper indentation. Detection is
 * purely heuristic — we never parse the content, just sniff for marker
 * patterns. This is intentional:
 *
 *   - Speed: detection runs on every text-event flush (potentially many
 *     per dispatch turn). A regex-only path stays sub-microsecond.
 *   - Safety: false positives are MUCH worse than false negatives.
 *     Wrapping arbitrary prose in ``` makes the message uglier, not just
 *     unstyled. We err on the side of "leave it alone unless the markers
 *     are strong."
 *
 * Heuristics are conservative thresholds — see per-detector comments for
 * the exact triggers. The order matters: we check the most specific
 * patterns first (JSON / diff) before falling back to generic monospace
 * cues (shell prompt / stack trace / long-with-newlines).
 *
 * Pure-functions module — no Telegram imports. Consumed by the text
 * branch of the dispatcher in `src/bot/commands/index.ts` (Phase C wiring
 * not in scope for this file — added in C.6 follow-up).
 */
import { codeBlock } from './markdown.js';

/**
 * Outcome of {@link detectCodeBlock}. `null` means "no detection — render
 * as plain text" (callers should fall back to `escapeMd`). When set, the
 * caller should wrap the original text in {@link codeBlock} using `lang`.
 *
 *   - lang = 'json' | 'diff' | 'bash' | null
 *   - isCode = true (always — `null` return signals not-code).
 */
export interface CodeDetection {
  /**
   * Highlight hint for the fenced block. `null` means "fence as plain
   * monospace" (no language tag) — used for stack traces and generic
   * long-with-newlines fallback where Telegram clients don't have
   * syntax highlighters anyway.
   */
  lang: string | null;
  /** Always true when this object is returned. Reserved for future tri-state. */
  isCode: true;
}

/**
 * Detect whether `text` looks like a code/structured snippet and pick the
 * best language tag for the MarkdownV2 fence.
 *
 * Returns `null` when no heuristic fires — callers should render the text
 * as escaped prose. When a detector matches, the caller should wrap the
 * ORIGINAL (un-escaped) text in {@link codeBlock} with the returned lang —
 * MarkdownV2 fences need only backtick + backslash escaping (handled by
 * `codeBlock` itself).
 *
 * Performance: ~5 short regexes per call, no allocations on the no-match
 * path. Safe to call per text event.
 */
export function detectCodeBlock(text: string): CodeDetection | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // ── JSON ───────────────────────────────────────────────────────────
  // Triggers:
  //   - Starts with `{` or `[` AND ends with the matching `}` / `]`
  //   - Contains at least one `"key":` pair (proper JSON shape)
  // Rejects single-line inline blurbs like "user said {hello}" because
  // those lack the `"key":` pair.
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    // Must contain a `"key":` pair somewhere. Conservative: requires at
    // least one double-quoted key followed by colon. This filters out
    // "{hello}" (no quoted key) and "[1, 2, 3]" (no key:value structure
    // — array of primitives is technically JSON but rendering as plain
    // is fine, and forcing `json` highlighting on numeric arrays adds
    // little value).
    if (/"[^"\\]*"\s*:/.test(trimmed)) {
      return { lang: 'json', isCode: true };
    }
  }

  // ── Diff ──────────────────────────────────────────────────────────
  // Triggers:
  //   - ≥ 2 lines starting with `+` or `-` at column 0 (not `++` / `--`
  //     which would be C decrement operators / file headers — we accept
  //     those too, they're part of unified-diff format)
  //   - AND a `@@` hunk header OR `---`/`+++ ` file-header line
  // Both must hold. A standalone "- foo" bullet list doesn't trigger
  // because there's no hunk header.
  const diffLineCount = countMatches(text, /^[+-]/gm);
  const hasHunkHeader = /^@@.*@@/m.test(text) || /^[-+]{3} /m.test(text);
  if (diffLineCount >= 2 && hasHunkHeader) {
    return { lang: 'diff', isCode: true };
  }

  // ── Shell transcript ──────────────────────────────────────────────
  // Triggers: ≥ 2 lines beginning with `$ ` or `> ` (prompt + space).
  // The leading space is mandatory — naked `$variable` or `>redirect`
  // shouldn't trigger. We also accept tab as separator for `$\t…`.
  const shellPromptCount = countMatches(text, /^[$>][ \t]/gm);
  if (shellPromptCount >= 2) {
    return { lang: 'bash', isCode: true };
  }

  // ── Stack trace ───────────────────────────────────────────────────
  // Triggers: ≥ 2 lines starting with whitespace + "at " (followed by
  // an identifier or `Function`/`Object`). Matches Node and JVM-style
  // stack traces; Python's "File \"x\", line N" is detected by the
  // generic fallback below.
  const stackLineCount = countMatches(text, /^\s+at [A-Za-z_$<]/gm);
  if (stackLineCount >= 2) {
    // No language hint — Telegram doesn't have a syntax highlighter
    // for "stack trace" and forcing `bash` or `javascript` would be
    // wrong for half the cases. Plain monospace is the safest.
    return { lang: null, isCode: true };
  }

  // ── Generic monospace fallback ────────────────────────────────────
  // Triggers: text > 200 chars AND contains a newline AND looks like
  // it has columnar / aligned formatting. The "aligned" signal is:
  //   - ≥ 2 lines with leading 2+ spaces (indentation), OR
  //   - ≥ 2 consecutive runs of 3+ spaces inside lines (table-like
  //     alignment)
  //
  // We DON'T trigger on every long-with-newlines text because chatty
  // agent responses (markdown notes, Vietnamese explanations) often
  // exceed 200 chars and would look worse in a fenced block.
  if (text.length > 200 && text.includes('\n')) {
    const indentLineCount = countMatches(text, /^ {2,}\S/gm);
    const tabularRunCount = countMatches(text, / {3,}\S/g);
    if (indentLineCount >= 2 || tabularRunCount >= 2) {
      return { lang: null, isCode: true };
    }
  }

  return null;
}

/**
 * Convenience: detect + wrap in a single call. Returns the ORIGINAL text
 * (unwrapped) when no heuristic matches, so callers can chain:
 *
 *   const piece = maybeWrapCodeBlock(rawAgentText);
 *   // piece is either fenced MarkdownV2 OR raw text — caller decides whether
 *   // to escape it further (raw text needs escapeMd; fenced doesn't).
 *
 * Note: the unwrapped passthrough does NOT escape MarkdownV2 specials —
 * caller still needs to run `escapeMd` on it before composing into a
 * MarkdownV2 message. We separate the two concerns so the caller has
 * explicit control over the parse mode.
 */
export function maybeWrapCodeBlock(text: string): string {
  const detection = detectCodeBlock(text);
  if (!detection) return text;
  return codeBlock(text, detection.lang ?? undefined);
}

/**
 * v1.3 Bug fix — long code-block truncation. A single detected code block
 * longer than Telegram's per-message limit was previously wrapped once and
 * sent via `sendMarkdownV2`, which `clip()`-ped it at 3500 chars (dropping the
 * tail). Split the RAW content at line boundaries and wrap EACH chunk in its
 * own complete fence, so every emitted message is independently valid
 * MarkdownV2 (balanced ``` open/close) and no content is lost.
 *
 * Budget is measured on the WRAPPED (escaped) length — `codeBlock` doubles
 * backticks/backslashes, so a raw-char budget could still overflow after
 * escaping. Pathologically long single lines (no `\n`) are hard-split.
 *
 * Returns at least one element. `lang` is the detector's hint (may be null).
 *
 * Senior-review (Opus 4.7) [P1] — budget headroom for the label prefix. The
 * dispatch path prepends `escapeMd("[label] ") + "\n"` to the FIRST chunk, then
 * sends every chunk through `sendMarkdownV2`, which internally `clip()`s at
 * MAX_MSG_CHARS (3500). If a chunk were the full 3500, prefix + newline pushed
 * `composed` to ~3506 → clip lopped off the closing ``` fence → MarkdownV2
 * parse error → fell back to plain with a lost tail. We size CODE_CHUNK_BUDGET
 * BELOW 3500 by CODE_CHUNK_HEADROOM so chunk[0] + prefix still fits under the
 * clip with margin. Headroom covers a generous escaped label prefix.
 */
const CODE_CHUNK_HEADROOM = 96;
const CODE_CHUNK_BUDGET = 3500 - CODE_CHUNK_HEADROOM;

export function wrapCodeBlockChunked(text: string, lang: string | null): string[] {
  const langArg = lang ?? undefined;
  // Fast path: already fits in one message once wrapped.
  const whole = codeBlock(text, langArg);
  if (whole.length <= CODE_CHUNK_BUDGET) return [whole];

  // Fence-wrapper overhead (``` + lang + two \n + closing ```), measured on
  // the empty block so the math accounts for the actual lang slug length.
  const WRAPPER = codeBlock('', langArg).length;
  // Senior-review (Opus 4.7) [P2] fix — the raw budget for a single hard-split
  // slice must reserve room for BOTH the wrapper AND the worst-case 2× escape
  // expansion (a line of pure backticks/backslashes). The previous
  // `BUDGET / 2` ignored the wrapper, so an all-backslash line produced a 3512-
  // char chunk (> CODE_CHUNK_BUDGET; still < 4096 so no Telegram reject, but it
  // broke the budget contract). `(BUDGET - WRAPPER) / 2` keeps it safely under.
  const HARD_SLICE = Math.max(1, Math.floor((CODE_CHUNK_BUDGET - WRAPPER) / 2));

  const lines = text.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  const flushBuf = (): void => {
    if (buf.length === 0) return;
    chunks.push(codeBlock(buf.join('\n'), langArg));
    buf = [];
  };
  for (const lineRaw of lines) {
    let line = lineRaw;
    // Hard-split a single line whose wrapped form alone blows the budget.
    while (codeBlock(line, langArg).length > CODE_CHUNK_BUDGET) {
      flushBuf();
      chunks.push(codeBlock(line.slice(0, HARD_SLICE), langArg));
      line = line.slice(HARD_SLICE);
    }
    const candidate = buf.length === 0 ? line : [...buf, line].join('\n');
    if (buf.length > 0 && codeBlock(candidate, langArg).length > CODE_CHUNK_BUDGET) {
      flushBuf();
    }
    buf.push(line);
  }
  flushBuf();
  return chunks.length > 0 ? chunks : [whole];
}

/* ────────────────────────── small helpers ────────────────────────── */

/**
 * Count non-overlapping matches of `re` in `text`. Avoids the
 * `String.matchAll` allocation cost — we only need the count, not the
 * match objects. Caller must pass a `g`-flagged regex.
 */
function countMatches(text: string, re: RegExp): number {
  let count = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex defensively — caller may reuse the regex across
  // multiple calls.
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    count++;
    // Guard against zero-length matches (defensive — none of our
    // patterns can produce one, but a future change might).
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  return count;
}
