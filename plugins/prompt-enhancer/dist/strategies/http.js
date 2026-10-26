/**
 * Shared HTTP+SSE plumbing for chat-completion style providers.
 *
 * Both the GLM and the generic OpenAI-compatible strategy use the same wire
 * format, so the transport lives here once and the two strategies only differ
 * in defaults (base URL, model, env keys).
 */
import { EnhancerError } from '../core/types.js';
/**
 * POST the request and parse a streaming SSE response. Uses the injection
 * parameter `fetchImpl` so tests can stub the network entirely.
 */
export async function postSse(req, callbacks, fetchImpl = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    let response;
    try {
        response = await fetchImpl(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...req.headers },
            body: JSON.stringify(req.body),
            signal: controller.signal,
        });
    }
    catch (error) {
        throw controller.signal.aborted
            ? new EnhancerError('PROVIDER_TIMEOUT', `Request aborted after ${req.timeoutMs}ms`, error)
            : new EnhancerError('PROVIDER_UNAVAILABLE', `Network request failed: ${errorMessage(error)}`, error);
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new EnhancerError('PROVIDER_UNAVAILABLE', `Provider returned HTTP ${response.status}: ${truncate(detail, 300)}`);
    }
    const body = response.body;
    if (!body) {
        throw new EnhancerError('PROVIDER_UNAVAILABLE', 'Provider returned an empty body');
    }
    await readSseStream(body, callbacks);
}
async function readSseStream(body, callbacks) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
                buffer = buffer.slice(newlineIndex + 1);
                handleSseLine(line, callbacks);
            }
        }
        if (buffer.trim())
            handleSseLine(buffer, callbacks);
    }
    finally {
        reader.releaseLock();
    }
}
function handleSseLine(line, callbacks) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':'))
        return; // comment / keep-alive
    if (!trimmed.startsWith('data:'))
        return;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') {
        callbacks.onDone();
        return;
    }
    callbacks.onData(payload);
}
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
export function truncate(text, maxLength) {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}
/**
 * Retry-once wrapper for idempotent streaming calls that fail before any
 * content was received. Once deltas have flushed, retrying would duplicate
 * partial output, so only cold-start failures (connection refused, TLS
 * handshake, first-byte timeout) get a second attempt.
 */
export async function withColdStartRetry(run, hasReceivedContent) {
    try {
        return await run();
    }
    catch (error) {
        if (hasReceivedContent())
            throw error;
        return await run();
    }
}
