import crypto from "crypto";
import { ServerParameters } from "./types.js"; // Corrected import path
import { validateBearerToken, validateApiUrl, validateEnvVarName } from "./security-utils.js";
import { debugError } from "./debug-log.js";
import { getSettingsEnvVar } from "./config-loader.js";

export const getSessionKey = (uuid: string, params: ServerParameters): string => {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(params));
  return `${uuid}_${hash.digest("hex")}`;
};

export const sanitizeName = (name: string): string => {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
};

// Helper function to get the API key, prioritizing argument over environment variable
export const getPluggedinMCPApiKey = (apiKey?: string): string | undefined => {
  // Prioritize argument, then environment variable, then settings.local.json
  // Use || instead of ?? so empty strings (from unexpanded ${PLUGGEDIN_API_KEY}) trigger fallback
  const key = apiKey || process.env.PLUGGEDIN_API_KEY || getSettingsEnvVar('PLUGGEDIN_API_KEY');
  
  // Validate token format if present
  if (key && !validateBearerToken(key)) {
    debugError("Invalid API key format detected");
    return undefined;
  }
  
  return key;
};

let invalidBaseUrlWarned = false;

// Helper function to get the API base URL, prioritizing argument, then env var, then default
export const getPluggedinMCPApiBaseUrl = (baseUrl?: string): string | undefined => {
  // Prioritize argument, then environment variable, then user-level config files, then default
  const url = baseUrl || process.env.PLUGGEDIN_API_BASE_URL || getSettingsEnvVar('PLUGGEDIN_API_BASE_URL') || 'https://plugged.in';
  
  if (!url) {
    return undefined;
  }
  
  // The API key is sent to this URL: https only (http for loopback), no embedded credentials
  if (!validateApiUrl(url)) {
    // debugError is silent in STDIO mode, so tell the user once on stderr.
    // The URL itself is not echoed: it may contain credentials.
    if (!invalidBaseUrlWarned) {
      invalidBaseUrlWarned = true;
      console.error(
        "[pluggedin-mcp] Invalid PLUGGEDIN_API_BASE_URL: it must use https (plain http is allowed only " +
        "for localhost, 127.0.0.1 and [::1]) and must not contain credentials. Plugged.in API calls are disabled."
      );
    }
    return undefined;
  }
  
  return url;
};

// Helper function to check if debug logging is enabled
export const isDebugEnabled = (): boolean => {
  return process.env.DEBUG === "true";
};

// Helper function to get default environment variables
export const getDefaultEnvironment = (): Record<string, string> => {
  const defaultEnv: Record<string, string> = {};
  const allowedEnvVars = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL'];
  
  for (const varName of allowedEnvVars) {
    if (process.env[varName] && validateEnvVarName(varName)) {
      // Sanitize the value to prevent injection
      defaultEnv[varName] = String(process.env[varName]).replace(/[\0\r\n]/g, '');
    }
  }

  return defaultEnv;
};
