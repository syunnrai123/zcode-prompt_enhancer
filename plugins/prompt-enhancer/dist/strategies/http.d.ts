/** Shared, bounded HTTP/SSE transport for the streaming provider strategies. */
import { EnhancerError } from '../core/types.js';
export declare const STREAM_LIMITS: {
    readonly eventChars: number;
    readonly responseBytes: number;
    readonly outputChars: number;
    readonly errorBodyBytes: 4096;
    readonly eventIds: 4096;
};
export interface SseRequest {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
    readonly timeoutMs: number;
}
export interface SseEvent {
    readonly type: string;
    /** Only an explicit id on this event, not an inherited EventSource last-event-id. */
    readonly id?: string;
}
export interface SseCallbacks {
    /** One complete SSE event, with multiline data joined by a newline. */
    onData(payload: string, event?: SseEvent): void | 'stop';
    /** The OpenAI [DONE] sentinel. Returning normally ends and cancels the stream. */
    onDone(): void;
}
/** Keep the public error codes stable, but distinguish transient failures internally. */
export declare class ProviderUnavailableError extends EnhancerError {
    readonly retryable: boolean;
    readonly status?: number;
    readonly retryAfterMs: number;
    constructor(message: string, options: {
        retryable: boolean;
        status?: number;
        retryAfterMs?: number;
        cause?: unknown;
    });
}
/**
 * The timer covers headers, error details, and the streamed body. Native fetch
 * receives the same abort signal; the abort race also makes injected fetches and
 * streams obey it. Providers validate semantic completion in their callbacks.
 */
export declare function postSse(req: SseRequest, callbacks: SseCallbacks, fetchImpl?: typeof fetch): Promise<void>;
export declare function isTransientStatus(status: number): boolean;
/** JSON comments/keep-alives belong in SSE comments or typed ping events, not malformed data. */
export declare function parseSsePayload(payload: string): Record<string, unknown>;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Errors delivered after HTTP 200 still fail the entire private attempt. */
export declare function streamedProviderError(provider: string, value: unknown): ProviderUnavailableError;
export declare function errorMessage(error: unknown): string;
export declare function truncate(text: string, maxLength: number): string;
export interface RetryOptions {
    /** One original wall-clock budget, shared by both attempts and any backoff. */
    readonly timeoutMs?: number;
    readonly retryDelayMs?: number;
    /** Clock/sleep injection keeps deadline/backoff tests deterministic. */
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}
/**
 * At most one retry, only for explicitly transient failures. The second argument
 * retains the old cold-start API for callers that publish deltas. Buffered
 * providers pass false and create fresh text/parser state inside each run.
 */
export declare function withColdStartRetry<T>(run: (remainingMs: number) => Promise<T>, hasPublishedContent: () => boolean, options?: RetryOptions): Promise<T>;
