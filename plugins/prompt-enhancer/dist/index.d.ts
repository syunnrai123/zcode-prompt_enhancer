import { Container } from './di/container.js';
import { PromptEnhancerService } from './core/enhancer.js';
import type { EnhancerConfig } from './core/types.js';
import { ProviderStrategyRegistry } from './strategies/provider-strategy.js';
export declare const Tokens: {
    Config: import("./di/container.js").Token<EnhancerConfig>;
    StrategyRegistry: import("./di/container.js").Token<ProviderStrategyRegistry>;
    Enhancer: import("./di/container.js").Token<PromptEnhancerService>;
};
export declare function buildContainer(env?: NodeJS.ProcessEnv): Container;
