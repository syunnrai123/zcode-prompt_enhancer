import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectProjectContext } from '../dist/context/project-context.js';
import { buildFullPrompt } from '../dist/core/prompt-builder.js';
import { summarizePaths } from '../dist/context/project-summary.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-large-bench-'));
const target = 'apps/payments/src/server/routes/v2/auth/login.ts';
const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
try {
  await fs.mkdir(path.join(root, path.posix.dirname(target)), { recursive: true });
  await fs.writeFile(path.join(root, target), 'BENCH_SOURCE_NOT_SENT');
  await fs.writeFile(path.join(root, 'package.json'), '{"workspaces":["apps/*","packages/*"]}');
  await fs.writeFile(path.join(root, 'apps', 'payments', 'package.json'), '{"dependencies":{"react":"19"}}');
  await Promise.all(Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `noise${i}.txt`), 'body')));
  git('init', '-q');
  git('add', '.');
  const blob = git('hash-object', '-w', '--stdin').trim();
  const indexed = Array.from({ length: 20_000 }, (_, i) => `packages/module${i % 40}/src/features/deep/file${i}.ts`);
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], {
    input: indexed.map((file) => `100644 ${blob}\t${file}\n`).join(''), encoding: 'utf8', timeout: 30_000,
  });
  // Synthetic index entries are deliberately not materialized source files.
  git('commit', '-q', '-m', 'Synthetic large path index');
  const start = performance.now();
  const context = await collectProjectContext(root, { prompt: `修复 ${target}` });
  const elapsed = performance.now() - start;
  const fullPrompt = buildFullPrompt(`修复 ${target}`, context);
  assert.ok(context.relevantPaths?.includes(target));
  assert.ok(fullPrompt.includes(target));
  assert.ok(JSON.parse(fullPrompt).projectMetadata.length <= 6000);
  assert.ok(!fullPrompt.includes('BENCH_SOURCE_NOT_SENT'));
  const sampleStart = performance.now();
  summarizePaths([...indexed, target], `修复 ${target}`, [], [], false, 'Synthetic index');
  const selectionMs = performance.now() - sampleStart;
  console.log(JSON.stringify({
    fixture: 'Synthetic Git index, 20000 virtual tracked paths plus 303 real files',
    projectOverview: context.projectOverview,
    moduleSummaries: context.modules?.length,
    relevantPaths: context.relevantPaths?.length,
    explicitDeepTargetRetained: true,
    contextChars: JSON.parse(fullPrompt).projectMetadata.length,
    collectionMs: Number(elapsed.toFixed(1)),
    pathSelectionMs: Number(selectionMs.toFixed(1)),
    notes: context.notes,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
