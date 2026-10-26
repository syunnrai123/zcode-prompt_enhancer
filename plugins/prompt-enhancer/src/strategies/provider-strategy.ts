/**
 * Provider strategy layer (Strategy pattern).
 *
 * Each strategy knows how to call one family of LLM APIs with the shared
 * system prompt and assembled full prompt. The enhancer service depends only
 * on the `ProviderStrategy` interface, so adding a provider never touches the
 * pipeline — register a new strategy in the composition root.
 */
import type { EnhancerConfig, EnhanceRequest, EnhanceResult } from '../core/types.js';

export interface ProviderStrategy {
  /** Unique provider id (`glm`, `openai-compatible`, `anthropic`, `mock`). */
  readonly id: string;
  /** Human-readable model id resolved for this run (diagnostics). */
  readonly resolvedModel: string | null;
  /**
   * Whether this strategy can run under the given config. Used by the
   * registry for auto-detection when no explicit provider is configured.
   */
  isConfigured(config: EnhancerConfig): boolean;
  /**
   * Run the enhancement. `request.prompt` is the FULL assembled user message
   * (draft + context sections) — `PromptEnhancerService` builds it via
   * `buildFullPrompt` before dispatching, so strategies never re-assemble.
   */
  enhance(request: EnhanceRequest, config: EnhancerConfig): Promise<EnhanceResult>;
}

/**
 * Registry with resolution precedence:
 *  1. the explicitly configured provider id,
 *  2. auto-detection: first registered strategy that reports itself configured.
 */
export class ProviderStrategyRegistry {
  private readonly strategies: ProviderStrategy[] = [];

  register(strategy: ProviderStrategy): this {
    this.strategies.push(strategy);
    return this;
  }

  list(): readonly ProviderStrategy[] {
    return this.strategies;
  }

  resolve(config: EnhancerConfig): ProviderStrategy {
    const explicit = config.provider ? this.strategies.find((s) => s.id === config.provider) : undefined;
    if (explicit) {
      if (!explicit.isConfigured(config)) {
        throw new EnhancerSelectionError(
          `Provider "${config.provider}" is selected but not configured (missing API key or base URL).`,
        );
      }
      return explicit;
    }
    const detected = this.strategies.find((s) => s.id !== 'mock' && s.isConfigured(config));
    if (detected) return detected;
    throw new EnhancerSelectionError(
      'No enhancement provider is configured. Set an API key in plugin settings (Settings → Plugins → prompt-enhancer) or via environment variables (ZAI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).',
    );
  }
}

/** Selection failure surfaced to the MCP layer with an actionable message. */
export class EnhancerSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnhancerSelectionError';
  }
}
