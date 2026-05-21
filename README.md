# Telecode

> Chat với Claude Code / Kiro / Codex / Cursor trên máy Mac / Linux / Windows của bạn qua Telegram. Vibecode mọi lúc mọi nơi.

Telecode là 1 local daemon chạy nền trên máy bạn, bắc cầu giữa Telegram và các coding agent CLI (**Claude Code**, **Kiro**, **Codex**, **Cursor**) đã cài sẵn. Bạn gửi prompt từ điện thoại → agent thực thi trên máy → kết quả stream về Telegram. Khi agent muốn chạy lệnh nguy hiểm, bạn nhận inline button approve/deny ngay trong chat.

**Tính năng**:
- 🧵 **Multi-session song song**: vd "Claude #1 refactor module A" + "Codex viết test cho module B" + "Cursor fix bug ở project khác", tất cả chạy parallel, không block lẫn nhau.
- 🤖 **4 agent CLI**, cùng UX: 🤖 Claude · ⚡ Kiro · 🅒 Codex · ✦ Cursor. Switch giữa agents trong cùng 1 chat. Adapter registry **open-set** — thêm agent mới (Gemini, Antigravity, …) chỉ cần 1 file + 1 dòng register.
- 🛡 **Approval an toàn**: policy engine + native approval của từng CLI (`canUseTool` Claude, `preToolUse` hook Kiro, `approvalPolicy` Codex, `session/request_permission` Cursor). Tool an toàn auto-allow + notify; tool nguy hiểm hỏi qua Telegram inline button **[Allow once] [Allow always] [📌 Forever] [Deny]**. Nút `📌 Forever` (2-step confirm) ghi rule vĩnh viễn vào `policy.yaml`.
- 📊 **Live dashboard**: `/dashboard` edit message mỗi 2s với snapshot sessions đang chạy, pending approvals, buffer sizes.
- 💡 **Follow-up suggestions**: sau mỗi tool result, bot gợi ý buttons hành động tiếp theo (Tiếp tục / Xem file / Run again / Rollback) theo heuristic.
- 👤 **Single-user**: chỉ Telegram user_id của bạn mới interact được.
- 🔄 **Resume session**: mỗi session có UUID riêng, context không mất khi bot restart.
- 🔐 **Secret-safe**: tự scrub Telegram token, Anthropic key, GitHub PAT, Bearer headers khỏi mọi log + outbound message. Per-boot HMAC token bảo vệ Kiro hook server khỏi same-user spoof. Daemon singleton lockfile chống race giữa dev + launchd / systemd / NSSM.
- 🌐 **Cross-platform native**: macOS (launchd), Linux (systemd `--user`), Windows 11 (NSSM service). Không cần WSL.

**Status**: **v1.1** — streaming UX redesign. 717 passing tests. Multi-version log:
- v0.4 — M0–M5 ship: core daemon + Claude adapter + multi-session + canUseTool.
- v0.5 — Kiro chuyển sang `kiro-cli` headless (stream stdout, resume by UUID).
- v0.6 — Kiro mid-session approval qua `preToolUse` hook bridge → cùng inline-button UX với Claude.
- v0.6.1 — P0 fix: scrub bot token khỏi raw stderr (grammY runner error path).
- v0.7 — Telegram UX widgets: slash-command menu, persistent reply keyboard (6 nút), Menu button, `/new` wizard, inline project picker, `/sessions` enhanced.
- v0.8 — Multi-session view discipline: chỉ session active stream live, background → RAM buffer; auto-switch on approval; catch-up flush; session strip; silent stream.
- **v1.0** — Cross-platform + multi-agent:
  - **T3 carry-over**: `🔀 Switch khác` / `📋 Tail logs` wizard success buttons wired thật; `📌 Forever` 2-step confirm; `/dashboard` live edit-loop; follow-up suggestions; wizard-aware auto-switch (defer khi đang trong wizard).
  - **Foundation refactor**: adapter registry open-set (`registry.register(kind, factory)`), `AgentKind = string` mở rộng tự do. Path portability sweep (`path.delimiter`, `path.isAbsolute`, `os.tmpdir()`).
  - **Linux**: `scripts/install-systemd.sh` (`--user` unit, `--dry-run`, atomic writes, lingering hint). `/screenshot` Linux qua `grim` / `gnome-screenshot` / `scrot`.
  - **Codex adapter**: OpenAI Codex CLI qua JSON-RPC app-server (`turn/start` với `approvalPolicy: unlessTrusted` + `sandboxPolicy.workspaceWrite`).
  - **Cursor adapter**: Cursor CLI qua ACP (`agent acp` JSON-RPC over stdio, `session/request_permission` routing).
  - **Windows 11**: `scripts/install-windows.ps1` (NSSM service, owner-only ACL, dry-run, env pre-fill, `SIGBREAK` graceful stop). `/screenshot` Windows qua PowerShell `[Screen]::PrimaryScreen`.
  - **Hardening**: per-boot 32-byte CSPRNG gate token (`Authorization: Bearer`), KiroHookServer drain (30s timeout), daemon singleton lockfile (`~/.telecode/daemon.lock`), `kiro-cli --list-sessions` per-cwd 30s cache.
- **v1.1** — Streaming UX redesign · 717 tests · backward compat 100% (verbose mode = byte-identical v1.0):
  - **4 verbosity modes** (`/mode`, `/settings`): 🎯 Summary (default) / 📝 Normal / 🧠 Thinking / 🔬 Verbose. Per-session + per-chat default. First-boot v1.1 message giải thích migration.
  - **Bug fixes**: duplicate Claude `tool_use` events (was emit 2× per tool), dropped `tool_result` events từ Codex/Cursor (silently invisible).
  - **Friendly tool rendering**: `Read · notifier.ts` thay `Read — {"file_path":"/Users/koi/..."}`. Path collapse (`~`, `./`, git-root). Diff stats trên Edit: `Edit · auth.ts (-3 +7)`.
  - **Smart rendering**: MarkdownV2 auto code-fence (JSON / diff / bash / stack trace), `[📜 Show diff]` clickable viewer, repeated tool collapse (5s window: `Read ×3 · foo.ts, bar.ts, baz.ts`).
  - **Agentic compression** (killer feature): reuse session để AI-summarize long output (>500 chars threshold). Auto done-summary: `Done · 47s · $0.023\nTách validateToken ra file riêng, thêm 5 tests, pass.`. On-demand `[💬 AI summary]` button. `[📜 Full output (200 lines)]` viewer.
  - **Activity indicators**: single rolling progress message per session (edit-only), surface adapter status events (`⏳ Codex thinking...`), idle ping ladder 30s → 1m → 2m → 5m+ cap.

---

## Mục lục

