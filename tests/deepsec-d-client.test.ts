import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createPluggedinMCPClient } from '../src/client.js';
import type { ServerParameters } from '../src/types.js';

describe('createPluggedinMCPClient STDIO arguments', () => {
  let tmpDir: string;
  let scriptPath: string;
  let transport: Transport | undefined;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsec-d-'));
    scriptPath = path.join(tmpDir, 'echo-argv.cjs');
    // Reports the argv it was spawned with as a JSON-RPC notification, then exits
    fs.writeFileSync(
      scriptPath,
      "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/argv', params: { argv: process.argv.slice(2) } }) + '\\n');\n"
    );
  });

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes arguments to the spawned process unchanged (no shell is involved)', async () => {
    const args = [
      '--password=ab$cd',
      'https://example.com/cb?a=1&b=2',
      'C:\\Users\\me\\file.txt',
      '--filter=(foo|bar)',
      '<x>;`y`',
    ];
    const created = createPluggedinMCPClient({
      uuid: 'argv-server',
      name: 'argv-server',
      type: 'STDIO',
      command: 'node',
      args: [scriptPath, ...args],
    });
    transport = created.transport;
    expect(transport).toBeDefined();

    const received = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not report argv')), 5000);
      transport!.onmessage = (message: any) => {
        clearTimeout(timer);
        resolve(message.params.argv);
      };
    });
    await transport!.start();

    expect(await received).toEqual(args);
  });

  it('rejects arguments containing NUL bytes instead of rewriting them', () => {
    const created = createPluggedinMCPClient({
      uuid: 'nul-server',
      name: 'nul-server',
      type: 'STDIO',
      command: 'node',
      args: ['ok', 'bad\0arg'],
    });

    expect(created.transport).toBeUndefined();
    expect(created.client).toBeUndefined();
  });
});

describe('createPluggedinMCPClient SSE authentication', () => {
  let server: http.Server;
  let baseUrl: string;
  let streamHeaders: http.IncomingHttpHeaders | undefined;
  let postHeaders: http.IncomingHttpHeaders | undefined;
  let transport: Transport | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        streamHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('event: endpoint\ndata: /messages\n\n');
        return;
      }
      if (req.method === 'POST' && req.url === '/messages') {
        postHeaders = req.headers;
        req.resume();
        req.on('end', () => {
          res.writeHead(202);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
    streamHeaders = undefined;
    postHeaders = undefined;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connect = async (params: Partial<ServerParameters>) => {
    const created = createPluggedinMCPClient({
      uuid: 'sse-server',
      name: 'sse-server',
      type: 'SSE',
      url: `${baseUrl}/sse`,
      ...params,
    });
    transport = created.transport;
    expect(transport).toBeDefined();
    await transport!.start();
    await transport!.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  };

  it('sends configured headers on the event stream and on posted messages', async () => {
    await connect({ headers: { 'X-Api-Key': 'downstream-key' } });

    expect(streamHeaders?.['x-api-key']).toBe('downstream-key');
    expect(postHeaders?.['x-api-key']).toBe('downstream-key');
  });

  it('sends the configured OAuth token as a bearer token', async () => {
    await connect({ oauthToken: 'downstream-oauth-token' });

    expect(streamHeaders?.authorization).toBe('Bearer downstream-oauth-token');
    expect(postHeaders?.authorization).toBe('Bearer downstream-oauth-token');
  });
});
