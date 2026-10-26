import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanEnhancedOutput } from '../src/core/output-guard.js';

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

  it('strips recognized spoken prefixes in English and Chinese', () => {
    assert.equal(cleanEnhancedOutput('Optimized prompt: do the thing').text, 'do the thing');
    assert.equal(cleanEnhancedOutput('Here is the enhanced prompt:做这件事').text, '做这件事');
    assert.equal(cleanEnhancedOutput('优化后的提示词:做这件事').text, '做这件事');
  });

  it('removes trailing explanation lines', () => {
    const result = cleanEnhancedOutput('do the thing\n\nHope this helps!');
    assert.equal(result.text, 'do the thing');
  });

  it('unwraps a single-line fully-quoted string', () => {
    assert.equal(cleanEnhancedOutput('"do the thing"').text, 'do the thing');
  });
});
