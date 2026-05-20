# Telecode

> Chat với Claude Code / Kiro trên máy Mac của bạn qua Telegram. Vibecode mọi lúc mọi nơi.

Telecode là 1 local daemon chạy nền trên Mac, bắc cầu giữa Telegram và các coding agent (**Claude Code**, **Kiro**) đã cài sẵn trên máy. Bạn gửi prompt từ điện thoại → agent thực thi trên Mac → kết quả stream về Telegram. Khi agent muốn chạy lệnh nguy hiểm, bạn nhận inline button approve/deny ngay trong chat.

- **Multi-session song song**: vd "Claude #1 refactor module A" + "Claude #2 viết test cho module B" + "Kiro fix bug ở project khác", tất cả chạy parallel, không block lẫn nhau.
- **Approval an toàn**: policy engine + `canUseTool` callback. Tool an toàn auto-allow + notify; tool nguy hiểm hỏi qua Telegram inline button.
- **Single-user**: chỉ Telegram user_id của bạn mới interact được.
- **Resume session**: mỗi project có session id riêng, context không mất khi bot restart.

**Status**: v0.4 (M0–M5 ship-ready, macOS only — launchd).

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
- [Bảng lệnh đầy đủ](#bảng-lệnh-đầy-đủ)
- [Policy & Approval](#policy--approval)
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
| macOS | 13 (Ventura) trở lên | `sw_vers -productVersion` |
| Node.js | **22 LTS** | `node -v` |
| npm | đi kèm Node 22 | `npm -v` |
| `claude` CLI | 2.1+ | `which claude && claude --version` |
| `kiro` CLI (optional) | 0.12+ | `which kiro && kiro --version` |
| Telegram account | bất kỳ | — |

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

**Cài Kiro** (nếu muốn dùng song song): tải từ https://kiro.dev → mở `.dmg` → kéo vào `/Applications` → mở Kiro 1 lần để nó cài CLI shim. Test bằng `kiro --version`.

Không có Kiro vẫn dùng được — Telecode tự skip kiro adapter.

---

## Cài đặt từng bước

### 1. Clone repo

```bash
git clone https://git2.fptshop.com.vn/frt-public-projects/toys/telecode.git ~/Documents/workspaces/telecode
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
   ├ id: 675265747
   ├ is_bot: false
   ├ first_name: ...
   └ username: ...
   ```
3. **Copy `id`** (chuỗi số). Đây là Telegram user_id của bạn.

### 4. Chạy installer

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
6. `npm install && npm run build`.
7. Generate `~/Library/LaunchAgents/dev.telecode.daemon.plist`.
8. `launchctl load` + start.

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
  allowed_user_ids: [675265747]    # ← THAY bằng user_id của BẠN (lấy ở bước 3)

daemon:
  workspace_scan:
    roots: [~/Documents/workspaces]  # ← Đường dẫn folder chứa các project của bạn
```

Reload daemon để pick up config mới:
```bash
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

### 5. Kiểm tra daemon chạy

```bash
# Xem process có running chưa
launchctl list | grep telecode

# Tail log realtime
tail -f ~/.telecode/logs/telecode.log
```

Bạn nên thấy log kiểu:
```
{"level":"info","msg":"telecode starting","version":"0.4.0"}
{"level":"info","msg":"workspace scan complete","projects":12}
{"level":"info","msg":"telegram bot connected","username":"khoa_telecode_bot"}
```

Nếu không thấy → xem [Troubleshooting](#troubleshooting).

---

## Smoke test đầu tiên

1. Trong Telegram, search bot của bạn theo username (vd `@khoa_telecode_bot`), bấm **Start**.
2. Gửi `/start`. Bot reply welcome + list session.
3. Gửi `/projects`. Bot list tất cả project nó scan được từ `~/Documents/workspaces/`.
4. Tạo session:
   ```
   /session new claude smoke ~/Documents/workspaces/telecode
   ```
   Bot reply: `📍 Created session [smoke] — agent=claude, project=telecode`.
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

```
/session new claude refactor-auth ~/work/api
/session new claude debug ~/work/api          # cùng project, session khác
/session new kiro mobile-ui ~/work/mobile
```

### Liệt kê + switch nhanh

```
/session list
```

Bot reply kèm inline keyboard với từng session — tap để switch (không cần gõ tên).

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

Khi Claude muốn chạy tool ngoài policy (vd `gh pr create`, `npm install <pkg-mới>`):

```
🛡 Approval needed
Session: refactor-auth
Tool: Bash
Input: gh pr create --title "..."

[Allow once] [Allow always] [Deny]
```

- **Allow once**: cho lần này thôi.
- **Allow always**: append pattern vào `~/.telecode/policy.yaml` allow list → lần sau auto-pass.
- **Deny**: reject + Claude báo lỗi back.

Không tap trong 5 phút → auto-deny + Telegram báo `⏱ timeout, denied`.

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

## Bảng lệnh đầy đủ

| Command | Mô tả |
| --- | --- |
| **Session** | |
| `/session new <agent> <label> [path]` | `claude` hoặc `kiro`. Path mặc định = project active. |
| `/session list` | List sessions + inline keyboard switch. |
| `/session switch <label>` | Đổi active session + show 3 dòng context cuối. |
| `/session rename <new-label>` | Đổi tên session active. |
| `/session close [label]` | Đóng session (mặc định = active). |
| `/session reset` | Giữ label, wipe resume id. |
| **Project** | |
| `/projects` | List project đã register. |
| `/add <path> [name]` | Register path làm project. |
| `/cd <name\|path>` | Đổi project cho session active. |
| **Control** | |
| `/stop` | Interrupt task đang chạy. |
| `/status` | Active session, agent, project, last 5 tool calls. |
| `/status logs [n]` | Tail n tool calls (default 20). |
| `/allow <pattern>` | Append pattern vào policy allow. |
| `/deny <pattern>` | Append pattern vào policy deny. |
| `/screenshot` | Chụp desktop gửi về (cần Screen Recording perm). |
| `<plain text>` | Dispatch vào active session. |

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

---

## Logs & debugging

| File | Mô tả |
| --- | --- |
| `~/.telecode/logs/telecode.log` | pino structured logs, daily rotation, retention 7 ngày |
| `~/.telecode/logs/stdout.log` | launchd-captured stdout |
| `~/.telecode/logs/stderr.log` | launchd-captured stderr |
| `~/.telecode/state.db` | SQLite WAL (sessions, projects, tool_log, approvals) |

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

```bash
launchctl list | grep telecode
# Nếu không thấy → reload thủ công:
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
# Xem error:
cat ~/.telecode/logs/stderr.log
```

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

### `/screenshot` báo lỗi permission

macOS cần Screen Recording permission cho `screencapture`:
- System Settings → Privacy & Security → Screen & System Audio Recording
- Add `node` (path: `which node`) hoặc terminal app bạn dùng để chạy launchctl.

### `/session new kiro ...` không mở IDE

```bash
# Kiro CLI có không?
which kiro
kiro chat --help
```

Nếu không có → cài Kiro (xem [Yêu cầu máy](#yêu-cầu-máy)).

### Daemon crash loop

```bash
tail -50 ~/.telecode/logs/stderr.log
```

Thường do:
- `~/.telecode/config.yaml` syntax YAML sai → validate bằng `python3 -c "import yaml; yaml.safe_load(open('$HOME/.telecode/config.yaml'))"`.
- Port conflict (không có port vì daemon dùng long-poll, không listen).
- SQLite lock — check `~/.telecode/state.db-wal` và `state.db-shm` còn dính sau crash không, xóa nếu cần.

### Macbook sleep → bot offline

Bot dùng long-poll qua Telegram API, máy sleep thì daemon pause. Options:
- `caffeinate -i` chạy trong terminal khi cần online dài hạn.
- Cài [Amphetamine](https://apps.apple.com/app/amphetamine/id937984704) — keep awake on demand.
- Tương lai: deploy daemon lên VPS (chưa support v0.4).

---

## Update Telecode

```bash
cd ~/Documents/workspaces/telecode
git pull
npm install
npm run build
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

Config + policy + DB ở `~/.telecode/` giữ nguyên qua update.

---

## Uninstall

```bash
cd ~/Documents/workspaces/telecode
./scripts/uninstall-launchd.sh
```

Script này chỉ **stop daemon + remove LaunchAgent plist**. `~/.telecode/` (config, token, DB, log) **được giữ lại** để bạn install lại sau không mất setup.

Nếu muốn xóa sạch:
```bash
rm -rf ~/.telecode/
# Optional: revoke bot
# → @BotFather → /mybots → chọn bot → Delete Bot
```

---

## Kiến trúc & tài liệu

- [docs/plans/telegram-bridge.html](docs/plans/telegram-bridge.html) — Plan v0.4 (mục tiêu, kiến trúc, milestones, risk register).
- [docs/design/telegram-bridge.html](docs/design/telegram-bridge.html) — SDD (design decisions, tech freshness, scope completeness, verification).

Mở bằng browser: `open docs/plans/telegram-bridge.html`.

Tóm tắt stack:
- Node 22 ESM + TypeScript strict
- [grammY](https://grammy.dev) + `@grammyjs/runner` (Telegram bot)
- `@anthropic-ai/claude-agent-sdk` (Claude integration, `canUseTool` + hooks + resume)
- `kiro chat --mode agent` (Kiro integration via CLI spawn)
- `better-sqlite3` WAL (state)
- `pino` + `pino-roll` (logs)
- `async-mutex` (per-session serialization)
- `zod` + `yaml` (config validation)

---

## Known limitations

- **macOS only** (launchd). Linux/Windows hỗ trợ sau (cần systemd / service manager).
- **Single user per daemon** — multi-tenant không support. Mỗi người 1 daemon + 1 bot riêng.
- **Kiro output không stream về Telegram** — phase 1 fire-and-notify, mở Kiro IDE để xem agent run.
- **Mac sleep → bot offline** — chưa có VPS relay mode.
- **Không có web UI** — quản qua Telegram + edit YAML là chính.

Roadmap ngắn:
- Kiro log-tail stream-back (stretch).
- Linux/systemd support.
- VPS relay mode cho 24/7.
- Cursor / Codex adapter qua interface chung.

Đóng góp / báo lỗi: tạo issue trong repo này.
