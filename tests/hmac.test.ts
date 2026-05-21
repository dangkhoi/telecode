import { describe, it, expect } from 'vitest';
import {
  generateGateToken,
  verifyGateToken,
  extractBearerToken,
  GATE_TOKEN_BYTES,
} from '../src/util/hmac.js';

describe('P6.1 gate token', () => {
  describe('generateGateToken', () => {
    it('produces 64-character hex (32 bytes)', () => {
      const tok = generateGateToken();
      expect(tok).toMatch(/^[0-9a-f]{64}$/);
      expect(tok.length).toBe(GATE_TOKEN_BYTES * 2);
    });

    it('produces a different token on every call (CSPRNG)', () => {
      const a = generateGateToken();
      const b = generateGateToken();
      const c = generateGateToken();
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    });
  });

  describe('verifyGateToken', () => {
    it('returns true for the matching token', () => {
      const tok = generateGateToken();
      expect(verifyGateToken(tok, tok)).toBe(true);
    });

    it('returns false for a different token', () => {
      const tok = generateGateToken();
      const other = generateGateToken();
      expect(verifyGateToken(tok, other)).toBe(false);
    });

    it('returns false for undefined / null / empty', () => {
      const tok = generateGateToken();
      expect(verifyGateToken(tok, undefined)).toBe(false);
      expect(verifyGateToken(tok, null)).toBe(false);
      expect(verifyGateToken(tok, '')).toBe(false);
    });

    it('returns false for a wrong-length token (early bail before timingSafeEqual throws)', () => {
      const tok = generateGateToken();
      expect(verifyGateToken(tok, tok.slice(0, 32))).toBe(false);
      expect(verifyGateToken(tok, tok + 'aa')).toBe(false);
    });

    it('returns false for a non-string candidate', () => {
      const tok = generateGateToken();
      // Cast through unknown to satisfy the type system — runtime guard is
      // the point of the test.
      expect(verifyGateToken(tok, 123 as unknown as string)).toBe(false);
      expect(verifyGateToken(tok, {} as unknown as string)).toBe(false);
    });

    it('uses constant-time compare (timingSafeEqual via length check sentinel)', () => {
      // Smoke test: equal-length tokens differing only at the LAST byte
      // should still return false (timingSafeEqual scans the whole buffer
      // regardless of where the mismatch is).
      const tok = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde0';
      const tweaked = tok.slice(0, -1) + 'f'; // last char flips 0 → f
      expect(verifyGateToken(tok, tweaked)).toBe(false);
      // And differing at the FIRST byte too.
      const tweaked2 = 'f' + tok.slice(1);
      expect(verifyGateToken(tok, tweaked2)).toBe(false);
    });
  });

  describe('extractBearerToken', () => {
    it('extracts a well-formed Bearer header', () => {
      expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    });

    it('is case-insensitive on the scheme', () => {
      expect(extractBearerToken('bearer abc123')).toBe('abc123');
      expect(extractBearerToken('BEARER abc123')).toBe('abc123');
    });

    it('tolerates extra whitespace', () => {
      expect(extractBearerToken('  Bearer   abc123  ')).toBe('abc123');
    });

    it('returns undefined for missing / wrong scheme', () => {
      expect(extractBearerToken(undefined)).toBeUndefined();
      expect(extractBearerToken('')).toBeUndefined();
      expect(extractBearerToken('Basic abc')).toBeUndefined();
      expect(extractBearerToken('abc123')).toBeUndefined();
    });

    it('uses the first entry when given an array (Node http header repeat)', () => {
      expect(extractBearerToken(['Bearer first', 'Bearer second'])).toBe('first');
    });
  });
});
