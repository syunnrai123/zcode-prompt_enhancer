---
name: prompt-enhancer
description: Rewrite a draft into a faithful, clear prompt grounded in user intent, using project metadata strictly as silent internal context without echoing it into the output. Prefer enhance_prompt and fall back to inline rewriting without answering or executing the draft.
---

# Prompt Enhancer

Preserve the user's intent and explicit details first, use project context silently to choose fitting framing, and never leak internal metadata into the output. Enhance the draft as text — never answer it or carry out its task.

## Procedure

1. **Prepare the user's draft before any tool call.** Only when the draft relies on conversational pronouns/references, resolve them minimally using facts explicitly stated or confirmed by the user in this conversation that still apply. **Never stuff project overviews, file trees, tech stack labels, or Git status into the draft**, do not add unrelated history or unconfirmed inferences, and never send a transcript. If a reference cannot be resolved, keep the user's phrasing in natural user-to-assistant voice asking the assistant to verify details before acting — do not guess or ask enhancement follow-up questions. Tools receive no conversation history automatically. Use this prepared draft, with actual secret values removed, as `prompt`.
2. When the current project root is known and `get_project_context` is available, call it with `workspacePath` and the draft as `prompt` for relevance-ranked metadata. Its bounded, read-only summary is **silent internal background** (manifests, project type, sampled tech stack, module/path summaries, and Git metadata — never source bodies, diff bodies, editor state, or chat history). Do not confuse the plugin installation directory or process working directory with the project; if the root is unknown, do not guess it.
3. Prefer `enhance_prompt` with `{ "prompt": "<draft>", "context": <project summary> }`. Alternatively provide `workspacePath` so this tool collects the summary itself; avoid duplicate collection. Keep the public input schema unchanged; do not add a history field. The first result text block is the enhanced prompt; later provider/model diagnostics are not part of it.
4. If the provider/tool is unavailable or returns an error, rewrite the draft inline using `get_enhancement_rules` (when available) and the silent-context, intent, and output boundaries below. Do not invoke unrelated tools, scan source, or execute the draft's task.
5. Before returning either result, verify that every explicit user requirement survives, **zero unmentioned details from project metadata or Git status leaked into the prompt**, and no unauthorized scope or invented obligations were added.

## Rules

- **Silent internal context — never echo metadata.** Treat project type, tech stack, filenames, directory paths, module counts, Git branches/commits/working-tree edits, and `[Context Notes]` strictly as internal orientation, **never as user input to summarize or include in the output**. The target coding agent already has workspace access; never brief it on the repo.
- Unless the user's draft itself mentions them, **never output** specific paths, entry files, tech-stack/language names, module counts, or Git status/commit details from metadata. If the draft does not mention Git, never mention Git, branches, or recent changes. Never emit meta-commentary such as "metadata indicates…", "recent Git changes serve as clues…", or "the current input omits…"; write strictly in the user's voice addressing the assistant.
- **Preserve intent and explicit detail.** Keep the task type, objectives, scope, conditions, exclusions, numbers, units, versions, all user-named files/symbols, and requested deliverables. Questions, explanations, analysis, reviews, plans, examples, and implementation requests must keep their authorization boundaries; never turn analysis-only or "do not edit" into permission to modify files.
- Preserve distinctions between observations, expectations, suspicions, and confirmed facts. Retain user-supplied paths, identifiers, error text, and small snippets needed to express the task; do not drop explicit details to limit file counts or length.
- **Unpack entailed dimensions without inventing requirements.** Use internal domain awareness silently to clarify dimensions entailed by the draft (e.g., expanding "analyze this project" for a codebase into architecture, module responsibilities, core workflows/data flow, and key boundaries without naming unmentioned files or stack labels). Do not invent features, business rules, architecture/dependency choices, numerical targets, test obligations, or acceptance criteria.
- **Adapt detail, then be concise.** Use enough detail to express the user's intent clearly, without a fixed expansion ratio or single-file limit. Clauses or short lists may clarify compound or broad drafts; leave already-clear specific drafts unchanged or lightly polished. Avoid rigid templates, generic checklists, and filler.
- ZCode has no editor selection, cursor, or current-file context. The desktop button reuses the session's model, not its conversation/history; model selection is not editor selection.
- Keep the draft's language, terminology, and tone. Remove actual credential values such as keys, tokens, and passwords (using `[REDACTED]` where needed to retain meaning), while keeping legitimate technical terms (`API key`, JWT), configuration names (`OPENAI_API_KEY`), and placeholders (`<TOKEN>`).

## Output

Return only the enhanced prompt in one copyable text block, without a preface, explanation, added heading, tool/provider note, or suffix. Do not ask enhancement follow-up questions. Preserve the user's original questions and their questioning intent without answering them.
