/**
 * PromptEnhancerService — the orchestration pipeline.
 *
 * validate → assemble full prompt → resolve provider strategy → call →
 * guard the output. Every step is replaceable through the DI container;
 * the service itself has no knowledge of which provider answered.
 */
import { EnhancerError } from './types.js';
import type { EnhanceRequest, EnhanceResult, EnhancerConfig } from './types.js';
import { buildFullPrompt } from './prompt-builder.js';
import { cleanEnhancedOutput } from './output-guard.js';
import type { ProviderStrategyRegistry } from '../strategies/provider-strategy.js';

export class PromptEnhancerService {
  constructor(
    private readonly registry: ProviderStrategyRegistry,
    private readonly config: EnhancerConfig,
    /** Observer for diagnostics; defaults to no-op, injected in index.ts. */
    private readonly onEvent: (event: EnhancerEvent) => void = () => {},
  ) {}

  async enhance(request: EnhanceRequest): Promise<EnhanceResult> {
    const draft = request.prompt?.trim();
    if (!draft) {
      throw new EnhancerError('EMPTY_PROMPT', 'Prompt is empty; nothing to enhance.');
    }

    const strategy = this.registry.resolve(this.config);
    const fullPrompt = buildFullPrompt(draft, request.context);
    this.onEvent({ type: 'enhance:start', provider: strategy.id, fullPromptLength: fullPrompt.length });

    let result: EnhanceResult;
    try {
      result = await strategy.enhance({ prompt: fullPrompt, context: request.context }, this.config);
    } catch (error) {
      this.onEvent({
        type: 'enhance:error',
        provider: strategy.id,
        code: error instanceof EnhancerError ? error.code : 'PROVIDER_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const guarded = cleanEnhancedOutput(result.enhancedPrompt);
    if (guarded.modified) {
      this.onEvent({ type: 'output:guarded', provider: strategy.id });
    }
    if (!guarded.text) {
      throw new EnhancerError('EMPTY_RESPONSE', 'Enhancement produced empty output after cleaning.');
    }

    this.onEvent({ type: 'enhance:end', provider: strategy.id, model: result.model });
    return { ...result, enhancedPrompt: guarded.text };
  }

  /** Diagnostics view for the `get_enhancer_info` tool: never leaks the key. */
  describe(): Record<string, unknown> {
    const configured = this.registry.list().map((s) => ({
      id: s.id,
      configured: s.id === 'mock' ? true : s.isConfigured(this.config),
      model: s.resolvedModel,
    }));
    let effective: string;
    try {
      effective = this.registry.resolve(this.config).id;
    } catch {
      effective = 'none (agent-side fallback)';
    }
    return {
      provider: this.config.provider ?? 'auto',
      effectiveProvider: effective,
      apiKeyConfigured: this.config.apiKey !== null,
      baseUrl: this.config.baseUrl ?? '(provider default)',
      model: this.config.model ?? '(provider default)',
      timeoutMs: this.config.timeoutMs,
      providers: configured,
    };
  }
}

export type EnhancerEvent =
  | { type: 'enhance:start'; provider: string; fullPromptLength: number }
  | { type: 'enhance:end'; provider: string; model: string | null }
  | { type: 'enhance:error'; provider: string; code: string; message: string }
  | { type: 'output:guarded'; provider: string };
