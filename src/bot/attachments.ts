/**
 * v1.2 Feature 2/3 — Telegram attachment download + local persistence.
 *
 * Bridges `bot.on('message:photo' | 'message:document')` to the agent
 * dispatch path: download the file from Telegram's Bot API into
 * `~/.telecode/inbox/<chatId>/<yyyymmdd-HHMMSS>-<rand6>-<filename>`, then
 * return a {@link SavedAttachment} so the caller can inject an `@<path>`
 * reference into the agent prompt.
 *
 * Design notes:
 *
 *   - No new dependency. We use Node 22's native `fetch` for the download
 *     and stream the response body into the file via `node:stream/promises`
 *     `pipeline`. The `@grammyjs/files` plugin offers a `file.download()`
 *     shortcut but adds a runtime dep for ~30 LoC we can write ourselves —
 *     not worth it.
 *
 *   - Path is absolute + cross-platform (`os.homedir()` + `path.join`) so
 *     the same logic works on macOS / Linux / Windows. The agent prompt
 *     receives the absolute path; each agent (Claude / Kiro / Codex /
 *     Cursor) uses its own Read tool to open it, which is uniform.
 *
 *   - Filename sanitize is strict: only `[A-Za-z0-9._-]` survives. Spaces,
 *     parentheses, unicode → underscores. Stem capped at 80 chars (Telegram
 *     can deliver weird filenames; long paths blow up tar/zip pipelines on
 *     Windows).
 *
 *   - Size cap enforced BEFORE the download starts using the metadata
 *     returned by `getFile` — we don't fetch megabytes only to throw them
 *     away. (Telegram returns `file_size` for documents reliably; photos
 *     come back without one sometimes, in which case the download proceeds
 *     and we check `Content-Length` from the HTTP response instead.)
 *
 *   - Extension allowlist applies to documents only. Photos skip it
 *     because Telegram normalizes them to JPEG/PNG and emits no filename.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { logger } from '../util/logger.js';

/** Default file extension allowlist when config omits `attachment_allowed_exts`. */
export const DEFAULT_ALLOWED_EXTS: ReadonlySet<string> = new Set(
  [
    // Plain text & markup
    '.md', '.markdown', '.txt', '.rst', '.adoc',
    '.html', '.htm', '.xml', '.svg',
    // Structured data
    '.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
    // Logs
    '.log',
    // Office docs
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.pdf',
    // Code
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
    '.c', '.h', '.cpp', '.hpp', '.cs',
    '.sh', '.bash', '.zsh', '.ps1',
    '.sql', '.graphql', '.proto',
    // Images (also accepted as `message:document` when sent uncompressed)
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic',
  ].map((s) => s.toLowerCase()),
);

export interface SavedAttachment {
  /** Absolute path on disk — pass this to the agent via `@<path>`. */
  absPath: string;
  /** Sanitized filename (basename of absPath). */
  filename: string;
  /** Size in bytes after download. */
  sizeBytes: number;
  /** Origin kind — distinguishes the prompt-suffix template. */
  kind: 'photo' | 'document';
  /** Lower-case extension including dot (e.g. `.docx`). Empty string if none. */
  ext: string;
}

export interface DownloadOpts {
  /** Max bytes accepted. Caller computes from config. */
  maxBytes: number;
  /**
   * Optional extension allowlist (lower-case, leading dot). When `undefined`,
   * the default safe set in {@link DEFAULT_ALLOWED_EXTS} applies.
   * Photo downloads ignore this — Telegram delivers JPEG/PNG only.
   */
  allowedExts?: Set<string>;
  /**
   * Inbox root override (mostly for tests). Defaults to
   * `~/.telecode/inbox`. The full path appends `<chatId>/<filename>`.
   */
  inboxRoot?: string;
}

/**
 * Minimal grammY Bot interface — we only need `api.getFile` + `token`. Typed
 * loosely here so the module stays test-friendly without pulling the heavy
 * Bot<Context> generic from grammy into every consumer.
 */
export interface MinimalBot {
  token: string;
  api: { getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }> };
}

/**
 * Result envelope: success returns a {@link SavedAttachment}, failure returns
 * `{ error }` with a user-facing Vietnamese message ready to ship to Telegram.
 * Never throws — callers don't need try/catch.
 */
export type DownloadResult = SavedAttachment | { error: string };

const MAX_STEM_CHARS = 80;
const RAND_SUFFIX_BYTES = 3; // 6 hex chars

/**
 * Sanitize a filename to `[A-Za-z0-9._-]+` so the resulting path is safe on
 * every OS we ship to (Windows is the strictest — colons, asterisks, pipes,
 * NUL, etc. are forbidden). Stem (without extension) capped at
 * {@link MAX_STEM_CHARS} chars to keep total path length sane.
 *
 * Exported for unit testing — the sanitizer is the boundary between
 * untrusted Telegram input and the local filesystem, so it has to be exact.
 */
