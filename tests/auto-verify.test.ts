import { describe, it, expect } from 'vitest';
import { runVerifyCommand, shouldAutoVerify, buildRetryPrompt } from '../src/bot/auto-verify.js';

describe('auto-verify', () => {
  describe('runVerifyCommand', () => {
    it('returns passed=true for a successful command', async () => {
      const result = await runVerifyCommand('echo ok', process.cwd());
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
    });

    it('returns passed=false for a failing command', async () => {
      const result = await runVerifyCommand('exit 1', process.cwd());
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('returns passed=false with stderr for a command that writes to stderr', async () => {
      const result = await runVerifyCommand('echo fail >&2 && exit 2', process.cwd());
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.trim()).toBe('fail');
    });

    it('handles timeout gracefully', async () => {
      const result = await runVerifyCommand('sleep 10', process.cwd(), 100);
      expect(result.passed).toBe(false);
    });
  });

  describe('shouldAutoVerify', () => {
    it('returns true when agents list is empty (all match)', () => {
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: [] }, 'claude')).toBe(true);
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: [] }, 'kiro')).toBe(true);
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: [] }, 'codex')).toBe(true);
    });

    it('returns true when agent is in the list', () => {
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: ['claude', 'kiro'] }, 'claude')).toBe(true);
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: ['claude', 'kiro'] }, 'kiro')).toBe(true);
    });

    it('returns false when agent is not in the list', () => {
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: ['claude'] }, 'kiro')).toBe(false);
      expect(shouldAutoVerify({ command: 'test', maxRetries: 3, agents: ['kiro', 'codex'] }, 'claude')).toBe(false);
    });
  });

  describe('buildRetryPrompt', () => {
    it('includes attempt info, command, and exit code', () => {
      const result = { passed: false, stdout: 'FAIL test.ts', stderr: '', exitCode: 1 };
      const prompt = buildRetryPrompt('pnpm test', result, 1, 3);
      expect(prompt).toContain('attempt 1/3');
      expect(prompt).toContain('`pnpm test`');
      expect(prompt).toContain('Exit code: 1');
      expect(prompt).toContain('FAIL test.ts');
      expect(prompt).toContain('Please fix the failing tests');
    });

    it('truncates output longer than 2000 chars', () => {
      const longOutput = 'x'.repeat(3000);
      const result = { passed: false, stdout: longOutput, stderr: '', exitCode: 1 };
      const prompt = buildRetryPrompt('pnpm test', result, 2, 5);
      expect(prompt).toContain('attempt 2/5');
      expect(prompt).toContain('…');
      // The truncated portion should be at most 2000 chars of the original
      const outputSection = prompt.split('```\n')[1]!;
      expect(outputSection.length).toBeLessThanOrEqual(2100); // 2000 + '…' + some overhead
    });

    it('does not truncate short output', () => {
      const result = { passed: false, stdout: 'short error', stderr: 'detail', exitCode: 1 };
      const prompt = buildRetryPrompt('npm test', result, 1, 3);
      expect(prompt).toContain('short error');
      expect(prompt).toContain('detail');
      expect(prompt).not.toContain('…');
    });
  });
});
