/**
 * Vietnamese message catalog. MUST implement every key from
 * {@link ./en.ts EN_MESSAGES} — enforced at compile time by typing this
 * record as `MessageCatalog` in `../index.ts`.
 *
 * Editing rules: see ../messages/en.ts header. Keep emoji + Markdown layout
 * IDENTICAL to the EN counterpart so the rendered Telegram bubbles look the
 * same shape across locales (only the words change).
 */
import type { EnMessages } from './en.js';

export const VI_MESSAGES: EnMessages = {
  // ---- /start welcome ---------------------------------------------------
  'start.welcome.title': '👋 *Telecode* đã online',
  'start.activeSession': 'Active: `{label}`',
  'start.noActiveSession': 'Active: (chưa có — `/session new`)',
  'start.sessionsCount': 'Sessions: {count}',
  'start.commandsHint':
    'Lệnh: `/session`, `/projects`, `/cd`, `/stop`, `/status`, `/allow`, `/deny`, `/screenshot`',

  // ---- Language picker (first-boot + /language) -------------------------
  'language.picker.prompt':
    '🌐 *Choose your language* / *Chọn ngôn ngữ*\n\nChỉ ảnh hưởng tới message của bot. Đổi bất kỳ lúc nào qua `/language`.',
  'language.picker.button.en': '🇬🇧 English',
  'language.picker.button.vi': '🇻🇳 Tiếng Việt',
  'language.changed': '✅ Đã đặt ngôn ngữ thành *Tiếng Việt*.',
  'language.current':
    'Ngôn ngữ hiện tại: *Tiếng Việt* (`vi`).\nGõ `/language` rồi chọn để đổi.',
  'language.invalid': 'Ngôn ngữ `{value}` không hợp lệ. Dùng buttons ở trên.',

  // ---- v1.1 verbosity migration note (sent after language pick) ---------
  'verbosity.migrationNote':
    '📢 *Telecode v1.1* — verbosity modes\n\n' +
    'Mode mặc định giờ là 🎯 *Summary* — chỉ show approval + done + errors.\n\n' +
    'Muốn behavior cũ (verbose firehose):\n' +
    '  • `/mode verbose`           — chỉ áp dụng cho session active\n' +
    '  • `/settings mode verbose`  — đặt làm default cho cả chat\n\n' +
    'Đổi mode bất kỳ lúc nào qua slash menu (`/mode`, `/settings`).',
};
