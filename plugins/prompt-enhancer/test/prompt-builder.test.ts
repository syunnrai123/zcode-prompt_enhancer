import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFullPrompt,
  computeMaxTokens,
  getLanguageFromPath,
  truncateText,
} from '../src/core/prompt-builder.js';
import { ENHANCE_SYSTEM_PROMPT } from '../src/core/system-prompt.js';

describe('buildFullPrompt', () => {
  it('returns the bare optimization frame without context', () => {
    const result = buildFullPrompt('fix the bug');
    assert.equal(result, 'Please optimize the following prompt:\n\nfix the bug');
  });

  it('embeds selected code with the file language', () => {
    const result = buildFullPrompt('review this', {
      selectedCode: 'const x = 1;',
      currentFile: { path: 'src/a.ts' },
    });
    assert.ok(result.includes('[User Selected Code]'));
    assert.ok(result.includes('```typescript'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('uses cursor context only when nothing is selected', () => {
    const withSelection = buildFullPrompt('p', {
      selectedCode: 'a',
      cursorContext: 'b',
      currentFile: { path: 'x.py' },
    });
    assert.ok(!withSelection.includes('[Code Around Cursor]'));

    const withoutSelection = buildFullPrompt('p', {
      cursorContext: 'def main():',
      cursorPosition: { line: 3 },
      currentFile: { path: 'x.py' },
    });
    assert.ok(withoutSelection.includes('[Code Around Cursor (line 3)]'));
    assert.ok(withoutSelection.includes('```python'));
  });

  it('adds a file content preview only when no richer context exists', () => {
    const rich = buildFullPrompt('p', {
      selectedCode: 'sel',
      currentFile: { path: 'a.js', content: 'file-body' },
    });
    assert.ok(!rich.includes('[File Content Preview]'));

    const bare = buildFullPrompt('p', { currentFile: { path: 'a.js', content: 'file-body' } });
    assert.ok(bare.includes('[File Content Preview]'));
    assert.ok(bare.includes('file-body'));
  });

  it('caps each related file and the total budget', () => {
    const long = 'x'.repeat(900);
    const result = buildFullPrompt('p', {
      relatedFiles: [
        { path: 'one.txt', content: long },
        { path: 'two.txt', content: long },
      ],
    });
    assert.ok(result.includes('- one.txt'));
    assert.ok(result.includes('- two.txt'));
    // 500-char single-file budget applies even though 900 chars were offered.
    assert.ok(!result.includes('x'.repeat(600)));
  });

  it('appends project type last', () => {
    const result = buildFullPrompt('p', { projectType: 'React app' });
    assert.ok(result.endsWith('[Project Type] React app'));
  });
});

describe('truncateText', () => {
  it('passes short text through untouched', () => {
    assert.equal(truncateText('short', 10), 'short');
  });
  it('truncates from the end marker', () => {
    const out = truncateText('0123456789', 4);
    assert.equal(out, '0123\n...');
  });
});

describe('getLanguageFromPath', () => {
  it('maps known extensions and falls back to text', () => {
    assert.equal(getLanguageFromPath('a.tsx'), 'typescript');
    assert.equal(getLanguageFromPath('a.ZSH'), 'bash');
    assert.equal(getLanguageFromPath('noext'), 'text');
    assert.equal(getLanguageFromPath(undefined), 'text');
  });
});

describe('computeMaxTokens', () => {
  it('floors at 1024 and ceilings at 4096 with the 0.8x formula', () => {
    assert.equal(computeMaxTokens(10), 1024);
    assert.equal(computeMaxTokens(2000), 1600);
    assert.equal(computeMaxTokens(999_999), 4096);
    assert.equal(computeMaxTokens(NaN), 1024);
  });
});

describe('canonical system prompt contract', () => {
  const text = ENHANCE_SYSTEM_PROMPT;

  it('enforces the brevity contract', () => {
    assert.match(text, /Brevity Contract/);
    assert.match(text, /≤1\.5x the original length/);
    assert.match(text, /hard cap 2x/);
    assert.match(text, /never pad with/);
  });

  it('restricts file references to at most one anchor', () => {
    assert.match(text, /File Reference Policy/);
    assert.match(text, /at most ONE file or symbol anchor/);
    assert.match(text, /Never enumerate multiple paths/);
    assert.match(text, /never copy code snippets into the output/);
  });

  it('keeps the language-match and output-only rules', () => {
    assert.match(text, /Chinese in, Chinese out; English in, English out/);
    assert.match(text, /Output ONLY the optimized prompt text/);
  });

  it('is lean enough to keep first-token latency low', () => {
    // Guard against accidental prompt bloat: the refined prompt must stay
    // compact (the v1 prompt it replaces was ~3.5k chars).
    assert.ok(text.length < 3600, `system prompt grew to ${text.length} chars`);
  });
});

describe('related files context', () => {
  it('keeps content only for small files; large ones contribute paths alone', () => {
    const result = buildFullPrompt('p', {
      relatedFiles: [
        { path: 'src/small.ts', content: 'export const a = 1;' },
        { path: 'src/big.ts', content: 'x'.repeat(1000) },
      ],
    });
    assert.ok(result.includes('src/small.ts'));
    assert.ok(result.includes('export const a = 1;'));
    assert.ok(result.includes('src/big.ts'));
    assert.ok(!result.includes('xxxxxxxxxx'), 'large related file content must not be embedded');
  });
});
