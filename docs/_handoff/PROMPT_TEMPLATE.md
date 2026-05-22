# Prompt Template: Large Plan Execution

> Include template này vào prompt khi cần execute 1 plan lớn (>7 deliverables hoặc có dependency chain).
> Output: file `.md` tại `docs/_handoff/` chứa prompt cho orchestrator chạy.

---

## Workflow Principles (from steering/workflow.md)

Mọi execution prompt PHẢI tuân thủ các nguyên tắc sau. Đây là **bắt buộc**, không phải gợi ý.

### W1. Technology Validation (Context7) — trước khi code

Mỗi stage PHẢI có bước Context7 validation:
- Dùng `resolve-library-id` + `query-docs` để xác nhận version mới nhất của mỗi dependency
- Kiểm tra API đang dùng có bị deprecated không, có API mới hơn/tốt hơn không
- **Ưu tiên latest stable API** — không chấp nhận deprecated patterns trong code mới
- Ghi kết quả verify vào SDD (docs/design/)

### W2. Design Document (SDD) — song song với code

- Tạo 1 file HTML tại `docs/design/{feature-name}.html` (Apple 2026 style, inline CSS, light/dark)
- Sections: Context, Requirements, Design Decisions, File Changes, Verification
- SDD được viết **cùng lúc** với code trong cùng stage, KHÔNG phải trước code
- Mỗi sub-agent ghi section riêng vào SDD

### W3. Scope Completeness Check — bắt buộc cuối mỗi stage

Trước khi tuyên bố stage done:
1. Đọc lại plan document — liệt kê TỪNG deliverable của stage
2. Check từng item: ✅ Done (code + test + wired) hoặc ❌ Missing
3. Nếu có ❌ → implement tiếp ngay, KHÔNG proceed sang stage sau
4. Đặc biệt kiểm tra: UI wiring, E2E flow thật (không chỉ unit test pass), placeholder/stub phải wire thật

### W4. Senior Review — bắt buộc ở stage cuối

Stage cuối PHẢI include senior review sub-agent:
- Role: Senior architect, model cao nhất available
- Review criteria: correctness, cross-platform, consistency, error handling, scope completeness, **technology freshness**
- Reviewer **tự patch** issues (không chỉ report). Tag severity [P0]–[P3]
- **Review loop**: patch → rerun tests → rerun review → lặp cho đến 0 findings
- **Tech freshness check**: dùng Context7 verify mỗi dependency chính (version latest? API deprecated?)
- Verdict: APPROVED chỉ khi 0 P0–P1 remaining + 100% scope covered

### W5. Security Scan — trước mọi commit/push

Trước khi commit/push kết quả:
- Scan diff cho secrets/credentials/PII/private-keys/internal-infra leaks
- Pattern-based (regex) + semantic-based (LLM judgment)
- [BLOCK] → không commit. [WARN] → báo user. [INFO] → proceed
- **Không có exception** — kể cả docs-only, single-line fix

### W6. Stay On Track

- Luôn đọc lại plan trước khi code mỗi stage
- Không đi xa khỏi scope — nếu cần thay đổi ngoài scope → ghi vào handoff file, báo user
- Mỗi file change phải trace được về deliverable nào trong plan

---

## Instructions cho AI

Khi nhận prompt có include template này, thực hiện:

1. **Đọc plan document** được chỉ định
2. **Phân tích dependencies** giữa các deliverables
3. **Tách thành stages** theo rules bên dưới (inject W1–W6 vào mỗi stage)
4. **Tạo file prompt** tại `docs/_handoff/{feature-name}.md` — file này CHỈ chứa prompt text, không chứa code
5. **KHÔNG implement** — chỉ tạo prompt file. User sẽ chạy prompt đó sau.

---

## Rules tách stage

| Rule | Giải thích |
|------|-----------|
| ≤ 5 deliverables / sub-agent | Quá 5 → context overflow, agent không hoàn thành |
| ≤ 2 sub-agents / stage | Parallel trong stage OK, nhưng quá nhiều agents → context của orchestrator bị đầy |
| Dependency → tách stage | Nếu D7 depends on D6 → D6 ở stage trước, D7 ở stage sau |
| Mỗi stage có exit gate | Điều kiện verify được bằng command (test/grep/build/curl), không cần human judgment |
| Handoff file giữa stages | Stage N ghi `docs/_handoff/stage-N-done.md`, Stage N+1 đọc file đó |

---

## Format của prompt file output

