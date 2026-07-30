/**
 * Error codes introduced by MCP 2026-07-28.
 *
 * The spec partitions the JSON-RPC server-error range: -32000..-32019 stays
 * implementation-defined (our existing UNAUTHORIZED/-32001 and
 * APPLICATION_ERROR/-32000 in constants.ts are grandfathered there and must not
 * move), while -32020..-32099 is reserved for the specification itself.
 */

export const PROTOCOL_ERROR_CODES = Object.freeze({
  /** Mcp-Method or Mcp-Name header disagrees with the JSON-RPC body. */
  HEADER_MISMATCH: -32020,
  /** Request needs a client capability the caller did not declare. */
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  /** Requested protocol revision is not one this server speaks. */
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
  /** Standard JSON-RPC Invalid Params — now also used for resource-not-found. */
  INVALID_PARAMS: -32602,
} as const);

export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }

  toJsonRpc(id: string | number | null): object {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: this.code,
        message: this.message,
        ...(this.data !== undefined ? { data: this.data } : {}),
      },
    };
  }
}
