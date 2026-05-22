import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPinnedContext,
  hasPinnedContext,
  pinnedContextPath,
  clearPinnedContext,
} from '../src/bot/pinned-context.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telecode-pinctx-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadPinnedContext', () => {
  it('returns null when .telecode/context.md does not exist', () => {
    expect(loadPinnedContext(tmpDir)).toBeNull();
  });

  it('returns content when file exists', () => {
    const dir = join(tmpDir, '.telecode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.md'), 'This is project context.\nLine 2.');
    expect(loadPinnedContext(tmpDir)).toBe('This is project context.\nLine 2.');
  });

  it('returns null for empty file', () => {
    const dir = join(tmpDir, '.telecode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.md'), '   \n  ');
    expect(loadPinnedContext(tmpDir)).toBeNull();
  });
});

describe('hasPinnedContext', () => {
  it('returns false when file does not exist', () => {
    expect(hasPinnedContext(tmpDir)).toBe(false);
  });

  it('returns true when file exists', () => {
    const dir = join(tmpDir, '.telecode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.md'), 'hello');
    expect(hasPinnedContext(tmpDir)).toBe(true);
  });
});

describe('pinnedContextPath', () => {
  it('returns correct path', () => {
    expect(pinnedContextPath('/foo/bar')).toBe('/foo/bar/.telecode/context.md');
  });
});

describe('clearPinnedContext', () => {
  it('returns false when file does not exist', () => {
    expect(clearPinnedContext(tmpDir)).toBe(false);
  });

  it('deletes file and returns true', () => {
    const dir = join(tmpDir, '.telecode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.md'), 'hello');
    expect(clearPinnedContext(tmpDir)).toBe(true);
    expect(hasPinnedContext(tmpDir)).toBe(false);
  });
});
