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
 * POST the request and parse a streaming SSE response. Uses the injection
 * parameter `fetchImpl` so tests can stub the network entirely.
 */
export declare function postSse(req: SseRequest, callbacks: SseCallbacks, fetchImpl?: typeof fetch): Promise<void>;
export declare function errorMessage(error: unknown): string;
export declare function truncate(text: string, maxLength: number): string;
/**
 * Retry-once wrapper for idempotent streaming calls that fail before any
 * content was received. Once deltas have flushed, retrying would duplicate
 * partial output, so only cold-start failures (connection refused, TLS
 * handshake, first-byte timeout) get a second attempt.
 */
export declare function withColdStartRetry<T>(run: () => Promise<T>, hasReceivedContent: () => boolean): Promise<T>;
