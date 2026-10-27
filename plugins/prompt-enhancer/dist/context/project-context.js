import { execFile, spawn } from 'node:child_process';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeProjectContext } from '../core/prompt-builder.js';
import { createRelevanceMatcher, moduleOf, PATH_INDEX_LIMITS, summarizePaths } from './project-summary.js';
import { PathIndexReader } from './path-index.js';
const MAX_DIRECTORIES = 128;
const MAX_DEPTH = 8;
const MAX_PER_DIRECTORY_ENTRIES = 2048;
const MAX_PENDING_DIRECTORIES = 2048;
const MAX_MANIFESTS = 16;
const MAX_MANIFEST_BYTES = 16 * 1024;
const COLLECTION_TIMEOUT_MS = 3000;
const OMITTED = new Set([
    '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'dist-test', 'build',
    'out', 'target', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage',
]);
const MANIFESTS = new Set([
    'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json',
]);
const FRAMEWORKS = {
    react: 'React', vue: 'Vue', '@angular/core': 'Angular', next: 'Next.js',
    nuxt: 'Nuxt', vite: 'Vite', electron: 'Electron', express: 'Express',
    fastify: 'Fastify', '@nestjs/core': 'NestJS', typescript: 'TypeScript',
    svelte: 'Svelte', '@modelcontextprotocol/sdk': 'MCP SDK',
};
function isSensitive(name) {
    return /^(?:\.env(?:\..*)?|\.zcode|\.claude|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.git-credentials|\.npmrc|\.pypirc)$/i.test(name) ||
        /(?:secret|credential|private.?key)|(?:^|[.\-_])token(?:[.\-_]|$)|\.(?:pem|key|p12|pfx|gpg)$/i.test(name) ||
        /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.\w+)?$/i.test(name);
}
async function readManifest(root, relative) {
    try {
        const parts = relative.split('/');
        for (let i = 1; i <= parts.length; i++) {
            if ((await lstat(path.join(root, ...parts.slice(0, i)))).isSymbolicLink())
                return undefined;
        }
        const file = path.join(root, relative);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES)
            return undefined;
        const handle = await open(file, 'r');
        try {
            const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return bytesRead <= MAX_MANIFEST_BYTES ? buffer.subarray(0, bytesRead).toString('utf8') : undefined;
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return undefined;
    }
}
function inspectManifest(name, text, stack, types) {
    switch (name) {
        case 'package.json': {
            try {
                const pkg = JSON.parse(text);
                if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
                    return;
                stack.add('JavaScript / Node.js');
                types.add('Node.js project');
                if (pkg.workspaces)
                    types.add('monorepo');
                for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
                    const deps = pkg[group];
                    if (!deps || typeof deps !== 'object' || Array.isArray(deps))
                        continue;
                    for (const [dependency, label] of Object.entries(FRAMEWORKS)) {
                        if (Object.prototype.hasOwnProperty.call(deps, dependency))
                            stack.add(label);
                    }
                }
            }
            catch { /* malformed or changing manifest: omit it */ }
            break;
        }
        case 'tsconfig.json':
            stack.add('TypeScript');
            break;
        case 'pyproject.toml':
        case 'requirements.txt':
            stack.add('Python');
            types.add('Python project');
            for (const framework of ['django', 'flask', 'fastapi', 'pytest']) {
                if (new RegExp(`\\b${framework}\\b`, 'i').test(text))
                    stack.add(framework);
            }
            break;
        case 'Cargo.toml':
            stack.add('Rust / Cargo');
            types.add('Rust project');
            break;
        case 'go.mod':
            stack.add('Go');
            types.add('Go project');
            break;
        case 'pom.xml':
            stack.add('Java / Maven');
            types.add('JVM project');
            break;
        case 'build.gradle':
            stack.add('Java / Gradle');
            types.add('JVM project');
            break;
        case 'build.gradle.kts':
            stack.add('Kotlin / Gradle');
            types.add('JVM project');
            break;
        case 'composer.json':
            stack.add('PHP / Composer');
            types.add('PHP project');
            break;
    }
}
function gitEnvironment() {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])
        delete env[name];
    return env;
}
function git(root, args, timeout, signal, notes) {
    return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'status.relativePaths=true', '-C', root, ...args], {
            encoding: 'utf8', timeout, maxBuffer: 512 * 1024, windowsHide: true,
            env: gitEnvironment(),
            ...(signal ? { signal } : {}),
        }, (error, stdout) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            if (notes && stdout) {
                const end = stdout.lastIndexOf('\0');
                if (end >= 0) {
                    notes.add('Git metadata truncated; only complete prefix records were kept.');
                    resolve(stdout.slice(0, end + 1));
                    return;
                }
            }
            reject(error);
        });
    });
}
function safePath(value) {
    const parts = value.split(/[\\/]/);
    return value.length > 0 && value.length <= PATH_INDEX_LIMITS.pathChars && !path.isAbsolute(value) &&
        !/[\x00-\x1f\x7f]/.test(value) &&
        !parts.some((part) => part === '..' || isSensitive(part) || OMITTED.has(part) || /^\.tmp/.test(part));
}
function gitPathIndex(root, timeout, signal) {
    return new Promise((resolve) => {
        const reader = new PathIndexReader(safePath);
        let partial = false;
        let stopped = false;
        const child = spawn('git', ['-c', 'core.fsmonitor=false', '-C', root,
            'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
            windowsHide: true, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], signal,
        });
        const finish = (available) => {
            if (stopped)
                return;
            stopped = true;
            clearTimeout(timer);
            reader.finish();
            resolve({ paths: reader.paths, partial: partial || reader.partial, available: available || reader.paths.length > 0 });
        };
        const limit = () => {
            partial = true;
            child.kill();
            finish(true);
        };
        const timer = setTimeout(() => { partial = true; child.kill(); finish(reader.paths.length > 0); }, timeout);
        child.stdout.on('data', (chunk) => {
            if (stopped)
                return;
            reader.accept(chunk);
            if (reader.stopped)
                limit();
        });
        child.on('error', () => { partial = true; finish(false); });
        child.on('close', (code) => { if (code !== 0)
            partial = true; finish(code === 0); });
    });
}
async function filesystemIndex(root, matcher, signal, deadline, notes) {
    const paths = [];
    const pending = [{ relative: '', depth: 0, priority: 0, group: '(root)' }];
    const visitedGroups = new Map();
    let visited = 0;
    let indexedBytes = 0;
    let partial = false;
    while (pending.length && !signal.aborted && Date.now() < deadline && visited < MAX_DIRECTORIES && paths.length < PATH_INDEX_LIMITS.paths) {
        pending.sort((a, b) => {
            if (!a.relative)
                return -1;
            if (!b.relative)
                return 1;
            return Number(b.priority > 0) - Number(a.priority > 0) ||
                (visitedGroups.get(a.group) ?? 0) - (visitedGroups.get(b.group) ?? 0) ||
                a.depth - b.depth || a.relative.localeCompare(b.relative);
        });
        const directory = pending.shift();
        visited++;
        visitedGroups.set(directory.group, (visitedGroups.get(directory.group) ?? 0) + 1);
        try {
            const entries = [];
            const listing = await opendir(path.join(root, directory.relative));
            let count = 0;
            for await (const entry of listing) {
                if (signal.aborted || Date.now() >= deadline)
                    break;
                if (++count > MAX_PER_DIRECTORY_ENTRIES) {
                    partial = true;
                    break;
                }
                const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
                if (entry.isSymbolicLink() || !safePath(relative))
                    continue;
                entries.push({ entry, relative });
            }
            entries.sort((a, b) => a.relative.localeCompare(b.relative));
            for (const { entry, relative } of entries) {
                if (paths.length >= PATH_INDEX_LIMITS.paths) {
                    partial = true;
                    break;
                }
                const indexedPath = relative + (entry.isDirectory() ? '/' : '');
                indexedBytes += Buffer.byteLength(indexedPath, 'utf8') + 1;
                if (indexedBytes > PATH_INDEX_LIMITS.bytes) {
                    partial = true;
                    pending.length = 0;
                    break;
                }
                paths.push(indexedPath);
                if (entry.isDirectory()) {
                    if (directory.depth < MAX_DEPTH - 1 && pending.length < MAX_PENDING_DIRECTORIES) {
                        pending.push({ relative, depth: directory.depth + 1, priority: matcher(relative), group: moduleOf(relative + '/_') });
                    }
                    else
                        partial = true;
                }
            }
        }
        catch {
            notes.add('Some project directories could not be read.');
            partial = true;
        }
    }
    if (pending.length || signal.aborted || Date.now() >= deadline)
        partial = true;
    if (partial)
        notes.add('Filesystem index truncated (at most 8 levels, 128 directories, 50000 paths).');
    return { paths, partial, available: true };
}
function parseStatus(raw, prefix = '') {
    const records = raw.split('\0');
    const changes = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record)
            continue;
        const status = record.slice(0, 2).trim();
        const fromRoot = record.slice(3);
        const oldPath = /[RC]/.test(status) ? records[++i] : undefined;
        if (prefix && !fromRoot.startsWith(prefix))
            continue;
        const file = prefix ? fromRoot.slice(prefix.length) : fromRoot;
        const previous = oldPath && (!prefix || oldPath.startsWith(prefix))
            ? (prefix ? oldPath.slice(prefix.length) : oldPath) : undefined;
        if (!safePath(file) || (oldPath && !safePath(oldPath)) || (previous && !safePath(previous)))
            continue;
        changes.push({ file, status, ...(previous ? { previous } : {}) });
    }
    return changes;
}
/** Parse and rank changes with a precomputed matcher — never rebuild it inside the comparator. */
export function rankedStatusChanges(raw, prefix, matcher) {
    return parseStatus(raw, prefix)
        .map((change) => ({ change, score: matcher(change.file) }))
        .sort((a, b) => b.score - a.score || a.change.file.localeCompare(b.change.file))
        .map((entry) => entry.change);
}
/** Commit records are strictly "\x1e<hash> <subject>"; other records are file names. */
export function parseLog(raw, matcher) {
    const parsed = [];
    const recentPaths = [];
    for (const record of raw.split('\0')) {
        if (/^\x1e[0-9a-f]{4,40} /.test(record)) {
            parsed.push({ title: record.slice(1), files: [] });
            continue;
        }
        const file = record.replace(/^\n+/, '');
        if (safePath(file)) {
            parsed.at(-1)?.files.push(file);
            recentPaths.push(file);
        }
    }
    const commits = parsed.map((commit) => ({
        title: commit.title,
        files: commit.files.map((file) => ({ file, score: matcher(file) }))
            .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
            .map((entry) => entry.file),
    }));
    return { commits, recentPaths };
}
async function scanProjectContext(workspacePath, prompt, signal, deadline) {
    const notes = new Set();
    let root;
    try {
        if (!path.isAbsolute(workspacePath))
            throw new Error('explicit absolute project root required');
        root = await realpath(workspacePath);
        if (!(await lstat(root)).isDirectory())
            throw new Error('not a directory');
    }
    catch {
        return { notes: ['Project directory is unavailable; project context omitted.'] };
    }
    const alive = () => !signal.aborted && Date.now() < deadline;
    const matcher = createRelevanceMatcher(prompt);
    const timeout = Math.max(1, Math.min(1200, deadline - Date.now()));
    const [index, branchResult, statusResult, logResult, prefixResult] = await Promise.all([
        gitPathIndex(root, timeout, signal),
        git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], timeout, signal).catch(() => undefined),
        git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'], timeout, signal, notes).catch(() => undefined),
        git(root, ['log', '-3', '--format=%x00%x1e%h %s%x00', '--name-only', '-z', '--no-renames', '--relative', '--', '.'], timeout, signal, notes).catch(() => undefined),
        git(root, ['rev-parse', '--show-prefix'], timeout, signal).catch(() => undefined),
    ]);
    const inventory = index.available ? index : await filesystemIndex(root, matcher, signal, deadline, notes);
    if (index.available && index.partial)
        notes.add('Git path index truncated (50000 records, 4 MiB or collection timeout); coverage is partial.');
    const files = [...new Set(inventory.paths)];
    const changes = statusResult !== undefined && prefixResult !== undefined
        ? rankedStatusChanges(statusResult, prefixResult.trimEnd(), matcher) : [];
    const changedPaths = changes.map((change) => change.file);
    const { commits, recentPaths } = logResult !== undefined ? parseLog(logResult, matcher) : { commits: [], recentPaths: [] };
    const summary = summarizePaths(files, prompt, changedPaths, recentPaths, inventory.partial, index.available ? 'Git path index' : 'Filesystem index');
    const stack = new Set(summary.techStack);
    const types = new Set();
    const changedDirs = new Set();
    for (const file of changedPaths) {
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i++)
            changedDirs.add(parts.slice(0, i).join('/'));
    }
    const manifests = files.filter((file) => MANIFESTS.has(path.posix.basename(file)))
        .map((file) => ({ file, score: matcher(file) }))
        .sort((a, b) => {
        const rootA = !a.file.includes('/'), rootB = !b.file.includes('/');
        return Number(rootB) - Number(rootA) || b.score - a.score ||
            Number(changedDirs.has(path.posix.dirname(b.file))) - Number(changedDirs.has(path.posix.dirname(a.file))) ||
            a.file.split('/').length - b.file.split('/').length || a.file.localeCompare(b.file);
    })
        .map((entry) => entry.file);
    const chosen = [];
    const groups = new Set();
    for (const file of manifests) {
        const group = path.posix.dirname(file);
        if (!groups.has(group)) {
            chosen.push(file);
            groups.add(group);
        }
        if (chosen.length >= MAX_MANIFESTS)
            break;
    }
    for (const file of manifests) {
        if (chosen.length >= MAX_MANIFESTS)
            break;
        if (!chosen.includes(file))
            chosen.push(file);
    }
    for (const file of chosen) {
        if (!alive())
            break;
        const text = await readManifest(root, file);
        if (text !== undefined)
            inspectManifest(path.posix.basename(file), text, stack, types);
        else
            notes.add('Some manifests were skipped (unavailable, symlink, or larger than 16 KiB).');
    }
    if (manifests.length > chosen.length)
        notes.add(`Manifest sampling: ${chosen.length} of ${manifests.length} indexed manifests; stack may be incomplete.`);
    if (files.some((file) => file.split('/').includes('.zcode-plugin')))
        types.add('ZCode plugin');
    if (new Set(files.filter((file) => MANIFESTS.has(path.posix.basename(file))).map(moduleOf)).size > 1)
        types.add('multi-module project');
    let gitChanges;
    if (branchResult !== undefined || statusResult !== undefined || logResult !== undefined) {
        const workingTree = changes.slice(0, 40).map(({ file, status, previous }) => `${status} ${previous ? `${previous} -> ` : ''}${file}`);
        if (changes.length > 40)
            workingTree.push(`... ${changes.length - 40} additional changes omitted`);
        gitChanges = {
            branch: branchResult?.trim(),
            workingTree,
            recentCommits: commits.slice(0, 3).map((commit) => `${commit.title}${commit.files.length ? ` [${commit.files.slice(0, 5).join(', ')}${commit.files.length > 5 ? ', ...' : ''}]` : ''}`),
        };
        if (statusResult !== undefined && changes.length === 0)
            notes.add('No visible working-tree changes in the selected project.');
        if (branchResult === undefined || statusResult === undefined || logResult === undefined)
            notes.add('Some Git metadata is unavailable.');
    }
    else
        notes.add('Git metadata unavailable (not a repository, Git missing, or collection timed out).');
    if (!alive())
        notes.add('Project collection reached its time limit; context is incomplete.');
    if (stack.has('React') || stack.has('Vue') || stack.has('Angular') || stack.has('Next.js'))
        types.add('web application');
    if (stack.has('Electron'))
        types.add('desktop application');
    return sanitizeProjectContext({
        ...summary,
        projectType: types.size ? [...types].join('; ') : undefined,
        techStack: [...stack], gitChanges, notes: [...notes],
    }) ?? {};
}
export async function collectProjectContext(workspacePath, { signal, prompt = '' } = {}) {
    if (signal?.aborted)
        return { notes: ['Project collection cancelled.'] };
    const controller = new AbortController();
    const deadline = Date.now() + COLLECTION_TIMEOUT_MS;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, COLLECTION_TIMEOUT_MS);
    let aborted;
    try {
        const interrupted = new Promise((resolve) => {
            aborted = () => resolve({ notes: ['Project collection interrupted or timed out; context omitted.'] });
            controller.signal.addEventListener('abort', aborted, { once: true });
        });
        return await Promise.race([scanProjectContext(workspacePath, prompt, controller.signal, deadline), interrupted]);
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (aborted)
            controller.signal.removeEventListener('abort', aborted);
        controller.abort();
    }
}
export async function resolveProjectContext(workspacePath, supplied, prompt = '') {
    const context = sanitizeProjectContext(supplied);
    if (!workspacePath?.trim())
        return context;
    const collected = await collectProjectContext(workspacePath, { prompt });
    return sanitizeProjectContext({
        ...context,
        ...collected,
        projectType: collected.projectType ?? context?.projectType,
        techStack: collected.techStack ?? context?.techStack,
        projectOverview: collected.projectOverview ?? context?.projectOverview,
        modules: collected.modules ?? context?.modules,
        relevantPaths: collected.relevantPaths ?? context?.relevantPaths,
        directoryStructure: collected.directoryStructure ?? context?.directoryStructure,
        gitChanges: collected.gitChanges ?? context?.gitChanges,
        notes: [...(context?.notes ?? []), ...(collected.notes ?? [])],
    });
}
