import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';

// Mock fs and os before importing the module
vi.mock('fs');
vi.mock('os');

// Import after mocks
import { getSettingsEnvVar, clearSettingsCache } from '../src/config-loader.js';

describe('config-loader', () => {
  beforeEach(() => {
    clearSettingsCache();
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');
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

  it('project-level settings override user-level settings', () => {
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

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('project_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
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
