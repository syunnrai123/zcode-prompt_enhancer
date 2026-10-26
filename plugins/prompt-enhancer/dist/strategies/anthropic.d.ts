import type { EnhancerConfig, EnhanceRequest, EnhanceResult } from '../core/types.js';
import type { ProviderStrategy } from './provider-strategy.js';
export interface AnthropicStrategyOptions {
    /** Injected for tests; defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
}
export declare class AnthropicStrategy implements ProviderStrategy {
    readonly id = "anthropic";
    private readonly fetchImpl;
    constructor(options?: AnthropicStrategyOptions);
    get resolvedModel(): string | null;
    isConfigured(config: EnhancerConfig): boolean;
    enhance(request: EnhanceRequest, config: EnhancerConfig): Promise<EnhanceResult>;
}
