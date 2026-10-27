import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { collectProjectContext, parseLog, rankedStatusChanges, resolveProjectContext } from '../src/context/project-context.js';
import { createRelevanceMatcher } from '../src/context/project-summary.js';
import { buildFullPrompt, MAX_PROJECT_CONTEXT_LENGTH } from '../src/core/prompt-builder.js';

async function fixture(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pe-project-'));
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.autocrlf=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true });
}

describe('project context collection', () => {
  it('collects manifests, shallow paths and recent Git changes without file bodies', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'src', 'auth'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { run: 'THIS SCRIPT MUST NOT BE RUN' },
      dependencies: { react: '^19.0.0' }, devDependencies: { typescript: '^5.6.0' },
    }));
    await fs.writeFile(path.join(root, 'src', 'auth', 'session.ts'), 'SOURCE_BODY_NOT_ALLOWED');
    await fs.writeFile(path.join(root, '.env'), 'SECRET_NOT_ALLOWED');
    await fs.writeFile(path.join(root, '.gitignore'), '.env\nnode_modules/\n');
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'ignored.txt'), 'NOT_ALLOWED');
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'Initial auth scaffolding');
    await fs.writeFile(path.join(root, 'src', 'auth', 'session.ts'), 'CHANGED_SOURCE_NOT_ALLOWED');
    const context = await collectProjectContext(root);
    assert.ok(context.techStack?.includes('React'));
    assert.ok(context.techStack?.includes('TypeScript'));
    assert.ok(context.projectType?.includes('web application'));
    assert.ok(context.directoryStructure?.includes('src/auth/'));
    assert.ok(context.gitChanges?.workingTree?.some((line) => /M src\/auth\/session.ts/.test(line)));
    assert.ok(context.gitChanges?.recentCommits?.some((line) => line.includes('Initial auth scaffolding')));
    const text = buildFullPrompt('fix auth', context);
    assert.ok(!text.includes('SOURCE_BODY_NOT_ALLOWED'));
    assert.ok(!text.includes('SECRET_NOT_ALLOWED'));
    assert.ok(!text.includes('.env'));
    assert.ok(!text.includes('node_modules'));
    assert.ok(!text.includes('THIS SCRIPT MUST NOT BE RUN'));
    assert.ok(text.length < MAX_PROJECT_CONTEXT_LENGTH + 250);
  });

  it('handles a non-Git directory and nested project manifests', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'plugins', 'example'), { recursive: true });
    await fs.writeFile(path.join(root, 'plugins', 'example', 'package.json'), '{"devDependencies":{"typescript":"5"}}');
    const context = await collectProjectContext(root);
    assert.ok(context.techStack?.includes('TypeScript'));
    assert.equal(context.gitChanges, undefined);
    assert.match(context.notes?.join(' ') ?? '', /Git metadata unavailable/);
  });

  it('caps a large project and skips symlinked content', async (t) => {
    const root = await fixture();
    const external = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    t.after(() => fs.rm(external, { recursive: true, force: true }));
    await fs.writeFile(path.join(external, 'package.json'), '{"dependencies":{"vue":"3"}}');
    try {
      await fs.symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await Promise.all(Array.from({ length: 120 }, (_, i) => fs.writeFile(path.join(root, `file${i}.ts`), 'source')));
    const context = await collectProjectContext(root);
    assert.ok((context.directoryStructure?.length ?? 0) <= 48);
    assert.ok(!context.directoryStructure?.includes('linked/'));
    assert.ok(!context.techStack?.includes('Vue'));
    assert.ok(context.projectOverview?.includes('120 indexed files'));
  });

  it('omits oversized manifests and never executes project scripts', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'package.json'), 'x'.repeat(20_000));
    const context = await collectProjectContext(root);
    assert.equal(context.techStack, undefined);
    assert.match(context.notes?.join(' ') ?? '', /16 KiB/);
  });

  it('discovers deep modules despite hundreds of unrelated root files and prioritizes draft/Git targets', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = 'apps/payments/src/server/routes/v2/auth/login.ts';
    await fs.mkdir(path.join(root, path.posix.dirname(target)), { recursive: true });
    await fs.mkdir(path.join(root, 'services', 'search'), { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `noise${i}.txt`), 'NEVER_EMBED')));
    await fs.writeFile(path.join(root, target), 'DEEP_SOURCE_NOT_ALLOWED');
    await fs.writeFile(path.join(root, 'apps', 'payments', 'package.json'), '{"dependencies":{"react":"19"}}');
    await fs.writeFile(path.join(root, 'services', 'search', 'go.mod'), 'module example/search');
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'Add project modules');
    await fs.writeFile(path.join(root, target), 'CHANGED_BODY_NOT_ALLOWED');
    const context = await collectProjectContext(root, { prompt: `修复 ${target}` });
    assert.equal(context.relevantPaths?.[0], target);
    assert.ok(context.modules?.some((line) => line.startsWith('apps/payments/')));
    assert.ok(context.modules?.some((line) => line.startsWith('services/search/')));
    assert.ok(context.techStack?.includes('React'));
    assert.ok(context.techStack?.includes('Go'));
    assert.ok(context.projectOverview?.includes('Git path index'));
    const prompt = buildFullPrompt('修复登录', context);
    assert.ok(prompt.includes(target));
    assert.ok(!prompt.includes('BODY_NOT_ALLOWED'));
    assert.ok(!prompt.includes('NEVER_EMBED'));
  });

  it('uses a fair deeper fallback without Git and keeps a late relevant branch', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = 'zzz/login/src/server/routes/v2/handler.ts';
    await fs.mkdir(path.join(root, path.posix.dirname(target)), { recursive: true });
    await Promise.all(Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `early${i}.ts`), 'body')));
    await fs.writeFile(path.join(root, target), 'DO_NOT_EMBED');
    const context = await collectProjectContext(root, { prompt: 'fix login handler' });
    assert.ok(context.relevantPaths?.includes(target));
    assert.match(context.projectOverview ?? '', /Filesystem index/);
    assert.ok(buildFullPrompt('draft', context).includes(target));
  });

  it('scopes index, status and history to a nested workspace and excludes tracked sensitive/generated paths', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sub = path.join(root, 'packages', 'auth');
    await fs.mkdir(path.join(sub, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'other'));
    await fs.writeFile(path.join(sub, 'src', 'login.ts'), 'PRIVATE_SOURCE');
    await fs.writeFile(path.join(sub, '.env'), 'PRIVATE_KEY');
    await fs.writeFile(path.join(root, 'other', 'outside.ts'), 'OUTSIDE');
    await fs.mkdir(path.join(sub, 'dist'));
    await fs.writeFile(path.join(sub, 'dist', 'output.js'), 'OUTPUT');
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'Nested workspace');
    await fs.writeFile(path.join(sub, 'src', 'login.ts'), 'CHANGED');
    const context = await collectProjectContext(sub, { prompt: 'login' });
    const text = JSON.stringify(context);
    assert.ok(context.relevantPaths?.includes('src/login.ts'));
    assert.ok(context.gitChanges?.workingTree?.some((line) => line.includes('src/login.ts')));
    assert.ok(!text.includes('outside.ts'));
    assert.ok(!text.includes('.env'));
    assert.ok(!text.includes('dist/output.js'));
    assert.ok(!text.includes('PRIVATE'));
    assert.ok(!text.includes('packages/auth/src'));
  });

  it('reports renames with workspace-relative paths in a nested package', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sub = path.join(root, 'packages', 'auth');
    await fs.mkdir(path.join(sub, 'src'), { recursive: true });
    await fs.writeFile(path.join(sub, 'src', 'old.ts'), 'body');
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    git(root, '-C', sub, 'mv', 'src/old.ts', 'src/new.ts');
    const context = await collectProjectContext(sub, { prompt: 'fix auth' });
    assert.ok(context.gitChanges?.workingTree?.some((line) => /R\s+src\/old\.ts -> src\/new\.ts/.test(line)),
      JSON.stringify(context.gitChanges?.workingTree));
  });

  it('excludes common secret filenames while keeping lookalike source files', async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const name of ['id_rsa', 'id_ed25519.pub', '.git-credentials', 'token.ts', 'tokenizer.ts', 'safe.ts']) {
      await fs.writeFile(path.join(root, name), 'PRIVATE');
    }
    const context = await collectProjectContext(root, { prompt: 'token' });
    const text = JSON.stringify(context);
    assert.ok(text.includes('safe.ts'));
    assert.ok(text.includes('tokenizer.ts'), 'lookalike names must survive');
    for (const banned of ['id_rsa', 'id_ed25519', '.git-credentials', 'token.ts', 'PRIVATE']) {
      assert.ok(!text.includes(banned), banned);
    }
  });

  it('treats control-prefixed filenames as files, never commit headers', () => {
    const matcher = createRelevanceMatcher('');
    const hostile = parseLog('\0\x1efake header not a hash\0\0evil\x1e.ts\0\0normal.ts\0', matcher);
    assert.equal(hostile.commits.length, 0);
    assert.deepEqual(hostile.recentPaths, ['normal.ts']);
    const real = parseLog('\x1eabc123 Add feature\0\0src/a.ts\0', matcher);
    assert.equal(real.commits[0]?.title, 'abc123 Add feature');
    assert.deepEqual(real.commits[0]?.files, ['src/a.ts']);
  });

  it('precomputes relevance so huge status output ranks in milliseconds', () => {
    const matcher = createRelevanceMatcher('review the login handler module ' + 'x'.repeat(16_000));
    const raw = Array.from({ length: 10_000 }, (_, i) => `?? packages/mod${i % 50}/src/login/file${i}.ts\0`).join('');
    const start = performance.now();
    const changes = rankedStatusChanges(raw, '', matcher);
    const elapsed = performance.now() - start;
    assert.equal(changes.length, 10_000);
    assert.ok(elapsed < 800, `ranking 10000 records took ${elapsed.toFixed(0)}ms`);
  });

  it('handles missing roots and cancellation without collecting unrelated cwd', async () => {
    const missing = await collectProjectContext(path.join(os.tmpdir(), `missing-${Date.now()}`));
    assert.match(missing.notes?.join(' ') ?? '', /unavailable/);
    const relative = await collectProjectContext('.');
    assert.match(relative.notes?.join(' ') ?? '', /unavailable/);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await collectProjectContext('.', { signal: controller.signal }), { notes: ['Project collection cancelled.'] });
    assert.deepEqual(await resolveProjectContext(undefined, { projectType: 'explicit', selectedCode: 'ignored' }), {
      projectType: 'explicit', techStack: undefined, projectOverview: undefined, modules: undefined, relevantPaths: undefined,
      directoryStructure: undefined, gitChanges: undefined, notes: undefined,
    });
  });
});
