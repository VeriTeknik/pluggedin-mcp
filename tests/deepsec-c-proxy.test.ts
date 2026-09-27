import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Never fall back to real credential files on the developer's machine
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
}));

// Activity logging posts to the API via axios; keep it out of the axios spies.
vi.mock('../src/notification-logger.js', () => ({
  logMcpActivity: vi.fn().mockResolvedValue(undefined),
  createExecutionTimer: () => ({ stop: () => 0 }),
}));

vi.mock('../src/fetch-pluggedinmcp.js', () => ({
  getMcpServers: vi.fn(),
}));

vi.mock('../src/sessions.js', () => ({
  getSession: vi.fn(),
  initSessions: vi.fn().mockResolvedValue(undefined),
  cleanupAllSessions: vi.fn().mockResolvedValue(undefined),
}));

import { createServer } from '../src/mcp-proxy';
import { getMcpServers } from '../src/fetch-pluggedinmcp.js';
import { getSession } from '../src/sessions.js';
import { allStaticTools } from '../src/tools/static-tools.js';

// Must satisfy validateBearerToken (32-256 chars) or the proxy treats it as unset
const TEST_API_KEY = 'pg_in_' + 'a'.repeat(40);
const BASE_URL = 'http://localhost:3000';
const NOTIFICATION_ID = '550e8400-e29b-41d4-a716-446655440000';
const SERVER_A = '11111111-1111-4111-8111-111111111111';
const SERVER_B = '22222222-2222-4222-8222-222222222222';

let client: Client;
let cleanup: () => Promise<void>;

async function connect() {
  const created = await createServer();
  cleanup = created.cleanup;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  client = new Client({ name: 'deepsec-c-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
}

// Tool calls may surface as JSON-RPC errors or as isError results depending on the SDK
async function callToolOutcome(name: string, args: Record<string, unknown>) {
  try {
    const result: any = await client.callTool({ name, arguments: args });
    return { ok: !result.isError, result, error: undefined as Error | undefined };
  } catch (error) {
    return { ok: false, result: undefined, error: error as Error };
  }
}

beforeEach(async () => {
  process.env.PLUGGEDIN_API_KEY = TEST_API_KEY;
  process.env.PLUGGEDIN_API_BASE_URL = BASE_URL;
  vi.mocked(getMcpServers).mockReset();
  vi.mocked(getSession).mockReset();
  await connect();
});

afterEach(async () => {
  await client.close();
  await cleanup();
  vi.restoreAllMocks();
});

describe('notification IDs cannot redirect authenticated requests (path traversal)', () => {
  const traversalIds = [
    `../documents/${NOTIFICATION_ID}`,
    `${NOTIFICATION_ID}#`,
    `${NOTIFICATION_ID}/../../documents/x`,
    `${NOTIFICATION_ID}?x=1`,
    'not-a-uuid',
  ];

  for (const badId of traversalIds) {
    it(`pluggedin_delete_notification rejects ${JSON.stringify(badId)} without calling the API`, async () => {
      const del = vi.spyOn(axios, 'delete').mockResolvedValue({ data: {} } as any);
      const outcome = await callToolOutcome('pluggedin_delete_notification', { notificationId: badId });
      expect(outcome.ok).toBe(false);
      expect(del).not.toHaveBeenCalled();
    });

    it(`pluggedin_mark_notification_done rejects ${JSON.stringify(badId)} without calling the API`, async () => {
      const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ data: {} } as any);
      const outcome = await callToolOutcome('pluggedin_mark_notification_done', { notificationId: badId });
      expect(outcome.ok).toBe(false);
      expect(patch).not.toHaveBeenCalled();
    });
  }

  it('deletes a notification addressed by UUID', async () => {
    const del = vi.spyOn(axios, 'delete').mockResolvedValue({ data: {} } as any);
    const outcome = await callToolOutcome('pluggedin_delete_notification', { notificationId: NOTIFICATION_ID });
    expect(outcome.ok).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toBe(`${BASE_URL}/api/notifications/${NOTIFICATION_ID}`);
  });

  it('marks a notification addressed by UUID as done', async () => {
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ data: {} } as any);
    const outcome = await callToolOutcome('pluggedin_mark_notification_done', { notificationId: NOTIFICATION_ID });
    expect(outcome.ok).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe(`${BASE_URL}/api/notifications/${NOTIFICATION_ID}/completed`);
  });
});

