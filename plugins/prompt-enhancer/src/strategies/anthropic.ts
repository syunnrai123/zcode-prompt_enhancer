/**
 * Anthropic messages-API strategy.
 *
 * Streams with `thinking: disabled` so reasoning models do not spend the token
 * budget on thinking blocks and leave the text empty.
 */
import { EnhancerError } from '../core/types.js';
import type { EnhancerConfig, EnhanceRequest, EnhanceResult } from '../core/types.js';
import { computeMaxTokens } from '../core/prompt-builder.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';
import { PROVIDER_DEFAULTS } from '../config/config.js';
import { postSse, withColdStartRetry } from './http.js';
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
    if (!config.apiKey) {
      throw new EnhancerError('NO_PROVIDER_CONFIGURED', 'No API key configured for anthropic');
    }
    const defaults = PROVIDER_DEFAULTS.anthropic;
    const baseUrl = (config.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '');
    const model = config.model ?? defaults.model;

    const fullPrompt = request.prompt;
    const maxTokens = computeMaxTokens(fullPrompt.length);

    let received = '';
    let receivedContent = false;

    await withColdStartRetry(
      () =>
        postSse(
          {
            url: `${baseUrl}/v1/messages`,
            headers: {
              'x-api-key': config.apiKey!,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: {
              model,
              stream: true,
              max_tokens: maxTokens,
              // Reasoning models otherwise burn the budget on thinking blocks.
              thinking: { type: 'disabled' },
              system: ENHANCE_SYSTEM_PROMPT,
              messages: [{ role: 'user', content: fullPrompt }],
            },
            timeoutMs: config.timeoutMs,
          },
          {
            onData: (payload) => {
              const delta = extractTextDelta(payload);
              if (delta) {
                receivedContent = true;
                received += delta;
              }
            },
            onDone: () => {
              /* Anthropic streams end with a message_stop event, not [DONE] */
            },
          },
          this.fetchImpl,
        ),
      () => receivedContent,
    );

    if (!received.trim()) {
      throw new EnhancerError('EMPTY_RESPONSE', 'anthropic returned an empty enhancement');
    }
    return { enhancedPrompt: received.trim(), provider: this.id, model };
  }
}

function extractTextDelta(payload: string): string {
  try {
    const event = JSON.parse(payload) as {
      type?: string;
      delta?: { type?: string; text?: string };
    };
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      return event.delta.text;
    }
    return '';
  } catch {
    // Ignore non-JSON chunks (keep-alives).
    return '';
  }
}
