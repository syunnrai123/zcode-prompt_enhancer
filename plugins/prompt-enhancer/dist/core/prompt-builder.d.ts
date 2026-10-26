/**
 * Full-prompt assembly: combines the draft prompt and editor context into the
 * single user message sent to the model.
 *
 * Per-section character budgets keep the assembled prompt small regardless of
 * how large the editor context is: less input means faster first token, and a
 * lean context nudges the model toward concise, low-file-count output.
 */
import type { EditorContext } from './types.js';
export declare function getLanguageFromPath(filePath: string | undefined): string;
export declare function truncateText(text: string, maxLength: number, fromEnd?: boolean): string;
/**
 * Assemble the full user message: the draft first, then context sections,
 * then project type.
 */
export declare function buildFullPrompt(originalPrompt: string, context?: EditorContext): string;
/**
 * Cap output tokens by input size. The brevity contract in the system prompt
 * targets ≤1.5x the original length, so the cap only has to cover a lightly
 * polished rewrite of the input itself — sized for a CJK-heavy worst case
 * (~0.7 tokens per character) with a small margin. Capping tight protects
 * against runaway verbose output; generation still stops naturally early.
 */
export declare function computeMaxTokens(promptLength: number): number;
