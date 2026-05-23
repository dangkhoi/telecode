/**
 * English message catalog. The KEYS in this file form the source of truth
 * for the i18n type system — `MessageKey = keyof typeof EN_MESSAGES`. Every
 * other locale catalog (vi, …) must implement the SAME keys, enforced at
 * compile time via the `MessageCatalog` type in `../index.ts`.
 *
 * Conventions:
 *   - Keys are dotted, namespaced by feature (`start.*`, `language.*`).
 *   - Values may contain `{var}` placeholders interpolated by `t()` via the
 *     `vars` parameter — see {@link interpolate} in `../index.ts`.
 *   - Telegram Markdown is allowed; callers pass `parse_mode: 'Markdown'`
 *     where appropriate. Keep emoji + asterisks in BOTH catalogs so the
 *     visual layout matches across locales.
 */
export const EN_MESSAGES = {
  // ---- /start welcome ---------------------------------------------------
  'start.welcome.title': '👋 *Telecode* online',
  'start.activeSession': 'Active: `{label}`',
  'start.noActiveSession': 'Active: (none — `/session new`)',
  'start.sessionsCount': 'Sessions: {count}',
  'start.commandsHint':
    'Commands: `/session`, `/projects`, `/cd`, `/stop`, `/status`, `/allow`, `/deny`, `/screenshot`',

  // ---- Language picker (first-boot + /language) -------------------------
  'language.picker.prompt':
    '🌐 *Choose your language* / *Chọn ngôn ngữ*\n\nThis affects bot messages only. You can change it any time via `/language`.',
  'language.picker.button.en': '🇬🇧 English',
  'language.picker.button.vi': '🇻🇳 Tiếng Việt',
  'language.changed': '✅ Language set to *English*.',
  'language.current': 'Current language: *English* (`en`).\nUse `/language` and pick to change.',
  'language.invalid': 'Unknown language `{value}`. Use the buttons above.',

  // ---- v1.1 verbosity migration note (sent after language pick) ---------
  'verbosity.migrationNote':
    '📢 *Telecode v1.1* — verbosity modes\n\n' +
    'Default mode is now 🎯 *Summary* — only approval, done, and errors are shown.\n\n' +
    'Want the old verbose firehose:\n' +
    '  • `/mode verbose`           — applies to the active session only\n' +
    '  • `/settings mode verbose`  — sets the chat default\n\n' +
    'Switch any time via the slash menu (`/mode`, `/settings`).',
};

/**
 * Catalog shape derived from the EN baseline. Every locale catalog must
 * implement this shape (TS enforces this in `vi.ts` via the type annotation).
 * Values are widened to `string` so non-EN translations don't have to match
 * the EN literal — that would defeat the purpose of translation.
 */
export type EnMessages = Record<keyof typeof EN_MESSAGES, string>;
