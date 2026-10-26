const MAX_SELECTED_CODE_LENGTH = 1500;
const MAX_CURSOR_CONTEXT_LENGTH = 800;
const MAX_CURRENT_FILE_LENGTH = 2000;
const MAX_RELATED_FILES_LENGTH = 1200;
const MAX_SINGLE_RELATED_FILE_LENGTH = 300;
/** Related files contribute paths only unless content is tiny; paths alone rarely justify output references. */
const MAX_RELATED_FILE_CONTENT_TO_EMBED = 300;
const EXTENSION_LANGUAGE_MAP = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript',
    py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rs: 'rust',
    rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', scala: 'scala', vue: 'vue', html: 'html',
    css: 'css', scss: 'scss', less: 'less', json: 'json', xml: 'xml',
    yaml: 'yaml', yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'bash',
    bash: 'bash', zsh: 'bash',
};
export function getLanguageFromPath(filePath) {
    if (!filePath)
        return 'text';
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_LANGUAGE_MAP[ext] ?? 'text';
}
export function truncateText(text, maxLength, fromEnd = false) {
    if (!text || text.length <= maxLength)
        return text;
    if (fromEnd)
        return '...\n' + text.slice(-maxLength);
    return text.slice(0, maxLength) + '\n...';
}
function languageOf(context) {
    return (context?.currentFile?.language ??
        getLanguageFromPath(context?.currentFile?.path) ??
        'text');
}
function selectedCodeSection(context) {
    const code = context.selectedCode?.trim();
    if (!code)
        return null;
    return `[User Selected Code]\n\`\`\`${languageOf(context)}\n${truncateText(code, MAX_SELECTED_CODE_LENGTH)}\n\`\`\``;
}
function cursorContextSection(context) {
    // Cursor context only matters when the user did not select anything.
    if (context.selectedCode?.trim())
        return null;
    const around = context.cursorContext?.trim();
    if (!around)
        return null;
    const lineInfo = context.cursorPosition ? ` (line ${context.cursorPosition.line})` : '';
    return `[Code Around Cursor${lineInfo}]\n\`\`\`${languageOf(context)}\n${truncateText(around, MAX_CURSOR_CONTEXT_LENGTH)}\n\`\`\``;
}
function currentFileSection(context) {
    const file = context.currentFile;
    if (!file?.path)
        return null;
    const lang = file.language ?? getLanguageFromPath(file.path);
    let section = `[Current File] ${file.path}\n[Language Type] ${lang}`;
    const hasRichContext = Boolean(context.selectedCode?.trim() || context.cursorContext?.trim());
    if (!hasRichContext && file.content?.trim()) {
        section += `\n[File Content Preview]\n\`\`\`${lang}\n${truncateText(file.content, MAX_CURRENT_FILE_LENGTH)}\n\`\`\``;
    }
    return section;
}
function relatedFilesSection(context) {
    const files = context.relatedFiles;
    if (!files?.length)
        return null;
    const entries = [];
    let totalLength = 0;
    for (const file of files) {
        if (totalLength >= MAX_RELATED_FILES_LENGTH || !file.path)
            continue;
        let entry = `- ${file.path}`;
        // Embed content only when it is small enough to matter; otherwise the bare
        // path already tells the model a related file exists.
        const content = file.content?.trim() ?? '';
        if (content && content.length <= MAX_RELATED_FILE_CONTENT_TO_EMBED) {
            const remaining = MAX_RELATED_FILES_LENGTH - totalLength;
            const budget = Math.min(MAX_SINGLE_RELATED_FILE_LENGTH, remaining);
            const truncated = truncateText(content, budget);
            entry += `\n\`\`\`${getLanguageFromPath(file.path)}\n${truncated}\n\`\`\``;
            totalLength += truncated.length;
        }
        entries.push(entry);
    }
    return entries.length > 0 ? `[Related Files]\n${entries.join('\n')}` : null;
}
/**
 * Assemble the full user message: the draft first, then context sections,
 * then project type.
 */
export function buildFullPrompt(originalPrompt, context) {
    let fullPrompt = `Please optimize the following prompt:\n\n${originalPrompt}`;
    if (!context)
        return fullPrompt;
    const parts = [
        selectedCodeSection(context),
        cursorContextSection(context),
        currentFileSection(context),
        relatedFilesSection(context),
        context.projectType ? `[Project Type] ${context.projectType}` : null,
    ].filter((part) => part !== null);
    if (parts.length > 0) {
        fullPrompt +=
            '\n\n---\nBelow is relevant context information; use it when optimizing the prompt:\n\n' +
                parts.join('\n\n');
    }
    return fullPrompt;
}
/**
 * Cap output tokens by input size. The brevity contract in the system prompt
 * targets ≤1.5x the original length, so the cap only has to cover a lightly
 * polished rewrite of the input itself — sized for a CJK-heavy worst case
 * (~0.7 tokens per character) with a small margin. Capping tight protects
 * against runaway verbose output; generation still stops naturally early.
 */
export function computeMaxTokens(promptLength) {
    const len = Number.isFinite(promptLength) && promptLength > 0 ? Math.ceil(promptLength) : 0;
    return Math.min(4096, Math.max(1024, Math.ceil(len * 0.8)));
}
