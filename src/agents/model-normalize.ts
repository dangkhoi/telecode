/**
 * Normalize user-facing model identifiers before passing them to an adapter.
 *
 * Claude Code expects hyphenated model IDs (`claude-opus-4-7`), while
 * Kiro CLI expects dotted IDs (`claude-opus-4.7`). Each adapter calls this
 * with its own `kind` so the correct direction is applied.
 */
export function normalizeModelForAgent(kind: string, model: string | null | undefined): string | null | undefined {
  if (!model) return model;
  if (kind === 'claude') {
    // claude-opus-4.7 → claude-opus-4-7
    return model.replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/i, 'claude-$1-$2-$3');
  }
  if (kind === 'kiro') {
    // claude-opus-4-7 → claude-opus-4.7 (reverse: kiro-cli uses dotted IDs)
    return model.replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i, 'claude-$1-$2.$3');
  }
  return model;
}
