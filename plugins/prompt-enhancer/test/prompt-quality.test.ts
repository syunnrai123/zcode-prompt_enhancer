import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildFullPrompt, MAX_PROJECT_CONTEXT_LENGTH } from '../src/core/prompt-builder.js';
import { validateEnhancedOutput } from '../src/core/output-guard.js';
import type { ProjectContext } from '../src/core/types.js';
import { TOOLS } from '../src/mcp/server.js';

function readProjectFile(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
}

interface QualityCase {
  id: string;
  draft: string;
  context?: ProjectContext;
  mustPreserve: string[];
  mustNotAdd: string[];
  allowedClarifications: string[];
  reference: string;
}

describe('enhancement policy consistency', () => {
  it('removes obsolete expansion and single-anchor contracts from all entrypoint instructions', () => {
    const files = ['commands/enhance-prompt.md', 'skills/prompt-enhancer/SKILL.md'];
    for (const file of files) {
      const text = readProjectFile(file);
      assert.doesNotMatch(text, /≤\s*1\.5|hard cap 2x|上限\s*2\s*倍|最多一个文件|at most one (?:explicit )?file\/symbol anchor/i, file);
      assert.match(text, /静默|silent internal/i, `${file}: silent context rule`);
    }
    const tool = TOOLS.find((entry) => entry.name === 'enhance_prompt')!;
    assert.match(tool.description, /Preserves task type, explicit constraints and uncertainty/);
    assert.match(tool.description, /silent internal background/);
    assert.match(tool.description, /No automatic conversation history or source bodies/);
    assert.doesNotMatch(tool.description, /1\.5x|at most one file/);
  });
});

describe('human quality evaluation fixture integrity', () => {
  it('keeps cases complete and drafts round-trippable without evaluating model semantics', () => {
    const cases = JSON.parse(readProjectFile('evals/cases.json')) as QualityCase[];
    assert.ok(Array.isArray(cases) && cases.length >= 14);
    const ids = new Set<string>();
    for (const sample of cases) {
      assert.match(sample.id, /^[a-z0-9-]+$/);
      assert.ok(!ids.has(sample.id), `duplicate case: ${sample.id}`);
      ids.add(sample.id);
      assert.ok(typeof sample.draft === 'string' && sample.draft.trim(), sample.id);
      assert.ok(typeof sample.reference === 'string' && sample.reference.trim(), sample.id);
      for (const key of ['mustPreserve', 'mustNotAdd', 'allowedClarifications'] as const) {
        assert.ok(Array.isArray(sample[key]) && sample[key].length, `${sample.id}: ${key}`);
        assert.ok(sample[key].every((item) => typeof item === 'string' && item.trim()), `${sample.id}: ${key}`);
      }
      if (sample.context) {
        const context = sample.context as Record<string, unknown>;
        const fields = ['projectType', 'projectOverview', 'techStack', 'modules', 'relevantPaths', 'directoryStructure', 'notes', 'gitChanges'];
        assert.ok(Object.keys(context).every((key) => fields.includes(key)), `${sample.id}: metadata-only fields`);
        for (const key of ['projectType', 'projectOverview']) {
          if (context[key] !== undefined) assert.equal(typeof context[key], 'string', `${sample.id}: ${key}`);
        }
        for (const key of ['techStack', 'modules', 'relevantPaths', 'directoryStructure', 'notes']) {
          if (context[key] !== undefined) {
            assert.ok(Array.isArray(context[key]) && context[key].every((item) => typeof item === 'string'), `${sample.id}: ${key}`);
          }
        }
        if (context.gitChanges !== undefined) {
          assert.ok(context.gitChanges && typeof context.gitChanges === 'object' && !Array.isArray(context.gitChanges), sample.id);
          const git = context.gitChanges as Record<string, unknown>;
          assert.ok(Object.keys(git).every((key) => ['branch', 'workingTree', 'recentCommits'].includes(key)), sample.id);
          if (git.branch !== undefined) assert.equal(typeof git.branch, 'string', sample.id);
          for (const key of ['workingTree', 'recentCommits']) {
            if (git[key] !== undefined) assert.ok(Array.isArray(git[key]) && git[key].every((item) => typeof item === 'string'), sample.id);
          }
        }
      }
      const input = JSON.parse(buildFullPrompt(sample.draft, sample.context));
      assert.equal(input.draft, sample.draft, sample.id);
      if (input.projectMetadata) assert.ok(input.projectMetadata.length <= MAX_PROJECT_CONTEXT_LENGTH, sample.id);
      assert.equal(validateEnhancedOutput(sample.reference).text, sample.reference, `${sample.id}: output formatting`);
      assert.doesNotMatch(
        sample.reference,
        /根据(?:已提供的)?项目摘要|Git\s*摘要|元数据列出的|当前输入未(?:包含|提供)|索引计数为下界/,
        `${sample.id}: reference must not leak internal metadata commentary`,
      );
    }
    const broad = cases.find((entry) => entry.id === 'broad-project-analysis-silent-context')!;
    assert.ok(broad, 'includes broad project analysis case');
    for (const leaked of ['Node.js', 'TypeScript', 'marketplace.json', 'plugins/prompt-enhancer', 'main', 'overlay.js', 'Git']) {
      assert.ok(!broad.reference.includes(leaked), `broad reference must not leak "${leaked}"`);
    }
  });
});
