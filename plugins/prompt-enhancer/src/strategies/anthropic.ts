/** Anthropic Messages API with a private, validated streaming attempt. */
import { EnhancerError } from '../core/types.js';
import type { EnhancerConfig, EnhanceRequest, EnhanceResult } from '../core/types.js';
import { computeMaxTokens } from '../core/prompt-builder.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';
import { PROVIDER_DEFAULTS } from '../config/config.js';
import {
  isRecord, parseSsePayload, postSse, ProviderUnavailableError, STREAM_LIMITS,
  streamedProviderError, withColdStartRetry,
} from './http.js';
import type { ProviderStrategy } from './provider-strategy.js';

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicStrategyOptions {
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class AnthropicStrategy implements ProviderStrategy {
  readonly id = 'anthropic';
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicStrategyOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get resolvedModel(): string | null {
    return null;
  }

  isConfigured(config: EnhancerConfig): boolean {
    return config.apiKey !== null;
  }

  async enhance(request: EnhanceRequest, config: EnhancerConfig): Promise<EnhanceResult> {
    const apiKey = config.apiKey;
    if (!apiKey) throw new EnhancerError('NO_PROVIDER_CONFIGURED', 'No API key configured for anthropic');
    const defaults = PROVIDER_DEFAULTS.anthropic;
    const baseUrl = (config.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '');
    const model = config.model ?? defaults.model;
    const fullPrompt = request.prompt;
    const maxTokens = computeMaxTokens(fullPrompt.length);

    const enhancedPrompt = await withColdStartRetry(async (remainingMs) => {
      const state = new AnthropicMessageState();
      await postSse({
        url: `${baseUrl}/v1/messages`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: {
          model, stream: true, max_tokens: maxTokens,
          thinking: { type: 'disabled' },
          system: ENHANCE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: fullPrompt }],
        },
        timeoutMs: remainingMs,
      }, {
        onData: (payload, event) => state.accept(payload, event?.type ?? 'message'),
        onDone: () => { throw new EnhancerError('INVALID_OUTPUT', 'Anthropic returned an unexpected [DONE] sentinel'); },
      }, this.fetchImpl);
      return state.result();
    }, () => false, { timeoutMs: config.timeoutMs });

    return { enhancedPrompt, provider: this.id, model };
  }
}

class AnthropicMessageState {
  private received = '';
  private started = false;
  private nextBlockIndex = 0;
  private activeBlock: number | null = null;
  private stopReason: 'end_turn' | 'stop_sequence' | null = null;
  private done = false;

  accept(payload: string, eventType: string): void | 'stop' {
    const event = parseSsePayload(payload);
    const type = event.type;
    if (typeof type !== 'string' || (eventType !== 'message' && eventType !== type)) {
      this.invalid('Missing or mismatched Anthropic event type');
    }
    if (type === 'error') throw streamedProviderError('anthropic', event.error);
    if (type === 'ping') return;
    if (type === 'message_start') {
      if (this.started || !isRecord(event.message)) this.invalid('Invalid or duplicate message_start');
      const message = event.message;
      if (message.role !== 'assistant' || (message.type != null && message.type !== 'message') ||
          !Array.isArray(message.content) || message.content.length !== 0 || message.stop_reason != null) {
        this.invalid('Invalid streamed Anthropic message');
      }
      this.started = true;
      return;
    }
    if (!this.started) this.invalid('Anthropic event arrived before message_start');

    switch (type) {
      case 'content_block_start': {
        if (this.stopReason !== null || this.activeBlock !== null || event.index !== this.nextBlockIndex ||
            this.nextBlockIndex >= STREAM_LIMITS.eventIds || !isRecord(event.content_block)) {
          this.invalid('Invalid content_block_start sequence or index');
        }
        const block = event.content_block;
        if (block.type !== 'text' || typeof block.text !== 'string') {
          this.invalid('Only text content blocks can produce an enhanced prompt');
        }
        this.activeBlock = this.nextBlockIndex;
        this.nextBlockIndex += 1;
        this.append(block.text);
        return;
      }
      case 'content_block_delta': {
        if (this.stopReason !== null || this.activeBlock === null || event.index !== this.activeBlock ||
            !isRecord(event.delta) || event.delta.type !== 'text_delta' || typeof event.delta.text !== 'string') {
          this.invalid('Invalid text delta, content block index, or sequence');
        }
        this.append(event.delta.text);
        return;
      }
      case 'content_block_stop':
        if (this.activeBlock === null || event.index !== this.activeBlock) this.invalid('Invalid content_block_stop');
        this.activeBlock = null;
        return;
      case 'message_delta': {
        if (!isRecord(event.delta)) this.invalid('Anthropic message_delta is missing its delta object');
        const reason = event.delta.stop_reason;
        if (reason == null) return; // Usage-only updates do not complete a message.
        if (reason !== 'end_turn' && reason !== 'stop_sequence') {
          this.invalid(`Anthropic stopped with unsafe stop reason: ${String(reason)}`);
        }
        if (this.activeBlock !== null || this.stopReason !== null) this.invalid('Invalid message_delta sequence');
        this.stopReason = reason;
        return;
      }
      case 'message_stop':
        if (this.activeBlock !== null) this.invalid('message_stop arrived before content_block_stop');
        if (this.stopReason === null) {
          throw new ProviderUnavailableError('Anthropic sent message_stop without a stop reason', { retryable: true });
        }
        this.done = true;
        return 'stop'; // Semantic completion need not wait for the connection to close.
      default:
        this.invalid(`Unsupported Anthropic event type: ${type}`);
    }
  }

  result(): string {
    if (!this.done) {
      throw new ProviderUnavailableError('Anthropic stream ended before message_stop', { retryable: true });
    }
    const text = this.received.trim();
    if (!text) throw new EnhancerError('EMPTY_RESPONSE', 'anthropic returned an empty enhancement');
    return text;
  }

  private append(text: string): void {
    if (this.received.length + text.length > STREAM_LIMITS.outputChars) this.invalid('Enhanced output exceeded the size limit');
    this.received += text;
  }

  private invalid(message: string): never {
    throw new EnhancerError('INVALID_OUTPUT', `anthropic: ${message}`);
  }
}
