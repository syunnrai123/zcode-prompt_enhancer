/**
 * OpenAI chat-completions compatible strategy.
 *
 * One implementation serves both `glm` (Z.ai, OpenAI-compatible wire format)
 * and `openai-compatible` (any custom endpoint); the two ids exist so that
 * defaults and provider-native env keys resolve differently.
 */
import { EnhancerError } from '../core/types.js';
import { computeMaxTokens } from '../core/prompt-builder.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';
import { PROVIDER_DEFAULTS } from '../config/config.js';
import { errorMessage, postSse, withColdStartRetry } from './http.js';
export class OpenAiCompatibleStrategy {
    options;
    id;
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.id = options.id;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    get resolvedModel() {
        return null; // resolved per-request from config; see enhance()
    }
    isConfigured(config) {
        return config.apiKey !== null;
    }
    async enhance(request, config) {
        if (!config.apiKey) {
            throw new EnhancerError('NO_PROVIDER_CONFIGURED', `No API key configured for ${this.id}`);
        }
        const defaults = PROVIDER_DEFAULTS[this.id];
        const baseUrl = (config.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '');
        const model = config.model ?? defaults.model;
        const fullPrompt = request.prompt; // pre-assembled by the service (see enhancer.ts)
        const maxTokens = computeMaxTokens(fullPrompt.length);
        let received = '';
        let receivedContent = false;
        await withColdStartRetry(() => postSse({
            url: `${baseUrl}/chat/completions`,
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body: {
                model,
                stream: true,
                max_tokens: maxTokens,
                temperature: 0.3,
                messages: [
                    { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
                    { role: 'user', content: fullPrompt },
                ],
            },
            timeoutMs: config.timeoutMs,
        }, {
            onData: (payload) => {
                const delta = extractDelta(payload);
                if (delta) {
                    receivedContent = true;
                    received += delta;
                }
            },
            onDone: () => {
                /* stream sentinel — nothing to do */
            },
        }, this.fetchImpl), () => receivedContent);
        if (!received.trim()) {
            throw new EnhancerError('EMPTY_RESPONSE', `${this.id} returned an empty enhancement`);
        }
        return { enhancedPrompt: received.trim(), provider: this.id, model };
    }
}
function extractDelta(payload) {
    try {
        const parsed = JSON.parse(payload);
        const choice = parsed.choices?.[0];
        return choice?.delta?.content ?? choice?.message?.content ?? '';
    }
    catch (error) {
        // Malformed keep-alive chunks must not kill the stream.
        if (error instanceof SyntaxError)
            return '';
        throw new EnhancerError('PROVIDER_UNAVAILABLE', `Failed to parse SSE payload: ${errorMessage(error)}`);
    }
}
