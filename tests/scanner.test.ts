import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspaces } from '../src/util/workspace-scanner.js';

describe('workspace scanner', () => {
  it('finds depth-1 dirs and skips excludes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    try {
      mkdirSync(join(root, 'proj-a'));
      mkdirSync(join(root, 'proj-b'));
      mkdirSync(join(root, 'node_modules'));
      mkdirSync(join(root, '.git'));
      const out = scanWorkspaces({ roots: [root], maxDepth: 1, exclude: ['node_modules', '.git'] });
      const names = out.map((o) => o.name).sort();
      expect(names).toEqual(['proj-a', 'proj-b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty for non-existent root', () => {
    const out = scanWorkspaces({ roots: ['/nonexistent-xyz-abc'], maxDepth: 1, exclude: [] });
    expect(out).toEqual([]);
  });
});
