import { describe, it, expect, vi } from 'vitest';
import type { Bot } from 'grammy';
import type { BotCommand } from 'grammy/types';
import {
  COMMANDS,
  applyCommandsAndMenu,
} from '../src/bot/commands-registry.js';
import {
  KEYBOARD_ACTIONS,
  isKeyboardActionText,
  keyboardActionToCommand,
} from '../src/bot/keyboard-actions.js';

describe('commands-registry: COMMANDS', () => {
  it('exports exactly 25 entries', () => {
    // Phase B (v1.1) added /mode + /settings (was 11 in v1.0).
    // v1.2 D3/D4 added /cost + /template.
    // v1.2 D1/D2/D5/D6/D7/D8/D10/D11 added /send + /notify + /schedule + /history + /context + /timeline + /chain + /verify.
    // Per-session model override added /model.
    // v1.2 i18n added /language (24 → 25).
    expect(COMMANDS).toHaveLength(25);
  });

  it('each entry has non-empty command + description', () => {
    for (const cmd of COMMANDS) {
      expect(typeof cmd.command).toBe('string');
      expect(cmd.command.length).toBeGreaterThan(0);
      // Telegram disallows leading slash in `command` (just the bare name).
      expect(cmd.command.startsWith('/')).toBe(false);
      // Telegram limit: command name 1-32 chars, lowercase ascii + underscore.
      expect(cmd.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(typeof cmd.description).toBe('string');
      expect(cmd.description.length).toBeGreaterThan(0);
      // Telegram limit: description 1-256 chars.
      expect(cmd.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('covers the expected command surface from the plan', () => {
    const names = COMMANDS.map((c) => c.command);
    expect(names).toEqual([
      'start',
      'new',
      'sessions',
      'projects',
      'status',
      'dashboard',
      'clear',
      'handoff',
      // Phase B (v1.1) — verbosity controls.
      'mode',
      'settings',
      // v1.2 D3/D4 — cost tracking + templates.
      'cost',
      'template',
      // Per-session model override.
      'model',
      // v1.2 D2/D5/D6/D7/D8/D10/D11 — quiet hours + schedule + history + pinned context + chain + timeline + verify.
      'notify',
      'schedule',
      'history',
      'context',
      'chain',
      'verify',
      'timeline',
      // v1.2 D1 — outbound file sharing.
      'send',
      'stop',
      'screenshot',
      // v1.2 i18n — bilingual UI picker.
      'language',
      'help',
    ]);
  });
});

describe('commands-registry: applyCommandsAndMenu', () => {
  it('calls setMyCommands with the COMMANDS list scoped to all_private_chats, then setChatMenuButton', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true as const);
    const setChatMenuButton = vi.fn().mockResolvedValue(true as const);
    const fakeBot = { api: { setMyCommands, setChatMenuButton } } as unknown as Bot;

    await applyCommandsAndMenu(fakeBot);

    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const [cmdsArg, otherArg] = setMyCommands.mock.calls[0]!;
    expect(cmdsArg).toEqual(COMMANDS);
    // It should be the same array reference (or at least structurally equal)
    // and scope must be private chats only.
    expect(otherArg).toEqual({ scope: { type: 'all_private_chats' } });

    expect(setChatMenuButton).toHaveBeenCalledTimes(1);
    expect(setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: 'commands' },
    });

    // setMyCommands must precede setChatMenuButton — otherwise the menu
    // button could briefly show stale commands.
    expect(setMyCommands.mock.invocationCallOrder[0]!).toBeLessThan(
      setChatMenuButton.mock.invocationCallOrder[0]!,
    );
  });

  it('propagates errors from the underlying api calls', async () => {
    const boom = new Error('telegram down');
    const fakeBot = {
      api: {
        setMyCommands: vi.fn().mockRejectedValue(boom),
        setChatMenuButton: vi.fn().mockResolvedValue(true as const),
      },
    } as unknown as Bot;

    await expect(applyCommandsAndMenu(fakeBot)).rejects.toBe(boom);
  });

  it('passes a BotCommand[]-shaped argument', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true as const);
    const setChatMenuButton = vi.fn().mockResolvedValue(true as const);
    const fakeBot = { api: { setMyCommands, setChatMenuButton } } as unknown as Bot;

    await applyCommandsAndMenu(fakeBot);
    const cmds = setMyCommands.mock.calls[0]![0] as BotCommand[];
    expect(Array.isArray(cmds)).toBe(true);
    expect(cmds.every((c) => 'command' in c && 'description' in c)).toBe(true);
  });
});

describe('keyboard-actions', () => {
  it('maps all 6 reply-keyboard buttons to slash commands', () => {
    expect(Object.keys(KEYBOARD_ACTIONS)).toHaveLength(6);
    expect(KEYBOARD_ACTIONS).toEqual({
      '📋 Sessions': '/sessions',
      '📁 Projects': '/projects',
      '📊 Status': '/status',
      '🛑 Stop': '/stop',
      '📸 Screen': '/screenshot',
      '❓ Help': '/help',
    });
  });

  it('isKeyboardActionText returns true for known buttons', () => {
    expect(isKeyboardActionText('📋 Sessions')).toBe(true);
    expect(isKeyboardActionText('📁 Projects')).toBe(true);
    expect(isKeyboardActionText('❓ Help')).toBe(true);
  });

  it('isKeyboardActionText returns false for non-matches', () => {
    expect(isKeyboardActionText('Sessions')).toBe(false); // no emoji
    expect(isKeyboardActionText('/sessions')).toBe(false);
    expect(isKeyboardActionText('')).toBe(false);
    expect(isKeyboardActionText('hello world')).toBe(false);
    // prototype pollution guard
    expect(isKeyboardActionText('toString')).toBe(false);
    expect(isKeyboardActionText('hasOwnProperty')).toBe(false);
    expect(isKeyboardActionText('__proto__')).toBe(false);
  });

  it('keyboardActionToCommand returns the slash command for known buttons', () => {
    expect(keyboardActionToCommand('📋 Sessions')).toBe('/sessions');
    expect(keyboardActionToCommand('📁 Projects')).toBe('/projects');
    expect(keyboardActionToCommand('📊 Status')).toBe('/status');
    expect(keyboardActionToCommand('🛑 Stop')).toBe('/stop');
    expect(keyboardActionToCommand('📸 Screen')).toBe('/screenshot');
    expect(keyboardActionToCommand('❓ Help')).toBe('/help');
  });

  it('keyboardActionToCommand returns null for non-matches', () => {
    expect(keyboardActionToCommand('Sessions')).toBeNull();
    expect(keyboardActionToCommand('')).toBeNull();
    expect(keyboardActionToCommand('toString')).toBeNull();
    expect(keyboardActionToCommand('__proto__')).toBeNull();
  });

  it('every mapped command exists in the COMMANDS registry', () => {
    const registered = new Set(COMMANDS.map((c) => `/${c.command}`));
    for (const slashCmd of Object.values(KEYBOARD_ACTIONS)) {
      expect(registered.has(slashCmd)).toBe(true);
    }
  });
});
