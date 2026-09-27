import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerParameters } from '../src/types.js';

// In-memory stand-in for a spawned STDIO server: it answers `initialize` like a real
// MCP server, can be held in start() to simulate a slow spawn, and can "exit".
const fake = vi.hoisted(() => {
  const state = {
    instances: [] as any[],
    startGate: null as Promise<void> | null,
  };

  class FakeStdioTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: any) => void;
    closed = false;

    constructor(public params: any) {
      state.instances.push(this);
    }

    async start() {
      if (state.startGate) await state.startGate;
    }

    async send(message: any) {
      if (this.closed) throw new Error('Not connected');
      if (message.method === 'initialize') {
        queueMicrotask(() =>
          this.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: {},
              serverInfo: { name: 'fake', version: '1.0.0' },
            },
          })
        );
      }
    }

    async close() {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    }

    // The downstream process exited on its own
    exit() {
      this.closed = true;
      this.onclose?.();
    }
  }

  return { state, FakeStdioTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: fake.FakeStdioTransport,
}));

// Never fall back to credential files on the machine running the tests
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
}));

type SessionsModule = typeof import('../src/sessions.js');
let sessions: SessionsModule;
let getSessionKey: typeof import('../src/utils.js').getSessionKey;

const UUID = '22222222-2222-4222-8222-222222222222';

const params = (overrides: Partial<ServerParameters> = {}): ServerParameters => ({
  uuid: UUID,
  name: 'fake-server',
  type: 'STDIO',
  command: 'fake-server',
  args: ['--stdio'],
  ...overrides,
});

const openTransports = () => fake.state.instances.filter((t) => !t.closed);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(async () => {
  fake.state.instances.length = 0;
  fake.state.startGate = null;
  delete (globalThis as any).sessions;
  vi.resetModules();
  sessions = await import('../src/sessions.js');
  ({ getSessionKey } = await import('../src/utils.js'));
});

afterEach(async () => {
  fake.state.startGate = null;
  await sessions.cleanupAllSessions();
});

describe('getSession concurrent cache misses', () => {
  it('shares one in-flight connection between concurrent callers', async () => {
    const gate = deferred();
    fake.state.startGate = gate.promise;
    const p = params();
    const key = getSessionKey(UUID, p);

    const pending = Array.from({ length: 5 }, () => sessions.getSession(key, UUID, p));
    gate.resolve();
    const results = await Promise.all(pending);

    expect(fake.state.instances).toHaveLength(1);
    expect(results[0]).toBeDefined();
    for (const result of results) expect(result).toBe(results[0]);
  });

  it('keeps only one live connection when configurations for one server race', async () => {
    const gate = deferred();
    fake.state.startGate = gate.promise;
    const a = params({ args: ['--config=a'] });
    const b = params({ args: ['--config=b'] });

    const pending = [
      sessions.getSession(getSessionKey(UUID, a), UUID, a),
      sessions.getSession(getSessionKey(UUID, b), UUID, b),
    ];
    gate.resolve();
    await Promise.all(pending);

    expect(openTransports()).toHaveLength(1);
  });

  it('closes a connection that completes after cleanupAllSessions instead of caching it', async () => {
    const gate = deferred();
    fake.state.startGate = gate.promise;
    const p = params();
    const key = getSessionKey(UUID, p);

    const pending = sessions.getSession(key, UUID, p);
    await sessions.cleanupAllSessions();
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(openTransports()).toHaveLength(0);
  });
});

describe('getSession disconnected clients', () => {
  it('reconnects when the cached downstream connection has closed', async () => {
    const p = params();
    const key = getSessionKey(UUID, p);
    const first = await sessions.getSession(key, UUID, p);
    expect(first).toBeDefined();

    fake.state.instances[0].exit();
    const second = await sessions.getSession(key, UUID, p);

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(fake.state.instances).toHaveLength(2);
    expect(await sessions.getSession(key, UUID, p)).toBe(second);
  });

  it('does not let a late close of an old client evict its replacement', async () => {
    const p = params();
    const key = getSessionKey(UUID, p);
    const first = await sessions.getSession(key, UUID, p);
    fake.state.instances[0].exit();
    const second = await sessions.getSession(key, UUID, p);

    // A second close notification from the old client arrives after the replacement
    first!.client.onclose?.();

    expect(await sessions.getSession(key, UUID, p)).toBe(second);
    expect(fake.state.instances).toHaveLength(2);
  });
});

describe('getSession configuration replacement', () => {
  it('does not retain replaced or cleaned-up clients in a global registry', async () => {
    const a = params({ args: ['--config=a'] });
    const b = params({ args: ['--config=b'] });
    const keyA = getSessionKey(UUID, a);
    const keyB = getSessionKey(UUID, b);

    await sessions.getSession(keyA, UUID, a);
    await sessions.getSession(keyB, UUID, b);
    expect(fake.state.instances[0].closed).toBe(true);
    expect((globalThis as any).sessions?.[keyA]).toBeUndefined();

    await sessions.cleanupAllSessions();
    expect(Object.keys((globalThis as any).sessions ?? {})).toEqual([]);
    expect(openTransports()).toHaveLength(0);
  });
});

describe('sessions after the app revokes the API key', () => {
  let server: http.Server;
  let status = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? [params()] : { error: 'Invalid API key' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    status = 200;
    process.env.PLUGGEDIN_API_KEY = `pg_in_${'c'.repeat(40)}`;
    process.env.PLUGGEDIN_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes downstream sessions established with the revoked configuration', async () => {
    const { getMcpServers } = await import('../src/fetch-pluggedinmcp.js');

    await sessions.initSessions();
    expect(openTransports()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2000);
    status = 401;
    expect(Object.keys(await getMcpServers(true))).toEqual([]);

    expect(openTransports()).toHaveLength(0);
  });
});
