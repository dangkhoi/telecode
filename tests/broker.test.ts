import { describe, it, expect, vi } from 'vitest';
import { ApprovalBroker } from '../src/approval/broker.js';

describe('ApprovalBroker', () => {
  it('resolves when decision arrives', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 5000 });
    broker.attach({ prompt: async () => undefined });
    const p = broker.ask({
      sessionId: 's1',
      chatId: 1,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'lab',
    });
    // grab the id from internal map
    const pending = broker.pendingForSession('s1');
    expect(pending.length).toBe(1);
    broker.resolve(pending[0]!.id, 'allow_once');
    await expect(p).resolves.toBe('allow_once');
  });

  it('times out and returns "timeout"', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    broker.attach({ prompt: async () => undefined });
    const p = broker.ask({
      sessionId: 's2',
      chatId: 1,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'lab',
    });
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe('timeout');
    vi.useRealTimers();
  });

  it('calls notifyTimeout on prompter when timing out', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    const notifyTimeout = vi.fn(async () => undefined);
    broker.attach({ prompt: async () => undefined, notifyTimeout });
    const p = broker.ask({
      sessionId: 's4',
      chatId: 1,
      toolName: 'Bash',
      input: { command: 'ls' },
      inputPreview: 'ls',
      sessionLabel: 'lab',
    });
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe('timeout');
    expect(notifyTimeout).toHaveBeenCalledOnce();
    expect(notifyTimeout.mock.calls[0]![0]!.sessionLabel).toBe('lab');
    vi.useRealTimers();
  });

  it('returns deny when no prompter attached', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 5000 });
    const p = broker.ask({
      sessionId: 's3',
      chatId: 1,
      toolName: 'Bash',
      input: {},
      inputPreview: '',
      sessionLabel: 'l',
    });
    await expect(p).resolves.toBe('deny');
  });
});
