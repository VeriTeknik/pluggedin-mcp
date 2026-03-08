/**
 * Reads Plugged.in credentials from the XDG-compliant config file
 * (~/.config/pluggedin/credentials.json) with fallback to legacy
 * .claude/settings.local.json locations.
 *
 * Search order (first match wins):
 * 1. ~/.config/pluggedin/credentials.json  (preferred — outside any repo)
 * 2. ./.claude/settings.local.json         (project-level, legacy)
 * 3. ~/.claude/settings.local.json         (user-level, legacy)
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debugLog } from './debug-log.js';

interface SettingsCache {
  env: Record<string, string>;
  mtimes: number[];
  lastCheckedAt: number;
}

const CACHE_TTL_MS = 5_000;

let cache: SettingsCache | null = null;

function getCredentialsPath(): string {
  return join(homedir(), '.config', 'pluggedin', 'credentials.json');
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
    if (typeof parsed.api_key === 'string') {
      env['PLUGGEDIN_API_KEY'] = parsed.api_key;
    }
    if (typeof parsed.base_url === 'string') {
      env['PLUGGEDIN_API_BASE_URL'] = parsed.base_url;
    }
    if (typeof parsed.mcp_endpoint === 'string') {
      env['PLUGGEDIN_MCP_ENDPOINT'] = parsed.mcp_endpoint;
    }
    return env;
  } catch {
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
  const projectPath = getProjectSettingsPath();
  const userPath = getUserSettingsPath();

  const mtimes = [
    getFileMtime(credentialsPath),
    getFileMtime(projectPath),
    getFileMtime(userPath),
  ];

  if (cache && cache.mtimes.every((m, i) => m === mtimes[i])) {
    cache.lastCheckedAt = now;
    return cache.env;
  }

  // Read in priority order: credentials.json first, then legacy settings
  const credentialsEnv = readCredentialsFile(credentialsPath);
  const userEnv = readSettingsFile(userPath);
  const projectEnv = readSettingsFile(projectPath);

  // Lower priority first, higher priority overrides
  const merged = { ...userEnv, ...projectEnv, ...credentialsEnv };

  const hasKeys = Object.keys(merged).length > 0;

  cache = { env: merged, mtimes, lastCheckedAt: now };

  if (hasKeys) {
    const sources: string[] = [];
    if (Object.keys(credentialsEnv).length > 0) sources.push('credentials');
    if (Object.keys(projectEnv).length > 0) sources.push('project');
    if (Object.keys(userEnv).length > 0) sources.push('user');
    debugLog(`[config-loader] Loaded settings from: ${sources.join(', ')}`);
  }

  return merged;
}

/**
 * Get a single environment variable from config files.
 * Checks ~/.config/pluggedin/credentials.json first, then legacy settings.
 * Results are cached with mtime-based invalidation (5s TTL).
 */
export function getSettingsEnvVar(varName: string): string | undefined {
  const settings = getCachedSettings();
  return settings[varName];
}

/** Clear the settings cache (for testing). */
export function clearSettingsCache(): void {
  cache = null;
}
