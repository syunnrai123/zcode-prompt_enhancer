/**
 * Minimal MCP stdio transport — newline-delimited JSON-RPC 2.0 over
 * stdin/stdout, which is exactly the framing the MCP specification uses for
 * stdio servers.
 *
 * Hand-rolled (instead of depending on @modelcontextprotocol/sdk) so the
 * compiled plugin ships with zero runtime dependencies and no node_modules
 * beside the install cache. Only the methods ZCode needs are implemented:
 * initialize / ping / tools/list / tools/call.
 */
import * as readline from 'node:readline';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export function response(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

/** Parse one inbound line; notifications (no id) return null — they need no reply. */
export function parseMessage(line: string): JsonRpcRequest | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw Object.assign(new Error(`Invalid JSON line: ${trimmed.slice(0, 120)}`), { code: PARSE_ERROR });
  }
  if (typeof parsed !== 'object' || parsed === null || !('method' in parsed)) return null;
  const msg = parsed as { method?: unknown; id?: unknown; params?: unknown };
  if (typeof msg.method !== 'string') return null;
  return {
    jsonrpc: '2.0',
    id: typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null,
    method: msg.method,
    params: msg.params,
  };
}

export interface StdioHooks {
  onMessage(msg: JsonRpcRequest): void;
  onInvalidLine?(error: Error & { code?: number }): void;
}

/**
 * Wire readline to the message handler. Logs must go to stderr — stdout is
 * reserved for the protocol itself.
 */
export function startStdio(hooks: StdioHooks): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    try {
      const msg = parseMessage(line);
      if (msg) hooks.onMessage(msg);
    } catch (error) {
      hooks.onInvalidLine?.(error as Error & { code?: number });
    }
  });
}
