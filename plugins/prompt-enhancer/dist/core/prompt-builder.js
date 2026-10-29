export const MAX_PROJECT_CONTEXT_LENGTH = 8000;
const MAX_LINE_LENGTH = 200;
export function truncateText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return text.slice(0, Math.max(0, maxLength - 4)) + '\n...';
}
function singleLine(value) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    return text ? (text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH - 3) + '...' : text) : undefined;
}
function lines(value, limit) {
    if (!Array.isArray(value))
        return undefined;
    const result = value.slice(0, limit).map(singleLine).filter((line) => !!line);
    if (value.length > limit)
        result.push('... (additional entries omitted)');
    return result.length ? result : undefined;
}
export function sanitizeProjectContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    const git = raw.gitChanges && typeof raw.gitChanges === 'object' && !Array.isArray(raw.gitChanges)
        ? raw.gitChanges
        : undefined;
    return {
        projectType: singleLine(raw.projectType),
        techStack: lines(raw.techStack, 24),
        projectOverview: singleLine(raw.projectOverview),
        modules: lines(raw.modules, 17),
        relevantPaths: lines(raw.relevantPaths, 24),
        directoryStructure: lines(raw.directoryStructure, 80),
        gitChanges: git ? {
            branch: singleLine(git.branch),
            workingTree: lines(git.workingTree, 40),
            recentCommits: lines(git.recentCommits, 5),
        } : undefined,
        notes: lines(raw.notes, 5),
    };
}
export function compactList(entries, budget) {
    const result = [];
    let remaining = budget;
    for (let i = 0; i < entries.length; i++) {
        const slots = Math.min(12, entries.length - i);
        // Truncate against the real remaining budget (not just this entry's slot)
        // so a lone long entry still fits when the budget can hold it.
        const cap = Math.min(Math.max(40, Math.floor(remaining / slots)), remaining - 3);
        const line = entries[i].length > cap ? entries[i].slice(0, Math.max(0, cap - 3)) + '...' : entries[i];
        if (line.length + 3 > remaining)
            break;
        result.push(`- ${line}`);
        remaining -= line.length + 3;
    }
    if (result.length < entries.length)
        result.push(`... (${entries.length - result.length} more omitted)`);
    return result.join('\n');
}
function listSection(title, entries, budget) {
    if (!entries?.length)
        return null;
    return `[${title}]\n${compactList(entries, budget)}`;
}
export function formatProjectMetadata(context) {
    const project = sanitizeProjectContext(context);
    if (!project)
        return '';
    const git = project.gitChanges;
    const gitSummary = git ? [
        ...(git.branch ? [`Branch: ${git.branch}`] : []),
        git.workingTree?.length ? `Working tree:\n${compactList(git.workingTree, 700)}` : '',
        git.recentCommits?.length ? `Recent commits:\n${compactList(git.recentCommits, 600)}` : '',
    ].filter(Boolean).join('\n') : '';
    const parts = [
        project.projectType ? `[Project Type] ${project.projectType}` : null,
        project.projectOverview ? `[Project Overview] ${project.projectOverview}` : null,
        listSection('Tech Stack', project.techStack, 600),
        listSection('Relevant Paths', project.relevantPaths, 1100),
        listSection('Module Overview', project.modules, 1000),
        listSection('Directory Structure', project.directoryStructure, 650),
        gitSummary ? `[Recent Git Changes]\n${gitSummary}` : null,
        listSection('Context Notes', project.notes, 400),
    ].filter((part) => part !== null);
    return truncateText(parts.join('\n\n'), MAX_PROJECT_CONTEXT_LENGTH);
}
export function buildFullPrompt(originalPrompt, context) {
    const metadata = formatProjectMetadata(context);
    return JSON.stringify({
        draft: originalPrompt,
        ...(metadata ? { projectMetadata: metadata } : {}),
    });
}
/** Character-based output budget with a fixed 8192-token ceiling. */
export function computeMaxTokens(promptLength) {
    const len = Number.isFinite(promptLength) && promptLength > 0 ? Math.ceil(promptLength) : 0;
    return Math.min(8192, Math.max(1024, Math.ceil(len * 0.8)));
}
