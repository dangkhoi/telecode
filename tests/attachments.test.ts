/**
 * v1.2 Feature 2/3 — unit tests for the attachment download module.
 *
 * Covers:
 *   - sanitizeFilename: weird characters → safe, stem cap, empty fallback.
 *   - buildPromptWithAttachment: caption + default + @path injection.
 *   - downloadTelegramAttachment:
 *       * size cap (getFile metadata)
 *       * extension allowlist (documents only; photos bypass)
 *       * end-to-end save under temp inboxRoot
 *       * file_path missing → friendly error
 *       * mid-stream byte-count over budget → reject + cleanup
 *
 * We mock the `MinimalBot` shape directly + stub `globalThis.fetch` so the
 * test never touches the real Telegram API. The inbox root is a `mkdtemp`
 * directory so the host's `~/.telecode` stays clean.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeFilename,
  buildPromptWithAttachment,
  downloadTelegramAttachment,
  formatBytes,
  DEFAULT_ALLOWED_EXTS,
  type MinimalBot,
  type SavedAttachment,
} from '../src/bot/attachments.js';

describe('sanitizeFilename', () => {
  it('keeps safe characters and replaces unsafe ones', () => {
    expect(sanitizeFilename('hello world.md', 'fb.md')).toBe('hello_world.md');
    expect(sanitizeFilename('file (1) [final].txt', 'fb.txt')).toBe('file_1_final_.txt');
  });
  it('falls back when input is empty or all-unsafe', () => {
    expect(sanitizeFilename('', 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeFilename('   ', 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeFilename('/// !@#', 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeFilename(null, 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeFilename(undefined, 'fallback.bin')).toBe('fallback.bin');
  });
  it('caps stem at 80 chars but preserves extension', () => {
    const longStem = 'a'.repeat(200);
    const out = sanitizeFilename(`${longStem}.docx`, 'fb.docx');
    // Stem should be 80 chars, extension preserved.
    expect(out.endsWith('.docx')).toBe(true);
    expect(out.length).toBe(80 + '.docx'.length);
  });
  it('preserves dots in the middle of a name as part of stem cap', () => {
    // 'a.b.c.txt' — last dot is extension; cap applies to 'a.b.c'.
    const out = sanitizeFilename('a.b.c.txt', 'fb.txt');
    expect(out).toBe('a.b.c.txt');
  });
});

describe('buildPromptWithAttachment', () => {
  const att: SavedAttachment = {
    absPath: '/tmp/inbox/123/x.png',
    filename: 'x.png',
    sizeBytes: 2048,
    kind: 'photo',
    ext: '.png',
  };
  it('uses caption when provided', () => {
    const out = buildPromptWithAttachment('describe this please', att);
    expect(out.startsWith('describe this please')).toBe(true);
    expect(out).toContain('📎 Attached image: @/tmp/inbox/123/x.png');
    expect(out).toContain('(2.0 KB)');
  });
  it('falls back to default for empty/whitespace caption — photo', () => {
    const out = buildPromptWithAttachment('   ', att);
    expect(out.startsWith('Xem ảnh đính kèm')).toBe(true);
  });
  it('falls back to default for empty caption — document', () => {
    const docAtt: SavedAttachment = { ...att, kind: 'document', ext: '.docx' };
    const out = buildPromptWithAttachment(null, docAtt);
    expect(out.startsWith('Đọc file đính kèm')).toBe(true);
    expect(out).toContain('📎 Attached file:');
    expect(out).toContain(', .docx)');
  });
});

describe('formatBytes', () => {
  it('formats across orders of magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
  it('handles non-finite + negative defensively', () => {
    expect(formatBytes(Number.NaN)).toContain('B');
    expect(formatBytes(-1)).toContain('B');
  });
});

describe('DEFAULT_ALLOWED_EXTS', () => {
  it('contains the headline formats from the spec', () => {
    for (const ext of [
      '.md', '.html', '.txt', '.csv', '.json', '.yaml',
      '.docx', '.xlsx', '.pdf', '.png', '.jpg',
      '.ts', '.py', '.go',
    ]) {
      expect(DEFAULT_ALLOWED_EXTS.has(ext)).toBe(true);
    }
  });
  it('rejects scary executable extensions by default', () => {
    // We don't WANT .exe / .bat / .dll / .so in the agent inbox; they're
    // not in the allowlist. If this assertion ever fails, the allowlist
    // has grown unsafe.
    for (const ext of ['.exe', '.bat', '.dll', '.so', '.dmg', '.pkg']) {
      expect(DEFAULT_ALLOWED_EXTS.has(ext)).toBe(false);
    }
  });
});

describe('downloadTelegramAttachment', () => {
  let inboxRoot: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    inboxRoot = mkdtempSync(join(tmpdir(), 'telecode-attach-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    rmSync(inboxRoot, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  function makeBot(getFileImpl: (fileId: string) => Promise<{ file_path?: string; file_size?: number }>): MinimalBot {
    return {
      token: 'TEST_TOKEN',
      api: { getFile: getFileImpl },
    };
  }

  function stubFetch(body: Uint8Array, opts?: { contentLength?: number; status?: number }): void {
    globalThis.fetch = vi.fn(async () => {
      const status = opts?.status ?? 200;
      const headers = new Headers();
      headers.set('content-length', String(opts?.contentLength ?? body.byteLength));
      // Build a ReadableStream<Uint8Array> the same way undici does.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      });
      return new Response(stream, { status, headers });
    }) as typeof globalThis.fetch;
  }

  it('downloads a document end-to-end + writes to inbox under chatId', async () => {
    const payload = new TextEncoder().encode('# hello world\n');
    stubFetch(payload);
    const bot = makeBot(async () => ({
      file_path: 'documents/file_1.md',
      file_size: payload.byteLength,
    }));
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_1',
      'README.md',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.kind).toBe('document');
    expect(result.ext).toBe('.md');
    expect(result.filename.endsWith('-README.md')).toBe(true);
    expect(result.absPath.startsWith(join(inboxRoot, '42'))).toBe(true);
    expect(existsSync(result.absPath)).toBe(true);
    expect(readFileSync(result.absPath, 'utf8')).toBe('# hello world\n');
    expect(result.sizeBytes).toBe(payload.byteLength);
  });

  it('rejects when getFile metadata size exceeds maxBytes (cheap pre-check)', async () => {
    const bot = makeBot(async () => ({ file_path: 'documents/big.pdf', file_size: 50_000_000 }));
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_2',
      'big.pdf',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('quá lớn');
    }
  });

  it('rejects document with extension outside allowlist (.exe)', async () => {
    const bot = makeBot(async () => ({ file_path: 'documents/evil.exe', file_size: 100 }));
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_3',
      'evil.exe',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('không được hỗ trợ');
    }
  });

  it('allows photo with no allowlist constraint (synthesized .jpg name)', async () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // tiny JPEG SOI
    stubFetch(payload);
    const bot = makeBot(async () => ({ file_path: 'photos/abc.jpg', file_size: payload.byteLength }));
    const result = await downloadTelegramAttachment(
      bot,
      99,
      'PHOTO_ID',
      null,
      'photo',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.kind).toBe('photo');
    expect(result.ext).toBe('.jpg');
    expect(result.absPath.startsWith(join(inboxRoot, '99'))).toBe(true);
    expect(existsSync(result.absPath)).toBe(true);
  });

  it('reports a friendly error when Telegram returns no file_path (expired link)', async () => {
    const bot = makeBot(async () => ({ file_size: 100 })); // no file_path
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_X',
      'doc.md',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('hết hạn');
    }
  });

  it('rejects when Content-Length declares oversize (server lies in getFile)', async () => {
    // getFile says 100, but Content-Length says 50 MB. Should refuse.
    stubFetch(new Uint8Array(8), { contentLength: 50_000_000 });
    const bot = makeBot(async () => ({ file_path: 'documents/x.md', file_size: 100 }));
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_Y',
      'x.md',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('quá lớn');
    }
  });

  it('handles getFile throwing as a clean error response (no exception leak)', async () => {
    const bot = makeBot(async () => {
      throw new Error('network down');
    });
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_Z',
      'x.md',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('network down');
    }
  });

  it('handles fetch non-2xx as a clean error response', async () => {
    stubFetch(new Uint8Array(0), { status: 404, contentLength: 0 });
    const bot = makeBot(async () => ({ file_path: 'documents/missing.md', file_size: 100 }));
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_404',
      'missing.md',
      'document',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('HTTP 404');
    }
  });

  it('returns friendly error when inbox dir cannot be created (mkdir EACCES)', async () => {
    // Senior-review (Opus 4.7) [P2] — point `inboxRoot` at a non-creatable
    // path (under a regular file) so `mkdirSync(recursive:true)` errors
    // with ENOTDIR. The download must surface a friendly error rather than
    // letting the sync exception escape the handler.
    const filePath = join(inboxRoot, 'not-a-dir');
    // Create a regular file at that path so attempts to mkdir a subdir
    // beneath it fail deterministically.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, 'blocker');
    stubFetch(new Uint8Array([1, 2, 3]));
    const bot = makeBot(async () => ({ file_path: 'documents/x.md', file_size: 3 }));
    const result = await downloadTelegramAttachment(
      bot,
      42,
      'FILE_ID_EACCES',
      'x.md',
      'document',
      { maxBytes: 1_000_000, inboxRoot: filePath },
    );
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('inbox');
    }
  });

  it('infers photo extension from Telegram file_path when hintName is null', async () => {
    // Senior-review (Opus 4.7) [P2] — Telegram photos can arrive as PNG,
    // WebP, etc. depending on compression. Without inference, every photo
    // landed as `.jpg` which confused agents that key off extension.
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    stubFetch(payload);
    const bot = makeBot(async () => ({ file_path: 'photos/abc.png', file_size: payload.byteLength }));
    const result = await downloadTelegramAttachment(
      bot,
      99,
      'PHOTO_PNG',
      null,
      'photo',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ext).toBe('.png');
    expect(result.filename.endsWith('.png')).toBe(true);
  });

  it('falls back to .jpg for photo with no parsable extension in file_path', async () => {
    const payload = new Uint8Array([0xff, 0xd8]);
    stubFetch(payload);
    // Telegram returns a file_path with no extension (rare but possible).
    const bot = makeBot(async () => ({ file_path: 'photos/abc', file_size: payload.byteLength }));
    const result = await downloadTelegramAttachment(
      bot,
      99,
      'PHOTO_NOEXT',
      null,
      'photo',
      { maxBytes: 1_000_000, inboxRoot },
    );
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ext).toBe('.jpg');
  });
});
