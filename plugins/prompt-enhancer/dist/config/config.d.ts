/**
 * Configuration resolution.
 *
 * ZCode injects userConfig values into the MCP server process environment
 * (PROMPT_ENHANCER_*). Provider-native environment variables are honored as
 * fallbacks so the plugin also works outside ZCode with zero configuration UI.
 */
import type { EnhancerConfig } from '../core/types.js';
export declare const SUPPORTED_PROVIDERS: readonly ["glm", "openai-compatible", "anthropic", "mock"];
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];
/** Default API base URLs and models per provider. */
export declare const PROVIDER_DEFAULTS: Record<SupportedProvider, {
    baseUrl: string;
    model: string;
}>;
/**
 * Resolve the effective config. `env` is injected for testability; production
 * callers pass `process.env`.
 */
export declare function resolveConfig(env?: NodeJS.ProcessEnv): EnhancerConfig;