```markdown
# [Feature Name] — Execution Prompt

> Auto-generated from plan: [path to plan]
> Stages: [N] | Total deliverables: [M]

## TASK
[1–2 câu từ plan]

## WORKING DIR
`[absolute path]`

## CONTEXT (≤ 5 dòng)
[Chỉ info cần để code — không giải thích history/background dài]

## CONSTRAINTS
[Copy từ plan — conventions, backward compat, test requirements]

## EXECUTION — [N]-STAGE CHAIN

> ⚠️ Đây là orchestrator prompt. Không implement trực tiếp.
> Chạy từng stage tuần tự. Mỗi stage = 1 sub-agent DAG blocking.

---

### Stage 1: [Tên ngắn]
**Sub-agents**: [số] parallel
- Agent 1 ([role]): [D1, D2, ...] — [mô tả 1 dòng]
- Agent 2 ([role]): [D3, D4, ...] — [mô tả 1 dòng]

**Context7 validation** (mỗi agent tự chạy trước khi code):
- `resolve-library-id` + `query-docs` cho mỗi dependency chính
- Verify latest API, không dùng deprecated patterns
- Ghi kết quả vào SDD

**SDD**: Ghi design decisions vào `docs/design/{feature-name}.html` (song song với code)

**Key files to read** (agent tự đọc, không paste vào prompt):
- `path/to/relevant/file1`
- `path/to/relevant/file2`

**Exit gate** (verify ALL trước khi sang stage sau):
- [ ] [điều kiện verify bằng command]
- [ ] [điều kiện verify bằng command]
- [ ] All tests pass
- [ ] Scope completeness: mọi deliverable của stage = ✅ (code + test + wired)

**Handoff**: Ghi vào `docs/_handoff/stage-1-done.md`:
- Files created/modified (list paths)
- API contracts confirmed (endpoints + response shape)
- Test count after stage
- Context7 versions verified

---

### Stage 2: [Tên ngắn]
**Reads**: `docs/_handoff/stage-1-done.md`
**Assumes done** (không re-implement):
- [bullet list những gì Stage 1 đã làm]

**Sub-agents**: [số] parallel
- Agent 1 ([role]): [D5, D6, ...] — [mô tả 1 dòng]

**Key files to read**:
- `path/to/file`

**Exit gate**:
- [ ] [điều kiện]
- [ ] All tests pass

**Handoff**: `docs/_handoff/stage-2-done.md`

---

### Stage N: [Tên] + Senior Review + Security Scan
**Reads**: `docs/_handoff/stage-{N-1}-done.md`
...

**Sub-agents**: [số] parallel + 1 senior reviewer

**Senior Review** (bắt buộc — spawn riêng 1 sub-agent):
```
TASK: Senior review + patch + scope completeness + technology freshness
ROLE: Senior architect / code reviewer
FILES TO REVIEW: [all files changed across ALL stages]
PLAN DOCUMENT: [path to plan HTML file]
SDD: docs/design/{feature-name}.html
WORKING DIR: [workspace path]
REQUIREMENTS:
1. Read PLAN DOCUMENT — list every deliverable/exit criteria
2. Read all changed files across all stages
3. For each deliverable: verify code exists, is wired, has test, user can use it
4. Identify bugs, edge cases, cross-platform issues, missing error handling
5. Fix each issue directly. Tag severity [P0]–[P3]
6. If scope gaps: implement missing pieces or report SCOPE GAP clearly
7. Context7: verify each major dependency (latest version? deprecated API?)
8. Run tests after fixes. If code changed → rerun review (loop until 0 P0–P1)
9. Report: scope checklist, tech freshness table, issues+severity, fixes, test results
DO NOT: Add features beyond plan scope, refactor beyond scope
```

**Security Scan** (bắt buộc trước commit):
- Scan toàn bộ diff (all stages combined) cho secrets/PII/credentials
- Pattern-based + semantic-based detection
- [BLOCK] → không commit, báo user. [WARN] → confirm. [INFO] → proceed

**Exit gate**:
- [ ] [điều kiện cuối]
- [ ] All tests pass
- [ ] Senior review: 0 P0–P1 findings remaining
- [ ] Tech freshness: no deprecated APIs in new code
- [ ] Security scan: CLEAN or NEEDS_CONFIRMATION (no BLOCK)
- [ ] SDD complete at docs/design/{feature-name}.html

---

## ORCHESTRATOR INSTRUCTIONS

1. **Đọc lại plan document** trước khi bắt đầu (W6 — stay on track)
2. Chạy Stage 1 bằng `subagent` tool (blocking mode, role: kiro_default)
3. Sau khi sub-agents return → verify exit gate (chạy test/grep/build trực tiếp)
4. **Scope check** (W3): đọc plan, verify từng deliverable của stage = ✅
5. Nếu exit gate PASS → ghi handoff file → proceed Stage 2
6. Nếu exit gate FAIL → fix ngay trong context hiện tại, re-verify, KHÔNG skip
7. Lặp cho đến hết stages
8. Stage cuối: include senior review + tech freshness + security scan (W4, W5)
9. Final verify: check ALL exit criteria từ plan document gốc
10. **Commit**: chạy security scan trước commit (W5). BLOCK nếu có secrets.

## ERROR RECOVERY
- Sub-agent fail / partial output → đọc output, identify missing items, re-run stage với scope thu hẹp
- Context approaching limit → ghi progress vào handoff file, báo user resume point
- Test fail sau stage → fix trong stage đó trước khi proceed
- Context7 unavailable → proceed with best-known version, flag in SDD as "unverified"
- Senior review finds P0/P1 → fix immediately, rerun tests, rerun review (loop)

## FINAL EXIT CRITERIA
[Copy nguyên văn từ plan document — đây là source of truth]

**Workflow gates (bắt buộc thêm vào exit criteria):**
- [ ] SDD exists at `docs/design/{feature-name}.html` — complete, not placeholder
- [ ] Context7 tech freshness verified — no deprecated APIs in new code
- [ ] Senior review verdict: APPROVED (0 P0–P1, scope 100%)
- [ ] Security scan: CLEAN (no [BLOCK] findings in final diff)
- [ ] All tests pass after senior review patches
```

