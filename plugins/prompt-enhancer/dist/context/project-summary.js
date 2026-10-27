/** Metadata-only selection: broad module coverage plus draft/change relevance. */
export const PATH_INDEX_LIMITS = { paths: 50_000, bytes: 4 * 1024 * 1024, pathChars: 1024 };
const CONTAINERS = new Set(['packages', 'apps', 'services', 'plugins', 'libs', 'modules', 'crates']);
const LANGUAGES = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#',
    cpp: 'C++', c: 'C', php: 'PHP', rb: 'Ruby', swift: 'Swift', vue: 'Vue', svelte: 'Svelte',
};
export function moduleOf(file) {
    const parts = file.replace(/\/$/, '').split('/');
    if (parts.length === 1)
        return '(root)';
    if (CONTAINERS.has(parts[0]) && parts.length > 2)
        return parts.slice(0, 2).join('/');
    if (parts[0] === 'src' && parts.length > 2)
        return parts.slice(0, 2).join('/');
    return parts[0];
}
const DOMAIN_TERMS = {
    登录: ['login', 'signin', 'auth'], 认证: ['auth', 'authentication'],
    支付: ['payment', 'payments', 'billing'], 订单: ['order', 'orders'],
    路由: ['route', 'routes', 'router'], 缓存: ['cache', 'caching'],
    测试: ['test', 'tests', 'spec'], 网络: ['network', 'http'],
};
const GENERIC_TERMS = new Set(['the', 'and', 'with', 'this', 'that', 'file', 'src', 'fix', 'project',
    'packages', 'apps', 'services', 'ts', 'tsx', 'js', 'jsx', 'json', 'py', 'java', 'rs']);
function relevanceMatcher(prompt) {
    const draft = prompt.slice(0, 16_384).toLowerCase().replace(/\\/g, '/');
    const terms = [...new Set([
            ...(draft.match(/[a-z][a-z0-9]{1,63}/g) ?? []),
            ...Object.entries(DOMAIN_TERMS).filter(([word]) => draft.includes(word)).flatMap(([, aliases]) => aliases),
        ].filter((term) => !GENERIC_TERMS.has(term)))].slice(0, 64);
    return (file) => {
        if (!draft)
            return 0;
        const lower = file.toLowerCase();
        if (lower.length >= 4 && draft.includes(lower))
            return 1000;
        const segments = lower.split(/[/.\-_]/).filter((part) => part.length >= 2);
        const basename = lower.slice(lower.lastIndexOf('/') + 1).split(/[.\-_]/);
        let score = 0;
        for (const term of terms) {
            if (basename.includes(term))
                score += 30;
            else if (segments.includes(term))
                score += 12;
        }
        for (const segment of segments) {
            if (/\p{Script=Han}/u.test(segment) && draft.includes(segment))
                score += 20;
        }
        return score;
    };
}
/** Build the scoring function once per collection; calling it is cheap. */
export function createRelevanceMatcher(prompt) {
    return relevanceMatcher(prompt);
}
export function relevanceScore(file, prompt) {
    return relevanceMatcher(prompt)(file);
}
export function selectPaths(paths, prompt, changes = [], recent = []) {
    const changed = new Set(changes);
    const committed = new Set(recent);
    const score = relevanceMatcher(prompt);
    const candidates = [...new Set([...paths, ...changes, ...recent])].map((file) => ({
        file,
        score: score(file) + (changed.has(file) ? 8 : 0) + (committed.has(file) ? 3 : 0),
    })).filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    const result = [];
    const perModule = new Map();
    for (const entry of candidates) {
        const module = moduleOf(entry.file);
        const count = perModule.get(module) ?? 0;
        if (count >= 3 && entry.score < 1000)
            continue;
        result.push(entry.file);
        perModule.set(module, count + 1);
        if (result.length >= 24)
            break;
    }
    return result;
}
export function summarizePaths(paths, prompt, changes, recent, partial, source) {
    const files = paths.filter((file) => !file.endsWith('/'));
    const modules = new Map();
    const tops = new Set();
    for (const file of files) {
        const module = moduleOf(file);
        const stats = modules.get(module) ?? { count: 0, languages: new Set() };
        stats.count++;
        const language = LANGUAGES[file.split('.').pop()?.toLowerCase() ?? ''];
        if (language)
            stats.languages.add(language);
        modules.set(module, stats);
        if (file.includes('/'))
            tops.add(file.split('/')[0] + '/');
    }
    for (const directory of paths.filter((file) => file.endsWith('/')))
        tops.add(directory.split('/')[0] + '/');
    const relevantPaths = selectPaths(files, prompt, changes, recent);
    const relevantModules = new Set(relevantPaths.map(moduleOf));
    const ranked = [...modules].sort((a, b) => Number(relevantModules.has(b[0])) - Number(relevantModules.has(a[0])) ||
        b[1].count - a[1].count || a[0].localeCompare(b[0]));
    // Reserve half the module slots for breadth, not only the hottest branch.
    const chosen = ranked.slice(0, 8);
    const parents = new Set(chosen.map(([module]) => module.split('/')[0]));
    for (const entry of [...modules].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
        const parent = entry[0].split('/')[0];
        if (!parents.has(parent)) {
            chosen.push(entry);
            parents.add(parent);
        }
        if (chosen.length >= 16)
            break;
    }
    for (const entry of ranked) {
        if (chosen.length >= 16)
            break;
        if (!chosen.some(([module]) => module === entry[0]))
            chosen.push(entry);
    }
    const moduleSummary = chosen.map(([module, stats]) => `${module}${module === '(root)' ? '' : '/'}: ${stats.count} indexed files${stats.languages.size ? `; ${[...stats.languages].slice(0, 3).join(', ')}` : ''}`);
    if (modules.size > chosen.length)
        moduleSummary.push(`... ${modules.size - chosen.length} other indexed modules`);
    const directoryStructure = [...new Set([
            ...[...tops].sort(),
            ...chosen.filter(([module]) => module !== '(root)').map(([module]) => module + '/'),
            ...files.filter((file) => !file.includes('/')).slice(0, 4),
        ])].slice(0, 48);
    return {
        projectOverview: `${source}: ${files.length} indexed files, ${modules.size} modules${partial ? ' (partial index; counts are lower bounds)' : ''}. Metadata only, not code analysis.`,
        modules: moduleSummary,
        directoryStructure,
        relevantPaths,
        techStack: [...new Set([...modules.values()].flatMap((stats) => [...stats.languages]))].sort(),
    };
}
