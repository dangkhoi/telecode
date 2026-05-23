# Streaming UX Redesign — Execution Prompt

> Auto-generated from plan: docs/plans/telecode-v1.1-streaming-ux-redesign.html
> Stages: 4 | Total deliverables: 19

## TASK
Implement Telecode v1.1 Streaming UX Redesign: fix 2 real bugs, add friendly tool render, mode system (4 verbosity levels), smart rendering (MarkdownV2 + code-fence + collapse), agentic compression (AI summarize via session reinjection), và activity indicators (rolling progress message).

## WORKING DIR
`/Users/<you>/Documents/workspaces/telecode`

## CONTEXT
- Telecode = Telegram bot bridge cho AI coding agents (Claude, Codex, Cursor, Kiro)
- v1.0 streams MỌI event → firehose noise. v1.1 = summary-first + mode toggle + smart render + AI compress
- Existing test suite: 435 tests. All must pass after changes.
- DB: SQLite via better-sqlite3. Schema migration pattern: idempotent ALTER TABLE.
- Notifier hiện dùng plain text. Chuyển sang MarkdownV2 cho formatted messages.

## CONSTRAINTS
- Backward compat 100%: v1.0 user upgrade không break, existing config/sessions resume OK
- Mode verbose = preserve current v1.0 behavior exactly
- No new external dependencies cho AI summarize (reuse existing session/adapter)
- MarkdownV2 escape phải comprehensive — fallback to plain text on Telegram 400 error
- All new code có unit tests. Target ≥50 new test cases across all phases.
- Follow existing code style: TypeScript, pino logger, grammy bot framework

## EXECUTION — 4-STAGE CHAIN

> ⚠️ Đây là orchestrator prompt. Không implement trực tiếp.
> Chạy từng stage tuần tự. Mỗi stage = 1 sub-agent DAG blocking.

---

### Stage 1: Bug fixes + Quick wins (Phase A)
**Sub-agents**: 2 parallel
- Agent 1 (bug-fix): A.1 (fix duplicate Claude tool_use), A.2 (surface tool_result events), A.3 (strip ANSI Codex) — Fix 2 real bugs + add tool_result dispatch branch + extract shared stripAnsi util
- Agent 2 (render): A.4 (friendly tool render), A.5 (suggestion keyboard defer) — Create `src/bot/tool-render.ts` with renderToolUse + collapsePath, defer suggestion keyboard to tool_result

**Key files to read**:
- `src/agents/claude.ts` (lines 50-120 for canUseTool + PreToolUse)
- `src/agents/codex.ts` (lines 435-465 for tool_result + ANSI)
- `src/bot/commands/index.ts` (lines 850-900 for dispatch handler)
- `src/agents/cursor.ts` (lines 483-510 for tool_result emit)

**Exit gate** (verify ALL trước khi sang stage sau):
- [ ] `npx vitest run` — all existing 435 tests pass
- [ ] `grep -r "onEvent.*tool_use" src/agents/claude.ts` — chỉ 1 emit point (PreToolUse hook)
- [ ] `grep "case 'tool_result'" src/bot/commands/index.ts` — branch exists
- [ ] New test file `tests/claude-tool-use-dedup.test.ts` exists and passes
- [ ] New test file `tests/tool-render.test.ts` exists and passes
- [ ] `src/util/ansi.ts` exists (shared stripAnsi helper)

**Handoff**: Ghi vào `docs/_handoff/stage-1-done.md`:
- Files created/modified (list paths)
- tool_result dispatch format confirmed
- renderToolUse output format per tool name
- Test count after stage

---

### Stage 2: Mode system + Smart rendering (Phase B + C)
**Reads**: `docs/_handoff/stage-1-done.md`
**Assumes done** (không re-implement):
- tool_result dispatch branch working
- tool-render.ts with renderToolUse + collapsePath
- stripAnsi shared util

**Sub-agents**: 2 parallel
- Agent 1 (mode-system): B.1–B.5 — Define 4 modes, DB migration (sessions.verbosity_mode + chat_settings.default_mode), `/mode` command + inline keyboard, shouldEmit filter in dispatch, v1.1 first-boot announcement
- Agent 2 (smart-render): C.1–C.5 — Create `src/bot/markdown.ts` (escapeMd, codeBlock, inlineCode), `src/bot/code-fence.ts` (auto-detect JSON/diff/bash/stack), diff stats in tool-render, collapse repeated tools (5s window ring buffer + edit message), path collapsing

**Key files to read**:
- `src/session/store.ts` (schema migration pattern)
- `src/bot/commands/index.ts` (dispatch + command registration)
- `src/bot/router.ts` (callback handlers)
- `src/bot/notifier.ts` (current sendPlain pattern)
- `src/bot/commands-registry.ts` (command list)

**Exit gate**:
- [ ] `npx vitest run` — all tests pass (old + new)
- [ ] `/mode` command registered: `grep "mode" src/bot/commands-registry.ts`
- [ ] `src/session/verbosity.ts` exists with shouldEmit function
- [ ] `src/bot/markdown.ts` exists with escapeMd + codeBlock
- [ ] `src/bot/code-fence.ts` exists with detection heuristics
- [ ] DB migration adds verbosity_mode column: grep in store.ts
- [ ] Collapse window logic: grep "ringBuffer\|collapseWindow\|recentTools" in commands/index.ts or dedicated file
- [ ] New tests ≥20 cases for mode filter + markdown escape + code-fence detection

**Handoff**: `docs/_handoff/stage-2-done.md`
- Files created/modified
- Mode filter API: `shouldEmit(event, mode)` signature confirmed
- Markdown escape tested with adversarial inputs
- Collapse window behavior confirmed (5s, edit message)

