export interface SseRequest {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
    readonly timeoutMs: number;
}
export interface SseCallbacks {
    /** Called once per `data:` chunk with the raw JSON payload string. */
    onData(payload: string): void;
    /** Called with the raw `[DONE]` sentinel. */
    onDone(): void;
}
/**
 * POST the request and parse a streaming SSE response. The timeout is a
 * WALL-CLOCK budget over the whole exchange: headers AND the streamed body.
 * The AbortController stays armed until the stream has been fully consumed,
 * so a provider that sends headers and then stalls cannot hang the caller.
 * Uses the injection parameter `fetchImpl` so tests can stub the network
 * entirely.
 */
export declare function postSse(req: SseRequest, callbacks: SseCallbacks, fetchImpl?: typeof fetch): Promise<void>;
export declare function errorMessage(error: unknown): string;
export declare function truncate(text: string, maxLength: number): string;
/**
 * Retry-once wrapper for idempotent streaming calls that fail before any
 * content was received. Once deltas have flushed, retrying would duplicate
 * partial output, so only cold-start failures (connection refused, TLS
 * handshake, first-byte errors) get a second attempt. Timeouts are never
 * retried: a second attempt would double the caller's wall-clock wait beyond
 * the configured hard timeout.
 */
export declare function withColdStartRetry<T>(run: () => Promise<T>, hasReceivedContent: () => boolean): Promise<T>;
