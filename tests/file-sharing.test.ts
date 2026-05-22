import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { sendFileToChat, type MinimalBotForSend } from '../src/bot/attachments.js';

// Mock fs
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn() };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn() };
});

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

const mockExistsSync = vi.mocked(existsSync);
const mockStat = vi.mocked(stat);

function makeMockBot() {
  return {
    api: {
      sendDocument: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
    },
  } as unknown as MinimalBotForSend & {
    api: { sendDocument: ReturnType<typeof vi.fn>; sendPhoto: ReturnType<typeof vi.fn> };
  };
}

describe('sendFileToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const bot = makeMockBot();
    const result = await sendFileToChat(bot, { chatId: 123, filePath: '/no/such/file.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('không tồn tại');
  });

  it('returns error when file exceeds 50MB', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStat.mockResolvedValue({ size: 60 * 1024 * 1024 } as never);
    const bot = makeMockBot();
    const result = await sendFileToChat(bot, { chatId: 123, filePath: '/big/file.zip' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('quá lớn');
  });

  it('uses sendPhoto for image extensions', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStat.mockResolvedValue({ size: 1024 } as never);
    const bot = makeMockBot();

    for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
      vi.clearAllMocks();
      mockExistsSync.mockReturnValue(true);
      mockStat.mockResolvedValue({ size: 1024 } as never);
      const result = await sendFileToChat(bot, { chatId: 123, filePath: `/img/photo${ext}` });
      expect(result.success).toBe(true);
      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);
      expect(bot.api.sendDocument).not.toHaveBeenCalled();
    }
  });

  it('uses sendDocument for non-image extensions', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStat.mockResolvedValue({ size: 2048 } as never);
    const bot = makeMockBot();
    const result = await sendFileToChat(bot, { chatId: 123, filePath: '/docs/report.pdf' });
    expect(result.success).toBe(true);
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();
  });

  it('passes caption and replyToMessageId in other params', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStat.mockResolvedValue({ size: 512 } as never);
    const bot = makeMockBot();
    await sendFileToChat(bot, {
      chatId: 42,
      filePath: '/a/b.txt',
      caption: 'hello',
      replyToMessageId: 99,
    });
    const call = bot.api.sendDocument.mock.calls[0]!;
    expect(call[0]).toBe(42);
    expect(call[2]).toMatchObject({ caption: 'hello', reply_to_message_id: 99 });
  });

  it('returns error when bot API throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStat.mockResolvedValue({ size: 100 } as never);
    const bot = makeMockBot();
    bot.api.sendDocument.mockRejectedValue(new Error('network fail'));
    const result = await sendFileToChat(bot, { chatId: 1, filePath: '/x.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('thất bại');
  });
});

describe('/send path security', () => {
  it('rejects path traversal outside project', () => {
    const projPath = '/Users/koi/project';
    // Simulate the security check from the command handler
    const testPaths = [
      { input: '../../../etc/passwd', shouldReject: true },
      { input: 'src/index.ts', shouldReject: false },
      { input: './README.md', shouldReject: false },
      { input: '/etc/passwd', shouldReject: true },
    ];
    for (const { input, shouldReject } of testPaths) {
      const resolved = path.resolve(projPath, input);
      const allowed = resolved.startsWith(projPath + path.sep) || resolved === projPath;
      expect(allowed).toBe(!shouldReject);
    }
  });
});
