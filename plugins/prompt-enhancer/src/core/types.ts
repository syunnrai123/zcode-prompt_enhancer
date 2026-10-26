/**
 * Domain types shared across the plugin.
 * Kept free of infrastructure concerns (no fetch / MCP / Node specifics) so the
 * core enhancement pipeline is unit-testable in isolation.
 */

/** Position of the user's cursor in the file being edited (1-based line). */
export interface CursorPosition {
  readonly line: number;
  readonly column?: number;
}

/** A file the enhancer may use as reference material. */
export interface FileContext {
  readonly path: string;
  readonly language?: string;
  readonly content?: string;
}

/** Editor context collected by the caller (ZCode agent or IDE integration). */
export interface EditorContext {
  /** Code the user currently has selected (wins over cursorContext). */
  readonly selectedCode?: string;
  /** Lines around the cursor; only used when nothing is selected. */
  readonly cursorContext?: string;
  readonly cursorPosition?: CursorPosition;
  readonly currentFile?: FileContext;
  readonly relatedFiles?: readonly FileContext[];
  readonly projectType?: string;
}

/** One enhancement request flowing through the pipeline. */
export interface EnhanceRequest {
  /** The raw draft prompt typed by the user. Must be non-empty. */
  readonly prompt: string;
  readonly context?: EditorContext;
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
export class EnhancerError extends Error {
  constructor(
    readonly code:
      | 'EMPTY_PROMPT'
      | 'NO_PROVIDER_CONFIGURED'
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_TIMEOUT'
      | 'EMPTY_RESPONSE'
      | 'INVALID_OUTPUT',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EnhancerError';
  }
}