// ---- Downstream tool routing ----

type ApiTool = { name: string; _serverUuid: string; _serverSlug?: string; _serverName?: string };

const SERVERS: Record<string, any> = {
  [SERVER_A]: { uuid: SERVER_A, name: 'Production DB', type: 'STDIO', command: 'node' },
  [SERVER_B]: { uuid: SERVER_B, name: 'Dev DB', type: 'STDIO', command: 'node' },
};

function mockDownstream(tools: ApiTool[], servers: Record<string, any> = SERVERS) {
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url.startsWith(`${BASE_URL}/api/tools`)) {
      return { data: { tools: tools.map(t => ({ description: '', inputSchema: { type: 'object' }, ...t })) } } as any;
    }
    throw new Error(`unexpected GET ${url}`);
  });
  vi.mocked(getMcpServers).mockResolvedValue(servers);
  const request = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const sessionsByServer: Record<string, any> = {};
  vi.mocked(getSession).mockImplementation(async (_key: string, uuid: string) => {
    sessionsByServer[uuid] = sessionsByServer[uuid] || { client: { request } };
    return sessionsByServer[uuid];
  });
  return { request, sessionsByServer };
}

function downstreamCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.map(([req]) => req.params);
}

describe('slug-prefixed tool names only resolve within their own server', () => {
  it('rejects a slug prefix that does not belong to the tool\'s server', async () => {
    const { request } = mockDownstream([
      { name: 'prod__delete_record', _serverUuid: SERVER_A, _serverSlug: 'prod' },
      { name: 'dev__list_items', _serverUuid: SERVER_B, _serverSlug: 'dev' },
    ]);
    await client.listTools();

    const outcome = await callToolOutcome('dev__delete_record', { id: 1 });
    expect(outcome.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an unknown slug prefix', async () => {
    const { request } = mockDownstream([
      { name: 'prod__delete_record', _serverUuid: SERVER_A, _serverSlug: 'prod' },
    ]);
    await client.listTools();

    const outcome = await callToolOutcome('development-old__delete_record', { id: 1 });
    expect(outcome.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves a slug prefix to the server that owns that slug', async () => {
    const { request, sessionsByServer } = mockDownstream([
      { name: 'read_file', _serverUuid: SERVER_B, _serverSlug: 'dev' },
    ]);
    await client.listTools();

    const outcome = await callToolOutcome('dev__read_file', { path: '/tmp/x' });
    expect(outcome.ok).toBe(true);
    expect(Object.keys(sessionsByServer)).toEqual([SERVER_B]);
    expect(downstreamCalls(request)[0].name).toBe('read_file');

    const wrongSlug = await callToolOutcome('prod__read_file', { path: '/tmp/x' });
    expect(wrongSlug.ok).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('still resolves UUID-prefixed names to that exact server', async () => {
    const { request, sessionsByServer } = mockDownstream([
      { name: 'read_file', _serverUuid: SERVER_B },
    ]);
    await client.listTools();

    const outcome = await callToolOutcome(`${SERVER_B}__read_file`, {});
    expect(outcome.ok).toBe(true);
    expect(Object.keys(sessionsByServer)).toEqual([SERVER_B]);
    expect(downstreamCalls(request)[0].name).toBe('read_file');

    const otherServer = await callToolOutcome(`${SERVER_A}__read_file`, {});
    expect(otherServer.ok).toBe(false);
  });
});

describe('prefixed tool names keep the exact downstream tool name', () => {
  it('slug prefix: lookup@account is not rewritten to lookupaccount', async () => {
    const { request } = mockDownstream([
      { name: 'my-server__lookup@account', _serverUuid: SERVER_A, _serverSlug: 'my-server' },
    ]);
    await client.listTools();

    const outcome = await callToolOutcome('my-server__lookup@account', {});
    expect(outcome.ok).toBe(true);
    expect(downstreamCalls(request)[0].name).toBe('lookup@account');
  });

  it('UUID prefix: characters stripped by HTML sanitisation are preserved', async () => {
    const { request } = mockDownstream([
      { name: `${SERVER_A}__rock&roll`, _serverUuid: SERVER_A },
    ]);
    await client.listTools();

    const outcome = await callToolOutcome(`${SERVER_A}__rock&roll`, {});
    expect(outcome.ok).toBe(true);
    expect(downstreamCalls(request)[0].name).toBe('rock&roll');
  });
});

describe('server constraints and context are applied to downstream tool calls', () => {
  const constrainedServers = {
    ...SERVERS,
    [SERVER_A]: { ...SERVERS[SERVER_A], customInstructions: 'Denied operations: delete_record' },
  };

  it('blocks a tool explicitly denied by the server\'s custom instructions', async () => {
    const { request } = mockDownstream(
      [{ name: 'prod__delete_record', _serverUuid: SERVER_A, _serverSlug: 'prod' }],
      constrainedServers
    );
    await client.listTools();

    const outcome = await callToolOutcome('prod__delete_record', { id: 1 });
    expect(outcome.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('passes the server context to the downstream call', async () => {
    const { request } = mockDownstream(
      [{ name: 'prod__list_records', _serverUuid: SERVER_A, _serverSlug: 'prod' }],
      constrainedServers
    );
    await client.listTools();

    const outcome = await callToolOutcome('prod__list_records', {});
    expect(outcome.ok).toBe(true);
    const params = downstreamCalls(request)[0];
    expect(params.name).toBe('list_records');
    expect(params._meta?.serverContext?.instructions).toContain('Denied operations: delete_record');
    expect(params._meta?.serverContext?.constraints?.deniedOperations).toEqual(['delete_record']);
  });

  it('does not block or annotate calls to servers without instructions', async () => {
    const { request } = mockDownstream(
      [{ name: 'dev__delete_record', _serverUuid: SERVER_B, _serverSlug: 'dev' }],
      constrainedServers
    );
    await client.listTools();

    const outcome = await callToolOutcome('dev__delete_record', { id: 1 });
    expect(outcome.ok).toBe(true);
    expect(downstreamCalls(request)[0]._meta?.serverContext).toBeUndefined();
  });
});

// ---- Resources: built-in registry + downstream in one handler pair ----

describe('built-in resources are served alongside downstream resources', () => {
  async function reconnectWithoutCredentials() {
    await client.close();
    await cleanup();
    // Present but malformed: treated as unset without consulting any settings file
    process.env.PLUGGEDIN_API_KEY = 'unset';
    await connect();
  }

  it('lists and reads the public setup guide without credentials', async () => {
    await reconnectWithoutCredentials();
    const get = vi.spyOn(axios, 'get');

    const { resources } = await client.listResources();
    expect(resources.map(r => r.uri)).toContain('pluggedin://setup');
    expect(resources.map(r => r.uri)).not.toContain('pluggedin://documents');

    const read = await client.readResource({ uri: 'pluggedin://setup' });
    expect((read.contents[0] as any).text).toContain('Getting Started with Plugged.in MCP');

    await expect(client.readResource({ uri: 'pluggedin://documents' })).rejects.toThrow(/API key required/);
    expect(get).not.toHaveBeenCalled();
  });

  it('with credentials, lists built-in and downstream resources together', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url === `${BASE_URL}/api/resources`) {
        return { data: [{ uri: 'file:///downstream.txt', name: 'downstream' }] } as any;
      }
      throw new Error(`unexpected GET ${url}`);
    });

    const { resources } = await client.listResources();
    const uris = resources.map(r => r.uri);
    expect(uris).toEqual(expect.arrayContaining([
      'pluggedin://setup',
      'pluggedin://documents',
      'file:///downstream.txt',
    ]));
  });

  it('with credentials, reads built-in URIs locally instead of resolving them remotely', async () => {
    const get = vi.spyOn(axios, 'get');

    const read = await client.readResource({ uri: 'pluggedin://documents' });
    expect((read.contents[0] as any).text).toContain('pluggedin_list_documents');
    expect(get).not.toHaveBeenCalled();
  });

  it('with credentials, still proxies downstream resource reads', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.startsWith(`${BASE_URL}/api/resolve/resource?uri=`)) {
        return { data: { ...SERVERS[SERVER_A] } } as any;
      }
      throw new Error(`unexpected GET ${url}`);
    });
    const request = vi.fn().mockResolvedValue({ contents: [{ uri: 'file:///downstream.txt', text: 'hello' }] });
    vi.mocked(getSession).mockResolvedValue({ client: { request } } as any);

    const read = await client.readResource({ uri: 'file:///downstream.txt' });
    expect((read.contents[0] as any).text).toBe('hello');
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'resources/read', params: { uri: 'file:///downstream.txt' } });
  });
});

