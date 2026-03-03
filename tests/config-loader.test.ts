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

  it('returns undefined when no settings files exist', () => {
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });

  it('reads API key from settings file', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'pg_in_test_key_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz' } })
    );

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe(
      'pg_in_test_key_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz'
    );
  });

  it('project-level overrides user-level', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.startsWith('/home/testuser')) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'user_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'project_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('project_level_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('falls back to user-level when project-level is missing', () => {
    let callCount = 0;
    vi.mocked(fs.statSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.startsWith('/home/testuser')) {
        return { mtimeMs: 1000 } as fs.Stats;
      }
      throw new Error('ENOENT');
    });
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.startsWith('/home/testuser')) {
        return JSON.stringify({ env: { PLUGGEDIN_API_KEY: 'user_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
      }
      throw new Error('ENOENT');
    });

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBe('user_key_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
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

  it('handles env object with no matching key', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ env: { SOME_OTHER_KEY: 'value' } })
    );

    expect(getSettingsEnvVar('PLUGGEDIN_API_KEY')).toBeUndefined();
  });

  it('only returns string values from env', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ env: { GOOD: 'string_value_padded_to_be_long_enough', BAD_NUM: 42, BAD_NULL: null, BAD_OBJ: {} } })
    );

    expect(getSettingsEnvVar('GOOD')).toBe('string_value_padded_to_be_long_enough');
    expect(getSettingsEnvVar('BAD_NUM')).toBeUndefined();
    expect(getSettingsEnvVar('BAD_NULL')).toBeUndefined();
    expect(getSettingsEnvVar('BAD_OBJ')).toBeUndefined();
  });

  it('uses cache within TTL — does not re-stat', () => {
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ env: { KEY: 'value' } })
    );

    // First call reads from file
    getSettingsEnvVar('KEY');
    const statCallsAfterFirst = vi.mocked(fs.statSync).mock.calls.length;

    // Second call within TTL should use cache (no new stat calls)
    getSettingsEnvVar('KEY');
    expect(vi.mocked(fs.statSync).mock.calls.length).toBe(statCallsAfterFirst);
  });

  it('re-reads when file mtime changes after cache expires', () => {
    let mtime = 1000;
    vi.mocked(fs.statSync).mockImplementation(() => ({ mtimeMs: mtime } as fs.Stats));
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ env: { KEY: 'old_value' } })
    );

    expect(getSettingsEnvVar('KEY')).toBe('old_value');

    // Simulate cache expiry by clearing
    clearSettingsCache();

    // Change mtime and file content
    mtime = 2000;
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ env: { KEY: 'new_value' } })
    );

    expect(getSettingsEnvVar('KEY')).toBe('new_value');
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
