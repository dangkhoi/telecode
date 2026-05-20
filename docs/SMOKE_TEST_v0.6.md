# Smoke test runbook — Telecode v0.6 (Kiro hook bridge)

Mục tiêu: verify rằng kiro-cli ↔ daemon ↔ Telegram approval round-trip hoạt động sau khi pull v0.6.

## 0. Reload daemon

```bash
cd ~/Documents/workspaces/telecode
git pull          # đảm bảo có v0.6 (commit 8b6ddd8 trở đi)
npm install
npm run build
launchctl unload ~/Library/LaunchAgents/dev.telecode.daemon.plist
launchctl load ~/Library/LaunchAgents/dev.telecode.daemon.plist
```

## 1. Verify boot — phải thấy các log sau

```bash
tail -n 200 -f ~/.telecode/logs/telecode.1.log | jq -r '.msg + " " + (.port // .path // "" | tostring)'
```

Expected lines (cờ `telegram bot connected` không emit explicit — daemon "telecode ready" sau khi startBot resolve nghĩa là grammY đã start polling):
```
telecode booting
policy loaded
kiro hook server listening on loopback <port>
kiro telecode agent config written /Users/<you>/.kiro/agents/telecode.json
workspace scan complete
telecode ready
```

Lưu ý log file dùng tên `telecode.1.log` (pino-roll daily rotation), không phải `telecode.log`. File `.log` cha là 0 byte placeholder.

Nếu thấy log `kiro-gate script not found` → `npm run build` chưa chạy / `dist/cli/kiro-gate.js` không tồn tại. Fail-loud assertion (v0.6 fix) — không phải bug daemon, build lại.

Verify stderr không leak token nào (v0.6.1 fix):
```bash
grep -c "bot[0-9]\|sk-ant" ~/.telecode/logs/stderr.log    # phải = 0
```

## 2. Verify Kiro custom agent file

```bash
cat ~/.kiro/agents/telecode.json | jq
```

Expected:
```json
{
  "name": "telecode",
  "tools": ["*"],
  "allowedTools": ["*"],
  "hooks": {
    "preToolUse": [
      { "command": "/Users/<you>/Documents/workspaces/telecode/dist/cli/kiro-gate.js", "timeout_ms": 310000 }
    ]
  }
}
```

- `timeout_ms` = `approval_timeout_sec * 1000 + 10000` (default 310000ms = 5min 10s, broker timeout luôn trigger trước).
- `command` phải trỏ đến file thật, `ls -la <path>` xác nhận có `+x`.

## 3. Smoke test cơ bản qua Telegram

DM bot `@koi_telecode_bun_bot`:

### 3.1 Tạo Kiro session

```
/session new kiro smoke ~/Documents/workspaces/telecode
```

Expected: `📍 Created session [smoke] — agent=kiro, project=telecode`.

### 3.2 Gửi prompt cần read tool (sẽ hỏi approval)

```
đọc file README.md ở project hiện tại và tóm tắt
```

Expected sequence:
1. `[smoke] 🔧 kiro_spawning` (status event)
2. `🛡 Approval needed`
   ```
   Session: smoke
   Tool: read
   Input: {"operations":[{"mode":"...","path":".../README.md"}]}
   ```
   Kèm 3 inline buttons.
3. Tap **Allow once**.
4. Telegram stream output từ kiro-cli (text chunks edit cùng 1 message).
5. Khi xong: `✅ Done` + brief summary.

### 3.3 Test deny

```
/deny "shell(rm*)"
```

Rồi prompt:
```
chạy "rm /tmp/foo" thử (file giả lập, không tồn tại)
```

Expected:
- Bot KHÔNG hiện approval button (deny pattern match).
- kiro-cli nhận stderr "denied by policy (shell(rm*))" → model thấy được → response từ Kiro sẽ là explanation tại sao không chạy được.

### 3.4 Test allow always persist

```
/allow Glob
```

Rồi prompt:
```
list các file .ts trong src/
```

Expected:
- Lần đầu: hỏi approval (vì `Glob` tool chưa trong allow). Tap **Allow always**.
- `cat ~/.telecode/policy.yaml | grep Glob` — phải xuất hiện trong `allow:`.
- Prompt kế cần `Glob` → auto-pass, chỉ thấy `🔧 Glob ...` notify, không button.

### 3.5 Test timeout

Gửi prompt cần unknown tool, ĐỪNG tap button 5+ phút.

Expected sau 5 phút:
- `⏱ Approval timeout — denied`
- Session về trạng thái idle (không stuck).

### 3.6 Test resume

```
/stop                    (nếu đang chạy)
giờ trong README có những section nào?
```

Expected: Kiro nhớ context từ message trước (gọi `--resume-id <uuid>` đã persist từ §3.2).

## 4. Verify SQLite state

```bash
sqlite3 ~/.telecode/state.db "SELECT label, agent, status, sdk_session_id FROM sessions ORDER BY updated_at DESC LIMIT 5;"
sqlite3 ~/.telecode/state.db "SELECT tool_name, decision FROM tool_log ORDER BY id DESC LIMIT 10;"
```

Expected:
- `smoke | kiro | idle | <uuid>` — sdk_session_id present sau §3.2.
- `tool_log` có row `decision = kiro_allow:<rule>` hoặc `kiro_user_allow_once` etc.

## 5. Multi-session parallel (optional stress test)

```
/session new claude task1 ~/Documents/workspaces/telecode
hello, count to 5 slowly
                                  → song song với:
/session new kiro task2 ~/Documents/workspaces/telecode
list 3 .ts files in src/
```

Expected: cả 2 session reply parallel, mỗi message prefix `[task1]` hoặc `[task2]`, mutex per-session không block lẫn nhau.

## 6. Cleanup

```
/session close smoke
/session close task1
/session close task2
```

---

## Checklist final

- [ ] Boot logs đầy đủ 7 lines (§1)
- [ ] `~/.kiro/agents/telecode.json` đúng schema (§2)
- [ ] Approve flow round-trip < 2s (§3.2)
- [ ] Deny pattern bypass policy (§3.3)
- [ ] Allow-always persist `policy.yaml` (§3.4)
- [ ] Timeout auto-deny (§3.5)
- [ ] Resume context (§3.6)
- [ ] SQLite state khớp (§4)
- [ ] 2 session parallel không block (§5, optional)

Báo lại kết quả checklist hoặc bất kỳ step nào fail → mình debug.
