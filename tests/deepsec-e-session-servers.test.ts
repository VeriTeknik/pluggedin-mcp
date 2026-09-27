/**
 * One MCP Server per Streamable HTTP session (review follow-up to the deepsec fixes).
 *
 * The SDK refuses a second connect() on a Server ("Already connected to a transport"),
 * so a single shared Server served exactly one session: an unauthenticated client could
 * initialize (public) and keep that session alive with ping (public), and every later
 * initialize, the key holder's included, got a 500. Concurrent stateless requests hit
 * the same error. Unauthenticated traffic must also not keep a session alive when auth
 * is required.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import request from 'supertest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Keep the developer's real credential files out of these tests
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
  clearSettingsCache: vi.fn(),
}));

// Activity logging posts to the API; keep these tests off the network
vi.mock('../src/notification-logger.js', () => ({
  logMcpActivity: vi.fn().mockResolvedValue(undefined),
  createExecutionTimer: () => ({ stop: () => 0 }),
}));

// Process-wide downstream connections: ending one HTTP session must not tear them down
const { cleanupAllSessionsMock } = vi.hoisted(() => ({
  cleanupAllSessionsMock: vi.fn(async () => {}),
}));
vi.mock('../src/sessions.js', () => ({
  getSession: vi.fn(),
  initSessions: vi.fn(async () => {}),
  cleanupAllSessions: cleanupAllSessionsMock,
}));

import { createServerFactory } from '../src/mcp-proxy';
import { startStreamableHTTPServer } from '../src/streamable-http';
import { SESSION_TTL_MS, SESSION_CLEANUP_INTERVAL_MS } from '../src/constants';

const KEY = 'pg_in_' + 'e'.repeat(40);

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

// The transport answers POSTs as SSE by default; pull the JSON-RPC message out of either form
function rpcMessage(res: request.Response): any {
  if (res.body && typeof res.body === 'object' && 'jsonrpc' in res.body) {
    return res.body;
  }
  const dataLine = String(res.text)
    .split('\n')
    .find((line) => line.startsWith('data: '));
  return dataLine ? JSON.parse(dataLine.slice('data: '.length)) : undefined;
}

// The SDK transport reads the raw request headers, so send the Accept header real clients send
const ACCEPT = 'application/json, text/event-stream';

function withAuth(req: request.Test, key?: string): request.Test {
  req.set('Accept', ACCEPT);
  return key ? req.set('Authorization', `Bearer ${key}`) : req;
}

describe('Streamable HTTP: one Server per session (index.ts entry, auth required)', () => {
  const originalEnv = process.env;
  let base: string;
  let stop: (() => Promise<void>) | undefined;

  async function start() {
    const port = await getFreePort();
    process.env.PLUGGEDIN_API_KEY = KEY;
    process.env.PLUGGEDIN_API_BASE_URL = 'http://localhost:3000';
    const factory = createServerFactory();
    const stopTransport = await startStreamableHTTPServer(factory.createServer, {
      port,
      requireApiAuth: true,
    });
    stop = async () => {
      await stopTransport();
      await factory.cleanup();
    };
    base = `http://localhost:${port}`;
  }

  async function initialize(key?: string) {
    const res = await withAuth(request(base).post('/mcp'), key).send(INIT_BODY);
    return { status: res.status, sessionId: res.headers['mcp-session-id'] as string, message: rpcMessage(res) };
  }

  async function call(sessionId: string, body: object, key?: string) {
    const res = await withAuth(request(base).post('/mcp').set('mcp-session-id', sessionId), key).send(body);
    return { status: res.status, message: rpcMessage(res) };
  }

  const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
  const getCapabilitiesPrompt = (id: number) => ({
    jsonrpc: '2.0',
    id,
    method: 'prompts/get',
    params: { name: 'pluggedin_proxy_capabilities' },
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BIND_HOST;
    delete process.env.REQUIRE_API_AUTH;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (stop) {
      await stop().catch(() => {});
      stop = undefined;
    }
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('an unauthenticated initialize kept alive with ping does not lock the key holder out', async () => {
    await start();

    const squatter = await initialize();
    expect(squatter.status).toBe(200);
    expect((await call(squatter.sessionId, ping(2))).status).toBe(200);

    const owner = await initialize(KEY);
    expect(owner.status).toBe(200);
    expect(owner.message.result.serverInfo.name).toBe('PluggedinMCP');
    expect(owner.sessionId).toBeTruthy();
    expect(owner.sessionId).not.toBe(squatter.sessionId);

    const prompt = await call(owner.sessionId, getCapabilitiesPrompt(3), KEY);
    expect(prompt.status).toBe(200);
    expect(prompt.message.id).toBe(3);
    expect(prompt.message.result.messages.length).toBeGreaterThan(0);
  });

  it('serves two concurrent sessions, each on its own Server', async () => {
    await start();

    const [a, b] = await Promise.all([initialize(KEY), initialize(KEY)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.sessionId).not.toBe(b.sessionId);

    const [ra, rb] = await Promise.all([
      call(a.sessionId, getCapabilitiesPrompt(11), KEY),
      call(b.sessionId, getCapabilitiesPrompt(22), KEY),
    ]);
    expect(ra.status).toBe(200);
    expect(ra.message.id).toBe(11);
    expect(ra.message.result.messages.length).toBeGreaterThan(0);
    expect(rb.status).toBe(200);
    expect(rb.message.id).toBe(22);
    expect(rb.message.result.messages.length).toBeGreaterThan(0);

    // Ending one session leaves the other one, and the shared proxy state, working
    cleanupAllSessionsMock.mockClear();
    const del = await withAuth(request(base).delete('/mcp').set('mcp-session-id', a.sessionId), KEY);
    expect(del.status).toBe(200);
    expect((await call(a.sessionId, ping(12), KEY)).status).toBe(404);
    const stillUp = await call(b.sessionId, ping(23), KEY);
    expect(stillUp.status).toBe(200);
    expect(stillUp.message.id).toBe(23);
    expect(cleanupAllSessionsMock).not.toHaveBeenCalled();

    // Process shutdown is what tears the shared state down
    await stop!();
    stop = undefined;
    expect(cleanupAllSessionsMock).toHaveBeenCalledTimes(1);
  });

  describe('session lifetime', () => {
    // Fake only the sweep interval and the clock; HTTP I/O keeps running on real timers
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    });

    it('unauthenticated pings do not keep a session alive past its TTL', async () => {
      await start();
      const owner = await initialize(KEY);
      expect(owner.status).toBe(200);

      vi.advanceTimersByTime(SESSION_TTL_MS - SESSION_CLEANUP_INTERVAL_MS);
      // ping is public, so it gets through without the key...
      expect((await call(owner.sessionId, ping(2))).status).toBe(200);

      // ...but it must not have refreshed the session, which now expires on schedule
      vi.advanceTimersByTime(2 * SESSION_CLEANUP_INTERVAL_MS);
      expect((await call(owner.sessionId, ping(3), KEY)).status).toBe(404);
    });

    it('authenticated traffic still keeps a session alive', async () => {
      await start();
      const owner = await initialize(KEY);
      expect(owner.status).toBe(200);

      vi.advanceTimersByTime(SESSION_TTL_MS - SESSION_CLEANUP_INTERVAL_MS);
      expect((await call(owner.sessionId, ping(2), KEY)).status).toBe(200);

      vi.advanceTimersByTime(2 * SESSION_CLEANUP_INTERVAL_MS);
      expect((await call(owner.sessionId, ping(3), KEY)).status).toBe(200);
    });
  });
});

describe('Streamable HTTP stateless mode: concurrent requests', () => {
  const originalEnv = process.env;
  let stop: (() => Promise<void>) | undefined;

  // A server whose tool call parks until released, so two requests are in flight at once
  let releaseSlowCall: (() => void) | undefined;
  let markSlowCallStarted: () => void;
  let slowCallStarted: Promise<void>;

  function createToyServer(): Server {
    const server = new Server({ name: 'toy', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === 'slow') {
        await new Promise<void>((resolve) => {
          releaseSlowCall = resolve;
          markSlowCallStarted();
        });
      }
      return { content: [{ type: 'text', text: req.params.name }] };
    });
    return server;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BIND_HOST;
    slowCallStarted = new Promise<void>((resolve) => { markSlowCallStarted = resolve; });
  });

  afterEach(async () => {
    // Never leave the parked request holding the HTTP server open
    releaseSlowCall?.();
    releaseSlowCall = undefined;
    if (stop) {
      await stop().catch(() => {});
      stop = undefined;
    }
    process.env = originalEnv;
  });

  it('handles a second request while the first is still in flight', async () => {
    const port = await getFreePort();
    stop = await startStreamableHTTPServer(createToyServer, { port, stateless: true });
    const base = `http://localhost:${port}`;

    const callTool = (id: number, name: string) =>
      request(base).post('/mcp').set('Accept', ACCEPT).send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

    const slow = callTool(1, 'slow').then((res) => res);
    await slowCallStarted;

    const fast = await callTool(2, 'fast');
    expect(fast.status).toBe(200);
    expect(rpcMessage(fast).result.content[0].text).toBe('fast');

    releaseSlowCall!();
    const slowRes = await slow;
    expect(slowRes.status).toBe(200);
    expect(rpcMessage(slowRes).result.content[0].text).toBe('slow');
  });
});

describe('Streamable HTTP: per-session Server lifecycle', () => {
  const originalEnv = process.env;
  let stop: (() => Promise<void>) | undefined;
  let base: string;
  let servers: Server[];

  function createTrackedServer(): Server {
    const server = new Server({ name: 'tracked', version: '1.0.0' }, { capabilities: {} });
    vi.spyOn(server, 'close');
    servers.push(server);
    return server;
  }

  async function start() {
    const port = await getFreePort();
    stop = await startStreamableHTTPServer(createTrackedServer, { port });
    base = `http://localhost:${port}`;
  }

  async function initialize(): Promise<string> {
    const res = await request(base).post('/mcp').set('Accept', ACCEPT).send(INIT_BODY);
    expect(res.status).toBe(200);
    return res.headers['mcp-session-id'];
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BIND_HOST;
    servers = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (stop) {
      await stop().catch(() => {});
      stop = undefined;
    }
    process.env = originalEnv;
  });

  it('builds a Server per session and closes only that one on DELETE', async () => {
    await start();
    const first = await initialize();
    await initialize();
    expect(servers).toHaveLength(2);

    const del = await request(base).delete('/mcp').set('mcp-session-id', first);
    expect(del.status).toBe(200);
    expect(servers[0].close).toHaveBeenCalled();
    expect(servers[1].close).not.toHaveBeenCalled();
  });

  it('closes the Server of a session that expires', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await start();
    await initialize();

    vi.advanceTimersByTime(SESSION_TTL_MS + 2 * SESSION_CLEANUP_INTERVAL_MS);
    await vi.waitFor(() => expect(servers[0].close).toHaveBeenCalled());
  });

  it('closes every session Server at shutdown', async () => {
    await start();
    await initialize();
    await initialize();

    await stop!();
    stop = undefined;
    for (const server of servers) {
      expect(server.close).toHaveBeenCalled();
    }
  });
});
