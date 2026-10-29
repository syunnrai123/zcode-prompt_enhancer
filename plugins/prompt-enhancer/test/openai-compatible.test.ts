import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnhancerError } from '../src/core/types.js';
import { buildFullPrompt } from '../src/core/prompt-builder.js';
import { ENHANCE_SYSTEM_PROMPT } from '../src/core/system-prompt.js';
import type { EnhancerConfig } from '../src/core/types.js';
import { OpenAiCompatibleStrategy } from '../src/strategies/openai-compatible.js';
import { resolveConfig } from '../src/config/config.js';
import { STREAM_LIMITS } from '../src/strategies/http.js';

const CONFIG: EnhancerConfig = resolveConfig({
  PROMPT_ENHANCER_PROVIDER: 'openai-compatible', PROMPT_ENHANCER_API_KEY: 'test-key',
  PROMPT_ENHANCER_BASE_URL: 'https://relay.example/v1', PROMPT_ENHANCER_MODEL: 'test-model',
  PROMPT_ENHANCER_TIMEOUT_SECONDS: '20',
});
const encoder = new TextEncoder();
const DONE = 'data: [DONE]\n\n';
const payload = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content: unknown) => payload({ choices: [{ index: 0, delta: { content } }] });
const finish = (reason: unknown = 'stop') => payload({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

function response(chunks: readonly (string | Uint8Array)[], status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      c.close();
    },
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

function expectCode(code: EnhancerError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof EnhancerError);
    assert.equal(error.code, code);
    return true;
  };
}

async function rejected(chunks: readonly string[], code: EnhancerError['code'], attemptsExpected = 1): Promise<void> {
  let attempts = 0;
  const strategy = new OpenAiCompatibleStrategy({ id: 'openai-compatible', fetchImpl: (async () => {
    attempts += 1; return response(chunks);
  }) as typeof fetch });
  await assert.rejects(() => strategy.enhance({ prompt: 'p' }, CONFIG), expectCode(code));
  assert.equal(attempts, attemptsExpected);
}

