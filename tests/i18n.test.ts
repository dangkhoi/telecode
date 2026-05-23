/**
 * Phase 1 i18n — runtime + store helpers.
 *
 * Covers:
 *  - VI catalog has every EN key (parity gate so future PRs that add an EN
 *    key without a VI translation get caught at test time, not in prod).
 *  - `tStatic` renders both locales + applies `{var}` interpolation.
 *  - `createI18n` resolves per-chat language from store, caches, and
 *    invalidates on `setLanguage`.
 *  - Missing keys fall back to EN with a WARN (defensive — should be
 *    unreachable thanks to compile-time gating).
 *  - SessionStore `getChatLanguage` / `setChatLanguage`:
 *     - default 'en' for chats with NO row;
 *     - roundtrip persists; ON CONFLICT updates existing row;
 *     - pre-i18n migration backfills `'vi'` for chats that already had a
 *       chat_settings row before the language column existed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SessionStore } from '../src/session/store.js';
import {
  createI18n,
  tStatic,
  isLanguage,
  DEFAULT_LANGUAGE,
  type Language,
  type I18nStore,
} from '../src/i18n/index.js';
import { EN_MESSAGES } from '../src/i18n/messages/en.js';
import { VI_MESSAGES } from '../src/i18n/messages/vi.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telecode-i18n-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newDbPath(name = 's.db'): string {
  return join(tmpDir, name);
}

// ---------------------------------------------------------------------------
// Catalog parity
// ---------------------------------------------------------------------------

describe('i18n catalogs', () => {
  it('VI catalog has every EN key', () => {
    const enKeys = Object.keys(EN_MESSAGES).sort();
    const viKeys = Object.keys(VI_MESSAGES).sort();
    expect(viKeys).toEqual(enKeys);
  });

  it('VI catalog values are non-empty strings', () => {
    for (const [key, value] of Object.entries(VI_MESSAGES)) {
      expect(typeof value, `${key} should be string`).toBe('string');
      expect(value.length, `${key} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('every EN value with {placeholder} has the same placeholders in VI', () => {
    for (const key of Object.keys(EN_MESSAGES) as (keyof typeof EN_MESSAGES)[]) {
      const en = EN_MESSAGES[key];
      const vi = VI_MESSAGES[key];
      const enVars = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const viVars = [...vi.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(viVars, `vars mismatch for ${key}`).toEqual(enVars);
    }
  });
});

// ---------------------------------------------------------------------------
// tStatic + interpolation
// ---------------------------------------------------------------------------

describe('tStatic', () => {
  it('renders EN by default', () => {
    expect(tStatic('en', 'start.welcome.title')).toBe('👋 *Telecode* online');
  });

  it('renders VI when requested', () => {
    expect(tStatic('vi', 'start.welcome.title')).toBe('👋 *Telecode* đã online');
  });

  it('interpolates {placeholder} vars', () => {
    expect(tStatic('en', 'start.activeSession', { label: 'foo' })).toBe('Active: `foo`');
    expect(tStatic('vi', 'start.sessionsCount', { count: 3 })).toBe('Sessions: 3');
  });

  it('leaves missing vars as {key} so the gap is visible', () => {
    expect(tStatic('en', 'start.activeSession')).toBe('Active: `{label}`');
  });
});

describe('isLanguage', () => {
  it('accepts en + vi only', () => {
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('vi')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage('')).toBe(false);
    expect(isLanguage(null)).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createI18n with mock store
// ---------------------------------------------------------------------------

function mockStore(initial: Record<number, Language> = {}): {
  store: I18nStore;
  reads: number[];
  writes: Array<[number, Language]>;
} {
  const data = new Map<number, Language>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const reads: number[] = [];
  const writes: Array<[number, Language]> = [];
  return {
    reads,
    writes,
    store: {
      getChatLanguage(chatId: number) {
        reads.push(chatId);
        return data.get(chatId) ?? 'en';
      },
      setChatLanguage(chatId: number, language: Language) {
        writes.push([chatId, language]);
        data.set(chatId, language);
      },
    },
  };
}

describe('createI18n', () => {
  it('resolves t(chatId, key) using the chat language', () => {
    const m = mockStore({ 1: 'vi', 2: 'en' });
    const i18n = createI18n({ store: m.store });
    expect(i18n.t(1, 'start.welcome.title')).toBe('👋 *Telecode* đã online');
    expect(i18n.t(2, 'start.welcome.title')).toBe('👋 *Telecode* online');
  });

  it('caches per-chat language (one read per chat)', () => {
    const m = mockStore({ 7: 'vi' });
    const i18n = createI18n({ store: m.store });
    i18n.t(7, 'start.welcome.title');
    i18n.t(7, 'start.commandsHint');
    i18n.t(7, 'language.changed');
    expect(m.reads).toEqual([7]); // only first call hit the store
  });

  it('setLanguage writes to store + updates cache', () => {
    const m = mockStore({ 5: 'en' });
    const i18n = createI18n({ store: m.store });
    expect(i18n.t(5, 'language.changed')).toBe('✅ Language set to *English*.');
    i18n.setLanguage(5, 'vi');
    expect(m.writes).toEqual([[5, 'vi']]);
    // Subsequent t() must reflect the new language WITHOUT another store read.
    const readsBefore = m.reads.length;
    expect(i18n.t(5, 'language.changed')).toBe('✅ Đã đặt ngôn ngữ thành *Tiếng Việt*.');
    expect(m.reads.length).toBe(readsBefore);
  });

  it('invalidate forces a re-read on next t()', () => {
    const m = mockStore({ 9: 'en' });
    const i18n = createI18n({ store: m.store });
    i18n.t(9, 'start.welcome.title');
    expect(m.reads.length).toBe(1);
    i18n.invalidate(9);
    i18n.t(9, 'start.welcome.title');
    expect(m.reads.length).toBe(2);
  });

  it('falls back to DEFAULT_LANGUAGE when chatId is null', () => {
    const m = mockStore();
    const i18n = createI18n({ store: m.store });
    expect(i18n.t(null, 'start.welcome.title')).toBe(EN_MESSAGES['start.welcome.title']);
    expect(m.reads).toEqual([]); // no chat lookup
    expect(DEFAULT_LANGUAGE).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// SessionStore.getChatLanguage / setChatLanguage
// ---------------------------------------------------------------------------

describe('SessionStore — language column', () => {
  it('fresh DB has chat_settings.language column with default en', () => {
    const path = newDbPath();
    const store = new SessionStore(path);
    try {
      const cols = store.db.prepare(`PRAGMA table_info(chat_settings)`).all() as {
        name: string;
        dflt_value: string | null;
      }[];
      const langCol = cols.find((c) => c.name === 'language');
      expect(langCol).toBeDefined();
      // SQLite stores the default literally including the surrounding quotes.
      expect(langCol!.dflt_value).toBe(`'en'`);
    } finally {
      store.close();
    }
  });

  it('getChatLanguage returns en for chats without a row', () => {
    const path = newDbPath();
    const store = new SessionStore(path);
    try {
      expect(store.getChatLanguage(1234)).toBe('en');
    } finally {
      store.close();
    }
  });

  it('setChatLanguage inserts then updates idempotently', () => {
    const path = newDbPath();
    const store = new SessionStore(path);
    try {
      store.setChatLanguage(42, 'vi');
      expect(store.getChatLanguage(42)).toBe('vi');
      expect(store.chatSettingsExists(42)).toBe(true);
      store.setChatLanguage(42, 'en');
      expect(store.getChatLanguage(42)).toBe('en');
      // setChatLanguage with a row that already exists must NOT clobber
      // default_mode (it should ON CONFLICT only update language).
      store.setChatDefaultMode(42, 'verbose');
      store.setChatLanguage(42, 'vi');
      expect(store.getChatDefaultMode(42)).toBe('verbose');
      expect(store.getChatLanguage(42)).toBe('vi');
    } finally {
      store.close();
    }
  });

  it('migration backfills pre-i18n rows to vi', () => {
    // Hand-craft a v1.1-shape DB (chat_settings without `language` column),
    // insert a row, then re-open via SessionStore which runs the migration.
    const path = newDbPath();
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE chat_settings (
        chat_id INTEGER PRIMARY KEY,
        default_mode TEXT NOT NULL DEFAULT 'summary'
      );
    `);
    raw.prepare(`INSERT INTO chat_settings (chat_id, default_mode) VALUES (?, ?)`).run(
      999,
      'normal',
    );
    raw.close();

    const store = new SessionStore(path);
    try {
      // Migration ran; existing row backfilled to 'vi'.
      expect(store.getChatLanguage(999)).toBe('vi');
      // default_mode preserved.
      expect(store.getChatDefaultMode(999)).toBe('normal');
    } finally {
      store.close();
    }
  });

  it('unknown language values in the DB fall back to en defensively', () => {
    const path = newDbPath();
    const store = new SessionStore(path);
    try {
      store.db
        .prepare(
          `INSERT INTO chat_settings (chat_id, default_mode, language) VALUES (?, 'summary', ?)`,
        )
        .run(7, 'fr');
      expect(store.getChatLanguage(7)).toBe('en');
    } finally {
      store.close();
    }
  });
});