export function sanitizeFilename(input: string | null | undefined, fallback: string): string {
  const raw = (input ?? '').trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned.length === 0) return fallback;
  const dotIdx = cleaned.lastIndexOf('.');
  const stem = dotIdx > 0 ? cleaned.slice(0, dotIdx) : cleaned;
  const ext = dotIdx > 0 ? cleaned.slice(dotIdx) : '';
  const cappedStem = stem.length > MAX_STEM_CHARS ? stem.slice(0, MAX_STEM_CHARS) : stem;
  return cappedStem + ext;
}

/**
 * Build the inbox directory for a chat. Created lazily on first download.
 * Uses `mkdirSync(recursive)` so concurrent downloads from the same chat
 * never race on directory creation. Wrapped in try/catch so a read-only
 * `$HOME` or missing-permissions parent surfaces a friendly error instead
 * of an unhandled exception that escapes the dispatch handler.
 *
 * Senior-review (Opus 4.7) [P2] — previously this threw raw, crashing the
 * photo/document `bot.on` handler before the user-facing error reply.
 */
function ensureInboxDir(chatId: number, root: string): { dir: string } | { error: string } {
  const dir = path.join(root, String(chatId));
  try {
    mkdirSync(dir, { recursive: true });
    return { dir };
  } catch (err) {
    return {
      error:
        `📎 Không tạo được thư mục inbox \`${dir}\`: ${String(err).slice(0, 120)}. ` +
        `Kiểm tra quyền ghi vào \`~/.telecode/\`.`,
    };
  }
}

