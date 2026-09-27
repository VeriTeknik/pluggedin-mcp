import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';

// Never fall back to real credential files on the developer's machine
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
}));

// debug-log decides at import time whether it may write (non-STDIO transports only),
// so each test re-imports it with --transport streamable-http on argv.
const SECRET_KEY = 'pg_in_' + 'S3cr3t'.repeat(8);
const OTHER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';

let originalArgv: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map((call: unknown[]) => call.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' '))
    .join('\n');
}

function makeAxiosLikeError() {
  // Shape of an AxiosError: carries request config (with headers) and the request object
  const error: any = new Error('Request failed with status code 500');
  error.name = 'AxiosError';
  error.isAxiosError = true;
  error.code = 'ERR_BAD_RESPONSE';
  error.config = {
    method: 'get',
    url: 'http://localhost:3000/api/tools?prefix_tools=true',
    headers: { Authorization: `Bearer ${SECRET_KEY}`, 'X-Api-Key': OTHER_TOKEN },
  };
  error.request = { _header: `GET /api/tools HTTP/1.1\r\nAuthorization: Bearer ${SECRET_KEY}\r\n` };
  error.response = { status: 500, data: { error: 'boom' }, config: error.config };
  return error;
}

beforeEach(() => {
  originalArgv = process.argv;
  process.argv = [...process.argv, '--transport', 'streamable-http'];
  process.env.PLUGGEDIN_API_KEY = SECRET_KEY;
  vi.resetModules();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('debug-log redacts credentials', () => {
  it('does not print the API key or Authorization header of an Axios error', async () => {
    const { debugError } = await import('../src/debug-log.js');
    debugError('[ListTools Handler Error]', makeAxiosLikeError());

    const out = printed(errorSpy);
    expect(out).not.toContain(SECRET_KEY);
    expect(out).not.toContain(OTHER_TOKEN);
    // Still useful for debugging
    expect(out).toContain('[ListTools Handler Error]');
    expect(out).toContain('500');
  });

  it('redacts bearer tokens and pg_in_ keys inside strings', async () => {
    const { debugError, debugLog } = await import('../src/debug-log.js');
    debugError(`failed with Authorization: Bearer ${OTHER_TOKEN}`);
    debugLog(`key=${'pg_in_' + 'x'.repeat(30)}`);

    expect(printed(errorSpy)).not.toContain(OTHER_TOKEN);
    expect(printed(logSpy)).not.toContain('pg_in_' + 'x'.repeat(30));
  });

  it('redacts credentials nested in plain objects', async () => {
    const { debugError } = await import('../src/debug-log.js');
    debugError('context:', { headers: { authorization: `Bearer ${OTHER_TOKEN}` }, apiKey: SECRET_KEY });

    const out = printed(errorSpy);
    expect(out).not.toContain(OTHER_TOKEN);
    expect(out).not.toContain(SECRET_KEY);
  });

  it('redacts the configured API key even when it does not look like a pg_in_ key', async () => {
    const customKey = 'custom-' + 'k'.repeat(40);
    process.env.PLUGGEDIN_API_KEY = customKey;
    const { debugError } = await import('../src/debug-log.js');
    debugError(`something mentioned ${customKey} here`);

    expect(printed(errorSpy)).not.toContain(customKey);
  });

  it('stays silent on STDIO transport', async () => {
    process.argv = originalArgv;
    vi.resetModules();
    const { debugError } = await import('../src/debug-log.js');
    debugError('anything');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('tools/list failure logging (mcp-proxy)', () => {
  it('does not write the API key to stderr when the tools request fails', async () => {
    vi.doMock('../src/notification-logger.js', () => ({
      logMcpActivity: vi.fn().mockResolvedValue(undefined),
      createExecutionTimer: () => ({ stop: () => 0 }),
    }));
    process.env.PLUGGEDIN_API_BASE_URL = 'http://localhost:3000';

    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockRejectedValue(makeAxiosLikeError());

    const { createServer } = await import('../src/mcp-proxy');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const { server, cleanup } = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 't', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    await expect(client.listTools()).rejects.toThrow(/Failed to list tools/);

    const out = printed(errorSpy);
    expect(out).toContain('[ListTools Handler Error]');
    expect(out).not.toContain(SECRET_KEY);
    expect(out).not.toContain(OTHER_TOKEN);

    await client.close();
    await cleanup();
  });
});
