/**
 * Docker HEALTHCHECK script (deepsec findings other-module-format-mismatch-8e320ce049,
 * other-broken-healthcheck-248024025b, other-broken-container-healthcheck-b67b541601).
 *
 * package.json declares "type": "module", so scripts/healthcheck.js runs as ESM in
 * the image. Run it the same way here: a real node process against a real /health.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'healthcheck.js');

let server: http.Server | undefined;

function serveHealth(payload: unknown): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    server.listen(0, () => resolve((server!.address() as net.AddressInfo).port));
  });
}

async function runHealthcheck(port: number) {
  // spawnSync would block the event loop that serves /health, so run it async
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(port) },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('scripts/healthcheck.js', () => {
  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  it('parses as a module under the package\'s "type": "module"', () => {
    const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('exits 0 when /health reports ok', async () => {
    const port = await serveHealth({ status: 'ok' });
    const { code, stderr } = await runHealthcheck(port);
    expect(code, stderr).toBe(0);
  });

  it('exits 1 when /health reports something else', async () => {
    const port = await serveHealth({ status: 'degraded' });
    const { code, stderr } = await runHealthcheck(port);
    expect(code).toBe(1);
    expect(stderr).toContain('degraded');
  });
});
