// Scrub secrets from outbound notifications before they hit Telegram, AND
// from any console.error / stderr write before launchd captures it to log.
//
// We deliberately DON'T anchor with `\b` on the left side because the most
// dangerous leak shape — `https://api.telegram.org/bot<token>/getUpdates` —
// has the token glued to the literal `bot` prefix, and `\b` between `t` and
// a digit doesn't fire (both are word chars). The token format itself
// (numeric:35-base64) is specific enough that false positives are negligible.
const TG_TOKEN = /\d{6,12}:[A-Za-z0-9_-]{35}/g;
const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]{10,}/g;
const BEARER = /(Bearer|bearer)\s+[A-Za-z0-9._\-]+/g;
// Match OpenAI's sk-... style — anchor with non-word lookbehind so we don't
// chew into other `sk-…` words.
const OPENAI_KEY = /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/g;
const GH_TOKEN = /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g;

export function scrubSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(TG_TOKEN, '[REDACTED-TG]')
    .replace(ANTHROPIC_KEY, '[REDACTED-ANTHROPIC]')
    .replace(OPENAI_KEY, '[REDACTED-OPENAI]')
    .replace(GH_TOKEN, '[REDACTED-GH]')
    .replace(BEARER, '[REDACTED-BEARER]');
}
