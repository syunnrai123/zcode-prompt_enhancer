import type { EnhancerConfig, EnhanceRequest, EnhanceResult } from '../core/types.js';
import type { ProviderStrategy } from './provider-strategy.js';
export interface OpenAiCompatibleOptions {
    /** Registry id: `glm` or `openai-compatible`. */
    readonly id: 'glm' | 'openai-compatible';
    /** Injected for tests; defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
}
export declare class OpenAiCompatibleStrategy implements ProviderStrategy {
    private readonly options;
    readonly id: OpenAiCompatibleOptions['id'];
    private readonly fetchImpl;
    constructor(options: OpenAiCompatibleOptions);
    get resolvedModel(): string | null;
    isConfigured(config: EnhancerConfig): boolean;
    enhance(request: EnhanceRequest, config: EnhancerConfig): Promise<EnhanceResult>;
}
