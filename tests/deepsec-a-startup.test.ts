/**
 * REQUIRE_API_AUTH handling for the CLI / container entry point (deepsec findings
 * auth-bypass-25e91dce73, auth-bypass-dff86f76c8, missing-auth-0bf4ab57f0).
 *
 * Precedence: --require-api-auth flag > REQUIRE_API_AUTH env > fail-closed default
 * (auth on when bound to a non-loopback host with an API key configured).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { startMock, createServerMock, getSettingsEnvVarMock } = vi.hoisted(() => ({
  startMock: vi.fn(async (..._args: any[]) => async () => {}),
  createServerMock: vi.fn(async () => ({
    server: { connect: async () => {}, close: async () => {} },
    cleanup: async () => {},
  })),
  getSettingsEnvVarMock: vi.fn((): string | undefined => undefined),
}));

vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: getSettingsEnvVarMock,
  clearSettingsCache: vi.fn(),
}));

vi.mock('../src/mcp-proxy.js', () => ({
  createServer: createServerMock,
  createServerFactory: () => ({
    createServer: async () => ({ connect: async () => {}, close: async () => {} }),
    cleanup: async () => {},
  }),
}));

vi.mock('../src/streamable-http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/streamable-http.js')>()),
  startStreamableHTTPServer: startMock,
}));

import { resolveRequireApiAuth } from '../src/streamable-http.js';

const VALID_KEY = 'pg_in_' + 'k'.repeat(40);

describe('resolveRequireApiAuth', () => {
  it('lets the CLI flag win over REQUIRE_API_AUTH=false', () => {
    const decision = resolveRequireApiAuth({ cliFlag: true, envValue: 'false', bindHost: '0.0.0.0', hasApiKey: true });
    expect(decision.requireApiAuth).toBe(true);
  });

  it.each(['true', 'TRUE', ' true '])('honours REQUIRE_API_AUTH=%j', (envValue) => {
    const decision = resolveRequireApiAuth({ envValue, bindHost: 'localhost', hasApiKey: false });
    expect(decision.requireApiAuth).toBe(true);
  });

  it('honours an explicit REQUIRE_API_AUTH=false on a public bind, with a warning', () => {
    const decision = resolveRequireApiAuth({ envValue: 'false', bindHost: '0.0.0.0', hasApiKey: true });
    expect(decision.requireApiAuth).toBe(false);
    expect(decision.notice).toMatch(/REQUIRE_API_AUTH=false/);
  });

  it('does not warn about REQUIRE_API_AUTH=false on loopback', () => {
    const decision = resolveRequireApiAuth({ envValue: 'false', bindHost: '127.0.0.1', hasApiKey: true });
    expect(decision.requireApiAuth).toBe(false);
    expect(decision.notice).toBeUndefined();
  });

  it('fails closed on an unrecognised REQUIRE_API_AUTH value', () => {
    const decision = resolveRequireApiAuth({ envValue: 'yes please', bindHost: 'localhost', hasApiKey: true });
    expect(decision.requireApiAuth).toBe(true);
    expect(decision.notice).toMatch(/REQUIRE_API_AUTH/);
  });

  it.each(['0.0.0.0', '::', '10.1.2.3', 'example.internal'])(
    'defaults to requiring auth when bound to %s with an API key',
    (bindHost) => {
      const decision = resolveRequireApiAuth({ bindHost, hasApiKey: true });
      expect(decision.requireApiAuth).toBe(true);
      expect(decision.notice).toMatch(/REQUIRE_API_AUTH=false/);
    }
  );

  it.each([undefined, '', 'localhost', '127.0.0.1', '127.0.1.1', '::1', '[::1]'])(
    'keeps auth off by default on loopback bind %j',
    (bindHost) => {
      const decision = resolveRequireApiAuth({ bindHost, hasApiKey: true });
      expect(decision.requireApiAuth).toBe(false);
      expect(decision.notice).toBeUndefined();
    }
  );

  it('keeps auth off by default on a public bind when no API key is configured', () => {
    const decision = resolveRequireApiAuth({ envValue: '', bindHost: '0.0.0.0', hasApiKey: false });
    expect(decision.requireApiAuth).toBe(false);
  });
});

describe('src/index.ts streamable-http startup', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    startMock.mockClear();
    getSettingsEnvVarMock.mockReset();
    getSettingsEnvVarMock.mockReturnValue(undefined);
    process.env = { ...originalEnv };
    delete process.env.REQUIRE_API_AUTH;
    delete process.env.BIND_HOST;
    delete process.env.PORT;
    process.env.PLUGGEDIN_API_KEY = VALID_KEY;
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

  async function startWith(args: string[]): Promise<{ requireApiAuth?: boolean }> {
    process.argv = ['node', 'index.js', '--transport', 'streamable-http', ...args];
    await import('../src/index.js');
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    return startMock.mock.calls[0][1];
  }

  it('honours REQUIRE_API_AUTH=true from the environment', async () => {
    process.env.REQUIRE_API_AUTH = 'true';
    const options = await startWith([]);
    expect(options.requireApiAuth).toBe(true);
  });

  it('requires auth by default on a public bind with an API key, and says why on stderr', async () => {
    process.env.BIND_HOST = '0.0.0.0';
    const options = await startWith([]);
    expect(options.requireApiAuth).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/0\.0\.0\.0/));
  });

  it('counts a key from the credentials file as configured', async () => {
    delete process.env.PLUGGEDIN_API_KEY;
    getSettingsEnvVarMock.mockImplementation((name?: string) =>
      name === 'PLUGGEDIN_API_KEY' ? VALID_KEY : undefined
    );
    process.env.BIND_HOST = '0.0.0.0';
    const options = await startWith([]);
    expect(options.requireApiAuth).toBe(true);
  });

  it('keeps an explicit REQUIRE_API_AUTH=false but warns on stderr', async () => {
    process.env.BIND_HOST = '0.0.0.0';
    process.env.REQUIRE_API_AUTH = 'false';
    const options = await startWith([]);
    expect(options.requireApiAuth).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/REQUIRE_API_AUTH=false/));
  });

  it('lets --require-api-auth override REQUIRE_API_AUTH=false', async () => {
    process.env.REQUIRE_API_AUTH = 'false';
    const options = await startWith(['--require-api-auth']);
    expect(options.requireApiAuth).toBe(true);
  });

  it('leaves auth off for the default loopback bind', async () => {
    const options = await startWith([]);
    expect(options.requireApiAuth).toBe(false);
  });
});
