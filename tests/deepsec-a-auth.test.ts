/**
 * Auth gate for the Streamable HTTP transport (deepsec findings
 * auth-bypass-6c1f83653b / -828e38e9c2 / -dff86f76c8, missing-auth-b1bed91a0b,
 * other-configuration-mismatch-06d6b97b04 / other-auth-configuration-6771073d93).
 *
 * When requireApiAuth is on, every route that reaches the MCP handler must be
 * gated, for every HTTP method and every JSON-RPC envelope. Only the handshake
 * (initialize, notifications/initialized, ping) stays public.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import request from 'supertest';

const { getSettingsEnvVarMock } = vi.hoisted(() => ({
  getSettingsEnvVarMock: vi.fn((): string | undefined => undefined),
}));

// Keep the developer's real credential files out of these tests
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: getSettingsEnvVarMock,
  clearSettingsCache: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function (options: any) {
    return {
      options,
      handleRequest: vi.fn((_req: any, res: any) => {
        res.json({ jsonrpc: '2.0', result: 'reached-transport' });
      }),
      close: vi.fn(async () => {}),
    };
  }),
}));

import { startStreamableHTTPServer } from '../src/streamable-http';

const VALID_KEY = 'pg_in_' + 'a'.repeat(40);

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'deepsec-test', version: '1.0.0' },
  },
};

function rpc(method: string, id: number | undefined = 2) {
  return id === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', id, method, params: {} };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, 'localhost', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

describe('Streamable HTTP auth gate', () => {
  const originalEnv = process.env;
  let cleanup: (() => Promise<void>) | undefined;
  let base: string;

  async function start(requireApiAuth: boolean) {
    const port = await getFreePort();
    const mockServer: any = { connect: vi.fn(async () => {}), close: vi.fn() };
    cleanup = await startStreamableHTTPServer(() => mockServer, { port, requireApiAuth });
    base = `http://localhost:${port}`;
  }

  // Opens a session through the public handshake so later requests carry a real session ID
  async function openSession(path = '/mcp'): Promise<string> {
    const res = await request(base).post(path).send(INIT_BODY);
    expect(res.status).toBe(200);
    const sessionId = res.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();
    return sessionId;
  }

  beforeEach(() => {
    process.env = { ...originalEnv, PLUGGEDIN_API_KEY: VALID_KEY };
    getSettingsEnvVarMock.mockReset();
    getSettingsEnvVarMock.mockReturnValue(undefined);
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup().catch(() => {});
      cleanup = undefined;
    }
    process.env = originalEnv;
  });

  describe('when auth is required', () => {
    beforeEach(async () => {
      await start(true);
    });

    it('gates the root route, not just /mcp', async () => {
      const sessionId = await openSession('/');
      const res = await request(base)
        .post('/')
        .set('mcp-session-id', sessionId)
        .send(rpc('tools/call'));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(-32001);
    });

    it.each(['/MCP', '/mcp/', '/Mcp/'])('gates path variant %s that Express routes to the MCP handler', async (path) => {
      const sessionId = await openSession();
      const res = await request(base)
        .post(path)
        .set('mcp-session-id', sessionId)
        .send(rpc('tools/call'));
      expect(res.status).toBe(401);
    });

    it.each(['prompts/get', 'prompts/list', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'completion/complete', 'logging/setLevel'])(
      'requires the key for %s',
      async (method) => {
        const sessionId = await openSession();
        const res = await request(base)
          .post('/mcp')
          .set('mcp-session-id', sessionId)
          .send(rpc(method));
        expect(res.status).toBe(401);
      }
    );

    it('requires the key for a batch that mixes a public and a protected method', async () => {
      const sessionId = await openSession();
      const res = await request(base)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send([rpc('ping', 3), rpc('tools/call', 4)]);
      expect(res.status).toBe(401);
    });

    it('requires the key for an empty batch', async () => {
      const sessionId = await openSession();
      const res = await request(base)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .send([]);
      expect(res.status).toBe(401);
    });

    it('requires the key when the body was not parsed as JSON', async () => {
      const sessionId = await openSession();
      const res = await request(base)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify(rpc('tools/call')));
      expect(res.status).toBe(401);
    });

    it('requires the key for GET (SSE stream) on an existing session', async () => {
      const sessionId = await openSession();
      const res = await request(base).get('/mcp').set('mcp-session-id', sessionId);
      expect(res.status).toBe(401);
    });

    it('requires the key for DELETE and leaves the session alone', async () => {
      const sessionId = await openSession();
      const res = await request(base).delete('/mcp').set('mcp-session-id', sessionId);
      expect(res.status).toBe(401);

      const health = await request(base).get('/health');
      expect(health.body.sessions).toBe(1);
    });

    it('keeps the handshake public: initialize, notifications/initialized, ping', async () => {
      const sessionId = await openSession();
      for (const body of [rpc('notifications/initialized', undefined), rpc('ping')]) {
        const res = await request(base).post('/mcp').set('mcp-session-id', sessionId).send(body);
        expect(res.status, `${body.method} should stay public`).toBe(200);
      }
    });

    it('accepts the configured key on both routes', async () => {
      for (const path of ['/', '/mcp']) {
        const sessionId = await openSession(path);
        const res = await request(base)
          .post(path)
          .set('mcp-session-id', sessionId)
          .set('Authorization', `Bearer ${VALID_KEY}`)
          .send(rpc('tools/call'));
        expect(res.status).toBe(200);
        expect(res.body.result).toBe('reached-transport');
      }
    });

    it('accepts a key that only lives in the credentials/settings file', async () => {
      delete process.env.PLUGGEDIN_API_KEY;
      const fileKey = 'pg_in_' + 'f'.repeat(40);
      getSettingsEnvVarMock.mockImplementation((name?: string) =>
        name === 'PLUGGEDIN_API_KEY' ? fileKey : undefined
      );

      const sessionId = await openSession();
      const res = await request(base)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .set('Authorization', `Bearer ${fileKey}`)
        .send(rpc('tools/call'));
      expect(res.status).toBe(200);
    });

    it('never validates against an empty expected key', async () => {
      delete process.env.PLUGGEDIN_API_KEY;

      const sessionId = await openSession();
      for (const header of ['Bearer ', 'Bearer x', `Bearer ${VALID_KEY}`]) {
        const res = await request(base)
          .post('/mcp')
          .set('mcp-session-id', sessionId)
          .set('Authorization', header)
          .send(rpc('tools/call'));
        expect(res.status, header).toBe(401);
      }
    });

    it('rejects a same-length key with multi-byte characters as 401, not 500', async () => {
      const sessionId = await openSession();
      // supertest sends UTF-8; Node decodes header bytes as latin1, so each 'é' arrives as
      // two chars. The server-side string then matches the key's length but not its byte length.
      const res = await request(base)
        .post('/mcp')
        .set('mcp-session-id', sessionId)
        .set('Authorization', `Bearer ${'é'.repeat(VALID_KEY.length / 2)}`)
        .send(rpc('tools/call'));
      expect(res.status).toBe(401);
    });
  });

  describe('when auth is not required', () => {
    it('lets protected methods through on the root route without a key', async () => {
      await start(false);
      const sessionId = await openSession('/');
      const res = await request(base)
        .post('/')
        .set('mcp-session-id', sessionId)
        .send(rpc('tools/call'));
      expect(res.status).toBe(200);
    });
  });
});
