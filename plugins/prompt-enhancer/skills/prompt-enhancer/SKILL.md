---
name: prompt-enhancer
description: Enhance a draft prompt into a clear, concise, unambiguous instruction before sending it to the agent. Use when the user asks to improve/optimize/polish a prompt, or before submitting a vague or under-specified request. Prefers the enhance_prompt MCP tool; falls back to inline rewriting with the same rule set.
---

# Prompt Enhancer

Rewrite draft prompts into concise instructions an agent can execute without guessing.

## When to use

- The user asks to "enhance / optimize / improve / polish this prompt".
- The user types `/enhance-prompt <draft>` (the command markdown routes here).
- A draft you are about to execute is vague enough that execution would rely on guesses.

## How to enhance

1. **Preferred path — MCP tool.** If the `enhance_prompt` tool from the `prompt-enhancer` MCP server is available, call it with `{ "prompt": "<draft>" }` (plus `context.projectType` only if you already know it — do not read files to fill context). It applies the canonical rule set and the provider configured in plugin settings.
2. **Fallback path — inline.** Without the tool (no API key configured), rewrite the draft yourself following the canonical rules exposed by the `get_enhancement_rules` tool, summarized below:
   - Preserve intent; never answer or start executing the prompt.
   - Keep it SHORT: ≤1.5x the original length (hard cap 2x); no filler, no invented acceptance criteria; light polish only when the draft is already clear.
   - Reference at most ONE file/symbol anchor, and only when the draft points at code or the target is ambiguous; describe goals in words instead of paths.
   - Resolve vague references compactly; state assumptions in one short clause instead of asking.
   - Same language as the draft; output only the enhanced prompt text — no explanations, prefixes, or headings.
   - Pure text transformation: no tools, no file access, no fabricated facts, no secrets.

## Output contract

Return the enhanced prompt in its own text block so the user can copy it in one click. At most one short line naming the path used (tool vs. inline). If the desktop ✦ button is installed, remind the user they can also enhance directly from the composer.
