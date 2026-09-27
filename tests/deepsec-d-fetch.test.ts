import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Never fall back to credential files on the machine running the tests
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
}));

const API_KEY_A = `pg_in_${'a'.repeat(40)}`;
const API_KEY_B = `pg_in_${'b'.repeat(40)}`;
const SERVER_UUID = '11111111-1111-4111-8111-111111111111';

// Stand-in for the pluggedin-app /api/mcp-servers endpoint
let status = 200;
let body: unknown = [];
// When set, the next request's response is held until the callback's `send` is called
let hold: ((send: () => void) => void) | null = null;
let server: http.Server;
let baseUrl: string;

const stdioServer = (name: string) => ({
  uuid: SERVER_UUID,
  name,
  type: 'STDIO',
  command: 'node',
  args: ['server.js'],
  env: { DOWNSTREAM_TOKEN: 'secret-token' },
});

let getMcpServers: typeof import('../src/fetch-pluggedinmcp.js').getMcpServers;

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/api/mcp-servers') {
      res.writeHead(404);
      res.end();
      return;
    }
    // Answer with the state at the time the request arrived
    const [s, b] = [status, body];
    const send = () => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s === 200 ? b : { error: 'rejected' }));
    };
    if (hold) {
      const holder = hold;
      hold = null;
      holder(send);
      return;
    }
    send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.PLUGGEDIN_API_KEY = API_KEY_A;
  process.env.PLUGGEDIN_API_BASE_URL = baseUrl;
  status = 200;
  body = [stdioServer('first')];
  hold = null;
  vi.resetModules();
  ({ getMcpServers } = await import('../src/fetch-pluggedinmcp.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getMcpServers when the app rejects the API key', () => {
  it.each([401, 403])('drops the cached configuration on HTTP %i', async (rejection) => {
    expect(Object.keys(await getMcpServers(true))).toEqual([SERVER_UUID]);

    advance(2000);
    status = rejection;
    expect(Object.keys(await getMcpServers(true))).toEqual([]);

    // The revoked configuration must not come back as a fallback or a cache hit
    status = 500;
    advance(2000);
    expect(Object.keys(await getMcpServers(true))).toEqual([]);
    expect(Object.keys(await getMcpServers(false))).toEqual([]);
  });

  it('does not cache a response that was in flight when the key was rejected', async () => {
    let releaseHeld!: () => void;
    const received = new Promise<void>((resolve) => {
      hold = (send) => {
        releaseHeld = send;
        resolve();
      };
    });
    const inFlight = getMcpServers(true);
    await received;

    status = 401;
    expect(Object.keys(await getMcpServers(true))).toEqual([]);

    releaseHeld();
    expect(Object.keys(await inFlight)).toEqual([]);

    status = 500;
    expect(Object.keys(await getMcpServers(false))).toEqual([]);
  });

  it('notifies invalidation listeners so downstream sessions can be closed', async () => {
    const { onMcpServersInvalidated } = await import('../src/fetch-pluggedinmcp.js');
    const listener = vi.fn();
    onMcpServersInvalidated(listener);

    await getMcpServers(true);
    expect(listener).not.toHaveBeenCalled();

    advance(2000);
    status = 401;
    await getMcpServers(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('getMcpServers cache scoping and expiry', () => {
  it('does not serve configuration cached under a different API key', async () => {
    await getMcpServers(true);

    process.env.PLUGGEDIN_API_KEY = API_KEY_B;
    body = [stdioServer('second')];
    expect((await getMcpServers(false))[SERVER_UUID].name).toBe('second');

    // A transient failure must not fall back to the other key's configuration either
    process.env.PLUGGEDIN_API_KEY = API_KEY_A;
    status = 500;
    expect(Object.keys(await getMcpServers(true))).toEqual([]);
  });

  it('fails closed when the API key is no longer configured', async () => {
    await getMcpServers(true);

    delete process.env.PLUGGEDIN_API_KEY;
    advance(2000);
    expect(Object.keys(await getMcpServers(true))).toEqual([]);
    expect(Object.keys(await getMcpServers(false))).toEqual([]);
  });

  it('refreshes non-forced reads once the cache is older than its maximum age', async () => {
    await getMcpServers(false);

    body = [stdioServer('second')];
    advance(5000);
    expect((await getMcpServers(false))[SERVER_UUID].name).toBe('first');

    advance(10 * 60 * 1000);
    expect((await getMcpServers(false))[SERVER_UUID].name).toBe('second');
  });

  it('serves stale configuration after transient failures only for a bounded time', async () => {
    await getMcpServers(true);

    status = 503;
    advance(2000);
    expect(Object.keys(await getMcpServers(true))).toEqual([SERVER_UUID]);

    advance(60 * 60 * 1000);
    expect(Object.keys(await getMcpServers(true))).toEqual([]);
  });
});

describe('getMcpServers SSE configuration', () => {
  it('carries headers stored in streamableHTTPOptions over to SSE servers', async () => {
    body = [
      {
        uuid: SERVER_UUID,
        name: 'sse',
        type: 'SSE',
        url: 'https://sse.example.com/sse',
        streamableHTTPOptions: { headers: { Authorization: 'Bearer stored-token' } },
      },
    ];

    const params = (await getMcpServers(true))[SERVER_UUID];
    expect(params.headers).toEqual({ Authorization: 'Bearer stored-token' });
  });
});

describe('getMcpServers request bounds', () => {
  it('bounds the /api/mcp-servers request with a finite timeout', async () => {
    const axios = (await import('axios')).default;
    const spy = vi.spyOn(axios, 'get');
    try {
      await getMcpServers(true);
      const config = spy.mock.calls[0]?.[1];
      expect(config?.timeout).toBeGreaterThan(0);
      expect(Number.isFinite(config?.timeout)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
