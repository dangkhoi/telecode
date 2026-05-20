import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../src/util/scrub.js';

describe('scrubSecrets', () => {
  it('redacts telegram bot tokens', () => {
    const s = 'token=1234567890:ABCdefghijKLMnopqrstUVWxyz1234567ab here';
    expect(scrubSecrets(s)).toContain('[REDACTED-TG]');
    expect(scrubSecrets(s)).not.toContain('ABCdefghij');
  });
  it('redacts anthropic api keys', () => {
    const s = 'key=sk-ant-api01-AAAA-BBBB-CCCC-1234567890 done';
    expect(scrubSecrets(s)).toContain('[REDACTED-ANTHROPIC]');
  });
  it('redacts github tokens', () => {
    const s = 'ghp_' + 'A'.repeat(36);
    expect(scrubSecrets(s)).toContain('[REDACTED-GH]');
  });
  it('passes through innocuous text', () => {
    expect(scrubSecrets('hello world')).toBe('hello world');
  });
});
