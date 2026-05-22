import { describe, it, expect, afterEach } from 'vitest';
import { startTimelineServer, _escapeHtml } from '../src/bot/timeline.js';
import type { Server } from 'node:http';
import type { ToolLogRow } from '../src/session/store.js';

function makeStore(logs: ToolLogRow[] = []) {
  return { getToolLog: (_id: string) => logs } as any;
}

describe('timeline server', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('starts and responds on /timeline/:id', async () => {
    const logs: ToolLogRow[] = [
      { id: 1, session_id: 'abc-123', tool_name: 'Read', input_preview: 'src/index.ts', decision: 'allow_once', duration_ms: 50, created_at: Date.now() },
    ];
    const result = await startTimelineServer({ store: makeStore(logs), port: 0 });
    server = result.server;
    expect(result.port).toBeGreaterThan(0);

    const resp = await fetch(`http://127.0.0.1:${result.port}/timeline/abc-123`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const html = await resp.text();
    expect(html).toContain('Timeline: abc-123');
    expect(html).toContain('Read');
    expect(html).toContain('src/index.ts');
    expect(html).toContain('allow_once');
  });

  it('returns empty state when no logs', async () => {
    const result = await startTimelineServer({ store: makeStore([]), port: 0 });
    server = result.server;

    const resp = await fetch(`http://127.0.0.1:${result.port}/timeline/abc-def-00000000`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('No tool events recorded');
  });

  it('returns 404 for unknown routes', async () => {
    const result = await startTimelineServer({ store: makeStore(), port: 0 });
    server = result.server;

    const resp = await fetch(`http://127.0.0.1:${result.port}/unknown`);
    expect(resp.status).toBe(404);
  });

  it('returns 404 for invalid session id format', async () => {
    const result = await startTimelineServer({ store: makeStore(), port: 0 });
    server = result.server;

    const resp = await fetch(`http://127.0.0.1:${result.port}/timeline/INVALID`);
    expect(resp.status).toBe(404);
  });
});

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(_escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersands', () => {
    expect(_escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('handles empty string', () => {
    expect(_escapeHtml('')).toBe('');
  });
});
