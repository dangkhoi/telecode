import { createServer, type Server } from 'node:http';
import type { SessionStore, ToolLogRow } from '../session/store.js';
import { logger } from '../util/logger.js';

export interface TimelineOpts {
  store: SessionStore;
  port: number;
}

export function startTimelineServer(opts: TimelineOpts): Promise<{ server: Server; port: number }> {
  const { store, port } = opts;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const match = url.pathname.match(/^\/timeline\/([a-f0-9-]+)$/);
    if (!match || !match[1]) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const sessionId = match[1];
    const logs = store.getToolLog(sessionId);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTimelineHtml(sessionId, logs));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      logger.info({ port: actualPort }, 'timeline server listening');
      resolve({ server, port: actualPort });
    });
  });
}

function renderTimelineHtml(sessionId: string, logs: ToolLogRow[]): string {
  const rows = logs
    .map((log) => {
      const time = new Date(log.created_at).toLocaleTimeString();
      const duration = log.duration_ms != null ? `${log.duration_ms}ms` : '';
      const decision = log.decision ?? '';
      const color =
        decision === 'allow_once' || decision === 'allow_always'
          ? '#4caf50'
          : decision === 'deny'
            ? '#f44336'
            : '#2196f3';
      return `
      <div class="entry" style="border-left: 3px solid ${color}">
        <div class="time">${time} ${duration ? `(${duration})` : ''}</div>
        <div class="tool">🛠️ ${escapeHtml(log.tool_name)}</div>
        ${log.input_preview ? `<div class="preview">${escapeHtml(log.input_preview)}</div>` : ''}
        ${decision ? `<div class="decision">${decision}</div>` : ''}
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Timeline: ${sessionId.slice(0, 8)}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; background: #1a1a2e; color: #eee; }
  h1 { font-size: 1.2rem; color: #64b5f6; }
  .entry { margin: 0.5rem 0; padding: 0.5rem 1rem; background: #16213e; border-radius: 4px; }
  .time { font-size: 0.8rem; color: #888; }
  .tool { font-weight: bold; margin: 0.2rem 0; }
  .preview { font-size: 0.85rem; color: #aaa; white-space: pre-wrap; max-height: 100px; overflow: auto; }
  .decision { font-size: 0.8rem; color: #ffd54f; }
  .empty { color: #888; font-style: italic; }
</style>
</head><body>
<h1>📜 Timeline: ${sessionId.slice(0, 8)}…</h1>
${logs.length === 0 ? '<p class="empty">No tool events recorded.</p>' : rows}
<p style="color:#666;font-size:0.75rem;margin-top:2rem">Generated ${new Date().toISOString()}</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { escapeHtml as _escapeHtml };
