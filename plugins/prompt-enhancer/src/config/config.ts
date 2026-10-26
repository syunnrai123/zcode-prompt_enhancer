/**
 * Configuration resolution.
 *
 * ZCode injects userConfig values into the MCP server process environment
 * (PROMPT_ENHANCER_*). Provider-native environment variables are honored as
 * fallbacks so the plugin also works outside ZCode with zero configuration UI.
 */
import type { EnhancerConfig } from '../core/types.js';

export const SUPPORTED_PROVIDERS = ['glm', 'openai-compatible', 'anthropic', 'mock'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Default API base URLs and models per provider. */
export const PROVIDER_DEFAULTS: Record<SupportedProvider, { baseUrl: string; model: string }> = {
  'glm': { baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  'anthropic': { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  'mock': { baseUrl: '', model: 'mock-model' },
};

/** Provider-native env keys consulted when PROMPT_ENHANCER_API_KEY is unset. */
const PROVIDER_KEY_ENV: Record<SupportedProvider, string[]> = {
  'glm': ['ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  'openai-compatible': ['OPENAI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'],
  'anthropic': ['ANTHROPIC_API_KEY'],
  'mock': [],
};

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function clampTimeout(rawSeconds: number): number {
  return Math.min(180, Math.max(15, Math.round(rawSeconds))) * 1000;
}

/**
 * Resolve the effective config. `env` is injected for testability; production
 * callers pass `process.env`.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): EnhancerConfig {
  const rawProvider = readEnv(env, 'PROMPT_ENHANCER_PROVIDER');

  let provider: string | null = null;
  if (rawProvider && (SUPPORTED_PROVIDERS as readonly string[]).includes(rawProvider)) {
    provider = rawProvider;
  }

  // Explicit provider: consult only its native keys. Auto mode: scan every
  // provider's keys in registry order (glm → openai-compatible → anthropic) so
  // auto-detection picks the same provider the registry would.
  const nativeKeys = provider
    ? PROVIDER_KEY_ENV[provider as SupportedProvider]
    : SUPPORTED_PROVIDERS.flatMap((p) => PROVIDER_KEY_ENV[p]);
  const nativeKeyWithValue = nativeKeys.find((key) => readEnv(env, key) !== null);
  const apiKey =
    readEnv(env, 'PROMPT_ENHANCER_API_KEY') ??
    (nativeKeyWithValue !== undefined ? readEnv(env, nativeKeyWithValue) : null);

  const timeoutSeconds = Number.parseInt(readEnv(env, 'PROMPT_ENHANCER_TIMEOUT_SECONDS') ?? '60', 10);

  return {
    provider,
    apiKey,
    baseUrl: readEnv(env, 'PROMPT_ENHANCER_BASE_URL'),
    model: readEnv(env, 'PROMPT_ENHANCER_MODEL'),
    timeoutMs: Number.isFinite(timeoutSeconds) ? clampTimeout(timeoutSeconds) : clampTimeout(60),
  };
}
