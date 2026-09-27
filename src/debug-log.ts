/**
 * Debug logging utility that only outputs when not using STDIO transport
 * This prevents console output from interfering with the STDIO protocol
 *
 * Every argument is redacted before it is written: request errors (e.g. Axios)
 * carry the Authorization header of the failed request, and logs are retained
 * by container runtimes.
 */

import { inspect } from 'node:util';

const isStdioTransport = () => {
  // Check if we're running with STDIO transport (default) or another transport
  // We can detect this by checking if the --transport flag was set to something other than stdio
  const args = process.argv.slice(2);
  const transportIndex = args.findIndex(arg => arg === '--transport');
  if (transportIndex === -1) {
    // No --transport flag means default (stdio)
    return true;
  }
  const transportType = args[transportIndex + 1];
  return !transportType || transportType === 'stdio';
};

const useStdio = isStdioTransport();

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [/(Bearer\s+)[^\s'",}]+/gi, `$1${REDACTED}`],
  // Plugged.in API keys
  [/pg_in_[A-Za-z0-9_-]+/g, `pg_in_${REDACTED}`],
  // key: value / key=value pairs for credential-like keys (headers, query strings, objects)
  [
    /(\b(?:authorization|x-api-key|api[_-]?key|[a-z_]*token|password|secret)\b['"]?\s*[:=]\s*['"]?)(?!Bearer\b)[^\s'",}&]+/gi,
    `$1${REDACTED}`,
  ],
];

/**
 * Removes credentials from a string: bearer tokens, pg_in_ keys, credential-like
 * key/value pairs and the configured API key itself (whatever its format).
 */
const redactSecrets = (text: string): string => {
  let result = text;
  const configuredKey = process.env.PLUGGEDIN_API_KEY;
  if (configuredKey && configuredKey.length >= 8) {
    result = result.split(configuredKey).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

/**
 * Axios errors hold the full request config (headers included) and the raw
 * request; only an allowlist of fields is kept.
 */
const summarizeAxiosError = (error: any) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  status: error.response?.status,
  method: error.config?.method,
  url: error.config?.url,
});

const toSafeLogArg = (arg: unknown): unknown => {
  if (typeof arg === 'string') {
    return redactSecrets(arg);
  }
  if (arg === null || typeof arg !== 'object') {
    return arg;
  }
  const value = (arg as any).isAxiosError === true ? summarizeAxiosError(arg) : arg;
  return redactSecrets(inspect(value, { depth: 4, breakLength: Infinity }));
};

export const debugLog = (...args: any[]) => {
  if (!useStdio) {
    console.log(...args.map(toSafeLogArg));
  }
};

export const debugError = (...args: any[]) => {
  if (!useStdio) {
    console.error(...args.map(toSafeLogArg));
  }
};
