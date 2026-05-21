import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * P6.1 — Per-boot shared-secret token for the loopback Kiro hook bridge.
 *
 * Threat model: the Kiro hook server binds to 127.0.0.1 and accepts POST
 * requests from kiro-cli's preToolUse hook (via the `kiro-gate` shim). On a
 * single host, ANY process running under the same UID can reach this port and
 * spoof a tool-approval payload. Without auth, a hostile local process could
 * convince the Telecode daemon to escalate writes/exec for an unrelated Kiro
 * session.
 *
 * Decision (plan §9 P6.1 + Context7 verified): shared-secret token, not full
 * HMAC. We only need to verify identity (caller knows the secret), not the
 * integrity of the request body — the loopback bind already pins origin to
 * the host, and integrity over plain HTTP would require TLS anyway. The
 * token travels in an `Authorization: Bearer …` header.
 *
 *  * `generateGateToken()` is called once per daemon boot; the resulting hex
 *    string lives in process memory + the spawn env (`TELECODE_GATE_TOKEN`)
 *    for kiro-cli. It never touches disk.
 *  * `verifyGateToken()` does a length-checked constant-time compare via
 *    `crypto.timingSafeEqual` so we don't leak the secret byte-by-byte via
 *    response timing.
 *
 * Node 22 LTS surface used: `node:crypto` `randomBytes` + `timingSafeEqual`
 * — both stable, no deprecations (verified via Context7
 * `/websites/nodejs_latest-v22_x_api`).
 */
export const GATE_TOKEN_BYTES = 32;

/**
 * Generate a fresh per-boot gate token. 32 bytes of CSPRNG output rendered as
 * hex (64-char string) — comfortably above the 128-bit security floor while
 * fitting cleanly into an HTTP header and a JSON config field.
 */
export function generateGateToken(): string {
  return randomBytes(GATE_TOKEN_BYTES).toString('hex');
}

/**
 * Constant-time comparison of an expected token against an incoming header
 * value. Returns `false` for `undefined` / non-string / wrong-length inputs
 * BEFORE the timing-safe compare (length mismatch on `timingSafeEqual` would
 * throw — and the throw itself is timing-observable). The early returns leak
 * only "header missing" vs "header wrong" — both already public via response
 * body — so they don't widen the side channel.
 */
export function verifyGateToken(expected: string, candidate: string | undefined | null): boolean {
  if (typeof candidate !== 'string') return false;
  if (candidate.length !== expected.length) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Extract the bearer token from an `Authorization` header value. Returns
 * `undefined` for missing, malformed, or non-Bearer schemes. Case-insensitive
 * on the scheme per RFC 7235 §2.1.
 */
export function extractBearerToken(headerValue: string | string[] | undefined): string | undefined {
  if (Array.isArray(headerValue)) headerValue = headerValue[0];
  if (typeof headerValue !== 'string') return undefined;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return m ? m[1] : undefined;
}
