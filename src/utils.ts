import { ServerParameters } from "./fetch-pluggedin.js";
import crypto from "crypto";

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
      ]
    : /* list inspired by the default env inheritance of sudo */
      ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined) {
      continue;
    }

    if (value.startsWith("()")) {
      // Skip functions, which are a security risk.
      continue;
    }

    env[key] = value;
  }

  return env;
}

/**
 * Get the Pluggedin API base URL from environment variables
 */
export function getPluggedinApiBaseUrl(): string {
  return process.env.PLUGGEDIN_API_BASE_URL || "https://plugged.in/";
}

/**
 * Get the Pluggedin API key from environment variables
 */
export function getPluggedinApiKey(): string | undefined {
  return process.env.PLUGGEDIN_API_KEY;
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function computeParamsHash(
  params: ServerParameters,
  uuid: string
): string {
  let paramsDict: any;

  // Default to "STDIO" if type is undefined
  if (!params.type || params.type === "STDIO") {
    paramsDict = {
      uuid,
      type: "STDIO", // Explicitly set type to "STDIO" for consistent hashing
      command: params.command,
      args: params.args,
      env: params.env
        ? Object.fromEntries(
            Object.entries(params.env).sort((a, b) => a[0].localeCompare(b[0]))
          )
        : null,
    };
  } else if (params.type === "SSE") {
    paramsDict = {
      uuid,
      type: params.type,
      url: params.url,
    };
  } else {
    throw new Error(`Unsupported server type: ${params.type}`);
  }

  const paramsJson = JSON.stringify(paramsDict);
  return crypto.createHash("sha256").update(paramsJson).digest("hex");
}

export function getSessionKey(uuid: string, params: ServerParameters): string {
  return `${uuid}_${computeParamsHash(params, uuid)}`;
}
