import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanEnhancedOutput, validateEnhancedOutput } from '../src/core/output-guard.js';

describe('validateEnhancedOutput', () => {
  it('rejects corrupted Unicode, control bytes, non-text and oversized output', () => {
    for (const invalid of ['broken\ufffd', 'x\ud800', 'x\udc00', 'x\x00', 'x'.repeat(128 * 1024 + 1), null, 123]) {
      assert.throws(() => validateEnhancedOutput(invalid), /Provider output/);
    }
    assert.throws(() => validateEnhancedOutput('```\n\n```'), /empty output/);
  });

  it('keeps valid Chinese, emoji and line breaks intact', () => {
    assert.equal(validateEnhancedOutput('修复登录 🚀\n保留行为').text, '修复登录 🚀\n保留行为');
  });
});

describe('cleanEnhancedOutput', () => {
  it('keeps clean output untouched', () => {
    const result = cleanEnhancedOutput('Please review the parser for edge cases.');
    assert.deepEqual(result, { text: 'Please review the parser for edge cases.', modified: false });
  });

  it('strips a single wrapping code fence but keeps inner fences', () => {
    const inner = 'Refactor it:\n```ts\nlet a = 1;\n```';
    const result = cleanEnhancedOutput('```\n' + inner + '\n```');
    assert.equal(result.text, inner);
    assert.equal(result.modified, true);
  });

  it('preserves multi-file lists, paragraphs, questions and explicit code examples', () => {
    const text = '只分析，不修改文件。\n\n1. 对比 src/a.ts 与 src/b.ts。\n2. 为什么 `value !== null` 仍会失败？\n\n保留以下示例：\n```ts\nconst token = process.env.API_KEY;\n```';
    assert.deepEqual(validateEnhancedOutput(text), { text, modified: false });
  });

  it('strips recognized spoken prefixes in English and Chinese', () => {
    assert.equal(cleanEnhancedOutput('Optimized prompt: do the thing').text, 'do the thing');
    assert.equal(cleanEnhancedOutput('Here is the enhanced prompt:做这件事').text, '做这件事');
    assert.equal(cleanEnhancedOutput('优化后的提示词:做这件事').text, '做这件事');
  });

  it('does not strip legitimate instructions beginning with label-like words', () => {
    for (const prompt of ['优化后端性能，保持 API 行为不变。', '增强结果缓存以减少重复请求。', 'Describe why this should remain unchanged.']) {
      assert.equal(cleanEnhancedOutput(prompt).text, prompt);
    }
  });

  it('removes trailing explanation lines', () => {
    const result = cleanEnhancedOutput('do the thing\n\nHope this helps!');
    assert.equal(result.text, 'do the thing');
    assert.equal(cleanEnhancedOutput('完成任务\n---\n以上就是优化结果').text, '完成任务');
  });

  it('unwraps a single-line fully-quoted string', () => {
    assert.equal(cleanEnhancedOutput('"do the thing"').text, 'do the thing');
  });
});
