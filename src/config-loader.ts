/**
 * Reads environment variables from .claude/settings.local.json files.
 * Provides a fallback when env vars are not set (e.g., MCP server started
 * before /pluggedin:setup saved the API key).
 *
 * Search order: project-level (./.claude/settings.local.json) overrides
 * user-level (~/.claude/settings.local.json).
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debugLog } from './debug-log.js';

interface SettingsCache {
  env: Record<string, string>;
  projectMtime: number;
  userMtime: number;
  lastCheckedAt: number;
}

const CACHE_TTL_MS = 5_000;

let cache: SettingsCache | null = null;

function getProjectSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.local.json');
}

function getUserSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.local.json');
}

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

  const projectPath = getProjectSettingsPath();
  const userPath = getUserSettingsPath();
  const projectMtime = getFileMtime(projectPath);
  const userMtime = getFileMtime(userPath);

  if (cache && cache.projectMtime === projectMtime && cache.userMtime === userMtime) {
    cache.lastCheckedAt = now;
    return cache.env;
  }

  // User-level first, then project-level overrides
  const userEnv = readSettingsFile(userPath);
  const projectEnv = readSettingsFile(projectPath);
  const merged = { ...userEnv, ...projectEnv };

  const hasKeys = Object.keys(merged).length > 0;

  cache = { env: merged, projectMtime, userMtime, lastCheckedAt: now };

  if (hasKeys) {
    const sources: string[] = [];
    if (Object.keys(projectEnv).length > 0) sources.push('project');
    if (Object.keys(userEnv).length > 0) sources.push('user');
    debugLog(`[config-loader] Loaded settings from: ${sources.join(', ')}`);
  }

  return merged;
}

/**
 * Get a single environment variable from .claude/settings.local.json files.
 * Checks project-level first, then user-level.
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