function timestamp(): string {
  // yyyymmdd-HHMMSS in local time. Local is fine — the only consumer is the
  // user looking at filenames in `~/.telecode/inbox/`. UTC would just confuse.
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Resolve the default inbox root (`~/.telecode/inbox`). Pulled out so tests
 * can override via `opts.inboxRoot` without monkey-patching `os.homedir`.
 */
export function defaultInboxRoot(): string {
  return path.join(os.homedir(), '.telecode', 'inbox');
}

/**
 * Download a Telegram file (photo or document) to local disk.
 *
 * @param bot   Minimal grammY-bot facade with `token` + `api.getFile`.
 * @param chatId Chat id — used as subdirectory under inbox root.
 * @param fileId Telegram file id (`PhotoSize.file_id` or `Document.file_id`).
 * @param hintName Original filename for documents; `null` for photos (we
 *                 mint a synthetic name from MIME / timestamp).
 * @param kind   'photo' | 'document' — drives extension fallback + allowlist.
 * @param opts   {@link DownloadOpts}.
 * @returns A {@link DownloadResult} — either a saved attachment or a
 *          user-facing error message in Vietnamese.
 */
export async function downloadTelegramAttachment(
  bot: MinimalBot,
  chatId: number,
  fileId: string,
  hintName: string | null,
  kind: 'photo' | 'document',
  opts: DownloadOpts,
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes;
  const inboxRoot = opts.inboxRoot ?? defaultInboxRoot();

  // Step 1 — fetch metadata via Bot API. This returns the temporary
  // `file_path` we use to compose the download URL, plus an optional
  // `file_size` we use to short-circuit oversized requests.
  let meta: { file_path?: string; file_size?: number };
  try {
    meta = await bot.api.getFile(fileId);
  } catch (err) {
    logger.warn({ err: String(err), fileId, chatId }, 'getFile failed');
    return { error: `📎 Không lấy được thông tin file từ Telegram (${String(err).slice(0, 120)}).` };
  }
  if (!meta.file_path) {
    return { error: '📎 Telegram không trả về file_path — file có thể đã hết hạn (>1h).' };
  }
  if (typeof meta.file_size === 'number' && meta.file_size > maxBytes) {
    return {
      error:
        `📎 File quá lớn: ${formatBytes(meta.file_size)} (giới hạn ${formatBytes(maxBytes)}).\n` +
        `Tăng \`telegram.attachment_max_bytes\` trong config nếu cần.`,
    };
  }

  // Step 2 — derive a sanitized filename. Photos: synthesize from extension
  // hint (jpg) + timestamp. Documents: sanitize the original name.
  //
  // Senior-review (Opus 4.7) [P2] — for photos with no hintName, infer the
  // extension from Telegram's `file_path` (e.g. `photos/abc.png`) so the
  // saved filename matches the real content. Without this, Telegram-
  // compressed PNG/WebP photos landed as `photo-<ts>.jpg` which confused
  // agents that key off file extension.
  let baseName: string;
  if (kind === 'photo') {
    const remoteExt = path.extname(meta.file_path).toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(remoteExt) ? remoteExt : '.jpg';
    baseName = sanitizeFilename(hintName, `photo-${timestamp()}${safeExt}`);
  } else {
    baseName = sanitizeFilename(hintName, `file-${timestamp()}.bin`);
  }
  const ext = (path.extname(baseName) || '').toLowerCase();

  // Step 3 — enforce extension allowlist for documents.
  if (kind === 'document') {
    const allow = opts.allowedExts ?? DEFAULT_ALLOWED_EXTS;
    if (ext === '' || !allow.has(ext)) {
      return {
        error:
          `📎 Extension không được hỗ trợ: \`${ext || '(none)'}\`. ` +
          `Allowlist hiện tại: ${[...allow].slice(0, 12).join(', ')}…`,
      };
    }
  }

  // Step 4 — final path. Prefix with timestamp + 6-hex-char random so two
  // identically-named uploads in the same chat don't overwrite each other.
  const stamp = timestamp();
  const rand = randomBytes(RAND_SUFFIX_BYTES).toString('hex');
  const finalName = `${stamp}-${rand}-${baseName}`;
  const dirRes = ensureInboxDir(chatId, inboxRoot);
  if ('error' in dirRes) return { error: dirRes.error };
  const absPath = path.join(dirRes.dir, finalName);

  // Step 5 — fetch + stream to disk. We re-check size against
  // `Content-Length` (in case Telegram omitted `file_size` in step 1) and
  // additionally abort mid-stream if the cumulative byte count exceeds the
  // cap — defends against a server that lies in Content-Length.
  const url = `https://api.telegram.org/file/bot${bot.token}/${meta.file_path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { error: `📎 Tải file thất bại (network): ${String(err).slice(0, 120)}` };
  }
  if (!response.ok) {
    return { error: `📎 Telegram trả lỗi HTTP ${response.status} khi tải file.` };
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) {
    return {
      error:
        `📎 File quá lớn (Content-Length ${formatBytes(contentLength)} > ${formatBytes(maxBytes)}).`,
    };
  }
  if (!response.body) {
    return { error: '📎 Telegram trả response không có body — không tải được.' };
  }

  // Wrap the WebStream → Node Readable and pipe into the file. Track byte
  // count for the over-budget abort. `pipeline` rejects if any side errors,
  // so we get a single `try` boundary.
  let bytesSeen = 0;
  const nodeReadable = Readable.fromWeb(response.body as never);
  nodeReadable.on('data', (chunk: Buffer) => {
    bytesSeen += chunk.length;
    if (bytesSeen > maxBytes) {
      nodeReadable.destroy(
        new Error(`download exceeded ${formatBytes(maxBytes)} cap (received ${bytesSeen})`),
      );
    }
  });
  try {
    await pipeline(nodeReadable, createWriteStream(absPath));
  } catch (err) {
    // Best-effort cleanup — keep the partial file if unlink fails so the
    // user can inspect what landed. (Important: do NOT throw on unlink.)
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(absPath);
    } catch {
      // ignored
    }
    return { error: `📎 Lưu file thất bại: ${String(err).slice(0, 160)}` };
  }

  // Final size check after the fact (defense-in-depth — pipeline could
  // succeed with a 0-byte body on some adversarial inputs).
  let actualSize = bytesSeen;
  if (actualSize === 0) {
    try {
      const st = await stat(absPath);
      actualSize = st.size;
    } catch {
      // ignore — fall back to whatever we counted (0).
    }
  }

  return {
    absPath,
    filename: finalName,
    sizeBytes: actualSize,
    kind,
    ext,
  };
}

/**
 * Compose the agent prompt body given an optional user caption + the saved
 * attachment metadata. The structure deliberately mirrors how a developer
 * would manually paste a path into a CLI agent: a one-line directive
 * followed by the `📎 Attached …: @<path>` reference on a fresh line.
 *
 * All four shipping adapters (Claude / Kiro / Codex / Cursor) accept paths
 * inline in the prompt and resolve them via their own Read tool, so this
 * single representation works uniformly. (We explicitly chose NOT to use
 * Claude's base64 content-block streaming-mode API — see spec §D5
 * trade-off.)
 *
 * `caption` is the Telegram message caption (the text the user typed
 * alongside the file). When empty / whitespace-only, a sensible default
 * fires so the agent always has SOMETHING to act on.
 */
export function buildPromptWithAttachment(
  caption: string | null | undefined,
  attachment: SavedAttachment,
): string {
  const body = (caption ?? '').trim();
  const fallback =
    attachment.kind === 'photo'
      ? 'Xem ảnh đính kèm và cho biết bạn thấy gì.'
      : 'Đọc file đính kèm rồi trả lời tiếp.';
  const intro = body.length > 0 ? body : fallback;
  const sizeHint = formatBytes(attachment.sizeBytes);
  const meta =
    attachment.kind === 'photo'
      ? `📎 Attached image: @${attachment.absPath} (${sizeHint})`
      : `📎 Attached file: @${attachment.absPath} (${sizeHint}, ${attachment.ext})`;
  return `${intro}\n\n${meta}`;
}

/**
 * Lightweight byte-formatter — duplicates the one in `bot/commands/index.ts`
 * but lives here so the attachments module stays free of circular imports.
 * Returns "1.2 KB" / "3.4 MB" / "512 B" form.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