---

## Platform-specific: Orchestrator Instructions

Template output sẽ có section `ORCHESTRATOR INSTRUCTIONS` khác nhau tuỳ platform.
Khi tạo prompt, AI chọn variant phù hợp dựa trên platform user đang dùng.

### Variant A: Kiro CLI (có sub-agent tool)

```markdown
## ORCHESTRATOR INSTRUCTIONS
1. Đọc lại plan document (W6 — stay on track)
2. Chạy Stage 1 bằng `subagent` tool (blocking mode, role: kiro_default)
   - Sub-agent prompt PHẢI include: "Dùng Context7 (resolve-library-id + query-docs) verify dependencies trước khi code"
3. Verify exit gate (chạy test/grep/build) + scope completeness check (W3)
4. PASS → ghi handoff file → proceed Stage 2
5. FAIL → fix trong context, re-verify, KHÔNG skip
6. Lặp cho đến hết stages
7. Stage cuối: senior review sub-agent (W4) + security scan (W5) trước commit
```

### Variant B: Cursor / Windsurf / Cline (có file access, không có sub-agent)

```markdown
## ORCHESTRATOR INSTRUCTIONS
1. Đọc lại plan document (W6 — stay on track)
2. Context7 validation: verify dependencies trước khi code (W1)
3. Implement Stage 1 trực tiếp (tất cả deliverables trong stage, parallel nếu independent)
4. Ghi design decisions vào SDD (W2): docs/design/{feature-name}.html
5. Sau khi xong → verify exit gate (run tests, grep, build) + scope check (W3)
6. PASS → tạo file `docs/_handoff/stage-1-done.md` ghi kết quả → proceed Stage 2
7. FAIL → fix trước khi proceed
8. ⚠️ Nếu context gần limit → DỪNG, ghi progress vào handoff file, báo user:
   "Stage [N] done. Resume bằng cách paste Stage [N+1] prompt trong session mới."
9. Stage cuối: self-review theo tiêu chí senior review (W4) + security scan diff (W5)
10. Lặp cho đến hết stages hoặc hết context
```

### Variant C: Claude API / ChatGPT / Manual (không có file access)

```markdown
## ORCHESTRATOR INSTRUCTIONS
> User tự làm orchestrator. AI chỉ implement 1 stage per session.

Cho mỗi session:
1. User paste: "Implement Stage [N]" + nội dung stage đó + handoff file từ stage trước
2. AI verify dependencies qua Context7 trước khi code (W1)
3. AI implement + output code (user tự apply vào codebase)
4. AI ghi design decisions (user paste vào SDD) (W2)
5. AI output scope checklist (✅/❌ per deliverable) (W3)
6. AI output handoff summary cuối session
7. User verify exit gate manually → paste handoff vào session tiếp theo
8. Session cuối: AI self-review theo senior review criteria (W4) + scan diff cho secrets (W5)
```

---

## Ví dụ cách dùng

### Kiro CLI
```
Đọc plan tại docs/plans/my-feature-plan.html và tạo execution prompt.

@include docs/_handoff/PROMPT_TEMPLATE.md
```

### Cursor / Windsurf
Mở file `docs/_handoff/PROMPT_TEMPLATE.md` trong context, rồi prompt:
```
Đọc plan tại docs/plans/my-feature-plan.html và tạo execution prompt.
Dùng Variant B (no sub-agent).
```

### Claude / ChatGPT (manual)
Copy nội dung template vào system prompt hoặc đầu conversation, rồi:
```
Đọc plan (paste nội dung plan vào đây) và tạo execution prompt.
Dùng Variant C (manual orchestration).
```

---

AI sẽ:
1. Đọc plan
2. Tách stages theo rules
3. Tạo `docs/_handoff/{feature-name}.md` chứa prompt (hoặc output trực tiếp nếu không có file access)
4. User review prompt → chạy trong session mới (hoặc cùng session nếu scope đủ nhỏ)
