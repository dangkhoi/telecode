import { readdirSync, statSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { expandHome } from './paths.js';

export interface ScanResult {
  name: string;
  path: string;
}

export interface ScanOptions {
  roots: string[];
  maxDepth: number;
  exclude: string[];
}

export function scanWorkspaces(opts: ScanOptions): ScanResult[] {
  const out: ScanResult[] = [];
  const seen = new Set<string>();
  for (const rawRoot of opts.roots) {
    const root = expandHome(rawRoot);
    if (!existsSync(root)) continue;
    walk(root, 0, opts.maxDepth, opts.exclude, out, seen);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  exclude: string[],
  out: ScanResult[],
  seen: Set<string>,
): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (exclude.includes(name)) continue;
    const full = resolve(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    // record this directory as a candidate project (entries within roots count as projects)
    if (!seen.has(full)) {
      seen.add(full);
      out.push({ name: basename(full), path: full });
    }
    if (depth + 1 < maxDepth) {
      walk(full, depth + 1, maxDepth, exclude, out, seen);
    }
  }
}
