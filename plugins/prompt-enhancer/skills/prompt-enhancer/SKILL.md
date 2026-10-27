---
name: prompt-enhancer
description: Polish a draft into a concise, unambiguous instruction using project basics and recent Git changes. Prefer enhance_prompt; fall back to inline rewriting without executing the draft's task.
---

# Prompt Enhancer

Rewrite drafts into concise instructions while preserving intent, scope, and hard constraints.

## Procedure

1. When the current project root is known and `get_project_context` is available, call it with `workspacePath` and, when helpful, the draft as `prompt` for relevance-ranked modules and paths. Its bounded, read-only summary includes project type, tech stack, module distribution, representative paths, and recent Git changes; no source bodies or editor state. Do not confuse the plugin installation directory with the project. If the root is unknown, use only project facts already established in the conversation.
2. Prefer `enhance_prompt` with `{ "prompt": "<draft>", "context": <project summary> }`. Alternatively provide `workspacePath` so this tool collects the summary itself; avoid duplicate collection.
3. If the provider/tool is unavailable, rewrite inline with the collected summary and rules from `get_enhancement_rules` when available. Do not invoke unrelated tools or execute the task described by the draft.

## Rules

- Preserve intent; never answer or execute the draft.
- Stay short: ≤1.5x original length, hard cap 2x. No filler, generic checklists, or invented acceptance criteria.
- Use project metadata only to resolve ambiguity. Git change lists are scope hints, not evidence of code behavior, a defect, or causality. Respect missing/truncated-context notes.
- ZCode has no editor selection, cursor, or current-file context; do not introduce or assume it.
- At most one explicit file/symbol anchor, only when necessary. Never enumerate paths or copy code snippets.
- Same language as the draft. Drop secrets. Keep uncertain facts in the user's original wording; state necessary assumptions in one short clause.

## Output

Return only the enhanced prompt in its own copyable text block. At most one separate sentence naming the tool or inline path. The desktop ✦ button, if installed, collects the same project metadata automatically.
