import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock fs and os before importing the module
vi.mock('fs');
vi.mock('os');

// Import after mocks
import { getSettingsEnvVar, clearSettingsCache } from '../src/config-loader.js';

const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.local.json');

describe('config-loader', () => {
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    clearSettingsCache();
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when no config files exist', () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });

  it('reads API key from credentials.json', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        return JSON.stringify({ api_key: 'pg_in_test_key_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz' });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe(
      'pg_in_test_key_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz'
    );
  });

  it('reads base_url and mcp_endpoint from credentials.json', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        return JSON.stringify({
          api_key: 'pg_in_test_key_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz',
          base_url: 'https://self-hosted.example.com',
          mcp_endpoint: 'https://mcp.example.com/mcp',
        });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_BASE_URL')).toBe('https://self-hosted.example.com');
    expect(getSettingsEnvVar('PLUGGEDIN_MCP_ENDPOINT')).toBe('https://mcp.example.com/mcp');
  });

  it('credentials.json overrides legacy settings.local.json', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        return JSON.stringify({ api_key: 'credentials_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
      }
      if (p.includes('.claude/settings.local.json')) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'settings_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('credentials_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('falls back to legacy settings.local.json when credentials.json missing', () => {
    vi.mocked(fs.statSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin')) throw new Error('ENOENT');
      return { mtimeMs: 1000 } as fs.Stats;
    });
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin')) throw new Error('ENOENT');
      if (p.startsWith('/home/testuser')) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'user_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('user_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  // The working directory is whatever project the MCP client has open, which
  // may be an untrusted clone, so its .claude/settings.local.json must never
  // supply credentials or the API destination.
  it('ignores project-level settings; user-level settings are used', () => {
    vi.mocked(fs.statSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin')) throw new Error('ENOENT');
      return { mtimeMs: 1000 } as fs.Stats;
    });
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin')) throw new Error('ENOENT');
      if (p.startsWith('/home/testuser')) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'user_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'project_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('user_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('never reads a value from project-level settings, even when no other source has it', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        // Key only: a project-supplied base URL must not be paired with it
        return JSON.stringify({ api_key: 'credentials_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
      }
      if (p === projectSettingsPath) {
        return JSON.stringify({
          env: {
            PLUGGEDIN_API_BASE_URL: 'https://attacker.example',
            PLUGGEDIN_API_KEY: 'project_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          },
        });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_BASE_URL')).toBeUndefined();
    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('credentials_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('warns once on stderr (never stdout) when project-level settings hold PLUGGEDIN_* keys', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let userMtime = 1000;
    vi.mocked(fs.statSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.startsWith('/home/testuser/.claude')) return { mtimeMs: userMtime } as fs.Stats;
      throw new Error('ENOENT');
    });
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p === projectSettingsPath) {
        return JSON.stringify({ env: { PLUGGEDIN_API_BASE_URL: 'https://attacker.example', OTHER: 'x' } });
      }
      if (p.startsWith('/home/testuser/.claude')) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'user_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      throw new Error('ENOENT');
    });

    getSettingsEnvVar('PLUGGEDIN_API_KEY');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain(projectSettingsPath);
    expect(message).toContain('PLUGGEDIN_API_BASE_URL');
    expect(message).toContain('credentials.json');
    // Names only: the value (which may be a key) is never echoed
    expect(message).not.toContain('attacker.example');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();

    // A later re-read (TTL expired, user file changed) does not warn again
    now += 10_000;
    userMtime = 2000;
    getSettingsEnvVar('PLUGGEDIN_API_KEY');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn when project-level settings hold no PLUGGEDIN_* keys', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p === projectSettingsPath) {
        return JSON.stringify({ env: { SOME_OTHER_TOOL: 'value' } });
      }
      throw new Error('ENOENT');
    });

    getSettingsEnvVar('PLUGGEDIN_API_KEY');

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not warn when the working directory is the home directory', () => {
    // ./.claude/settings.local.json is then the user-level file itself
    vi.mocked(os.homedir).mockReturnValue(process.cwd());
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p === projectSettingsPath) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'user_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('user_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });

  it('handles missing env key in valid JSON', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ other: 'data' }));

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });

  it('only returns string values from any config file', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        return JSON.stringify({ api_key: 42, base_url: null });
      }
      return JSON.stringify({ env: { GOOD: 'string_value_padded_to_be_long_enough', BAD_NUM: 123, BAD_NULL: null, BAD_OBJ: {} } });
    });

    // Non-string values in credentials.json should be ignored
    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
    // Non-string values in legacy settings.local.json should be ignored
    expect(getSettingsEnvVar('BAD_NUM')).toBeUndefined();
    expect(getSettingsEnvVar('BAD_NULL')).toBeUndefined();
    expect(getSettingsEnvVar('BAD_OBJ')).toBeUndefined();
    // But valid string values from legacy files still work
    expect(getSettingsEnvVar('GOOD')).toBe('string_value_padded_to_be_long_enough');
  });

  it('uses cache within TTL — does not re-stat', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        return JSON.stringify({ api_key: 'cached_key' });
      }
      throw new Error('ENOENT');
    });

    // First call reads from file
    getSettingsEnvVar('PLUGGEDIN_API_KEY');
    const statCallsAfterFirst = vi.mocked(fs.statSync).mock.calls.length;

    // Second call within TTL should use cache (no new stat calls)
    getSettingsEnvVar('PLUGGEDIN_API_KEY');
    expect(vi.mocked(fs.statSync).mock.calls.length).toBe(statCallsAfterFirst);
  });

  it('re-reads when file mtime changes after cache expires', () => {
    let mtime = 1000;
    vi.mocked(fs.statSync).mockImplementation(() => ({ mtimeMs: mtime } as fs.Stats));
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.includes('.config/pluggedin/credentials.json')) {
        return JSON.stringify({ api_key: mtime === 1000 ? 'old_key' : 'new_key' });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('old_key');

    // Simulate cache expiry by clearing
    clearSettingsCache();

    // Change mtime and file content
    mtime = 2000;
    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('new_key');
  });

  it('handles empty file', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });

  it('handles permission denied gracefully', () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });
});
