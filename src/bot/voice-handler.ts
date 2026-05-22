import path from 'node:path';
import { logger } from '../util/logger.js';

export interface TranscribeOpts {
  apiKey: string | undefined;
  model?: string;
}

export interface TranscribeResult {
  text: string;
  durationSec?: number;
}

/**
 * Transcribe an audio buffer using OpenAI Whisper API (Node 22 native fetch + FormData).
 */
export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOpts,
): Promise<TranscribeResult | { error: string }> {
  if (!opts.apiKey) {
    return { error: '🎵 Voice-to-prompt chưa được cấu hình. Thêm OPENAI_API_KEY vào .env.' };
  }
  const model = opts.model ?? 'whisper-1';
  try {
    const { readFile } = await import('node:fs/promises');
    const fileBuffer = await readFile(audioPath);
    const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
    const formData = new FormData();
    formData.append('file', blob, path.basename(audioPath));
    formData.append('model', model);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: formData,
    });
    if (!response.ok) {
      const errText = await response.text();
      return { error: `🎵 Whisper API lỗi (${response.status}): ${errText.slice(0, 200)}` };
    }
    const data = (await response.json()) as { text: string; duration?: number };
    return { text: data.text, durationSec: data.duration };
  } catch (err) {
    logger.warn({ err: String(err) }, 'whisper transcription failed');
    return { error: `🎵 Transcription thất bại: ${String(err).slice(0, 200)}` };
  }
}
