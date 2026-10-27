/** Shared, bounded HTTP/SSE transport for the streaming provider strategies. */
import { EnhancerError } from '../core/types.js';

export const STREAM_LIMITS = {
  eventChars: 256 * 1024,
  responseBytes: 4 * 1024 * 1024,
  outputChars: 128 * 1024,
  errorBodyBytes: 4096,
  eventIds: 4096,
} as const;

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
export class ProviderUnavailableError extends EnhancerError {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs: number;

  constructor(message: string, options: {
    retryable: boolean;
    status?: number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super('PROVIDER_UNAVAILABLE', message, options.cause);
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

/**
 * The timer covers headers, error details, and the streamed body. Native fetch
 * receives the same abort signal; the abort race also makes injected fetches and
 * streams obey it. Providers validate semantic completion in their callbacks.
 */
export async function postSse(
  req: SseRequest,
  callbacks: SseCallbacks,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0) {
    throw new EnhancerError('PROVIDER_TIMEOUT', 'The provider deadline has expired');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    let response: Response;
    try {
      const pending = fetchImpl(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...req.headers },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      // An injected fetch might resolve after abort rather than reject. Do not
      // leave that late response's connection open.
      void pending.then((late) => {
        if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
      }, () => {});
      response = await abortable(pending, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError(req.timeoutMs, error);
      if (error instanceof EnhancerError) throw error;
      throw new ProviderUnavailableError(`Network request failed: ${errorMessage(error)}`, {
        retryable: true, cause: error,
      });
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response.body, controller.signal);
      throw new ProviderUnavailableError(
        `Provider returned HTTP ${response.status}: ${truncate(detail, 300)}`,
        {
          retryable: isTransientStatus(response.status),
          status: response.status,
          retryAfterMs: retryAfter(response.headers.get('retry-after')),
        },
      );
    }

    const body = response.body;
    if (!body) {
      throw new ProviderUnavailableError('Provider returned an empty body', { retryable: true });
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'text/event-stream') {
      void body.cancel().catch(() => {});
      throw new EnhancerError('INVALID_OUTPUT', 'Provider did not return a text/event-stream response');
    }

    try {
      await readSseStream(body, callbacks, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError(req.timeoutMs, error);
      if (error instanceof EnhancerError) throw error;
      throw new ProviderUnavailableError(`Stream failed: ${errorMessage(error)}`, {
        retryable: true, cause: error,
      });
    }
  } catch (error) {
    // In particular, do not turn an aborted HTTP error-body read into a 4xx/5xx
    // failure and give it another full timeout on retry.
    if (controller.signal.aborted && !(error instanceof EnhancerError && error.code === 'PROVIDER_TIMEOUT')) {
      throw timeoutError(req.timeoutMs, error);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort(); // Also closes the native connection on semantic completion or validation failure.
  }
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: SseCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const seenIds = new Map<string, string>();
  let responseBytes = 0;
  let line = '';
  let skipLf = false;
  let data: string[] = [];
  let eventType = 'message';
  let eventId: string | undefined;
  let eventChars = 0;
  let stopped = false;
  let eof = false;

  function checkSize(): void {
    if (eventChars + line.length > STREAM_LIMITS.eventChars) {
      throw new EnhancerError('INVALID_OUTPUT', 'Provider SSE event exceeded the size limit');
    }
  }

  function consumeLine(): void {
    const current = line;
    line = '';
    if (current === '') {
      const payload = data.join('\n');
      const metadata: SseEvent = { type: eventType, ...(eventId !== undefined ? { id: eventId } : {}) };
      const hasData = data.length !== 0;
      data = [];
      eventType = 'message';
      eventId = undefined;
      eventChars = 0;
      if (!hasData) return;

      // Text itself is never a deduplication key: repeated words can be valid
      // deltas. Replayed explicit ids must have exactly the same event content.
      if (metadata.id) {
        const fingerprint = `${metadata.type}\n${payload}`;
        const previous = seenIds.get(metadata.id);
        if (previous !== undefined) {
          if (previous !== fingerprint) {
            throw new EnhancerError('INVALID_OUTPUT', 'Provider reused an SSE event id with different content');
          }
          return;
        }
        if (seenIds.size >= STREAM_LIMITS.eventIds) {
          throw new EnhancerError('INVALID_OUTPUT', 'Provider SSE event-id limit exceeded');
        }
        seenIds.set(metadata.id, fingerprint);
      }
      try {
        if (payload === '[DONE]' && metadata.type === 'message') {
          callbacks.onDone();
          stopped = true;
        } else {
          stopped = callbacks.onData(payload, metadata) === 'stop';
        }
      } catch (error) {
        if (error instanceof EnhancerError) throw error;
        throw new EnhancerError('INVALID_OUTPUT', `Invalid provider event: ${errorMessage(error)}`, error);
      }
      return;
    }

    eventChars += current.length + 1;
    checkSize();
    if (current.startsWith(':')) return;
    const colon = current.indexOf(':');
    const field = colon === -1 ? current : current.slice(0, colon);
    let value = colon === -1 ? '' : current.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // SSE strips exactly one optional space.
    if (field === 'data') data.push(value);
    else if (field === 'event') eventType = value || 'message';
    else if (field === 'id' && !value.includes('\0')) eventId = value;
    // retry and unknown fields are legal SSE fields and do not carry content.
  }

  function consumeText(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (skipLf) {
        skipLf = false;
        if (char === '\n') {
          start = i + 1;
          continue;
        }
      }
      if (char !== '\r' && char !== '\n') continue;
      line += text.slice(start, i);
      checkSize();
      consumeLine();
      if (stopped) return;
      start = i + 1;
      skipLf = char === '\r';
    }
    line += text.slice(start);
    checkSize();
  }

  function decode(bytes?: Uint8Array): string {
    try {
      return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
    } catch (error) {
      if (bytes === undefined) {
        throw new ProviderUnavailableError('Provider stream ended inside a UTF-8 character', {
          retryable: true, cause: error,
        });
      }
      throw new EnhancerError('INVALID_OUTPUT', 'Provider returned invalid UTF-8', error);
    }
  }

  try {
    while (!stopped) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        eof = true;
        consumeText(decode()); // Flush buffered UTF-8, including incomplete trailing byte sequences.
        if (line || data.length) {
          throw new ProviderUnavailableError('Provider stream ended inside an SSE event', { retryable: true });
        }
        break;
      }
      responseBytes += value.byteLength;
      if (responseBytes > STREAM_LIMITS.responseBytes) {
        throw new EnhancerError('INVALID_OUTPUT', 'Provider response exceeded the size limit');
      }
      consumeText(decode(value));
    }
  } finally {
    if (!eof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readErrorDetail(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let detail = '';
  let bytes = 0;
  try {
    while (bytes < STREAM_LIMITS.errorBodyBytes) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      const prefix = value.subarray(0, STREAM_LIMITS.errorBodyBytes - bytes);
      bytes += prefix.byteLength;
      detail += decoder.decode(prefix, { stream: true });
    }
    return detail + decoder.decode();
  } catch (error) {
    if (signal.aborted) throw error;
    return detail; // Preserve the known HTTP status even if its diagnostic body resets.
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {}); // The operation was already started; observe a late native rejection.
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function timeoutError(timeoutMs: number, cause?: unknown): EnhancerError {
  return new EnhancerError('PROVIDER_TIMEOUT', `Provider request aborted after ${Math.ceil(timeoutMs)}ms`, cause);
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** JSON comments/keep-alives belong in SSE comments or typed ping events, not malformed data. */
export function parseSsePayload(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new EnhancerError('INVALID_OUTPUT', 'Provider returned malformed SSE JSON', error);
  }
  if (!isRecord(parsed)) throw new EnhancerError('INVALID_OUTPUT', 'Provider SSE payload must be a JSON object');
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Errors delivered after HTTP 200 still fail the entire private attempt. */
export function streamedProviderError(provider: string, value: unknown): ProviderUnavailableError {
  if (!isRecord(value) || typeof value.message !== 'string' || !value.message.trim() ||
      (value.type != null && typeof value.type !== 'string') ||
      (value.code != null && typeof value.code !== 'string' && typeof value.code !== 'number')) {
    throw new EnhancerError('INVALID_OUTPUT', `${provider} returned a malformed streamed error`);
  }
  const transient = new Set([
    'api_error', 'server_error', 'internal_error', 'internal_server_error', 'overloaded_error',
    'rate_limit_error', 'rate_limit_exceeded', 'timeout_error', 'request_timeout',
    'service_unavailable', 'engine_overloaded',
  ]);
  const permanent = new Set([
    'authentication_error', 'invalid_api_key', 'permission_error', 'permission_denied',
    'invalid_request_error', 'not_found_error', 'request_too_large', 'insufficient_quota',
    'billing_hard_limit_reached', 'content_policy_violation',
  ]);
  const labels = [value.code, value.type].filter((label): label is string => typeof label === 'string');
  const code = value.code ?? value.type;
  const status = typeof value.status === 'number' ? value.status : typeof code === 'number' ? code : undefined;
  return new ProviderUnavailableError(
    `${provider} streamed error${code != null ? ` (${String(code)})` : ''}: ${truncate(value.message, 300)}`,
    {
      retryable: !labels.some((label) => permanent.has(label)) &&
        (status !== undefined ? isTransientStatus(status) : labels.some((label) => transient.has(label))),
      status,
    },
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

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
export async function withColdStartRetry<T>(
  run: (remainingMs: number) => Promise<T>,
  hasPublishedContent: () => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budget = options.timeoutMs ?? Infinity;
  const deadline = now() + budget;
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError(budget);
    try {
      const result = await run(remaining);
      if (now() >= deadline) throw timeoutError(budget);
      return result;
    } catch (error) {
      if (attempt !== 0 || hasPublishedContent() ||
          !(error instanceof ProviderUnavailableError) || !error.retryable) throw error;
      const left = deadline - now();
      if (left <= 0) throw timeoutError(budget, error);
      const delay = Math.max(options.retryDelayMs ?? 50, error.retryAfterMs);
      if (delay >= left) throw error; // Retry-After cannot extend the original deadline.
      if (delay > 0) await sleep(delay);
    }
  }
}
