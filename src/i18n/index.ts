/**
 * i18n surface for telecode (Phase 1 — foundation).
 *
 * Design:
 *   - Two locale catalogs (`en`, `vi`) live under `./messages/`. EN is the
 *     SOURCE OF TRUTH — its keys define the {@link MessageKey} union; every
 *     other catalog must satisfy the same shape (enforced at compile time
 *     via `EnMessages` import in vi.ts).
 *   - Per-chat language is persisted in `chat_settings.language` (TEXT,
 *     'en' | 'vi'). Lookup goes through the SessionStore handle injected
 *     into {@link createI18n}; we keep i18n DECOUPLED from a global store
 *     singleton so the test suite can wire a mock without monkey-patching.
 *   - `t(chatId, key, vars?)` is synchronous. SQLite reads are O(µs) on the
 *     local WAL DB — well below the threshold where caching pays off; we
 *     memoise per-chat lookups inside this module so the hot path (e.g. a
 *     long stream of `ctx.reply` calls) skips the prepared-statement spawn
 *     beyond the first hit. Cache is invalidated on `setChatLanguage`.
 *   - Fallback chain: per-chat language → 'en'. If the resolved catalog is
 *     missing the requested key (defensive — should not happen given the
 *     compile-time gate), we fall back to the EN catalog and log WARN so
 *     CI noise surfaces stale catalogs.
 *
 * Usage from a command handler:
 *   const i18n = createI18n({ store });
 *   await ctx.reply(i18n.t(chatId, 'start.welcome.title'), {
 *     parse_mode: 'Markdown',
 *   });
 */
import { EN_MESSAGES, type EnMessages } from './messages/en.js';
import { VI_MESSAGES } from './messages/vi.js';
import { logger } from '../util/logger.js';

/**
 * The compile-time set of all valid message keys, derived from the EN
 * catalog. Adding a new key requires editing `messages/en.ts` first; TS
 * then forces every other locale catalog to add the matching key.
 */
export type MessageKey = keyof EnMessages;

/** All locales the daemon ships with. Open-set; add a new file under `messages/` and extend this. */
export type Language = 'en' | 'vi';

/** Default fallback when nothing else resolves. EN per `language` config. */
export const DEFAULT_LANGUAGE: Language = 'en';

/** A locale catalog — same shape as the EN baseline. */
export type MessageCatalog = EnMessages;

/** Map of locale code → catalog. Single source of truth for the runtime lookup. */
const CATALOGS: Record<Language, MessageCatalog> = {
  en: EN_MESSAGES,
  vi: VI_MESSAGES,
};

/** Type-guard for a runtime string → {@link Language}. */
export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'vi';
}

/**
 * Subset of {@link import('../session/store.js').SessionStore} this module
 * needs. Declared as a structural interface so test code can pass a stub
 * without instantiating SQLite.
 */
export interface I18nStore {
  getChatLanguage(chatId: number): Language;
  setChatLanguage(chatId: number, language: Language): void;
}

/**
 * Replace `{var}` placeholders in `template` with values from `vars`.
 * Missing keys are left intact (rendered as `{key}`) — easier to spot in
 * production than silent empty strings.
 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined ? match : String(v);
  });
}

/**
 * Public i18n handle. Owns a per-chat language cache so repeated `t()` calls
 * during a stream of replies hit memory, not SQLite.
 */
export interface I18n {
  /** Resolve the language for a chat (cached). */
  language(chatId: number): Language;
  /**
   * Render a message in the chat's language. `vars` substitutes
   * `{placeholder}` tokens. If `chatId` is unknown / `null` (rare — only
   * for system contexts), uses {@link DEFAULT_LANGUAGE}.
   */
  t(chatId: number | null, key: MessageKey, vars?: Record<string, string | number>): string;
  /**
   * Persist the chat's language and invalidate the cache. Idempotent.
   */
  setLanguage(chatId: number, language: Language): void;
  /**
   * Force a cache miss for a single chat. Useful when the chat_settings
   * row was deleted out of band (tests, manual SQL).
   */
  invalidate(chatId: number): void;
}

/**
 * Build an i18n handle bound to a SessionStore. Tests typically construct
 * one per case to avoid cache leakage between assertions.
 */
export function createI18n(opts: { store: I18nStore }): I18n {
  const cache = new Map<number, Language>();

  function language(chatId: number): Language {
    const cached = cache.get(chatId);
    if (cached) return cached;
    const lang = opts.store.getChatLanguage(chatId);
    cache.set(chatId, lang);
    return lang;
  }

  return {
    language,
    t(chatId, key, vars) {
      const lang = chatId == null ? DEFAULT_LANGUAGE : language(chatId);
      const catalog = CATALOGS[lang];
      let template = catalog[key];
      if (template === undefined) {
        // Defensive: should be unreachable thanks to compile-time gating,
        // but a future plugin loading a custom catalog could trip this.
        logger.warn({ key, lang }, 'i18n: missing key, falling back to en');
        template = CATALOGS.en[key];
        if (template === undefined) {
          // Truly missing — return the key itself so it's visible in chat.
          return key;
        }
      }
      return interpolate(template, vars);
    },
    setLanguage(chatId, lang) {
      opts.store.setChatLanguage(chatId, lang);
      cache.set(chatId, lang);
    },
    invalidate(chatId) {
      cache.delete(chatId);
    },
  };
}

/** Test seam: render directly without a chat context (uses DEFAULT_LANGUAGE). */
export function tStatic(
  language: Language,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = CATALOGS[language][key] ?? CATALOGS.en[key];
  return interpolate(template, vars);
}
