/**
 * One OpenAI chat-completions wire format for GLM and custom endpoints.
 * Endpoints must send finish_reason: "stop" followed by [DONE]. EOF or a
 * DONE-only stream is incomplete; text alone cannot prove a jitter-free result.
 */
import { EnhancerError } from '../core/types.js';
import { computeMaxTokens } from '../core/prompt-builder.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';
import { PROVIDER_DEFAULTS } from '../config/config.js';
import { isRecord, parseSsePayload, postSse, ProviderUnavailableError, STREAM_LIMITS, streamedProviderError, withColdStartRetry, } from './http.js';
export class OpenAiCompatibleStrategy {
    id;
    fetchImpl;
    constructor(options) {
        this.id = options.id;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    get resolvedModel() {
        return null; // Resolved per request from config.
    }
    isConfigured(config) {
        return config.apiKey !== null;
    }
    async enhance(request, config) {
        const apiKey = config.apiKey;
        if (!apiKey) {
            throw new EnhancerError('NO_PROVIDER_CONFIGURED', `No API key configured for ${this.id}`);
        }
        const defaults = PROVIDER_DEFAULTS[this.id];
        const baseUrl = (config.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '');
        const model = config.model ?? defaults.model;
        const fullPrompt = request.prompt; // Assembled by the service, not by a strategy.
        const maxTokens = computeMaxTokens(fullPrompt.length);
        const enhancedPrompt = await withColdStartRetry(async (remainingMs) => {
            // Nothing is published until a complete successful attempt. A retry must
            // regenerate from empty buffers, never append to the failed prefix.
            const state = new ChatCompletionState(this.id);
            await postSse({
                url: `${baseUrl}/chat/completions`,
                headers: { Authorization: `Bearer ${apiKey}` },
                body: {
                    model, stream: true, max_tokens: maxTokens, temperature: 0.3,
                    messages: [
                        { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
                        { role: 'user', content: fullPrompt },
                    ],
                },
                timeoutMs: remainingMs,
            }, {
                onData: (payload, event) => state.accept(payload, event?.type ?? 'message'),
                onDone: () => state.complete(),
            }, this.fetchImpl);
            return state.result();
        }, () => false, { timeoutMs: config.timeoutMs });
        return { enhancedPrompt, provider: this.id, model };
    }
}
class ChatCompletionState {
    provider;
    received = '';
    hasDeltas = false;
    hasSnapshot = false;
    finishReason = null;
    done = false;
    constructor(provider) {
        this.provider = provider;
    }
    accept(payload, eventType) {
        const event = parseSsePayload(payload);
        if (eventType === 'error' || event.error != null) {
            throw streamedProviderError(this.provider, event.error ?? event);
        }
        if (eventType === 'ping')
            return;
        if (eventType !== 'message')
            this.invalid(`Unexpected SSE event type: ${eventType}`);
        if (!Array.isArray(event.choices))
            this.invalid('Chat-completion event is missing a choices array');
        if (event.choices.length === 0) {
            // A usage-only terminal chunk is documented when include_usage is enabled.
            if (isRecord(event.usage))
                return;
            this.invalid('Chat-completion event has no choice or usage');
        }
        if (event.choices.length !== 1 || !isRecord(event.choices[0])) {
            this.invalid('Expected exactly one chat-completion choice');
        }
        const choice = event.choices[0];
        if (choice.index != null && choice.index !== 0)
            this.invalid('Unexpected chat-completion choice index');
        const reason = choice.finish_reason;
        if (reason != null) {
            if (typeof reason !== 'string' || reason !== 'stop') {
                this.invalid(`Chat completion stopped with unsafe finish reason: ${String(reason)}`);
            }
            if (this.finishReason !== null)
                this.invalid('Duplicate chat-completion finish event');
        }
        const delta = choice.delta;
        const message = choice.message;
        if (delta != null && !isRecord(delta))
            this.invalid('Chat-completion delta must be an object');
        if (message != null && !isRecord(message))
            this.invalid('Chat-completion message must be an object');
        if (isRecord(delta))
            this.validateText(delta);
        if (isRecord(message))
            this.validateText(message);
        if (!isRecord(delta) && !isRecord(message) && reason == null) {
            this.invalid('Chat-completion choice is missing a delta or message');
        }
        const deltaText = isRecord(delta) && typeof delta.content === 'string' ? delta.content : '';
        const snapshot = isRecord(message) && typeof message.content === 'string' ? message.content : '';
        if (this.finishReason !== null && (deltaText || snapshot)) {
            this.invalid('Received content after the chat-completion finish event');
        }
        if (deltaText) {
            if (this.hasSnapshot)
                this.invalid('Provider mixed a full message with subsequent deltas');
            this.hasDeltas = true;
            this.append(deltaText);
        }
        if (snapshot) {
            if (this.hasDeltas || this.hasSnapshot) {
                // Some relays include a full final message. It is a snapshot, not
                // another delta; validate it rather than duplicating the entire result.
                if (snapshot !== this.received)
                    this.invalid('Provider final message disagrees with streamed deltas');
            }
            else {
                this.hasSnapshot = true;
                this.append(snapshot);
            }
        }
        if (reason === 'stop')
            this.finishReason = reason;
    }
    complete() {
        if (this.finishReason !== 'stop') {
            throw new ProviderUnavailableError(`${this.provider} sent [DONE] without a stop finish reason`, {
                retryable: true,
            });
        }
        this.done = true;
    }
    result() {
        if (!this.done) {
            throw new ProviderUnavailableError(`${this.provider} stream ended before [DONE]`, { retryable: true });
        }
        const text = this.received.trim();
        if (!text)
            throw new EnhancerError('EMPTY_RESPONSE', `${this.provider} returned an empty enhancement`);
        return text;
    }
    validateText(part) {
        if (part.content != null && typeof part.content !== 'string') {
            this.invalid('Chat-completion content must be a string');
        }
        if (part.role != null && part.role !== 'assistant')
            this.invalid('Unexpected chat-completion role');
        if (part.refusal != null && part.refusal !== '')
            this.invalid('Provider refused to produce an enhancement');
        if (part.tool_calls != null && (!Array.isArray(part.tool_calls) || part.tool_calls.length !== 0)) {
            this.invalid('Tool-call output is not an enhanced prompt');
        }
        if (part.function_call != null)
            this.invalid('Function-call output is not an enhanced prompt');
    }
    append(text) {
        if (this.received.length + text.length > STREAM_LIMITS.outputChars) {
            this.invalid('Enhanced output exceeded the size limit');
        }
        this.received += text;
    }
    invalid(message) {
        throw new EnhancerError('INVALID_OUTPUT', `${this.provider}: ${message}`);
    }
}
