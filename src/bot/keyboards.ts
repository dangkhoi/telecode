import { InlineKeyboard } from 'grammy';

export function approvalKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Allow once', `apv:once:${requestId}`)
    .text('🌟 Allow always', `apv:always:${requestId}`)
    .row()
    .text('🚫 Deny', `apv:deny:${requestId}`);
}

export function sessionPickKeyboard(items: { id: string; label: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  let count = 0;
  for (const it of items) {
    kb.text(it.label, `ses:switch:${it.id}`);
    count++;
    if (count % 2 === 0) kb.row();
  }
  return kb;
}
