import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./government-transport.py', import.meta.url));
const safeError = /^upstream_(timeout|tls_failed|dns_failed|connection_failed)$/;

// Keep query credentials out of process arguments, exceptions and CI logs.
// Only scheduled collectors use this adapter; browser APIs keep their auth gate.
export function governmentFetch(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    function abort() {
      child.kill();
      finish(new Error('upstream_timeout'));
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on('error', () => finish(new Error('upstream_connection_failed')));
    child.stdin.on('error', () => finish(new Error('upstream_connection_failed')));
    child.stderr.resume(); // Never forward exception text containing a request URL.
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { child.kill(); finish(new Error('upstream_invalid_response')); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error('upstream_connection_failed');
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (data.error) throw new Error(safeError.test(data.error) ? data.error : 'upstream_connection_failed');
        if (!Number.isInteger(data.status) || typeof data.body !== 'string') throw new Error('upstream_invalid_response');
        finish(null, { ok: data.status >= 200 && data.status < 300, status: data.status, text: async () => data.body });
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify({ url }));
  });
}
