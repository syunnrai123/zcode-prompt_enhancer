import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnhancerError } from '../src/core/types.js';
import { PromptEnhancerService } from '../src/core/enhancer.js';
import type { EnhancerEvent } from '../src/core/enhancer.js';
import { ProviderStrategyRegistry, EnhancerSelectionError } from '../src/strategies/provider-strategy.js';
import { MockStrategy } from '../src/strategies/mock.js';
import { OpenAiCompatibleStrategy } from '../src/strategies/openai-compatible.js';
import { resolveConfig } from '../src/config/config.js';

function registryWithMock(): ProviderStrategyRegistry {
  return new ProviderStrategyRegistry().register(new MockStrategy());
}

describe('PromptEnhancerService', () => {
  it('rejects an empty draft with EMPTY_PROMPT', async () => {
    const service = new PromptEnhancerService(registryWithMock(), resolveConfig({ PROMPT_ENHANCER_PROVIDER: 'mock' }));
    await assert.rejects(() => service.enhance({ prompt: '   ' }), (error: unknown) => {
      assert.ok(error instanceof EnhancerError);
      assert.equal(error.code, 'EMPTY_PROMPT');
      return true;
    });
  });

  it('runs the full pipeline through the mock strategy and guards output', async () => {
    const events: EnhancerEvent[] = [];
    const service = new PromptEnhancerService(
      registryWithMock(),
      resolveConfig({ PROMPT_ENHANCER_PROVIDER: 'mock' }),
      (event) => events.push(event),
    );
    const result = await service.enhance({
      prompt: 'fix it',
      context: { projectType: 'TypeScript library' },
    });

    assert.equal(result.provider, 'mock');
    assert.ok(result.enhancedPrompt.startsWith('[mock-enhanced]'));
    // The assembled full prompt reached the strategy (context folded in).
    assert.ok(result.enhancedPrompt.includes('TypeScript library'));
    assert.ok(events.some((e) => e.type === 'enhance:start'));
    assert.ok(events.some((e) => e.type === 'enhance:end'));
  });

  it('fails with an actionable selection error when nothing is configured', async () => {
    const registry = new ProviderStrategyRegistry().register(new OpenAiCompatibleStrategy({ id: 'glm' }));
    const service = new PromptEnhancerService(registry, resolveConfig({}));
    await assert.rejects(() => service.enhance({ prompt: 'x' }), (error: unknown) => {
      assert.ok(error instanceof EnhancerSelectionError);
      assert.match(error.message, /No enhancement provider is configured/);
      return true;
    });
  });
});
