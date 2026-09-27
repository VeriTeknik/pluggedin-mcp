/**
 * Origin / Host validation on the MCP routes (review follow-up to the deepsec fixes).
 *
 * The MCP routes answered every origin with `Access-Control-Allow-Origin: *` and never
 * looked at Origin or Host. On loopback, where auth is off by default, any website (or a
 * DNS-rebinding page) could drive the proxy with the owner's Plugged.in key. The MCP
 * Streamable HTTP spec requires servers to validate Origin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import request from 'supertest';

// Keep the developer's real credential files out of these tests
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
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

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { startStreamableHTTPServer, resolveAllowedHostnames } from '../src/streamable-http';

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'deepsec-e-test', version: '1.0.0' },
  },
};

const FOREIGN_ORIGIN = 'https://evil.example';

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

describe('Streamable HTTP Origin/Host validation', () => {
  const originalEnv = process.env;
  let cleanup: (() => Promise<void>) | undefined;
  let port: number;
  let base: string;

  async function start() {
    port = await getFreePort();
    const mockServer: any = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    cleanup = await startStreamableHTTPServer(() => mockServer, { port });
    base = `http://localhost:${port}`;
  }

  async function sessionCount(): Promise<number> {
    const res = await request(base).get('/health');
    return res.body.sessions;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MCP_ALLOWED_ORIGINS;
    delete process.env.MCP_ALLOWED_HOSTS;
    delete process.env.BIND_HOST;
    vi.mocked(StreamableHTTPServerTransport).mockClear();
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup().catch(() => {});
      cleanup = undefined;
    }
    process.env = originalEnv;
  });

  describe('Origin', () => {
    it.each(['/mcp', '/'])('rejects a foreign Origin on %s with 403 before any session exists', async (path) => {
      await start();
      const res = await request(base).post(path).set('Origin', FOREIGN_ORIGIN).send(INIT_BODY);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/origin/i);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(StreamableHTTPServerTransport).not.toHaveBeenCalled();
      expect(await sessionCount()).toBe(0);
    });

    it('rejects Origin: null (sandboxed frames, file:// pages)', async () => {
      await start();
      const res = await request(base).post('/mcp').set('Origin', 'null').send(INIT_BODY);
      expect(res.status).toBe(403);
    });

    it('allows requests without an Origin header (non-browser clients)', async () => {
      await start();
      const res = await request(base).post('/mcp').send(INIT_BODY);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('reached-transport');
    });

    it.each(['http://localhost:6274', 'http://127.0.0.1:6274', 'http://[::1]:6274'])(
      'allows loopback origin %s by default and echoes it instead of *',
      async (origin) => {
        await start();
        const res = await request(base).post('/mcp').set('Origin', origin).send(INIT_BODY);
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['vary']).toMatch(/Origin/i);
      }
    );

    it('allows the origins listed in MCP_ALLOWED_ORIGINS, and only those', async () => {
      process.env.MCP_ALLOWED_ORIGINS = 'https://app.example.com, https://other.example.com:8443';
      await start();

      const allowed = await request(base).post('/mcp').set('Origin', 'https://app.example.com').send(INIT_BODY);
      expect(allowed.status).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');

      const allowedWithPort = await request(base).post('/mcp').set('Origin', 'https://other.example.com:8443').send(INIT_BODY);
      expect(allowedWithPort.status).toBe(200);

      // An explicit list replaces the loopback default
      const loopback = await request(base).post('/mcp').set('Origin', 'http://localhost:6274').send(INIT_BODY);
      expect(loopback.status).toBe(403);

      const foreign = await request(base).post('/mcp').set('Origin', FOREIGN_ORIGIN).send(INIT_BODY);
      expect(foreign.status).toBe(403);
    });

    it('MCP_ALLOWED_ORIGINS=* opts out of the check', async () => {
      process.env.MCP_ALLOWED_ORIGINS = '*';
      await start();
      const res = await request(base).post('/mcp').set('Origin', FOREIGN_ORIGIN).send(INIT_BODY);
      expect(res.status).toBe(200);
    });

    it('rejects a foreign Origin on GET and DELETE too', async () => {
      await start();
      const get = await request(base).get('/mcp').set('Origin', FOREIGN_ORIGIN);
      expect(get.status).toBe(403);
      const del = await request(base).delete('/mcp').set('Origin', FOREIGN_ORIGIN);
      expect(del.status).toBe(403);
    });
  });

  describe('CORS preflight on the MCP routes', () => {
    function preflight(path: string, origin?: string) {
      const req = request(base)
        .options(path)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type, authorization, mcp-session-id');
      return origin ? req.set('Origin', origin) : req;
    }

    it.each(['/mcp', '/'])('refuses a preflight from a foreign Origin on %s', async (path) => {
      await start();
      const res = await preflight(path, FOREIGN_ORIGIN);
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers an allowed Origin with that origin, never *', async () => {
      await start();
      const res = await preflight('/mcp', 'http://localhost:6274');
      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:6274');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
      expect(res.headers['access-control-allow-headers']).toContain('Mcp-Session-Id');
    });

    it('does not send Access-Control-Allow-Origin: * without an Origin', async () => {
      await start();
      const res = await preflight('/mcp');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('keeps permissive CORS on /health for discovery', async () => {
      await start();
      const res = await request(base).get('/health').set('Origin', FOREIGN_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('Host (DNS rebinding)', () => {
    it('rejects a rebinding page that reaches the loopback port under its own hostname', async () => {
      await start();
      const res = await request(base)
        .post('/mcp')
        .set('Host', `rebind.attacker.example:${port}`)
        .send(INIT_BODY);
      expect(res.status).toBe(403);
      expect(StreamableHTTPServerTransport).not.toHaveBeenCalled();
    });

    it.each(['localhost', '127.0.0.1', '[::1]'])('accepts loopback Host %s on a loopback bind', async (hostname) => {
      await start();
      const res = await request(base).post('/mcp').set('Host', `${hostname}:${port}`).send(INIT_BODY);
      expect(res.status).toBe(200);
    });

    it('accepts extra hostnames from MCP_ALLOWED_HOSTS (e.g. behind a local reverse proxy)', async () => {
      process.env.MCP_ALLOWED_HOSTS = 'mcp.example.com';
      await start();
      const res = await request(base).post('/mcp').set('Host', 'mcp.example.com').send(INIT_BODY);
      expect(res.status).toBe(200);
      const other = await request(base).post('/mcp').set('Host', 'other.example.com').send(INIT_BODY);
      expect(other.status).toBe(403);
    });

    it('leaves /health reachable under any Host', async () => {
      await start();
      const res = await request(base).get('/health').set('Host', `rebind.attacker.example:${port}`);
      expect(res.status).toBe(200);
    });
  });
});

describe('resolveAllowedHostnames', () => {
  it.each([undefined, '', 'localhost', '127.0.0.1'])('limits a loopback bind %j to loopback names', (bindHost) => {
    expect(resolveAllowedHostnames(bindHost)).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '[::1]']));
    expect(resolveAllowedHostnames(bindHost)).toHaveLength(3);
  });

  it('adds a non-default loopback bind host in Host-header form', () => {
    expect(resolveAllowedHostnames('::1')).toContain('[::1]');
    expect(resolveAllowedHostnames('127.0.0.2')).toContain('127.0.0.2');
  });

  it('adds MCP_ALLOWED_HOSTS entries, ignoring ports and case', () => {
    expect(resolveAllowedHostnames('localhost', ' MCP.Example.com:443 , fe80::1')).toEqual(
      expect.arrayContaining(['localhost', 'mcp.example.com', '[fe80::1]'])
    );
  });

  it('turns the check off on a public bind unless MCP_ALLOWED_HOSTS names the public host', () => {
    expect(resolveAllowedHostnames('0.0.0.0')).toBeUndefined();
    expect(resolveAllowedHostnames('0.0.0.0', 'mcp.example.com')).toEqual(
      expect.arrayContaining(['mcp.example.com', 'localhost'])
    );
  });
});
