// Scrub secrets from outbound notifications before they hit Telegram.
const TG_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g;
const BEARER = /\b(Bearer|bearer)\s+[A-Za-z0-9._\-]+/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9]{20,}\b/g;
const GH_TOKEN = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g;

export function scrubSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(TG_TOKEN, '[REDACTED-TG]')
    .replace(ANTHROPIC_KEY, '[REDACTED-ANTHROPIC]')
    .replace(OPENAI_KEY, '[REDACTED-OPENAI]')
    .replace(GH_TOKEN, '[REDACTED-GH]')
    .replace(BEARER, '[REDACTED-BEARER]');
}
