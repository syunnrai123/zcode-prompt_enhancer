/**
 * Output guard: enforces the output-format contract from the system prompt.
 *
 * Models occasionally break the "output ONLY the optimized prompt" rule despite
 * the instruction — wrapping the result in a code fence, prefixing it with
 * "Optimized prompt:", or quoting it. The guard strips those violations instead
 * of failing the request, and flags when stripping actually changed the text.
 */
const FENCE_RE = /^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/;
const QUOTE_RE = /^"([\s\S]*)"\s*$/;
const PREFIX_RE = /^(?:优化后的提示词|优化后|增强后的提示词|增强结果|optimized\s*prompt|enhanced\s*prompt|here(?:'s| is) (?:the )?(?:optimized|enhanced)(?: version of your)?(?: prompt)?\s*[:：])\s*[:：]?\s*/i;
const EXPLANATION_TAIL_RE = /\n*(?:---+|以上是|希望这|hope this helps|this should)[^\n]*$/i;
export function cleanEnhancedOutput(raw) {
    let text = (raw ?? '').trim();
    // Strip a single wrapping code fence, but keep fenced content the user would
    // legitimately want (inner fences survive because we only match the outer one).
    const fenced = text.match(FENCE_RE);
    const inner = fenced?.[1];
    if (inner !== undefined)
        text = inner.trim();
    const quoted = text.match(QUOTE_RE);
    const unquoted = quoted?.[1];
    if (unquoted !== undefined && !text.includes('\n'))
        text = unquoted.trim();
    text = text.replace(PREFIX_RE, '');
    text = text.replace(EXPLANATION_TAIL_RE, '');
    text = text.trim();
    return { text, modified: text !== (raw ?? '').trim() };
}
