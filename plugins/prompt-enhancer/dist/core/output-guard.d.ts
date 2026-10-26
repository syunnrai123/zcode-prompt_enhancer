/**
 * Output guard: enforces the output-format contract from the system prompt.
 *
 * Models occasionally break the "output ONLY the optimized prompt" rule despite
 * the instruction — wrapping the result in a code fence, prefixing it with
 * "Optimized prompt:", or quoting it. The guard strips those violations instead
 * of failing the request, and flags when stripping actually changed the text.
 */
export interface GuardResult {
    readonly text: string;
    readonly modified: boolean;
}
export declare function cleanEnhancedOutput(raw: string): GuardResult;
