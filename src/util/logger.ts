import { mkdirSync } from 'node:fs';
import pino from 'pino';
import { LOG_DIR } from './paths.js';

mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

const transport = pino.transport({
  targets: [
    {
      target: 'pino-roll',
      level: 'info',
      options: {
        file: `${LOG_DIR}/telecode.log`,
        frequency: 'daily',
        size: '50m',
        limit: { count: 7 },
        mkdir: true,
      },
    },
    {
      target: 'pino/file',
      level: 'info',
      options: { destination: 1 },
    },
  ],
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'bot_token',
        'telegram.bot_token',
        '*.bot_token',
        '*.token',
        'token',
        'Authorization',
        'authorization',
        'ANTHROPIC_API_KEY',
        '*.ANTHROPIC_API_KEY',
        'env.TELEGRAM_BOT_TOKEN',
        'env.ANTHROPIC_API_KEY',
      ],
      censor: '[REDACTED]',
    },
  },
  transport,
);
