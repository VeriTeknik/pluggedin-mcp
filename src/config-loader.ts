/**
 * Reads Plugged.in credentials from the XDG-compliant config file
 * ($XDG_CONFIG_HOME/pluggedin/credentials.json, default ~/.config)
 * with fallback to the legacy user-level ~/.claude/settings.local.json.
 *
 * Search order (first match wins, per key):
 * 1. $XDG_CONFIG_HOME/pluggedin/credentials.json  (preferred — outside any repo)
 * 2. ~/.claude/settings.local.json                 (user-level, legacy)
 *
 * The project-level ./.claude/settings.local.json is deliberately NOT read.
 * In STDIO mode the proxy runs with its working directory set to whatever
 * project the MCP client has open, which may be an untrusted clone; letting
 * that file choose PLUGGEDIN_API_BASE_URL would send the user's API key (and
 * trust for returned server definitions) to a host the repository picked.
 * If it holds PLUGGEDIN_* keys, a one-time warning goes to stderr.
 */

import { readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { debugLog } from './debug-log.js';

interface SettingsCache {
  env: Record<string, string>;
  mtimes: number[];
  lastCheckedAt: number;
}

const CACHE_TTL_MS = 5_000;

const CREDENTIAL_KEY_MAP: Record<string, string> = {
  api_key: 'PLUGGEDIN_API_KEY',
  base_url: 'PLUGGEDIN_API_BASE_URL',
  mcp_endpoint: 'PLUGGEDIN_MCP_ENDPOINT',
};

let cache: SettingsCache | null = null;
let projectSettingsWarned = false;

function getCredentialsPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdgConfig, 'pluggedin', 'credentials.json');
}

function getProjectSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.local.json');
}

function getUserSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.local.json');
}

/**
 * Read credentials.json format: { "api_key": "...", "base_url": "..." }
 * Returns normalized env-style record.
 */
function readCredentialsFile(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return {};

    const env: Record<string, string> = {};
    for (const [jsonKey, envKey] of Object.entries(CREDENTIAL_KEY_MAP)) {
      if (typeof parsed[jsonKey] === 'string') {
        env[envKey] = parsed[jsonKey];
      }
    }
    return env;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return {};
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
    }
    debugLog(`[config-loader] Failed to read credentials from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * Read .claude/settings.local.json format: { "env": { "KEY": "value" } }
 */
function readSettingsFile(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.env === 'object' && parsed.env !== null) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.env)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }
      return env;
    }
  } catch {
    // File missing, parse error, or permission denied — all silent
  }
  return {};
}

/**
 * Warn (once, on stderr — stdout carries the STDIO protocol) when the
 * working directory's .claude/settings.local.json holds PLUGGEDIN_* keys,
 * since they used to be honoured and are now ignored. Only key names are
 * printed, never values.
 */
function warnIfProjectSettingsHavePluggedinKeys(): void {
  if (projectSettingsWarned) return;

  const projectPath = getProjectSettingsPath();
  // With cwd = $HOME this is the user-level file, which is trusted
  if (resolve(projectPath) === resolve(getUserSettingsPath())) return;

  const keys = Object.keys(readSettingsFile(projectPath)).filter((k) => k.startsWith('PLUGGEDIN_'));
  if (keys.length === 0) return;

  projectSettingsWarned = true;
  console.error(
    `[pluggedin-mcp] Ignoring ${keys.join(', ')} in ${projectPath}: project-level settings ` +
    `are not trusted for credentials or the API endpoint. Move these values to ` +
    `${getCredentialsPath()} (or ${getUserSettingsPath()}).`
  );
}

function getFileMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function getCachedSettings(): Record<string, string> {
  const now = Date.now();

  if (cache && (now - cache.lastCheckedAt) < CACHE_TTL_MS) {
    return cache.env;
  }

  const credentialsPath = getCredentialsPath();
  const userPath = getUserSettingsPath();

  const mtimes = [
    getFileMtime(credentialsPath),
    getFileMtime(userPath),
  ];

  if (cache && cache.mtimes.every((m, i) => m === mtimes[i])) {
    cache.lastCheckedAt = now;
    return cache.env;
  }

  warnIfProjectSettingsHavePluggedinKeys();

  // Read in priority order: credentials.json first, then legacy settings
  const credentialsEnv = readCredentialsFile(credentialsPath);
  const userEnv = readSettingsFile(userPath);

  // Lower priority first, higher priority overrides
  const merged = { ...userEnv, ...credentialsEnv };

  const hasKeys = Object.keys(merged).length > 0;

  cache = { env: merged, mtimes, lastCheckedAt: now };

  if (hasKeys) {
    const sources: string[] = [];
    if (Object.keys(credentialsEnv).length > 0) sources.push('credentials');
    if (Object.keys(userEnv).length > 0) sources.push('user');
    debugLog(`[config-loader] Loaded settings from: ${sources.join(', ')}`);
  }

  return merged;
}

/**
 * Get a single environment variable from config files.
 * Checks ~/.config/pluggedin/credentials.json first, then user-level legacy settings.
 * Results are cached with mtime-based invalidation (5s TTL).
 */
export function getSettingsEnvVar(varName: string): string | undefined {
  const settings = getCachedSettings();
  return settings[varName];
}

/** Clear the settings cache and the one-time warning state (for testing). */
export function clearSettingsCache(): void {
  cache = null;
  projectSettingsWarned = false;
}