---

### Stage 3: Agentic compression (Phase D)
**Reads**: `docs/_handoff/stage-2-done.md`
**Assumes done**:
- Mode system working (shouldEmit filter)
- MarkdownV2 rendering + code-fence detection
- Collapse window for repeated tools

**Sub-agents**: 1
- Agent 1 (agentic): D.1–D.5 — Create `src/agents/summarize.ts` (summarizeWithSession helper, 30s timeout, fallback), `src/bot/summary-cache.ts` (LRU Map, TTL 1h, max 100), auto-summarize long tool_result (>500 chars), on-demand `[💬 AI summary]` button callback, auto done-summary on `done` event, `[📜 Full output]` button

**Key files to read**:
- `src/session/manager.ts` (session inject pattern, look for /handoff implementation)
- `src/bot/commands/index.ts` (done event handler)
- `src/bot/router.ts` (callback registration pattern)
- `docs/_handoff/stage-2-done.md` (mode filter API)

**Exit gate**:
- [ ] `npx vitest run` — all tests pass
- [ ] `src/agents/summarize.ts` exists with summarizeWithSession function
- [ ] `src/bot/summary-cache.ts` exists with LRU cache (TTL + max entries)
- [ ] Callback `summarize:tool-result:` registered in router
- [ ] Done event handler calls summarize when mode = summary/normal
- [ ] Mutex per session for summarize calls: grep "mutex\|lock\|pending" in summarize.ts
- [ ] New tests ≥15 cases (summarize timeout, fallback, cache eviction, done-summary)

**Handoff**: `docs/_handoff/stage-3-done.md`
- Files created/modified
- summarizeWithSession API confirmed (params + return)
- Cache behavior: TTL, max entries, eviction
- Button callback format

---

### Stage 4: Activity indicators + Senior review (Phase E)
**Reads**: `docs/_handoff/stage-3-done.md`
**Assumes done**:
- Agentic compression working
- Mode system + smart rendering
- All Phase A–D features complete

**Sub-agents**: 1
- Agent 1 (progress + review): E.1–E.3 + Senior review — Create `src/bot/progress.ts` (rolling progress message lifecycle: create → edit → cleanup on done), surface status events (kiro_spawning, codex_turn_started, cursor_spawning, cursor_plan_update), idle ping (30s no output → "⏳ Working..."), then perform senior review of ALL phases

**Key files to read**:
- `src/bot/commands/index.ts` (status event handling, done handler)
- `src/bot/notifier.ts` (message edit API)
- `src/agents/claude.ts`, `src/agents/codex.ts`, `src/agents/kiro.ts`, `src/agents/cursor.ts` (status event emit points)
- All files from stages 1–3

**Exit gate**:
- [ ] `npx vitest run` — ALL tests pass (435 original + ≥50 new)
- [ ] `src/bot/progress.ts` exists with progress message lifecycle
- [ ] Status events surface in progress message: grep "kiro_spawning\|codex_turn_started" in progress.ts or commands/index.ts
- [ ] Idle ping timer: grep "idlePing\|idleTimer\|30.*000\|30_000" in progress.ts
- [ ] Senior review: 0 P0–P1 findings
- [ ] `npm run build` succeeds (TypeScript compile clean)
- [ ] README updated with mode system + new commands + v1.0→v1.1 migration

**Handoff**: `docs/_handoff/stage-4-done.md`
- All files created/modified across all stages
- Senior review findings (P2+ only, P0–P1 must be 0)
- Final test count
- Build status

---

## ORCHESTRATOR INSTRUCTIONS
1. Chạy Stage 1 bằng `subagent` tool (blocking mode, role: kiro_default)
2. Sau khi sub-agents return → verify exit gate (chạy test/grep/build trực tiếp)
3. Nếu exit gate PASS → ghi handoff file → proceed Stage 2
4. Nếu exit gate FAIL → fix ngay trong context hiện tại, re-verify, KHÔNG skip
5. Lặp cho đến hết stages
6. Stage cuối: include senior review trong sub-agent prompt (theo workflow §5)
7. Final verify: check ALL exit criteria từ plan document gốc

## ERROR RECOVERY
- Sub-agent fail / partial output → đọc output, identify missing items, re-run stage với scope thu hẹp
- Context approaching limit → ghi progress vào handoff file, báo user resume point
- Test fail sau stage → fix trong stage đó trước khi proceed

## FINAL EXIT CRITERIA
- [ ] Duplicate Claude tool_use bug fixed (verified via test stub)
- [ ] tool_result events từ Codex + Cursor visible trong Telegram
- [ ] 4 modes (summary / normal / thinking / verbose) work end-to-end qua `/mode`
- [ ] AI summarize button render long output, tap → invoke session summarize
- [ ] Done event có auto-summary trong summary/normal modes
- [ ] Code-fence auto-wrap JSON / diff / bash output
- [ ] Path collapse `/Users/X/...` → `~/...`
- [ ] Repeated tool collapse trong 5s window
- [ ] Progress message edit-only cho status events trong summary mode
- [ ] Backward compat 100%: v1.0 user upgrade, existing config load OK, sessions resume OK
- [ ] All v1.0 tests (435) vẫn pass + new tests ≥50 cases mới
- [ ] Mode verbose = preserve current v1.0 behavior exactly
- [ ] Markdown escape comprehensive (test with adversarial inputs)
- [ ] README cập nhật mode system + new commands + migration guide
- [ ] `npm run build` clean (0 TypeScript errors)
- [ ] Senior review: 0 P0–P1 findings
