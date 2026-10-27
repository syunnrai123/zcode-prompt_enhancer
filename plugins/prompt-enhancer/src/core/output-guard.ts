/**
 * Output guard: enforces the output-format contract from the system prompt.
 *
 * Models occasionally break the "output ONLY the optimized prompt" rule despite
 * the instruction — wrapping the result in a code fence, prefixing it with
 * "Optimized prompt:", or quoting it. The guard strips those violations instead
 * of failing the request, and flags when stripping actually changed the text.
 */

import { EnhancerError } from './types.js';

const FENCE_RE = /^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/;
const QUOTE_RE = /^"([\s\S]*)"\s*$/;
const PREFIX_RE =
  /^(?:优化后的提示词|优化后|增强后的提示词|增强结果|optimized\s*prompt|enhanced\s*prompt|here(?:'s| is) (?:the )?(?:optimized|enhanced)(?: version of your)?(?: prompt)?)\s*[:：]\s*/i;
const EXPLANATION_TAIL_RE = /\n+(?:---+\s*\n)?(?:以上(?:是|就是)|希望这|hope this helps)[^\n]*\s*$/i;

export interface GuardResult {
  readonly text: string;
  readonly modified: boolean;
}

export function validateEnhancedOutput(raw: unknown): GuardResult {
  if (typeof raw !== 'string') throw new EnhancerError('INVALID_OUTPUT', 'Provider output is not text.');
  if (raw.length > 128 * 1024 || raw.includes('\ufffd') || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) {
    throw new EnhancerError('INVALID_OUTPUT', 'Provider output contains invalid characters or exceeds the size limit.');
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new EnhancerError('INVALID_OUTPUT', 'Provider output contains an incomplete Unicode character.');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new EnhancerError('INVALID_OUTPUT', 'Provider output contains an incomplete Unicode character.');
    }
  }
  const guarded = cleanEnhancedOutput(raw);
  if (!guarded.text) throw new EnhancerError('EMPTY_RESPONSE', 'Enhancement produced empty output after cleaning.');
  return guarded;
}

export function cleanEnhancedOutput(raw: string): GuardResult {
  let text = (raw ?? '').trim();

  // Strip a single wrapping code fence, but keep fenced content the user would
  // legitimately want (inner fences survive because we only match the outer one).
  const fenced = text.match(FENCE_RE);
  const inner = fenced?.[1];
  if (inner !== undefined) text = inner.trim();

  const quoted = text.match(QUOTE_RE);
  const unquoted = quoted?.[1];
  if (unquoted !== undefined && !text.includes('\n')) text = unquoted.trim();

  text = text.replace(PREFIX_RE, '');
  text = text.replace(EXPLANATION_TAIL_RE, '');
  text = text.trim();

  return { text, modified: text !== (raw ?? '').trim() };
}
