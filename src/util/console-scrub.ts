import { scrubSecrets } from './scrub.js';

/**
 * Install a process-wide stdout/stderr write hook that scrubs known secret
 * patterns BEFORE bytes hit launchd's StandardOutPath / StandardErrorPath.
 *
 * Why: dependencies (grammy, @grammyjs/runner, node-fetch) log error messages
 * via `console.error(err)` — which serialises FetchError objects whose
 * `.message` field contains the full request URL including the bot token
 * (`https://api.telegram.org/bot<TOKEN>/getUpdates failed`). Our pino logger
 * redact list and the Telegram notifier scrub do NOT see those writes, so the
 * token leaks unredacted into ~/.telecode/logs/stderr.log.
 *
 * Hooking the raw streams catches both `console.error`/`console.log` paths
 * (which write to process.stdout/stderr) and any library writing directly.
 *
 * Idempotent — calling twice is a no-op.
 */
let installed = false;

export function installConsoleScrub(): void {
  if (installed) return;
  installed = true;

  for (const stream of [process.stdout, process.stderr] as const) {
    const orig = stream.write.bind(stream) as (
      chunk: unknown,
      encoding?: unknown,
      cb?: unknown,
    ) => boolean;

    // Replace .write so any caller (console.*, raw stream writes, etc.) flows
    // through the scrubber. Bypass when the chunk isn't string-like (e.g. a
    // Buffer of binary data — unlikely on stdout/stderr but be safe).
    (stream as unknown as { write: typeof orig }).write = ((
      chunk: unknown,
      encoding?: unknown,
      cb?: unknown,
    ): boolean => {
      if (typeof chunk === 'string') {
        return orig(scrubSecrets(chunk), encoding, cb);
      }
      if (chunk instanceof Uint8Array) {
        try {
          const decoded = Buffer.from(chunk).toString('utf8');
          const scrubbed = scrubSecrets(decoded);
          if (scrubbed !== decoded) {
            return orig(scrubbed, 'utf8', cb);
          }
        } catch {
          /* fall through and write original */
        }
      }
      return orig(chunk, encoding, cb);
    }) as typeof orig;
  }
}
