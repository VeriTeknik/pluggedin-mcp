/**
 * Minor output fixes (review follow-up to the deepsec fixes):
 * - the --pluggedin-api-base-url error must describe what validateApiUrl accepts
 *   (https, or http only for loopback), not "http(s)";
 * - pluggedin_ask_knowledge_base must not dump the user's query and the full RAG
 *   response to stderr, in any transport mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { inspect } from 'node:util';

const { startMock } = vi.hoisted(() => ({
  startMock: vi.fn(async (..._args: any[]) => async () => {}),
}));

// Keep the developer's real credential files out of these tests
vi.mock('../src/config-loader.js', () => ({
  getSettingsEnvVar: () => undefined,
  clearSettingsCache: vi.fn(),
}));

vi.mock('../src/notification-logger.js', () => ({
  logMcpActivity: vi.fn().mockResolvedValue(undefined),
  createExecutionTimer: () => ({ stop: () => 0 }),
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

const KEY = 'pg_in_' + 'l'.repeat(40);

function printed(...spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((call: unknown[]) => call.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' '))
    .join('\n');
}

describe('logging hygiene', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.PLUGGEDIN_API_BASE_URL;
    delete process.env.REQUIRE_API_AUTH;
    delete process.env.BIND_HOST;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    vi.restoreAllMocks();
  });

  describe('--pluggedin-api-base-url error', () => {
    it('says https is required (http only for loopback) instead of "http(s)"', async () => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as any);
      process.argv = ['node', 'index.js', '--transport', 'streamable-http', '--pluggedin-api-base-url', 'http://plugged.example.com'];

      await expect(import('../src/index.js')).rejects.toThrow('process.exit(1)');

      const out = printed(errorSpy);
      expect(out).toMatch(/API base URL/);
      expect(out).not.toContain('http(s)');
      expect(out).toMatch(/https:\/\//);
      expect(out).toMatch(/localhost/);
    });
  });

  describe.each([
    ['stdio', [] as string[]],
    ['streamable-http', ['--transport', 'streamable-http']],
  ])('pluggedin_ask_knowledge_base in %s mode', (_mode, transportArgs) => {
    it('does not print the query or the RAG response', async () => {
      process.argv = ['node', 'index.js', ...transportArgs];
      process.env.PLUGGEDIN_API_KEY = KEY;
      process.env.PLUGGEDIN_API_BASE_URL = 'http://localhost:3000';

      const axios = (await import('axios')).default;
      vi.spyOn(axios, 'post').mockResolvedValue({
        data: { answer: 'PRIVATE-ANSWER from my notes', sources: ['PRIVATE-DOC.pdf'] },
      });
      const { StaticToolHandlers } = await import('../src/handlers/static-handlers.js');
      const handlers = new StaticToolHandlers({}, {});

      const result = await handlers.handleAskKnowledgeBase({ query: 'PRIVATE-QUESTION about payroll' });
      expect(JSON.stringify(result)).toContain('PRIVATE-ANSWER');

      const out = printed(errorSpy, logSpy);
      expect(out).not.toContain('PRIVATE-QUESTION');
      expect(out).not.toContain('PRIVATE-ANSWER');
      expect(out).not.toContain('PRIVATE-DOC');
      expect(out).not.toContain('[DEBUG');
    });
  });
});
