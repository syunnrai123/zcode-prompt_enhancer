/**
 * Domain types shared across the plugin.
 * Kept free of infrastructure concerns (no fetch / MCP / Node specifics) so the
 * core enhancement pipeline is unit-testable in isolation.
 */
/** Bounded project metadata; no source-code bodies or editor state. */
export interface ProjectContext {
    readonly projectType?: string;
    readonly techStack?: readonly string[];
    readonly projectOverview?: string;
    readonly modules?: readonly string[];
    readonly relevantPaths?: readonly string[];
    readonly directoryStructure?: readonly string[];
    readonly gitChanges?: {
        readonly branch?: string;
        readonly workingTree?: readonly string[];
        readonly recentCommits?: readonly string[];
    };
    readonly notes?: readonly string[];
}
/** One enhancement request flowing through the pipeline. */
export interface EnhanceRequest {
    /** The raw draft prompt typed by the user. Must be non-empty. */
    readonly prompt: string;
    readonly context?: ProjectContext;
}
/** Successful enhancement result. */
export interface EnhanceResult {
    /** The cleaned, ready-to-use enhanced prompt. */
    readonly enhancedPrompt: string;
    /** Which provider strategy produced the output (glm / openai-compatible / anthropic / mock / agent). */
    readonly provider: string;
    /** Model id used by the strategy, when known. */
    readonly model: string | null;
}
/** Provider-agnostic configuration resolved from env / ZCode userConfig. */
export interface EnhancerConfig {
    /** Explicit provider id, or null to auto-detect from available keys. */
    readonly provider: string | null;
    readonly apiKey: string | null;
    readonly baseUrl: string | null;
    readonly model: string | null;
    /** Hard wall-clock timeout in milliseconds for one LLM call. */
    readonly timeoutMs: number;
}
/** Structured error carrying a stable machine-readable code. */
export declare class EnhancerError extends Error {
    readonly code: 'EMPTY_PROMPT' | 'NO_PROVIDER_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT' | 'EMPTY_RESPONSE' | 'INVALID_OUTPUT';
    readonly cause?: unknown | undefined;
    constructor(code: 'EMPTY_PROMPT' | 'NO_PROVIDER_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT' | 'EMPTY_RESPONSE' | 'INVALID_OUTPUT', message: string, cause?: unknown | undefined);
}