- [Yêu cầu máy](#yêu-cầu-máy)
- [Cài đặt từng bước](#cài-đặt-từng-bước)
  - [1. Clone repo](#1-clone-repo)
  - [2. Tạo Telegram bot riêng cho bạn](#2-tạo-telegram-bot-riêng-cho-bạn)
  - [3. Lấy Telegram user_id của bạn](#3-lấy-telegram-user_id-của-bạn)
  - [4. Chạy installer](#4-chạy-installer)
  - [5. Kiểm tra daemon chạy](#5-kiểm-tra-daemon-chạy)
- [Smoke test đầu tiên](#smoke-test-đầu-tiên)
- [Daily workflow](#daily-workflow)
- [Multi-session UX](#multi-session-ux)
- [Live dashboard](#live-dashboard)
- [Bảng lệnh đầy đủ](#bảng-lệnh-đầy-đủ)
- [Policy & Approval](#policy--approval)
- [Adapter registry — thêm agent mới](#adapter-registry--thêm-agent-mới)
- [Logs & debugging](#logs--debugging)
- [Troubleshooting](#troubleshooting)
- [Update Telecode](#update-telecode)
- [Uninstall](#uninstall)
- [Kiến trúc & tài liệu](#kiến-trúc--tài-liệu)
- [Known limitations](#known-limitations)

---

## Yêu cầu máy

| Thứ | Tối thiểu | Verify lệnh |
| --- | --- | --- |
| OS | macOS 13+ **hoặc** Linux (Ubuntu 24.04+ / Fedora 39+ / RHEL 9+, glibc 2.34+) **hoặc** Windows 11 | `uname -s` / `sw_vers -productVersion` / `ldd --version` / `winver` |
| Node.js | **22 LTS** | `node -v` |
| npm | đi kèm Node 22 | `npm -v` |
| `claude` CLI | 2.1+ | `which claude && claude --version` |
| `kiro-cli` (optional) | 2.3+ | `which kiro-cli && kiro-cli --version` |
| `codex` CLI (optional) | rust-v0.75+ | `which codex && codex --version` |
| `cursor-agent` CLI (optional) | latest | `which cursor-agent && cursor-agent --version` |
| Telegram account | bất kỳ | — |
| systemd (Linux only) | có sẵn trên mọi distro hiện đại | `systemctl --user --version` |
| NSSM (Windows only) | 2.24 | `nssm --version` |

> **Tối thiểu**: cần Claude Code CLI **HOẶC** Kiro CLI **HOẶC** Codex CLI **HOẶC** Cursor CLI. Cài càng nhiều càng có nhiều agent để chọn trong wizard `/new`.

**Cài Node 22** nếu chưa có:
```bash
brew install node@22
brew link --overwrite node@22
```

**Cài Claude Code CLI**:
```bash
# Xem hướng dẫn chính thức: https://docs.claude.com/en/docs/claude-code/setup
curl -fsSL https://claude.ai/install.sh | sh
```

**Cài Kiro CLI** (nếu muốn dùng): cần `kiro-cli` (headless CLI), KHÁC với `kiro` IDE launcher.
```bash
# Theo hướng dẫn chính thức: https://kiro.dev/docs/cli/installation
# macOS / Linux:
curl -fsSL https://cli.kiro.dev/install | bash
# Windows (PowerShell):
#   irm 'https://cli.kiro.dev/install.ps1' | iex
kiro-cli --version    # phải in ra 2.3+
```

> **Lưu ý**: `kiro` (IDE launcher) và `kiro-cli` (headless CLI) là 2 binary khác nhau. `kiro` chỉ mở IDE window, `kiro-cli` mới stream stdout headless được — Telecode dùng `kiro-cli`.

**Cài Codex CLI** (optional, dùng OpenAI Codex):
```bash
# Theo hướng dẫn chính thức: https://github.com/openai/codex
# Sau đó: codex login   ← Telecode KHÔNG handle auth, user tự login trước
codex --version
```

**Cài Cursor CLI** (optional, dùng Cursor agent):
```bash
# Theo hướng dẫn chính thức: https://cursor.com/docs/cli
# Sau đó: cursor-agent login   ← Telecode KHÔNG handle auth, user tự login trước
cursor-agent --version
```

> **Auth philosophy**: Telecode là **cầu nối** — không lưu API key của bất kỳ
> CLI nào. Bạn login từng CLI bằng lệnh native của nó (`codex login`,
> `cursor-agent login`, etc.) trước khi start daemon. Daemon spawn binary +
> stream output, không touch credentials.

Không có agent nào trong số trên cũng dùng được — Telecode tự skip adapter thiếu binary, dùng những agent còn lại. Tối thiểu cần Claude Code CLI **hoặc** Kiro CLI để có ít nhất 1 adapter hoạt động.

---

## Cài đặt từng bước

### 1. Clone repo

```bash
git clone https://github.com/dangkhoi/telecode.git ~/Documents/workspaces/telecode
cd ~/Documents/workspaces/telecode
```

> Bạn có thể clone vào bất cứ đâu. Nhưng nếu để ở `~/Documents/workspaces/` thì Telecode sẽ tự scan các project anh em bên cạnh.

### 2. Tạo Telegram bot riêng cho bạn

Mỗi người 1 bot riêng (bot là cổng vào máy bạn, không share được).

1. Mở Telegram, search **@BotFather** (icon xanh có tick verified).
2. Gửi `/newbot`.
3. BotFather hỏi **display name** → đặt gì cũng được, vd `Telecode (Khoa)`.
4. BotFather hỏi **username** (bắt buộc kết thúc bằng `bot`) → vd `khoa_telecode_bot`. Nếu trùng thử cái khác.
5. BotFather reply 1 token dạng `123456789:ABCdefGHI…` (~46 ký tự). **Copy token này**.
6. (Tuỳ chọn) `/setprivacy` → chọn bot → **Disable** (cho phép bot đọc message trong group sau này nếu cần; DM 1-1 thì không ảnh hưởng).

### 3. Lấy Telegram user_id của bạn

Telecode chỉ accept message từ user_id trong whitelist. Cách lấy id:

1. Trong Telegram, search **@userinfobot** (chính thức của Telegram team).
2. Bấm **Start**. Bot sẽ reply ngay 1 message kiểu:
   ```
   👤 You
   ├ id: 123456789
   ├ is_bot: false
   ├ first_name: ...
   └ username: ...
   ```
3. **Copy `id`** (chuỗi số). Đây là Telegram user_id của bạn.

### 4. Chạy installer

Telecode hỗ trợ 3 installer — chọn theo OS:

#### macOS — launchd

```bash
cd ~/Documents/workspaces/telecode
./scripts/install-launchd.sh
```

Installer sẽ:
1. Verify Node 22+.
2. Tạo `~/.telecode/` (chmod 700) nếu chưa có.
3. Copy `config.example.yaml` → `~/.telecode/config.yaml` (nếu chưa có).
4. Copy `policy.example.yaml` → `~/.telecode/policy.yaml` (nếu chưa có).
5. Hiện BotFather wizard nếu `~/.telecode/.env` trống — paste token bạn vừa lấy ở bước 2 vào.
6. Chạy `npm install && npm run build`
7. Generate `~/Library/LaunchAgents/dev.telecode.daemon.plist`.
8. `launchctl load` + start.

#### Linux — systemd (`--user` unit)

```bash
cd ~/workspaces/telecode
./scripts/install-systemd.sh
```

Installer sẽ:
1. Verify Node 22+ (qua `command -v node`, fallback `~/.nvm/versions/node/...`).
2. Tạo `~/.telecode/` (chmod 700) nếu chưa có.
3. Hỏi 3 input (skip được qua env var, hữu ích cho automation):
   - **Telegram bot token** (`TELECODE_BOT_TOKEN`) — lấy từ @BotFather (bước 2).
   - **Allowed chat IDs** (`TELECODE_ALLOWED_CHAT_IDS`) — comma-separated, lấy từ @userinfobot (bước 3).
   - **Kiro CLI path** (`TELECODE_KIRO_BINARY`) — optional, absolute path tới `kiro-cli`.
4. Atomic write `~/.telecode/config.yaml` (chmod 600) + `~/.telecode/.env` (chmod 600).
5. `npm install && npm run build` nếu `dist/` chưa có.
6. Generate `~/.config/systemd/user/telecode.service` (atomic write, mode 0644).
7. `systemctl --user daemon-reload && systemctl --user enable --now telecode.service`.
8. Verify qua `systemctl --user status telecode.service` + tail journal 20 dòng.

> **Tip — keep running after logout**: Trên máy server / WSL, default systemd `--user` instance dừng khi bạn logout. Bật user lingering để daemon chạy 24/7:
> ```bash
> sudo loginctl enable-linger $USER
> ```
> Installer sẽ in hint này nếu chưa được bật.

**Verify install OK**:
```bash
systemctl --user status telecode.service
journalctl --user -u telecode.service -n 20
```

**Dry-run / preview** trước khi chạy thật (in ra unit file + commands sẽ chạy, không execute):
```bash
./scripts/install-systemd.sh --dry-run
```

**Distros đã test** (qua dry-run unit-file generation; smoke test E2E sẽ làm ở Phase 5/6 VM):
- Ubuntu 24.04 LTS
- Fedora 41
- Debian 13 (Trixie)
- RHEL 9 / Rocky 9 (glibc 2.34)

#### Windows 11 — NSSM service

**Pre-requisites** (cài 1 lần, dùng cho mọi version Telecode về sau):

```powershell
winget install OpenJS.NodeJS.LTS    # Node 22+
winget install NSSM.NSSM            # service manager (https://nssm.cc)
winget install Git.Git              # nếu chưa có
# Optional adapters (tuỳ nhu cầu):
irm 'https://cli.kiro.dev/install.ps1' | iex   # Kiro CLI
# Codex CLI: theo OpenAI installer
# Cursor CLI: theo Cursor docs
```

> NSSM (the Non-Sucking Service Manager) là wrapper Windows service phổ
> biến, BSD-licensed, ~330KB. Telecode KHÔNG bundle binary này — installer
> fail-fast với hint winget nếu chưa có.

**Install**:

```powershell
cd C:\Users\<you>\workspaces\telecode    # (clone trước nếu chưa có)
git clone https://github.com/dangkhoi/telecode.git
cd telecode
.\scripts\install-windows.ps1
```

Installer sẽ:
1. Verify NSSM + Node 22+ (qua `Get-Command`, fallback `%ProgramFiles%\nodejs` + `%APPDATA%\nvm\v...`).
2. Tạo `%USERPROFILE%\.telecode\` + logs subdir.
3. Hỏi 3 input (skip được qua env var):
   - **Telegram bot token** (`$env:TELECODE_BOT_TOKEN`)
   - **Allowed chat IDs** (`$env:TELECODE_ALLOWED_CHAT_IDS`)
   - **Kiro CLI path** (`$env:TELECODE_KIRO_BINARY`) — optional.
4. Atomic write `config.yaml` + `.env` với **owner-only ACL** (Windows equivalent của `chmod 600` — strip inheritance, single explicit ACE cho user hiện tại).
5. `npm install && npm run build` nếu `dist\` chưa có.
6. NSSM service install: `nssm install Telecode <node.exe> --enable-source-maps <dist\index.js>` + AppDirectory + AppEnvironmentExtra (TELECODE_HOME, NODE_ENV, **USERPROFILE/HOMEDRIVE/HOMEPATH** của user đang install — để `~`-expansion vẫn trỏ về home của user khi service chạy dưới LocalSystem, PATH) + AppRestartDelay 5000 + AppExit Default Restart + AppStopMethodConsole 15000 + AppStdout/AppStderr → `%USERPROFILE%\.telecode\logs\` + AppRotateFiles + AppRotateBytes (10 MiB) + Start `SERVICE_AUTO_START`.
7. `nssm start Telecode` + verify `Get-Service Telecode` status = `Running` (retry 6×1s cho SCM transition lag).

**Verify install OK**:
```powershell
Get-Service Telecode
Get-Content $env:USERPROFILE\.telecode\logs\stdout.log -Tail 30 -Wait
```

**Dry-run / preview** trước khi chạy thật:
```powershell
.\scripts\install-windows.ps1 -DryRun
```

**Uninstall**:
```powershell
.\scripts\uninstall-windows.ps1                # interactive — prompt giữ hay xóa ~/.telecode
.\scripts\uninstall-windows.ps1 -KeepData      # giữ %USERPROFILE%\.telecode
.\scripts\uninstall-windows.ps1 -Purge         # xóa luôn (1 confirm)
.\scripts\uninstall-windows.ps1 -Purge -Yes    # automation: skip confirm
.\scripts\uninstall-windows.ps1 -DryRun        # in commands, không execute
```

**Lightweight fallback (no NSSM)**: Nếu không muốn cài NSSM, có thể tự
register Task Scheduler với trigger `OnLogon` chạy
`node.exe C:\...\dist\index.js`. Không có crash-restart semantics (NSSM
restart sau 5s khi daemon exit), nhưng zero dependency. Plan §8 P5.2 ghi
đây là option đã được consider nhưng KHÔNG implement — user tự dựng nếu
cần.

**PowerShell compatibility**: Script chạy được trên cả Windows PowerShell
5.1 (default Windows 10/11) và PowerShell 7+ (winget). Static tests
(<code>tests/install-windows.test.ts</code>) block các 7+-only operators
(<code>??</code>, ternary) để không accidentally raise minimum runtime.

**Sau khi installer chạy xong**, edit `~/.telecode/config.yaml`:

```bash
# Mở bằng editor yêu thích
code ~/.telecode/config.yaml
# hoặc
nano ~/.telecode/config.yaml
```

Sửa 2 chỗ:

```yaml
telegram:
  allowed_user_ids: [123456789]    # ← THAY bằng user_id của BẠN (lấy ở bước 3)

daemon:
  workspace_scan:
    roots: [~/Documents/workspaces]  # ← Đường dẫn folder chứa các project của bạn
```

Reload daemon để pick up config mới:

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist

# Linux
systemctl --user restart telecode.service
```

```powershell
# Windows
nssm restart Telecode
```

### 5. Kiểm tra daemon chạy

**macOS**:
```bash
# Xem process có running chưa
launchctl list | grep telecode

# Tail log realtime
tail -f ~/.telecode/logs/telecode.log
```

**Linux**:
```bash
# Xem service status
systemctl --user status telecode.service

# Tail log realtime (journald)
journalctl --user -u telecode.service -f

# File log của telecode (cùng nội dung, format pino)
tail -f ~/.telecode/logs/telecode.log
```

**Windows**:
```powershell
# Xem service status
Get-Service Telecode

# Tail log realtime (NSSM redirects stdout/stderr)
Get-Content $env:USERPROFILE\.telecode\logs\stdout.log -Tail 30 -Wait
Get-Content $env:USERPROFILE\.telecode\logs\stderr.log -Tail 30 -Wait
```

Bạn nên thấy log kiểu:
```
{"level":"info","msg":"telecode starting","version":"1.0.0"}
{"level":"info","msg":"lockfile acquired","pid":12345,"path":"~/.telecode/daemon.lock"}
{"level":"info","msg":"adapter registry initialized","kinds":["claude","kiro","codex","cursor"]}
{"level":"info","msg":"workspace scan complete","projects":12}
{"level":"info","msg":"telegram bot connected","username":"khoa_telecode_bot"}
```

Nếu không thấy → xem [Troubleshooting](#troubleshooting).

---

## Smoke test đầu tiên

1. Trong Telegram, search bot của bạn theo username (vd `@khoa_telecode_bot`), bấm **Start**.
2. Gửi `/start`. Bot reply welcome + show **persistent reply keyboard** (6 nút phía dưới ô gõ: 📋 Sessions, 📁 Projects, 📊 Status, 🛑 Stop, 📸 Screen, ❓ Help). Cạnh paperclip có thêm nút **Menu** — bấm vào hiện đủ 8 slash command. Gõ `/` cũng ra cùng menu.
3. Gửi `/projects` (hoặc tap nút 📁 Projects). Bot list tất cả project nó scan được từ `~/Documents/workspaces/`, mỗi project là 1 nút inline có **tên project**; tap = set project đó làm active. Project hiện đang active có prefix `●` (vd `● telecode`). Pagination tự bật khi >8 project.
4. Tạo session bằng **wizard** — gõ `/new`. Bot dẫn 3 bước inline:
   1. Chọn agent → keyboard render dynamic từ adapter registry. Mặc định: `[🤖 Claude] [⚡ Kiro] [🅒 Codex] [✦ Cursor] [✖ Cancel]` (chỉ hiện adapter có config trong `~/.telecode/config.yaml`).
   2. Chọn project → inline list (paginate 8/page nếu nhiều)
   3. Gõ label → validate `/^[a-zA-Z0-9_-]{1,40}$/`

   Bot reply: `📍 [smoke] — agent=claude` kèm 2 inline buttons `[🔀 Switch khác] [📋 Tail logs]` để jump nhanh. Legacy syntax vẫn chạy: `/session new claude smoke ~/Documents/workspaces/telecode`.
5. Gửi prompt thường:
   ```
   list 3 files in src
   ```
   Bot reply (sau vài giây): `[smoke] 🔧 Read src/index.ts ...` và stream output.
6. Test approval: gửi:
   ```
   chạy `git status` xem repo trạng thái gì
   ```
   Bot sẽ hỏi inline button `[Allow once] [Allow always] [Deny]` (vì `Bash(git status)` đã trong allow pattern thì sẽ auto-pass; thử lệnh khác như `npm outdated` sẽ hỏi).

Nếu đến đây mượt → setup OK ✓.

---

## Daily workflow

### Tạo session mới

Cách nhanh — gõ `/new` (hoặc tap `[➕ New session]` cuối list `/sessions`). Bot guide 3 bước inline:

1. Pick agent — keyboard dynamic theo adapter đã config: `[🤖 Claude] [⚡ Kiro] [🅒 Codex] [✦ Cursor] [✖ Cancel]`. Adapter không có config trong `~/.telecode/config.yaml` sẽ không hiện trong picker.
2. Pick project: inline list (pagination khi >8); cũng có `[← Back] [✖ Cancel]`
3. Gõ label: `/^[a-zA-Z0-9_-]{1,40}$/` — bot reject + xin lại nếu sai format.

Sau khi xong wizard, bot gửi message success kèm 2 inline buttons:
- **🔀 Switch khác** — render `/sessions` list để switch sang session đã có
- **📋 Tail logs** — show 30 dòng tool log của session vừa tạo

Muốn tạo session cho 1 project cụ thể? Vào wizard `/new` rồi pick project ở step 2 — đó là single source of truth cho luồng tạo session.

Legacy syntax vẫn được hỗ trợ — nhanh hơn nếu nhớ rõ path:

```
/session new claude refactor-auth ~/work/api
/session new claude debug ~/work/api          # cùng project, session khác
/session new kiro mobile-ui ~/work/mobile
/session new codex tests ~/work/api
/session new cursor docs ~/work/api
```

### Liệt kê + switch nhanh

```
/sessions
```

Bot reply theo format mới — active session prefix `●`, agent badge 🤖 (Claude) / ⚡ (Kiro) / 🅒 (Codex) / ✦ (Cursor), last activity:

```
📋 Sessions (4):
● refactor-auth · 🤖 · 2m ago
  debug-api     · 🤖 · 1h ago
  mobile-ui     · ⚡ · 3h ago
  ts-tests      · 🅒 · 30m ago
```

Inline keyboard 1 nút / session — tap để switch (không cần gõ tên). Dòng cuối luôn có `[➕ New session]` mở wizard.

Legacy `/session list` (kèm `sessionPickKeyboard` cũ) vẫn hoạt động. Switch bằng label:

```
/session switch refactor-auth
```

Bot reply `📍 [refactor-auth]` + 3 dòng cuối context để gợi nhớ.

### Plain text → active session

Sau khi switch, gửi message thường:
```
tiếp tục refactor module userService, tách logic auth ra file riêng
```

Bot prefix mọi reply bằng `[refactor-auth]` để bạn biết đang chat session nào.

### Approval flow

Khi agent muốn chạy tool ngoài policy (vd `gh pr create`, `npm install <pkg-mới>`):

```
🛡 Approval needed
Session: refactor-auth
Tool: Bash
Input: gh pr create --title "..."

[✅ Once] [🔁 Always]
[📌 Forever] [🚫 Deny]
```

- **✅ Once**: cho lần này thôi.
- **🔁 Always**: cho phép trong **session hiện tại** (mất khi daemon restart).
- **📌 Forever** *(v1.0)*: **2-step confirm** — tap 1 → message edit thành `⚠️ Ghi vĩnh viễn quyền: <tool> với args <...>? Rule sẽ apply cho mọi session sau.` kèm `[✅ Xác nhận] [❌ Hủy]`. Tap `Xác nhận` → atomic write rule vào `~/.telecode/policy.yaml` (`tmp + rename`) → auto-allow cả session hiện tại lẫn mọi session sau khi restart.
- **🚫 Deny**: reject + agent báo lỗi back.

Không tap trong 5 phút → auto-deny + Telegram báo `⏱ timeout, denied`.

Sau mỗi tool result, bot append **follow-up suggestion buttons** (heuristic, không LLM call thêm):
- `fs_write` success → `[👁 Xem file] [▶ Tiếp tục] [↺ Rollback]`
- `execute_bash` exit 0 → `[▶ Tiếp tục] [🔁 Run again]`
- default → `[▶ Tiếp tục]`

### Quản lý policy

```
/allow Bash(gh pr*)             # append pattern allow
/allow Edit(/Users/khoa/work/api/**)
/deny Bash(rm -rf /work/**)     # append deny
```

Hoặc edit thẳng `~/.telecode/policy.yaml` bằng editor — daemon tự reload qua `fs.watchFile`.

### Tail logs khi task chạy lâu

```
/status logs 30
```

Show 30 tool call gần nhất của session active. Hữu ích khi prompt dài và bạn muốn xem agent đang ở đâu.

### Stop & reset

```
/stop                  # interrupt task đang chạy (AbortController)
/session reset         # giữ label nhưng wipe resume id → fresh context
/session close debug   # đóng hẳn session "debug"
```

---

## Multi-session UX

Khi chạy nhiều session song song, Telecode giữ Telegram chat luôn focus vào **đúng 1 session active** thay vì spam interleaved output. Cơ chế:

### Per-session view
- Session **active** → stream output (text + tool_use) gửi trực tiếp về Telegram, prefix `[label]`.
- Session **background** → output đi vào RAM buffer (per-session, cap mặc định 50 KB, drop-oldest khi đầy).
- Không có chuyện 2 session cùng spam — bạn chỉ thấy session đang theo dõi.

### Auto-switch on approval
Khi 1 background session cần approval:
1. Bot **tự switch active sang session đó** (first-come-first-active, không thrashing — đang approve session khác thì queue).
2. Gửi approval prompt `🛡 Approval needed` như bình thường.
3. **Flush catch-up buffer** của session vừa switch ngay sau prompt (xem dưới).

Vd: đang xem `refactor-auth`, session `mobile-ui` cần `Bash(pod install)` → bot ping `🔔 switched → [mobile-ui]` + approval card + catch-up dump của `mobile-ui`.

### Catch-up on switch
Mỗi lần switch (manual qua `/sessions` tap, hoặc auto qua approval), bot gửi 1 message **silent** (`disable_notification:true`):

```
📥 catch-up (12 events from background)
[mobile-ui] 🔧 Read Podfile
[mobile-ui] ... pod install --repo-update ...
```

Auto-split khi >3400 ký tự / message (Telegram limit 4096, trừ overhead). Sau khi flush, buffer của session đó được clear.

### Session strip
Mọi approval / critical message kèm 1 hàng inline button cuối:

```
[refactor-auth] [● mobile-ui] [debug-api] [+ New]
```

Marker `●` = active. Tap session khác = switch + trigger catch-up (như mục trên). `[+ New]` mở wizard `/new`.

### Silent stream
- Text + tool_use chunk gửi với `disable_notification:true` — không kêu, không vibrate. Cuộn lên xem khi cần.
- **Approval**, **done**, **error** vẫn notify đầy đủ (sound + badge).
- Catch-up flush cũng silent.

### Tuning
Edit `~/.telecode/config.yaml`, thêm section `notifier:` (nếu thiếu sẽ dùng default):

```yaml
notifier:
  debounce_ms: 3000        # stream chunk được gom trong N ms trước khi flush về Telegram
  buffer_cap_bytes: 50000  # cap RAM buffer / background session (drop-oldest khi full)
```

Tăng `debounce_ms` nếu thấy bot gửi quá dồn dập; tăng `buffer_cap_bytes` nếu background task dài + bạn muốn catch-up đầy đủ.

---

## Live dashboard

Gõ `/dashboard` → bot gửi 1 message rồi `editMessageText` mỗi **2s** với snapshot trạng thái daemon:

```
📊 Telecode dashboard (auto-refresh 2s)

Sessions (3 active):
● refactor-auth · 🤖 · busy · 12.4 KB buffered
  debug-api     · 🤖 · idle ·  0.0 KB
  ts-tests      · 🅒 · busy ·  5.1 KB buffered

Approvals: 1 pending (mobile-ui: shell)
Wizard: idle

Last update: 14:23:05
```

**Stop conditions** (loop tự dừng):
- Gõ `/dashboard stop`
- Message bị xóa (Telegram trả 400 `message_to_edit_not_found`)
- 5 phút idle (không user input nào)

Rate limit Telegram ~30 edit/min, 2s = đúng ngưỡng nên bot dùng throttler. Nếu gặp 429 → skip update, retry next tick.

---

## Verbosity modes (v1.1)

Telecode v1.0 stream MỌI event về Telegram (firehose) → khó đọc trên phone. v1.1 thêm 4 mode để control mức độ chi tiết. **Default = `summary`** cho new users.

| Mode | Icon | Hiển thị |
| --- | --- | --- |
| `summary` | 🎯 | Chỉ approval + done (+ AI summary) + errors |
| `normal` | 📝 | + tool calls compact + tool results compact |
| `thinking` | 🧠 | + Claude thinking blocks + Cursor thought chunks (prefix 🧠) |
| `verbose` | 🔬 | + raw text chunks + status events + full preview (= v1.0 firehose, byte-identical) |

**Commands**:
- `/mode` — show current effective mode + 4-button picker để switch (per session active)
- `/mode <name>` — set per-session, vd `/mode normal`
- `/settings mode <name>` — set chat default (apply cho session mới sau này)

Resolved hierarchy: session mode → chat default → `summary`. Edit ngay nhưng KHÔNG retroactive (events đã render giữ nguyên format).

**Migration v1.0 → v1.1**: lần đầu boot v1.1, telecode send 1 message announcement giải thích default mới + hướng dẫn `/mode verbose` cho user muốn behavior cũ. Backward compat 100% — `verbose` mode reproduces v1.0 byte-identical.

---

## Agentic compression (v1.1)

Thay vì rule-based truncate "200 dòng output → cắt 240 chars đầu", telecode reuse session đang chạy để **AI tóm tắt**. Cost ăn vào budget agent của session (không cần API key riêng).

### Auto-summarize long tool_result (>500 chars)

Bash command với output dài → 2-phase render:

```
[refactor-auth] 🔧 Bash · npm test
    ⏳ Summarizing 1.2KB output...   ← placeholder silent

(sau 2-3s)

[refactor-auth] 🔧 Bash · npm test ✅ (3.5s)
    Đã chạy 432 tests, 2 skipped, all pass.
    [📜 Full output (200 lines)] [💬 Re-summarize]
```

Tap `[📜 Full output]` → bot gửi nội dung gốc full (split nếu >3500 chars, wrap MarkdownV2 ```bash fence).

### On-demand `[💬 AI summary]` button

Mọi tool_result với full_preview cached → button `[💬 AI summary]` luôn có. Tap → reinject summarize → edit message với summary mới.

### Auto done-summary

Khi task xong (`done` event) trong mode `summary` hoặc `normal`:
```
[refactor-auth] ✅ Done · 47s · $0.0231
Tách validateToken ra file riêng, thêm 5 unit tests, all pass.
```
Bot inject prompt "Tóm tắt công việc vừa làm 1-2 câu" vào session → reply summary. Mode `verbose` bypass — vẫn show `✅ done · $0.0231` plain như v1.0.

### Cost transparency

Mỗi summarize call log structured pino: `{ sessionId, kind: 'auto-tool-result'|'on-demand'|'auto-done', elapsedMs, inputChars, outputChars }`. Audit qua `tail -f ~/.telecode/logs/telecode.log | grep summarize` hoặc `journalctl --user -u telecode | grep summarize` (Linux).

Conservative defaults (500-char threshold, per-session mutex chống burst spam, verbose mode opt-out) giữ cost story honest.

---

## Activity indicators (v1.1)

Trong mode `summary`/`normal`/`thinking`, bot maintain **1 message progress edit-only per session** showing current activity:

```
⏳ [refactor-auth] Starting Claude...
        ↓ (after first tool_use)
⏳ [refactor-auth] Running Read...
        ↓ (after tool_result)
⏳ [refactor-auth] Generating response...
        ↓ (done event)
✅ Done · 47s · $0.0231
{auto-summary}
```

**Idle ping ladder** (mode summary chỉ): 30s → 1m → 2m → 3m → 4m → 5m+ cap. Message updates `⏳ Working... (1m)` để user biết bot vẫn alive, không hang.

Mode `verbose` SKIP progress message hoàn toàn (preserve raw firehose UX cho debugging).

---

## Smart rendering (v1.1)

### Friendly tool rendering

Path collapse + basename rendering thay raw JSON params:

| Tool | Format v1.1 |
| --- | --- |
| Read | `🔧 Read · notifier.ts` |
| Edit | `📝 Edit · auth.ts (-3 +7)` (diff stats) |
| Bash | `🔧 Bash · npm test` (command first 80 chars) |
| Grep | `🔍 Grep "AgentEvent" in src/` |
| Write | `🔧 Write · output.ts (1.2 KB)` |

Path: absolute → `~/` (home) hoặc `./` (project cwd) hoặc git-root-rel cho monorepo siblings hoặc `...auth/validate.ts` (deeply nested).

### Repeated tool collapse (5s window)

3 file reads liên tiếp → 1 message edit thay 3 send:
```
🔧 Read ×3 · notifier.ts, types.ts, reply-builders.ts ✅
```

### MarkdownV2 auto code-fence

Bot tự detect + wrap content trong text events:
- JSON-like (`{...":...}`) → ```json
- Diff hunks (`+`/`-` lines + `@@`) → ```diff
- Bash output (`$ `/`> ` prompt) → ```bash
- Stack traces (`at Function ...`) → ``` (plain monospace)

Plain text fallback nếu Telegram parse fail (400 bad markdown).

### Allow forever 2-step confirm

(v1.0 feature, recap): nút `📌 Forever` trên approval → tap 1 → "⚠️ Ghi vĩnh viễn?" confirm dialog → tap 2 → atomic write rule vào `~/.telecode/policy.yaml`.

---

## Bảng lệnh đầy đủ

Gõ `/` trong Telegram chat sẽ hiện danh sách top-level commands (cùng list với nút **Menu** cạnh paperclip). Ngoài ra, mỗi approval / critical message đính kèm **session strip** inline button `[session1] [● active] [session2] [+ New]` để tap-switch nhanh không cần command.

| Command | Mô tả |
| --- | --- |
| **Top-level (slash menu)** | |
| `/start` | Welcome + active session info + re-issue persistent reply keyboard. |
| `/new` | Wizard tạo session (agent → project → label). |
| `/sessions` | Enhanced list — active marker `●`, agent 🤖/⚡, last activity. Mỗi dòng có 3 nút: `[label]` (switch) + `[🤝]` (handoff) + `[🗑]` (close). |
| `/projects` | Inline picker, 1 nút per project = tên project, active prefix `●`. Pagination >8. |
| `/status` | Active session, agent, project, last 5 tool calls. |
| `/clear` | Clear context của session active (wipe sdk_session_id + transcript). Label giữ nguyên, gõ prompt mới là fresh. |
| `/handoff` | Agent self-summarize context (5–15 dòng) → wipe context → inject summary làm preamble cho prompt kế tiếp (1-shot). Dùng khi context window đầy nhưng muốn giữ task. |
| `/stop` | Interrupt task đang chạy. |
| `/screenshot` | Chụp desktop gửi về (macOS cần Screen Recording perm; Linux cần `grim`/`gnome-screenshot`/`scrot`; Windows dùng PowerShell native). |
| `/dashboard` | *(v1.0)* Live dashboard edit-loop 2s. `/dashboard stop` để tắt. |
| `/mode` | *(v1.1)* Show current verbosity mode + 4-button picker. `/mode <name>` set per-session: `summary` (default) / `normal` / `thinking` / `verbose`. |
| `/settings` | *(v1.1)* Show chat-level settings. `/settings mode <name>` đặt default mode cho chat (apply session mới sau này). |
| `/help` | Hướng dẫn nhanh — list 6 nút keyboard + slash commands. |
| **Session (legacy `/session ...` — vẫn hoạt động)** | |
| `/session new <agent> <label> [path]` | `claude` / `kiro` / `codex` / `cursor`. Path mặc định = project active. |
| `/session list` | List sessions + inline keyboard switch (cũ, format ngắn gọn). |
| `/session switch <label>` | Đổi active session + show 3 dòng context cuối. |
| `/session rename <new-label>` | Đổi tên session active. |
| `/session close [label]` | Đóng session (mặc định = active). Hoặc tap nút `[🗑]` trong `/sessions`. |
| `/session clear` | Clear context (alias của top-level `/clear`). `/session reset` là legacy alias. |
| **Project** | |
| `/add <path> [name]` | Register path làm project. |
| `/cd <name\|path>` | Đổi project cho session active. |
| **Policy & misc** | |
| `/status logs [n]` | Tail n tool calls (default 20). |
| `/allow <pattern>` | Append pattern vào policy allow. |
| `/deny <pattern>` | Append pattern vào policy deny. |
| `<plain text>` | Dispatch vào active session. |

### Session lifecycle — clear / handoff / close

3 hành động AI-agentic để quản context window khi làm việc lâu trong 1 session:

| Lệnh | Khi nào dùng | Hiệu ứng |
|---|---|---|
| **`/clear`** | Context cũ không còn liên quan, muốn fresh start nhưng giữ session + label | Wipe `sdk_session_id` + `transcript_tail`. Lần prompt tiếp theo = session mới hoàn toàn (claude tạo resume id mới). |
| **`/handoff`** hoặc nút `[🤝]` | Context window sắp đầy, nhưng muốn giữ task — cần tóm tắt + tiếp tục | (1) Agent self-summarize 5–15 dòng (2) Save summary vào DB (3) Wipe context (4) Prompt KẾ TIẾP tự inject summary làm preamble — 1-shot, không lặp. Nút `[🤝]` trong `/sessions` cho phép handoff session bất kỳ (kể cả background, không cần switch trước). |
| **`/session close`** hoặc nút `[🗑]` | Xong việc với session này, không cần nữa | Interrupt task đang chạy + mark closed + discard buffer. Session ẩn khỏi `/sessions` (vẫn còn trong DB với `status='closed'`). |

**Flow `/handoff` chi tiết**:
```
You> /handoff
Bot> 🤝 [refactor-auth] requesting handoff summary từ agent…
Agent> "We're refactoring src/auth.ts. Done: extracted validateToken into
        separate file. Next: write unit tests for the new validator..."
Bot> [refactor-auth] 🤝 handoff complete — 387 chars saved.
     Context window đã clear. Gõ prompt tiếp theo, summary sẽ inject làm preamble (1-shot).

You> tiếp tục viết unit test
Bot> 📥 [refactor-auth] inject handoff context (387 chars) vào prompt — sẽ chỉ chạy 1 lần.
     [refactor-auth] dispatching…
Agent> [resumes with summary + new prompt, in fresh context window]
```

### Reply keyboard (6 nút persistent)

Sau khi `/start`, Telegram hiện 6 nút cố định phía dưới ô gõ (Telegram Desktop ≥ 4.6 giữ keyboard persistent; client cũ degrade về non-persistent nhưng vẫn dùng được):

```
[📋 Sessions] [📁 Projects]
[📊 Status]   [🛑 Stop]
[📸 Screen]   [❓ Help]
```

Mỗi nút = tap để gửi command tương ứng (`/sessions`, `/projects`, `/status`, `/stop`, `/screenshot`, `/help`). Khi đang trong wizard, keyboard tự ẩn để tránh tap nhầm; hoàn tất wizard sẽ restore lại.

### Wizard `/new`

Multi-step inline, mỗi step có nút Cancel / Back, callback data namespaced `wizard:new-*`:

| Step | UI | Validate |
| --- | --- | --- |
| 1. Agent | Keyboard render **dynamic** từ adapter registry — chỉ hiện adapter có config trong `~/.telecode/config.yaml`. Đầy đủ: `[🤖 Claude] [⚡ Kiro] [🅒 Codex] [✦ Cursor]` + `[✖ Cancel]`. | — |
| 2. Project | 1 nút / project, `[← Prev] [page x/y] [Next →]` khi >8, `[← Back] [✖ Cancel]` | Project phải tồn tại + còn registered. |
| 3. Label | Plain text reply | `/^[a-zA-Z0-9_-]{1,40}$/`. Reject + xin lại nếu sai. |

Conversation state persist trong SQLite (`conversations` table) — restart daemon giữa wizard không mất step.

**Wizard-aware auto-switch** *(v1.0)*: khi đang trong wizard, ApprovalBroker sẽ defer auto-switch (queue lại) cho đến khi wizard exit. Tránh việc text input của wizard bị hijack bởi auto-switch giữa chừng.

---

## Policy & Approval

`policy.yaml` có 2 list: `allow` (auto-pass) và `deny` (auto-reject). Tool không match list nào → hỏi qua Telegram.

```yaml
allow:
  - Read
  - Grep
  - Glob
  - "Edit({{project_dir}}/**)"        # giới hạn trong project active
  - "Bash(npm test*)"
  - "Bash(npm run *)"
  - "Bash(git status*)"
  - "Bash(git diff*)"
deny:
  - "Bash(rm -rf*)"
  - "Bash(git push --force*)"
  - "Bash(curl * | sh*)"
  - "Edit(~/.ssh/**)"                 # ~/ tự expand thành $HOME
  - "Edit(~/.aws/**)"
```

Patterns dùng glob đơn giản:
- `*` = bất cứ ký tự nào (kể cả space, slash)
- `{{project_dir}}` = path của project active (resolve runtime)
- `~/` = home directory (resolve compile time)

**Best practice**: deny rộng (vd `Bash(rm*)`), allow hẹp (vd `Bash(npm test*)` không phải `Bash(npm*)`).

### Cùng policy engine cho cả 4 agent

Policy engine xử lý chung. Khác biệt là tool name format + cách approval được route:

| Agent | Tool name | Input shape | Approval mechanism |
| --- | --- | --- | --- |
| Claude | `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob` | `{ command }`, `{ file_path }` | SDK `canUseTool` callback in-process |
| Kiro | `shell`, `write`, `read`, `fs_read`, `fs_write` | `{ command }`, `{ path }` | `preToolUse` hook (HTTP bridge với HMAC Bearer token) |
| Codex | `execute_bash`, `read`, `write`, `apply_patch` | `{ command }`, `{ path }` | JSON-RPC `turn/permissionRequest` (native) |
| Cursor | `readToolCall`, `writeToolCall`, `bashToolCall`, … | tool-specific args | ACP `session/request_permission` (native) |

Mỗi pattern phải dùng đúng tool name của agent:

```yaml
allow:
  # Claude
  - Read
  - "Bash(npm test*)"
  - "Edit({{project_dir}}/**)"
  # Kiro
  - read
  - "shell(npm test*)"
  - "write({{project_dir}}/**)"
  # Codex
  - "execute_bash(npm test*)"
  - "write({{project_dir}}/**)"
  # Cursor
  - readToolCall
  - "bashToolCall(npm test*)"
deny:
  - "Bash(rm -rf*)"
  - "shell(rm -rf*)"
  - "execute_bash(rm -rf*)"
  - "bashToolCall(rm -rf*)"
```

**Kiro bridge**: daemon sinh `~/.kiro/agents/telecode.json` có `preToolUse` hook trỏ về loopback HTTP server của daemon (port random, per-boot HMAC Bearer token chống same-user spoof). Hook command Windows-aware (`node "C:\..."` với quote escape), POSIX dùng bare path. Mỗi tool call kiro-cli → daemon decide → exit 0 (allow) hoặc 2 (deny + lý do về model).

**Codex / Cursor**: dùng native protocol approval, không cần hook bridge. Mọi 4 agent route qua cùng `ApprovalBroker` → cùng inline button UX.

---

## Adapter registry — thêm agent mới

Telecode dùng **open-set registry** (`src/agents/registry.ts`) — thêm agent CLI mới chỉ cần:

```typescript
// src/agents/<myagent>.ts (file MỚI)
import type { AgentAdapter, AdapterMetadata } from './types.js';

export const myagentMetadata: AdapterMetadata = {
  kind: 'myagent',
  displayName: 'My Agent',
  badge: '🆎',
  description: 'My custom agent CLI',
};

export class MyAgentAdapter implements AgentAdapter {
  readonly kind = 'myagent' as const;
  async run(opts: AgentStartOpts): Promise<void> {
    // spawn CLI, stream output via opts.onEvent, route approval qua opts.broker
  }
}
```

```typescript
// src/agents/index.ts — thêm 1 dòng register:
if (deps.myagent) {
  registry.register('myagent', () => new MyAgentAdapter(deps.myagent), myagentMetadata);
}
```

```yaml
# ~/.telecode/config.yaml — thêm overlay
agents:
  myagent:
    command: my-agent-cli
    model: default
```

Wizard `/new` picker, reply-builders badge, dashboard list — tất cả tự pick up adapter mới qua `registry.list()`. Không phải sửa types / UI / config schema cố định.

Hiện có 4 built-in: Claude (SDK in-process), Kiro (CLI + hook bridge), Codex (CLI JSON-RPC), Cursor (CLI ACP).

---

## Logs & debugging

| File | Mô tả |
| --- | --- |
| `~/.telecode/logs/telecode.log` | pino structured logs, daily rotation, retention 7 ngày |
| `~/.telecode/logs/stdout.log` | launchd/systemd/NSSM-captured stdout |
| `~/.telecode/logs/stderr.log` | launchd/systemd/NSSM-captured stderr |
| `~/.telecode/state.db` | SQLite WAL (sessions, projects, tool_log, approvals) |
| `~/.telecode/daemon.lock` *(v1.0)* | Singleton lockfile (PID + startedAtMs) — chặn 2 daemon chạy đồng thời |
| `~/.telecode/policy.yaml` | Policy rules (allow/deny). `📌 Forever` button append rule vào đây atomic. |

Tail realtime:
```bash
tail -f ~/.telecode/logs/telecode.log | jq -r '"[\(.level)] \(.msg) \(.session_id // "")"'
```

Inspect SQLite:
```bash
sqlite3 ~/.telecode/state.db ".tables"
sqlite3 ~/.telecode/state.db "SELECT label, agent, project_id, status FROM sessions;"
sqlite3 ~/.telecode/state.db "SELECT tool_name, decision, datetime(created_at,'unixepoch','localtime') FROM tool_log ORDER BY id DESC LIMIT 20;"
```

**Secret scrub**: bot token, `sk-ant-*`, GitHub PAT, `Bearer ...` được scrub trong cả pino redact lẫn Telegram notifier — kể cả khi log/notify nhỡ chứa.

---

## Troubleshooting

### Daemon không start

**macOS**:
```bash
launchctl list | grep telecode
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
cat ~/.telecode/logs/stderr.log
```

**Linux**:
```bash
systemctl --user status telecode.service
systemctl --user restart telecode.service
journalctl --user -u telecode.service -n 50
```

**Windows**:
```powershell
Get-Service Telecode
nssm restart Telecode
Get-Content $env:USERPROFILE\.telecode\logs\stderr.log -Tail 50
```

### Daemon already running (lockfile conflict — v1.0)

Boot fail với message kiểu `Telecode daemon đã chạy với PID 12345`:

```bash
# Check PID có sống không
ps -p 12345           # macOS / Linux
Get-Process -Id 12345 # Windows PowerShell

# Nếu PID đã chết (stale lockfile):
rm ~/.telecode/daemon.lock                                # macOS / Linux
Remove-Item $env:USERPROFILE\.telecode\daemon.lock        # Windows
```

Nguyên nhân thường gặp: chạy `npm run dev` trong khi service launchd/systemd/NSSM cũng chạy. Pick 1 — dev mode hoặc service mode, không cả hai.

### Bot không reply trong Telegram

1. Verify token đúng:
   ```bash
   TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.telecode/.env | cut -d= -f2)
   curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq
   ```
   Phải thấy `"ok": true` và info bot.

2. Verify user_id trong whitelist khớp với user của bạn:
   ```bash
   grep allowed_user_ids ~/.telecode/config.yaml
   ```
   So với id từ @userinfobot.

3. Verify daemon kết nối:
   ```bash
   grep "telegram bot connected" ~/.telecode/logs/telecode.log
   ```

4. **Privacy mode**: nếu add bot vào group mà bot không nhận message → vào @BotFather → `/setprivacy` → `Disable`.

### `/screenshot` báo lỗi

**macOS**: cần Screen Recording permission cho `screencapture`:
- System Settings → Privacy & Security → Screen & System Audio Recording
- Add `node` (path: `which node`) hoặc terminal app bạn dùng để chạy launchctl.

**Linux**: cần ít nhất 1 trong: `grim` (Wayland) / `gnome-screenshot` / `scrot`. Cài qua package manager:
```bash
sudo apt install gnome-screenshot   # Ubuntu / Debian
sudo dnf install gnome-screenshot   # Fedora
sudo apt install grim               # Wayland (sway, …)
```

**Windows**: dùng PowerShell `[Screen]::PrimaryScreen` — không cần thêm gì. Nếu fail kiểm tra log NSSM stderr.

### `/session new kiro ...` không mở IDE

```bash
# Kiro CLI (headless) có không?
which kiro-cli
kiro-cli --version   # phải in ra 2.3+
```

Nếu không có → cài kiro-cli (xem [Yêu cầu máy](#yêu-cầu-máy)). `kiro` (IDE) ≠ `kiro-cli` (headless).

### Kiro session fail ngay với `kiro-cli exit ?`

**Triệu chứng**: tạo session Kiro → bot reply `❌ kiro-cli exit ?` ngay lập tức, không output nào.

**Nguyên nhân thường gặp**: `~/.telecode/config.yaml` có `binary: /Users/YOU/.local/bin/kiro-cli` (placeholder placeholder từ bug pre-v1.0) hoặc absolute path tới location không tồn tại trên máy này.

**Fix**:
```bash
# Option 1 — bare name (v1.0+, recommended) — runtime PATH enrichment lo resolve
sed -i '' 's|^    binary: .*kiro-cli.*$|    binary: kiro-cli|' ~/.telecode/config.yaml

# Option 2 — absolute path đúng máy hiện tại
KIRO_BIN=$(command -v kiro-cli)
sed -i '' "s|^    binary: .*$|    binary: ${KIRO_BIN}|" ~/.telecode/config.yaml

# Reload daemon
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

**Verify**: log `~/.telecode/logs/telecode.log` phải có dòng `kiro adapter ready` (không warning về binary).

### Daemon crash loop

```bash
tail -50 ~/.telecode/logs/stderr.log
```

Thường do:
- `~/.telecode/config.yaml` syntax YAML sai → validate bằng `python3 -c "import yaml; yaml.safe_load(open('$HOME/.telecode/config.yaml'))"`.
- Port conflict (không có port vì daemon dùng long-poll, không listen).
- SQLite lock — check `~/.telecode/state.db-wal` và `state.db-shm` còn dính sau crash không, xóa nếu cần.

### Máy sleep → bot offline

Bot dùng long-poll qua Telegram API, máy sleep thì daemon pause. Options theo OS:

**macOS**: `caffeinate -i` trong terminal, hoặc [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704).

**Linux**: `systemd-inhibit --what=sleep:idle --who=telecode --why="long-poll" sleep infinity` hoặc disable suspend trong Settings.

**Windows**: Settings → System → Power & battery → Screen and sleep → set "Never". Hoặc cài [Caffeine for Windows](https://www.zhornsoftware.co.uk/caffeine/).

Tương lai: VPS relay mode (roadmap v1.1+).

---

## Update Telecode

**macOS**:
```bash
cd ~/Documents/workspaces/telecode
git pull
npm install
npm run build
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

**Linux**:
```bash
cd ~/workspaces/telecode
git pull
npm install
npm run build
systemctl --user restart telecode.service
```

**Windows**:
```powershell
cd C:\Users\<you>\workspaces\telecode
git pull
npm install
npm run build
nssm restart Telecode
```

Config + policy + DB + lockfile ở `~/.telecode/` (`%USERPROFILE%\.telecode\` trên Windows) giữ nguyên qua update.

### Migration v0.4 → v0.6 (Kiro config schema thay đổi)

Nếu bạn đã có config từ trước v0.5, cần edit `~/.telecode/config.yaml`:

```yaml
agents:
  kiro:
    binary: kiro-cli                         # ← bare name (v1.0+) hoặc absolute path
    # default_mode: agent                    # ← xoá dòng này (obsolete schema)
```

**v1.0 trở đi**: bare name `kiro-cli` resolve qua runtime PATH enrichment (`buildKiroMcpPath()` prepend `~/.local/bin`, `~/.cargo/bin`, `~/.nvm/...` vào PATH lúc spawn). Trước đó cần absolute path vì launchd default PATH không có user runtime dirs.

> **Nếu bạn upgrade từ v0.5–v0.8 mà thấy config cũ có `binary: /Users/YOU/.local/bin/kiro-cli`** (placeholder placeholder cũ từ `config.example.yaml`): đó là bug đã fix ở v1.0. Sửa thành `binary: kiro-cli` hoặc `binary: $(which kiro-cli)` và restart daemon. Installer mới (`install-launchd.sh`) tự auto-detect path qua `command -v kiro-cli`.

### Migration v0.7 → v0.8

Không cần migration: nếu `~/.telecode/config.yaml` không có section `notifier:`, defaults sẽ tự apply (`debounce_ms: 3000`, `buffer_cap_bytes: 50000`). Muốn tune thì thêm section như mô tả ở [Multi-session UX](#multi-session-ux).

### Migration v0.8 → v1.0

Backward compat 100% — không cần edit `config.yaml` nếu chỉ dùng Claude + Kiro.

**Optional** — thêm Codex / Cursor adapter:

```yaml
agents:
  # đã có claude: / kiro: ...
  codex:
    command: codex
    model: gpt-5.1-codex
    effort: medium
  cursor:
    command: cursor-agent
    model: auto
```

**Auth setup** (bắt buộc nếu enable Codex / Cursor):
```bash
codex login           # OpenAI account, persistent token
cursor-agent login    # Cursor account, persistent token
```

Telecode KHÔNG handle auth — bạn login bằng lệnh native trên shell trước, daemon spawn binary và assume đã ready.

**Daemon singleton**: v1.0 thêm `~/.telecode/daemon.lock`. Nếu boot fail với "Telecode daemon already running with PID X" → check PID đó còn sống không (`ps -p X` / `Get-Process -Id X`). Nếu đã chết → xóa lockfile manual: `rm ~/.telecode/daemon.lock`.

### Migration v1.0 → v1.1 (streaming UX redesign)

**Backward compat 100%** — không cần edit `config.yaml` hay DB migration thủ công.

**Lần đầu boot v1.1**, daemon auto-detect bằng cách check `chat_settings` table (v1.1 mới tạo) rồi send 1 message announcement tới mỗi `allowed_user_id`:

> 📢 *Telecode v1.1* — verbosity modes
>
> Mode mặc định giờ là 🎯 *Summary* — chỉ show approval + done + errors.
>
> Muốn behavior cũ (verbose firehose):
>   • `/mode verbose`           — chỉ áp dụng cho session active
>   • `/settings mode verbose`  — đặt làm default cho cả chat
>
> Đổi mode bất kỳ lúc nào qua slash menu (`/mode`, `/settings`).

Sau khi send xong, telecode mark `chat_settings(chat_id, default_mode='summary')` để không spam lặp lại.

**DB migration** chạy idempotent lúc boot:
1. Add column `sessions.verbosity_mode TEXT` (NULL → fallback chain → `summary`).
2. Create `chat_settings` table.

Existing sessions, policy.yaml, .env đều giữ nguyên. Nếu muốn force behavior cũ trước khi user boot v1.1 lần đầu: edit `~/.telecode/config.yaml` thêm field — nhưng nên để mode mặc định `summary` thử trước, rồi switch sau nếu cần.

**Anti-pattern**: nếu thấy bot "im lặng lâu" trong summary mode, đó là intended — events đã filter ở dispatch layer. Có 2 mechanisms backup:
- Rolling progress message (`⏳ Working... (1m)`) — idle ping ladder 30s/1m/2m/.../5m cap.
- Idle ping = visual feedback cho biết bot vẫn alive.

Nếu vẫn không quen, `/mode normal` show tool calls + results compact (middle ground).

---

## Uninstall

**macOS**:
```bash
cd ~/Documents/workspaces/telecode
./scripts/uninstall-launchd.sh
```

**Linux**:
```bash
cd ~/workspaces/telecode
./scripts/uninstall-systemd.sh             # interactive — prompt giữ hay xóa ~/.telecode
./scripts/uninstall-systemd.sh --keep-data # giữ ~/.telecode không hỏi
./scripts/uninstall-systemd.sh --purge     # xóa luôn ~/.telecode (cần `yes` confirm)
./scripts/uninstall-systemd.sh --purge --yes  # automation skip confirm
./scripts/uninstall-systemd.sh --dry-run   # in commands sẽ chạy, không execute
```

**Windows**:
```powershell
cd C:\Users\<you>\workspaces\telecode
.\scripts\uninstall-windows.ps1                # interactive — prompt giữ hay xóa
.\scripts\uninstall-windows.ps1 -KeepData      # giữ %USERPROFILE%\.telecode
.\scripts\uninstall-windows.ps1 -Purge         # xóa luôn (cần confirm)
.\scripts\uninstall-windows.ps1 -Purge -Yes    # automation skip confirm
.\scripts\uninstall-windows.ps1 -DryRun        # in commands, không execute
```

Script stop daemon + remove service unit/registration. Mặc định `~/.telecode/` (config, token, DB, log) **được giữ lại** để bạn install lại sau không mất setup (trừ khi dùng `--purge` / `-Purge`).

Nếu muốn xóa sạch (cross-platform):
```bash
# macOS / Linux
rm -rf ~/.telecode/

# Windows
Remove-Item -Recurse -Force $env:USERPROFILE\.telecode
```
Optional: revoke bot → @BotFather → `/mybots` → chọn bot → Delete Bot.

---

## Kiến trúc & tài liệu

- [docs/plans/telecode-v1.0-cross-platform-multi-agent.html](docs/plans/telecode-v1.0-cross-platform-multi-agent.html) — **Plan v1.0** (cross-platform + multi-agent: T3 carry-over + foundation refactor + Linux/Windows + Codex/Cursor + hardening).
- [docs/design/telecode-v1.0-cross-platform-multi-agent.html](docs/design/telecode-v1.0-cross-platform-multi-agent.html) — **SDD v1.0** (design decisions, tech freshness via Context7, 5 senior review patch sections — Opus 4.7).
- [docs/plans/per-session-view-buffering.html](docs/plans/per-session-view-buffering.html) + [docs/design/per-session-view-buffering.html](docs/design/per-session-view-buffering.html) — Plan + SDD v0.8 (Multi-session view discipline).
- [docs/plans/ux-telegram-widgets.html](docs/plans/ux-telegram-widgets.html) + [docs/design/ux-telegram-widgets.html](docs/design/ux-telegram-widgets.html) — Plan + SDD v0.7 (slash menu, persistent keyboard, `/new` wizard, project picker).
- [docs/plans/telegram-bridge.html](docs/plans/telegram-bridge.html) + [docs/design/telegram-bridge.html](docs/design/telegram-bridge.html) — Plan + SDD gốc M0–M5 (core daemon).
- [docs/SMOKE_TEST_v0.6.md](docs/SMOKE_TEST_v0.6.md) — Runbook smoke-test cho v0.6 (Kiro approval hook bridge).

Mở plan/SDD bằng browser: `open docs/plans/telecode-v1.0-cross-platform-multi-agent.html`.

Tóm tắt stack:
- **Node 22 ESM + TypeScript strict** (engines.node >= 22)
- [grammY](https://grammy.dev) `1.43.0` + `@grammyjs/conversations` `2.1.1` + `@grammyjs/runner` `2.0.3` (Telegram bot, conversation wizard)
- `@anthropic-ai/claude-agent-sdk` `0.3.145` (Claude — in-process SDK, `canUseTool` + hooks + resume)
- `kiro-cli chat --no-interactive` (Kiro — headless streaming, resume-id, HMAC-protected `preToolUse` hook)
- `codex app-server` (Codex — JSON-RPC stdio, native `approvalPolicy` + `sandboxPolicy`)
- `cursor-agent acp` (Cursor — ACP JSON-RPC stdio, `session/request_permission`)
- `better-sqlite3` `12.10.0` WAL (state)
- `pino` `10.3.1` + `pino-roll` `4.0.0` (logs với redact secrets)
- `async-mutex` `0.5.0` (per-session serialization)
- `zod` `4.4.3` + `yaml` `2.9.0` (config validation, `z.record` open-set adapter schema)
- `execa` `9.6.1` (cross-platform child process)
- `vitest` `4.1.7` (432 passing tests)

---

## Known limitations

- **Single user per daemon** — multi-tenant không support. Mỗi người 1 daemon + 1 bot riêng.
- **Sleep / suspend → bot offline** — daemon dùng Telegram long-poll; máy sleep thì daemon pause. Trên Linux dùng `caffeine` / disable suspend, trên Mac dùng `caffeinate -i` hoặc Amphetamine. Trên Windows tắt sleep trong Power Settings. VPS relay mode chưa có.
- **Không có web UI** — quản qua Telegram + edit YAML là chính.
- **Auth là native** — Telecode KHÔNG handle login flow. User phải `codex login` / `cursor-agent login` / `kiro-cli login` từ shell trước khi start daemon. Adapter spawn binary và assume credentials đã ready. Nếu CLI báo unauth → adapter surface error với Vietnamese hint.
- **`/screenshot` Linux** cần ít nhất 1 trong: `grim` (Wayland) / `gnome-screenshot` / `scrot`. Cài qua package manager.
- **Antigravity adapter chưa có** — Google ra mắt 19/05/2026 nhưng CLI **GUI-first**, headless mode chưa support. Đợi 6 tháng review lại. Registry open-set ở v1.0 đủ để add sau không phải re-plan.

Roadmap (v1.1+):
- Gemini CLI adapter (Google ecosystem nhánh, ACP-like protocol).
- Antigravity adapter khi headless mode mature.
- VPS relay mode cho 24/7 (bypass máy sleep).
- Aggregate notification (gộp N events done thành 1).
- Per-event user-configurable notification toggle.

Đóng góp / báo lỗi: tạo issue trong repo này.
