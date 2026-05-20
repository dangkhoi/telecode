#!/usr/bin/env node
/**
 * telecode-kiro-gate
 *
 * Tiny shim called by kiro-cli's `preToolUse` hook (from the Telecode-managed
 * custom agent at ~/.kiro/agents/telecode.json). Reads the hook event JSON from
 * stdin, forwards it to the running Telecode daemon over loopback HTTP, and
 * exits 0 (allow), 2 (block — kiro-cli will surface STDERR back to the model),
 * or non-zero (warn). Output to STDERR becomes the deny reason visible to the
 * LLM, so on deny we print a short, model-readable message.
 *
 * Required env (set by the kiro adapter when it spawns kiro-cli):
 *   TELECODE_GATE_URL      e.g. http://127.0.0.1:8787/kiro-hook
 *   TELECODE_SESSION_ID    the telecode-side session UUID
 *
 * The hook command in the agent config is the absolute path to this script.
 */
import { stdin } from 'node:process';

const url = process.env.TELECODE_GATE_URL;
const telecodeSessionId = process.env.TELECODE_SESSION_ID;

async function readStdin(): Promise<string> {
  let data = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) data += chunk;
  return data;
}

async function main(): Promise<void> {
  if (!url || !telecodeSessionId) {
    // Be permissive when the gate isn't configured — failing closed would break
    // any direct (non-telecode) invocation of the custom agent. Warn via STDERR
    // so kiro-cli logs it, but exit 0 (allow).
    process.stderr.write('[telecode-kiro-gate] missing TELECODE_GATE_URL or TELECODE_SESSION_ID — allowing\n');
    process.exit(0);
  }

  const payloadRaw = await readStdin();
  let payload: unknown;
  try {
    payload = payloadRaw.trim() ? JSON.parse(payloadRaw) : {};
  } catch {
    process.stderr.write('[telecode-kiro-gate] hook stdin was not JSON\n');
    process.exit(0);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telecode-session': telecodeSessionId,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    process.stderr.write(`[telecode-kiro-gate] daemon unreachable: ${String(err)} — denying for safety\n`);
    process.exit(2);
  }

  if (res.status === 204 || res.status === 200) {
    const body = await res.text().catch(() => '');
    const decision = res.headers.get('x-telecode-decision') ?? body.trim() ?? 'allow';
    if (decision === 'deny') {
      const reason = res.headers.get('x-telecode-reason') ?? (body || 'denied by Telecode policy');
      process.stderr.write(reason + '\n');
      process.exit(2);
    }
    process.exit(0);
  }

  const detail = await res.text().catch(() => `HTTP ${res.status}`);
  process.stderr.write(`[telecode-kiro-gate] daemon returned ${res.status}: ${detail.slice(0, 300)}\n`);
  // Treat unknown daemon responses as deny — fail closed.
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`[telecode-kiro-gate] fatal: ${String(err)}\n`);
  process.exit(2);
});
