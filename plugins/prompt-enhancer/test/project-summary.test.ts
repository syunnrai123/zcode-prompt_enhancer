import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PathIndexReader } from '../src/context/path-index.js';
import { moduleOf, PATH_INDEX_LIMITS, relevanceScore, selectPaths, summarizePaths } from '../src/context/project-summary.js';
import { buildFullPrompt, MAX_PROJECT_CONTEXT_LENGTH } from '../src/core/prompt-builder.js';

const encoder = new TextEncoder();

describe('bounded path index', () => {
  it('preserves UTF-8 names and NUL records across every byte boundary', () => {
    const bytes = encoder.encode('packages/登录/src/处理.ts\0apps/web/route.ts\0');
    for (let split = 0; split <= bytes.length; split++) {
      const reader = new PathIndexReader(() => true);
      reader.accept(bytes.subarray(0, split));
      reader.accept(bytes.subarray(split));
      reader.finish();
      assert.deepEqual(reader.paths, ['packages/登录/src/处理.ts', 'apps/web/route.ts']);
      assert.equal(reader.partial, false);
    }
  });

  it('counts filtered records, retains complete prefixes at input limits and bounds long records', () => {
    const reader = new PathIndexReader((file) => file !== 'filtered');
    reader.accept(encoder.encode('keep.ts\0' + 'filtered\0'.repeat(PATH_INDEX_LIMITS.paths)));
    reader.finish();
    assert.deepEqual(reader.paths, ['keep.ts']);
    assert.equal(reader.stopped, true);
    assert.equal(reader.partial, true);
    const long = new PathIndexReader(() => true);
    long.accept(encoder.encode('a'.repeat(1025) + '\0next.ts\0'));
    long.finish();
    assert.deepEqual(long.paths, ['next.ts']);
    assert.equal(long.partial, true);
    const byteLimited = new PathIndexReader(() => true);
    byteLimited.accept(encoder.encode('keep.ts\0' + 'x'.repeat(PATH_INDEX_LIMITS.bytes)));
    byteLimited.finish();
    assert.deepEqual(byteLimited.paths, ['keep.ts']);
    assert.equal(byteLimited.stopped, true);
  });

  it('does not publish incomplete records or invalid UTF-8', () => {
    const reader = new PathIndexReader(() => true);
    reader.accept(encoder.encode('complete.ts\0unfinished'));
    reader.finish();
    assert.deepEqual(reader.paths, ['complete.ts']);
    assert.equal(reader.partial, true);
    const invalid = new PathIndexReader(() => true);
    invalid.accept(Uint8Array.of(0xff));
    assert.equal(invalid.partial, true);
  });
});

describe('large-project metadata selection', () => {
  it('ranks an exact path before keyword matches and supports Chinese/Windows paths', () => {
    const file = 'packages/auth/src/deep/handler.ts';
    assert.equal(selectPaths(['packages/auth/src/login.ts', file], `修改 ${file}`)[0], file);
    assert.equal(relevanceScore(file, `修改 packages\\auth\\src\\deep\\handler.ts`), 1000);
    assert.ok(relevanceScore('src/登录/处理.ts', '优化登录模块') > 0);
    assert.equal(moduleOf('packages/auth/src/deep/handler.ts'), 'packages/auth');
  });

  it('covers deep targets, change hotspots and small sibling modules among 20000 paths', () => {
    const paths = Array.from({ length: 20_000 }, (_, i) => `packages/noise${i % 20}/src/feature/file${i}.ts`);
    const target = 'apps/payments/src/server/routes/v2/auth/login.ts';
    paths.push(target, 'services/search/src/worker.py', 'docs/architecture.md');
    const summary = summarizePaths(paths, `修复 ${target}`, ['services/search/src/worker.py'], [], false, 'Git path index');
    assert.equal(summary.relevantPaths[0], target);
    for (const module of ['apps/payments', 'services/search', 'docs']) {
      assert.ok(summary.modules.some((line) => line.startsWith(module + '/')), module);
    }
    assert.ok(summary.projectOverview.includes('20003 indexed files'));
    assert.ok(summary.modules.length <= 17);
    assert.ok(summary.relevantPaths.length <= 24);
    const prompt = buildFullPrompt(`修复 ${target}`, summary);
    assert.ok(prompt.includes(target));
    assert.ok(prompt.split('It may be incomplete.\n\n')[1]!.length <= MAX_PROJECT_CONTEXT_LENGTH);
  });

  it('keeps multiple change modules and reports lower-bound counts for a truncated index', () => {
    const changes = Array.from({ length: 100 }, (_, i) => `packages/a/src/file${i}.ts`);
    changes.push('packages/b/src/change.ts', 'services/c/main.go');
    const summary = summarizePaths(changes, '', changes, [], true, 'Git path index');
    assert.ok(summary.relevantPaths.includes('packages/b/src/change.ts'));
    assert.ok(summary.relevantPaths.includes('services/c/main.go'));
    assert.match(summary.projectOverview, /partial index; counts are lower bounds/);
    assert.deepEqual(selectPaths(['src/a.ts'], ''), []);
  });
});
