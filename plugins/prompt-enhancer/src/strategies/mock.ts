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

export class MockStrategy implements ProviderStrategy {
  readonly id = 'mock';
  readonly resolvedModel = 'mock-model';

  isConfigured(_config: EnhancerConfig): boolean {
    return true; // works with no credentials by design
  }

  async enhance(request: EnhanceRequest, _config: EnhancerConfig): Promise<EnhanceResult> {
    const lines = request.prompt
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    const enhanced = [
      '[mock-enhanced]',
      ...lines.map((line, index) => `${index + 1}. ${line}`),
      '[Mock: rewrite concisely (≤1.5x), at most one file anchor, no boilerplate.]',
    ].join('\n');

    return { enhancedPrompt: enhanced, provider: this.id, model: this.resolvedModel };
  }
}
