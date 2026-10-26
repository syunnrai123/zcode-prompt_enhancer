/**
 * Deterministic offline strategy.
 *
 * Two roles:
 *  1. `npm test` / smoke runs without network access.
 *  2. Users validating the plugin wiring end-to-end: selecting provider
 *     `mock` in settings returns a stable, recognizable enhancement.
 */
import type { EnhancerConfig, EnhanceRequest, EnhanceResult } from '../core/types.js';
import type { ProviderStrategy } from './provider-strategy.js';
export declare class MockStrategy implements ProviderStrategy {
    readonly id = "mock";
    readonly resolvedModel = "mock-model";
    isConfigured(_config: EnhancerConfig): boolean;
    enhance(request: EnhanceRequest, _config: EnhancerConfig): Promise<EnhanceResult>;
}
