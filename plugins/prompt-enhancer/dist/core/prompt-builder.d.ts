/** Bounded assembly of project metadata and Git summaries, without source bodies. */
import type { ProjectContext } from './types.js';
export declare const MAX_PROJECT_CONTEXT_LENGTH = 6000;
export declare function truncateText(text: string, maxLength: number): string;
export declare function sanitizeProjectContext(value: unknown): ProjectContext | undefined;
export declare function compactList(entries: readonly string[], budget: number): string;
export declare function buildFullPrompt(originalPrompt: string, context?: ProjectContext): string;
/** Character-based output budget with a fixed 8192-token ceiling. */
export declare function computeMaxTokens(promptLength: number): number;