describe('OpenAiCompatibleStrategy', () => {
  it('assembles only validated text and keeps request defaults and public result shape', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const strategy = new OpenAiCompatibleStrategy({
      id: 'openai-compatible', fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return response([
          payload({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
          delta('Please '), delta('review '), delta('the parser.'), finish(),
          payload({ choices: [], usage: { total_tokens: 30 } }), DONE,
        ]);
      }) as typeof fetch,
    });
    const fullPrompt = buildFullPrompt('只分析 "src/a.ts" 和 src/b.ts\n不要修改。', {
      techStack: ['TypeScript'], notes: ['Partial metadata.'],
    });
    assert.deepEqual(await strategy.enhance({ prompt: fullPrompt }, CONFIG), {
      enhancedPrompt: 'Please review the parser.', provider: 'openai-compatible', model: 'test-model',
    });
    assert.equal(calls[0]?.url, 'https://relay.example/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.messages[0].content, ENHANCE_SYSTEM_PROMPT);
    assert.equal(body.messages[1].content, fullPrompt);
    assert.equal(JSON.parse(body.messages[1].content).draft, '只分析 "src/a.ts" 和 src/b.ts\n不要修改。');
  });

  it('accepts correctly framed multiline JSON and byte-fragmented CJK/emoji', async () => {
    const wire = 'data: {"choices": [\r\ndata: {"delta": {"content": "中文🙂"}}]}\r\n\r\n' + finish() + DONE;
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () =>
      response(Array.from(encoder.encode(wire), (byte) => Uint8Array.of(byte)))) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, '中文🙂');
  });

  it('keeps equal deltas without ids, discards genuine explicit-id replays and never appends a full snapshot twice', async () => {
    const chunks = [
      'id: first\n' + delta('ha'), 'id: first\n' + delta('ha'), delta('ha'),
      payload({ choices: [{ message: { role: 'assistant', content: 'haha' }, finish_reason: 'stop' }] }), DONE,
    ];
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () => response(chunks)) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'haha');
    await rejected([delta('one'), payload({ choices: [{ message: { content: 'different' }, finish_reason: 'stop' }] }), DONE], 'INVALID_OUTPUT');
  });

  it('allows a relay full-message snapshot only with a valid stop finish and DONE', async () => {
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () => response([
      payload({ choices: [{ message: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }] }), DONE,
    ])) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'complete');
  });

  it('retries a cold network failure once, retaining provider identity', async () => {
    let attempts = 0;
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () => {
      if (++attempts === 1) throw new TypeError('fetch failed');
      return response([delta('ok'), finish(), DONE]);
    }) as typeof fetch });
    const result = await strategy.enhance({ prompt: 'p' }, CONFIG);
    assert.equal(result.enhancedPrompt, 'ok');
    assert.equal(result.provider, 'glm');
    assert.equal(attempts, 2);
  });

  it('retries clean premature EOF or a mid-stream reset using fresh text and event-id buffers', async () => {
    for (const reset of [false, true]) {
      let attempts = 0;
      const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () => {
        if (++attempts !== 1) return response(['id: first\n' + delta('only second'), finish(), DONE]);
        if (!reset) return response(['id: first\n' + delta('failed prefix')]);
        let step = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) {
            if (step++ === 0) c.enqueue(encoder.encode('id: first\n' + delta('failed prefix')));
            else c.error(new Error('socket hang up'));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch });
      assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'only second');
      assert.equal(attempts, 2);
    }
  });

  it('rejects missing DONE, missing finish reason and unterminated terminal frames after at most one retry', async () => {
    for (const chunks of [[delta('partial')], [delta('partial'), finish()], [delta('partial'), DONE],
      [delta('partial'), finish(), 'data: [DONE]\n']]) {
      await rejected(chunks, 'PROVIDER_UNAVAILABLE', 2);
    }
  });

  it('rejects truncation, filtering, tool/function calls, refusals and malformed content without retry', async () => {
    for (const reason of ['length', 'content_filter', 'tool_calls', 'function_call', 'unknown', 123]) {
      await rejected([delta('partial'), finish(reason), DONE], 'INVALID_OUTPUT');
    }
    for (const part of [
      { content: 123 }, { content: {} }, { content: [] }, { role: 'user', content: 'bad' },
      { tool_calls: [{ id: 'call' }] }, { function_call: { name: 'tool' } }, { refusal: 'no' },
    ]) await rejected([payload({ choices: [{ delta: part }] }), finish(), DONE], 'INVALID_OUTPUT');
    for (const malformed of ['data: {bad json}\n\n', payload(null), payload([]), payload({}),
      payload({ choices: [] }), payload({ choices: [{ delta: 'bad' }] }),
      payload({ choices: [{ index: 1, delta: { content: 'bad' } }] })]) {
      await rejected([delta('before'), malformed, delta('after'), finish(), DONE], 'INVALID_OUTPUT');
    }
  });

  it('surfaces provider-streamed permanent errors after text and retries transient streamed errors with fresh text', async () => {
    await rejected([delta('partial'), 'event: error\n' + payload({ error: { type: 'authentication_error', message: 'bad key' } })], 'PROVIDER_UNAVAILABLE');
    await rejected([payload({ error: { type: 'rate_limit_error', code: 'insufficient_quota', message: 'no quota' } })], 'PROVIDER_UNAVAILABLE');
    await rejected([delta('partial'), payload({ error: { message: 1 } })], 'INVALID_OUTPUT');
    let attempts = 0;
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () => {
      if (++attempts === 1) return response([delta('discard'), payload({ error: { type: 'server_error', code: 'upstream_failed', message: 'overloaded' } })]);
      return response([delta('recovered'), finish(), DONE]);
    }) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'recovered');
    assert.equal(attempts, 2);
  });

  it('classifies HTTP failures as transient or permanent before considering retry', async () => {
    for (const status of [401, 403, 422, 408, 429, 503]) {
      let attempts = 0;
      const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () => {
        attempts += 1; return response(['nope'], status);
      }) as typeof fetch });
      await assert.rejects(() => strategy.enhance({ prompt: 'p' }, CONFIG), new RegExp(`HTTP ${status}`));
      assert.equal(attempts, status === 408 || status === 429 || status >= 500 ? 2 : 1);
    }
  });

  it('returns at DONE, cancels the still-open stream and ignores late text', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode(delta('complete') + finish() + DONE + delta('late'))); },
      cancel() { cancelled = true; },
    });
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async () =>
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, { ...CONFIG, timeoutMs: 200 })).enhancedPrompt, 'complete');
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
    await rejected([delta('before'), finish(), delta('after'), DONE], 'INVALID_OUTPUT');
  });

  it('rejects completed empty or oversized output without retry', async () => {
    await rejected([finish(), DONE], 'EMPTY_RESPONSE');
    await rejected([delta('   '), finish(), DONE], 'EMPTY_RESPONSE');
    await rejected([delta('x'.repeat(STREAM_LIMITS.outputChars + 1)), finish(), DONE], 'INVALID_OUTPUT');
  });

  it('uses one deadline across a failed attempt, retry delay and second body stall', async () => {
    let attempts = 0;
    let secondSignal: AbortSignal | null | undefined;
    const strategy = new OpenAiCompatibleStrategy({ id: 'glm', fetchImpl: (async (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        throw new TypeError('connect reset');
      }
      secondSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch });
    const start = performance.now();
    await assert.rejects(() => strategy.enhance({ prompt: 'p' }, { ...CONFIG, timeoutMs: 180 }), expectCode('PROVIDER_TIMEOUT'));
    assert.equal(attempts, 2);
    assert.equal(secondSignal?.aborted, true);
    assert.ok(performance.now() - start < 250, 'retry must not restart a full 180ms budget');
  });
});
