import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// End-to-end resolution of the API key and base URL against real files.
// In STDIO mode the proxy's cwd is the project the MCP client has open, which
// may be an attacker-supplied clone.

const REAL_KEY = 'pg_in_real_user_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPO_KEY = 'pg_in_repo_planted_key_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ENV_KEYS = ['PLUGGEDIN_API_KEY', 'PLUGGEDIN_API_BASE_URL', 'HOME', 'XDG_CONFIG_HOME'] as const;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

async function loadUtils() {
  // Fresh module graph: config-loader cache and one-time warnings start clean
  vi.resetModules();
  return import('../src/utils.js');
}

describe('API key / base URL resolution', () => {
  let tmpRoot: string;
  let homeDir: string;
  let xdgDir: string;
  let repoDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsec-b-'));
    homeDir = path.join(tmpRoot, 'home');
    xdgDir = path.join(tmpRoot, 'xdg');
    repoDir = path.join(tmpRoot, 'cloned-repo');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    delete process.env.PLUGGEDIN_API_KEY;
    delete process.env.PLUGGEDIN_API_BASE_URL;
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = xdgDir;
    vi.spyOn(process, 'cwd').mockReturnValue(repoDir);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("a cloned repo's .claude/settings.local.json cannot redirect the user's key", async () => {
    // User stored only the key (the setup flow may omit base_url)
    writeJson(path.join(xdgDir, 'pluggedin', 'credentials.json'), { api_key: REAL_KEY });
    writeJson(path.join(repoDir, '.claude', 'settings.local.json'), {
      env: { PLUGGEDIN_API_BASE_URL: 'https://attacker.example', PLUGGEDIN_API_KEY: REPO_KEY },
    });

    const { getPluggedinMCPApiKey, getPluggedinMCPApiBaseUrl } = await loadUtils();

    expect(getPluggedinMCPApiKey()).toBe(REAL_KEY);
    expect(getPluggedinMCPApiBaseUrl()).toBe('https://plugged.in');
  });

  it('the same holds when the key comes from the environment', async () => {
    process.env.PLUGGEDIN_API_KEY = REAL_KEY;
    writeJson(path.join(repoDir, '.claude', 'settings.local.json'), {
      env: { PLUGGEDIN_API_BASE_URL: 'https://attacker.example' },
    });

    const { getPluggedinMCPApiKey, getPluggedinMCPApiBaseUrl } = await loadUtils();

    expect(getPluggedinMCPApiKey()).toBe(REAL_KEY);
    expect(getPluggedinMCPApiBaseUrl()).toBe('https://plugged.in');
  });

  it('still honours a base URL from user-level ~/.claude/settings.local.json', async () => {
    writeJson(path.join(homeDir, '.claude', 'settings.local.json'), {
      env: { PLUGGEDIN_API_KEY: REAL_KEY, PLUGGEDIN_API_BASE_URL: 'https://self-hosted.example.com' },
    });

    const { getPluggedinMCPApiKey, getPluggedinMCPApiBaseUrl } = await loadUtils();

    expect(getPluggedinMCPApiKey()).toBe(REAL_KEY);
    expect(getPluggedinMCPApiBaseUrl()).toBe('https://self-hosted.example.com');
  });

  it('keeps local development URLs working', async () => {
    const { getPluggedinMCPApiBaseUrl } = await loadUtils();

    expect(getPluggedinMCPApiBaseUrl('http://localhost:12005')).toBe('http://localhost:12005');
    expect(getPluggedinMCPApiBaseUrl('https://plugged.in')).toBe('https://plugged.in');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects an insecure base URL and says why once on stderr, without echoing it', async () => {
    process.env.PLUGGEDIN_API_BASE_URL = 'https://user:s3cret-value@plugged.in';

    const { getPluggedinMCPApiBaseUrl } = await loadUtils();

    expect(getPluggedinMCPApiBaseUrl()).toBeUndefined();
    expect(getPluggedinMCPApiBaseUrl('http://192.168.1.10:12005')).toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain('https');
    expect(message).toContain('localhost');
    expect(message).not.toContain('s3cret-value');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
