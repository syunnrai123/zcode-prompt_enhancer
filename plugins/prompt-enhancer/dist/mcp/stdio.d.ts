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
    readonly error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export declare const PARSE_ERROR = -32700;
export declare const METHOD_NOT_FOUND = -32601;
export declare const INTERNAL_ERROR = -32603;
export declare function response(id: JsonRpcId, result: unknown): JsonRpcResponse;
export declare function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse;
/** Parse one inbound line; notifications (no id) return null — they need no reply. */
export declare function parseMessage(line: string): JsonRpcRequest | null;
export interface StdioHooks {
    onMessage(msg: JsonRpcRequest): void;
    onInvalidLine?(error: Error & {
        code?: number;
    }): void;
}
/**
 * Wire readline to the message handler. Logs must go to stderr — stdout is
 * reserved for the protocol itself.
 */
export declare function startStdio(hooks: StdioHooks): void;
