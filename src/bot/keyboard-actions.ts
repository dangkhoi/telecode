/**
 * Maps the persistent reply-keyboard button TEXT to the slash command it
 * triggers. Keys are the exact emoji+label visible to the user; values are
 * the canonical slash-command string the bot middleware should dispatch as if
 * the user had typed it manually.
 *
 * Why exact-string mapping?
 * - Telegram delivers reply-keyboard taps as ordinary `message:text`
 *   updates. There is no callback_data for them — the text IS the signal.
 * - Using an emoji prefix (vd `📋 Sessions`) ensures users who type the word
 *   `Sessions` by hand do NOT accidentally trigger the command. Match must
 *   be exact.
 *
 * Kept in sync with the 6 buttons rendered by
 * `reply-builders.ts::buildPersistentKeyboard()` (§4.2 of plan).
 */
export const KEYBOARD_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  '📋 Sessions': '/sessions',
  '📁 Projects': '/projects',
  '📊 Status': '/status',
  '🛑 Stop': '/stop',
  '📸 Screen': '/screenshot',
  '❓ Help': '/help',
});

/**
 * True iff `text` exactly matches a reply-keyboard button. Uses
 * `Object.prototype.hasOwnProperty` to avoid prototype-pollution false
 * positives (e.g. someone sending the literal string `"toString"`).
 */
export function isKeyboardActionText(text: string): boolean {
  return Object.prototype.hasOwnProperty.call(KEYBOARD_ACTIONS, text);
}

/**
 * Returns the slash-command string for a reply-keyboard tap, or `null` when
 * `text` is not a known button. Callers should then dispatch the returned
 * command through the same path as a typed slash command.
 */
export function keyboardActionToCommand(text: string): string | null {
  return isKeyboardActionText(text) ? (KEYBOARD_ACTIONS[text] ?? null) : null;
}