// ---- Rate limiting of downstream prompt / resource work ----

describe('prompts/get and resources/read are rate limited like tools/call', () => {
  const LIMIT = 60; // toolCallRateLimiter: 60 calls per minute

  it('stops resolving prompts once the limit is reached', async () => {
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('resolver unavailable'));

    for (let i = 0; i < LIMIT; i++) {
      await expect(client.getPrompt({ name: `prompt-${i}` })).rejects.toThrow(/resolver unavailable/);
    }
    await expect(client.getPrompt({ name: 'one-too-many' })).rejects.toThrow(/Rate limit exceeded/);
    expect(get).toHaveBeenCalledTimes(LIMIT);
  });

  it('stops resolving downstream resources once the limit is reached', async () => {
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('resolver unavailable'));

    for (let i = 0; i < LIMIT; i++) {
      await expect(client.readResource({ uri: `file:///r-${i}` })).rejects.toThrow(/resolver unavailable/);
    }
    await expect(client.readResource({ uri: 'file:///one-too-many' })).rejects.toThrow(/Rate limit exceeded/);
    expect(get).toHaveBeenCalledTimes(LIMIT);
  });

  it('does not count the static capabilities prompt or built-in resources', async () => {
    for (let i = 0; i < LIMIT + 5; i++) {
      await client.getPrompt({ name: 'pluggedin_proxy_capabilities' });
      await client.readResource({ uri: 'pluggedin://setup' });
    }
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('resolver unavailable'));
    await expect(client.getPrompt({ name: 'real-prompt' })).rejects.toThrow(/resolver unavailable/);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

// ---- Static tool catalogue ----

describe('tools/list advertises every implemented static tool', () => {
  const recentlyAdded = [
    'pluggedin_cbp_query',
    'pluggedin_cbp_feedback',
    'pluggedin_memory_search_with_context',
    'pluggedin_memory_individuation',
  ];

  it('without credentials: every tool in allStaticTools', async () => {
    await client.close();
    await cleanup();
    process.env.PLUGGEDIN_API_KEY = 'unset';
    await connect();

    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(allStaticTools.map(t => t.name)));
    expect(names).toEqual(expect.arrayContaining(recentlyAdded));
  });

  it('with credentials: every static tool except the setup helper, plus downstream tools', async () => {
    mockDownstream([{ name: 'prod__read_file', _serverUuid: SERVER_A, _serverSlug: 'prod' }]);

    const names = (await client.listTools()).tools.map(t => t.name);
    const expected = allStaticTools.map(t => t.name).filter(n => n !== 'pluggedin_setup');
    expect(names).toEqual(expect.arrayContaining([...expected, 'prod__read_file']));
    expect(names).toEqual(expect.arrayContaining(recentlyAdded));
  });
});
