import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/config/config.js';
import { buildContainer, Tokens } from '../src/index.js';

describe('resolveConfig', () => {
  it('reads PROMPT_ENHANCER_* variables', () => {
    const config = resolveConfig({
      PROMPT_ENHANCER_PROVIDER: 'glm',
      PROMPT_ENHANCER_API_KEY: 'k',
      PROMPT_ENHANCER_MODEL: 'glm-4.7',
      PROMPT_ENHANCER_TIMEOUT_SECONDS: '30',
    });
    assert.equal(config.provider, 'glm');
    assert.equal(config.apiKey, 'k');
    assert.equal(config.model, 'glm-4.7');
    assert.equal(config.timeoutMs, 30_000);
  });

  it('falls back to provider-native key envs', () => {
    const config = resolveConfig({ PROMPT_ENHANCER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-a' });
    assert.equal(config.apiKey, 'sk-a');
  });

  it('ignores unknown providers and clamps timeout into [15s, 180s]', () => {
    const low = resolveConfig({ PROMPT_ENHANCER_PROVIDER: 'bogus', PROMPT_ENHANCER_TIMEOUT_SECONDS: '1' });
    assert.equal(low.provider, null);
    assert.equal(low.timeoutMs, 15_000);
    const high = resolveConfig({ PROMPT_ENHANCER_TIMEOUT_SECONDS: '9999' });
    assert.equal(high.timeoutMs, 180_000);
    const fallback = resolveConfig({});
    assert.equal(fallback.timeoutMs, 60_000);
  });
});

describe('DI container wiring', () => {
  it('resolves the enhancer end-to-end from environment', () => {
    const container = buildContainer({ PROMPT_ENHANCER_PROVIDER: 'mock' });
    const enhancer = container.resolve(Tokens.Enhancer);
    const info = enhancer.describe() as { effectiveProvider: string; apiKeyConfigured: boolean };
    assert.equal(info.effectiveProvider, 'mock');
    assert.equal(info.apiKeyConfigured, false);
  });

  it('reports auto-detection when no explicit provider is set', () => {
    const container = buildContainer({ OPENAI_API_KEY: 'sk-x' });
    const enhancer = container.resolve(Tokens.Enhancer);
    const info = enhancer.describe() as { provider: string; effectiveProvider: string };
    assert.equal(info.provider, 'auto');
    assert.equal(info.effectiveProvider, 'glm'); // first auto-detectable strategy
  });
});
