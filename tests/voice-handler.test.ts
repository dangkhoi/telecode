import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribeAudio } from '../src/bot/voice-handler.js';

describe('voice-handler: transcribeAudio', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns error when no API key', async () => {
    const result = await transcribeAudio('/tmp/test.ogg', { apiKey: undefined });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('OPENAI_API_KEY');
    }
  });

  it('returns transcription on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello world', duration: 3.5 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Mock fs.readFile
    vi.mock('node:fs/promises', async (importOriginal) => {
      const orig = await importOriginal() as any;
      return {
        ...orig,
        readFile: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
      };
    });

    const result = await transcribeAudio('/tmp/test.ogg', { apiKey: 'sk-test-key' });
    expect('text' in result).toBe(true);
    if ('text' in result) {
      expect(result.text).toBe('hello world');
      expect(result.durationSec).toBe(3.5);
    }
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns error on API failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    vi.mock('node:fs/promises', async (importOriginal) => {
      const orig = await importOriginal() as any;
      return {
        ...orig,
        readFile: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
      };
    });

    const result = await transcribeAudio('/tmp/test.ogg', { apiKey: 'sk-bad' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('401');
      expect(result.error).toContain('Unauthorized');
    }
  });

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', mockFetch);

    vi.mock('node:fs/promises', async (importOriginal) => {
      const orig = await importOriginal() as any;
      return {
        ...orig,
        readFile: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
      };
    });

    const result = await transcribeAudio('/tmp/test.ogg', { apiKey: 'sk-test' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('network down');
    }
  });
});
