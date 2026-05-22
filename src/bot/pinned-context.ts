import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CONTEXT_FILE = '.telecode/context.md';

export function loadPinnedContext(projectPath: string): string | null {
  const filePath = join(projectPath, CONTEXT_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function hasPinnedContext(projectPath: string): boolean {
  return existsSync(join(projectPath, CONTEXT_FILE));
}

export function pinnedContextPath(projectPath: string): string {
  return join(projectPath, CONTEXT_FILE);
}

export function clearPinnedContext(projectPath: string): boolean {
  const filePath = join(projectPath, CONTEXT_FILE);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
