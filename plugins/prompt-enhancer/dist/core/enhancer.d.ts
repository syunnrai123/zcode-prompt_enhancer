import type { EnhanceRequest, EnhanceResult, EnhancerConfig } from './types.js';
import type { ProviderStrategyRegistry } from '../strategies/provider-strategy.js';
export declare class PromptEnhancerService {
    private readonly registry;
    private readonly config;
    /** Observer for diagnostics; defaults to no-op, injected in index.ts. */
    private readonly onEvent;
    constructor(registry: ProviderStrategyRegistry, config: EnhancerConfig, 
    /** Observer for diagnostics; defaults to no-op, injected in index.ts. */
    onEvent?: (event: EnhancerEvent) => void);
    enhance(request: EnhanceRequest): Promise<EnhanceResult>;
    /** Diagnostics view for the `get_enhancer_info` tool: never leaks the key. */
    describe(): Record<string, unknown>;
}
export type EnhancerEvent = {
    type: 'enhance:start';
    provider: string;
    fullPromptLength: number;
} | {
    type: 'enhance:end';
    provider: string;
    model: string | null;
} | {
    type: 'enhance:error';
    provider: string;
    code: string;
    message: string;
} | {
    type: 'output:guarded';
    provider: string;
};
