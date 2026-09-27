/**
 * CLI credential arguments in src/index.ts must be validated, never silently rewritten.
 *
 * The old base-URL sanitizer's character class /[^a-zA-Z0-9:/.\\-_]/ parsed `\\-_` as a
 * range, so hyphens were stripped: https://my-host.example.com became
 * https://myhost.example.com and the owner's API key was sent to a different domain.
 * The API-key sanitizer likewise dropped characters instead of rejecting the key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { startMock } = vi.hoisted(() => ({
  startMock: vi.fn(async (..._args: any[]) => async () => {}),
}));

vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: vi.fn(() => undefined),
  clearSettingsCache: vi.fn(),
}));

vi.mock('../src/mcp-proxy.js', () => ({
  createServer: vi.fn(async () => ({
    server: { connect: async () => {}, close: async () => {} },
    cleanup: async () => {},
  })),
  createServerFactory: () => ({
    createServer: async () => ({ connect: async () => {}, close: async () => {} }),
    cleanup: async () => {},
  }),
}));

vi.mock('../src/streamable-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/streamable-http.js')>()),
  startStreamableHTTPServer: startMock,
}));

const VALID_KEY = 'pg_in_' + 'Ab9-_'.repeat(8);

describe('src/index.ts CLI credential arguments', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    startMock.mockClear();
    process.env = { ...originalEnv };
    delete process.env.PLUGGEDIN_API_KEY;
    delete process.env.PLUGGEDIN_API_BASE_URL;
    delete process.env.REQUIRE_API_AUTH;
    delete process.env.BIND_HOST;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    vi.restoreAllMocks();
  });

  function loadWith(args: string[]) {
    process.argv = ['node', 'index.js', '--transport', 'streamable-http', ...args];
    return import('../src/index.js');
  }

  it.each([
    'https://my-host.example.com',
    'https://my-host.example.com/base-path',
    'http://localhost:12005',
  ])('keeps base URL %s exactly as given', async (url) => {
    await loadWith(['--pluggedin-api-base-url', url]);
    expect(process.env.PLUGGEDIN_API_BASE_URL).toBe(url);
  });

  it.each(['not a url', 'ftp://files.example.com', 'my-host.example.com'])(
    'rejects base URL %j on stderr instead of rewriting it',
    async (url) => {
      await expect(loadWith(['--pluggedin-api-base-url', url])).rejects.toThrow('process.exit(1)');
      expect(process.env.PLUGGEDIN_API_BASE_URL).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/API base URL/i));
    }
  );

  it('keeps a well-formed API key exactly as given', async () => {
    await loadWith(['--pluggedin-api-key', VALID_KEY]);
    expect(process.env.PLUGGEDIN_API_KEY).toBe(VALID_KEY);
  });

  it.each([
    ['a key with characters outside the allowed set', VALID_KEY + '!$'],
    ['a key with a space', 'pg_in_' + 'a'.repeat(20) + ' ' + 'b'.repeat(20)],
    ['a key that is too short', 'pg_in_short'],
  ])('rejects %s instead of stripping it', async (_label, key) => {
    await expect(loadWith(['--pluggedin-api-key', key])).rejects.toThrow('process.exit(1)');
    expect(process.env.PLUGGEDIN_API_KEY).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/API key/i));
    // Never echo the rejected key to the logs
    for (const call of errorSpy.mock.calls) {
      expect(String(call[0])).not.toContain(key);
    }
  });
});
