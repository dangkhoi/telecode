# Stage 2 Complete

## Files Created
- `tests/file-sharing.test.ts` — 7 tests
- `tests/session-search.test.ts` — 13 tests

## Files Modified
- `src/bot/attachments.ts` — added sendFileToChat(), MinimalBotForSend interface, image detection
- `src/bot/commands-registry.ts` — added 'send' and 'history' commands (now 19 total)
- `src/bot/commands/index.ts` — added /send and /history command handlers
- `src/session/schema.sql` — added session_fts FTS5 virtual table
- `src/session/store.ts` — added updateSearchIndex, searchSessions, getRecentSessions methods + FTS5 migration + backfill
- `tests/commands-registry.test.ts` — updated expected count

## FTS5 Table
- Name: `session_fts`
- Indexed columns: session_id (UNINDEXED), label, transcript
- Tokenizer: unicode61
- Regular FTS5 (not contentless) to support snippet() function
- Auto-backfills existing sessions on first boot

## File Sharing
- Supported outbound: all file types (sendDocument), images auto-detected for sendPhoto
- Image extensions: .jpg, .jpeg, .png, .gif, .webp
- Max size: 50MB (Telegram Bot API limit)
- Security: path traversal prevention (files must be within project root)
- Inbound: already existed (all extensions in DEFAULT_ALLOWED_EXTS, max 20MB configurable)

## Test Count
- 72 test files, 854 tests passed (was 70 files / 834 tests)
