import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnhancerError } from '../src/core/types.js';
import type { EnhancerConfig } from '../src/core/types.js';
import { resolveConfig } from '../src/config/config.js';
import { AnthropicStrategy } from '../src/strategies/anthropic.js';
import { STREAM_LIMITS } from '../src/strategies/http.js';

const CONFIG: EnhancerConfig = resolveConfig({
  PROMPT_ENHANCER_PROVIDER: 'anthropic', PROMPT_ENHANCER_API_KEY: 'test-key',
  PROMPT_ENHANCER_BASE_URL: 'https://anthropic.test', PROMPT_ENHANCER_MODEL: 'test-model',
});
const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const start = () => frame({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [], stop_reason: null } });
const block = (text = '', index = 0) => frame({ type: 'content_block_start', index, content_block: { type: 'text', text } });
const delta = (text: unknown, index = 0) => frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = (index = 0) => frame({ type: 'content_block_stop', index });
const finish = (reason: unknown = 'end_turn') => frame({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 10 } });
const stop = () => frame({ type: 'message_stop' });
const success = (text: string) => [start(), block(), delta(text), blockStop(), finish(), stop()];

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

async function rejected(chunks: readonly string[], code: EnhancerError['code'], attemptsExpected = 1) {
  let attempts = 0;
  const strategy = new AnthropicStrategy({ fetchImpl: (async () => {
    attempts += 1; return response(chunks);
  }) as typeof fetch });
  await assert.rejects(() => strategy.enhance({ prompt: 'p' }, CONFIG), expectCode(code));
  assert.equal(attempts, attemptsExpected);
}

describe('AnthropicStrategy', () => {
  it('validates Messages events and preserves request defaults, headers and public result shape', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const strategy = new AnthropicStrategy({ fetchImpl: (async (requestUrl, requestInit) => {
      url = String(requestUrl); init = requestInit;
      return response([start(), frame({ type: 'ping' }), block('Please '), delta('review '),
        delta('the parser.'), blockStop(), finish(), stop()]);
    }) as typeof fetch });
    assert.deepEqual(await strategy.enhance({ prompt: 'full prompt' }, CONFIG), {
      enhancedPrompt: 'Please review the parser.', provider: 'anthropic', model: 'test-model',
    });
    assert.equal(url, 'https://anthropic.test/v1/messages');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'test-key');
    assert.equal(headers.get('anthropic-version'), '2023-06-01');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.stream, true);
    assert.equal(body.thinking.type, 'disabled');
    assert.equal(body.messages[0].content, 'full prompt');
  });

  it('accepts CJK/emoji byte splits, correctly framed multiline JSON, multiple text blocks and stop_sequence', async () => {
    const multiline = 'event: content_block_delta\r\ndata: {"type":"content_block_delta", "index":0,\r\ndata: "delta":{"type":"text_delta", "text":"中文🙂"}}\r\n\r\n';
    const wire = start() + block() + multiline + blockStop() + block(' text', 1) + delta('!', 1) +
      blockStop(1) + finish('stop_sequence') + stop();
    const strategy = new AnthropicStrategy({ fetchImpl: (async () => response(
      Array.from(encoder.encode(wire), (byte) => Uint8Array.of(byte)))) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, '中文🙂 text!');
  });

  it('deduplicates explicit SSE ids only, preserving equal unlabelled deltas', async () => {
    const strategy = new AnthropicStrategy({ fetchImpl: (async () => response([
      start(), block(), 'id: a\n' + delta('ha'), 'id: a\n' + delta('ha'), delta('ha'), blockStop(), finish(), stop(),
    ])) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'haha');
  });

  it('retries partial EOF and mid-stream resets once with fresh message/block/text state', async () => {
    for (const reset of [false, true]) {
      let attempts = 0;
      const strategy = new AnthropicStrategy({ fetchImpl: (async () => {
        if (++attempts !== 1) return response(success('only second'));
        if (!reset) return response([start(), block(), delta('failed prefix')]);
        let step = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) {
            if (step++ === 0) c.enqueue(encoder.encode(start() + block() + delta('failed prefix')));
            else c.error(new Error('socket reset'));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch });
      assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'only second');
      assert.equal(attempts, 2);
    }
  });

  it('requires a message_stop and valid stop reason, failing premature EOF after two attempts', async () => {
    for (const chunks of [
      [start(), block(), delta('partial')],
      [start(), block(), delta('partial'), blockStop(), finish()],
      [start(), block(), delta('partial'), blockStop(), stop()],
    ]) await rejected(chunks, 'PROVIDER_UNAVAILABLE', 2);
  });

  it('rejects unsafe stop reasons, nontext blocks, malformed deltas and invalid event sequence without retry', async () => {
    for (const reason of ['max_tokens', 'tool_use', 'pause_turn', 'refusal', 'content_filter', 'unknown', 123]) {
      await rejected([start(), block(), delta('partial'), blockStop(), finish(reason), stop()], 'INVALID_OUTPUT');
    }
    for (const type of ['tool_use', 'thinking', 'redacted_thinking']) {
      await rejected([start(), frame({ type: 'content_block_start', index: 0, content_block: { type, text: '' } })], 'INVALID_OUTPUT');
    }
    for (const bad of [
      delta(123), delta({}, 0), delta('wrong index', 1),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      'event: content_block_delta\ndata: {bad json}\n\n',
      'event: wrong\ndata: {"type":"content_block_delta", "index":0, "delta":{"type":"text_delta", "text":"bad"}}\n\n',
    ]) await rejected([start(), block(), bad], 'INVALID_OUTPUT');
    for (const chunks of [
      [delta('before message')], [start(), delta('before block')], [start(), block('', 1)],
      [start(), block(), stop()], [start(), start()], [start(), block(), finish()],
      [start(), block(), delta('before'), blockStop(), finish(), delta('after')],
      [start(), 'data: [DONE]\n\n'],
    ]) await rejected(chunks, 'INVALID_OUTPUT');
  });

  it('surfaces permanent streamed errors after text and safely retries transient overloaded errors', async () => {
    await rejected([start(), block(), delta('partial'), frame({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } })], 'PROVIDER_UNAVAILABLE');
    await rejected([frame({ type: 'error', error: { type: 'overloaded_error', message: 1 } })], 'INVALID_OUTPUT');
    let attempts = 0;
    const strategy = new AnthropicStrategy({ fetchImpl: (async () => {
      if (++attempts === 1) return response([start(), block(), delta('discard'),
        frame({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } })]);
      return response(success('recovered'));
    }) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, CONFIG)).enhancedPrompt, 'recovered');
    assert.equal(attempts, 2);
  });

  it('returns at message_stop and cancels a connection that stays open, ignoring late chunks', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode(success('complete').join('') + delta('late'))); },
      cancel() { cancelled = true; },
    });
    const strategy = new AnthropicStrategy({ fetchImpl: (async () =>
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch });
    assert.equal((await strategy.enhance({ prompt: 'p' }, { ...CONFIG, timeoutMs: 200 })).enhancedPrompt, 'complete');
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });

  it('rejects completed empty and oversized output without retry', async () => {
    await rejected([start(), finish(), stop()], 'EMPTY_RESPONSE');
    await rejected(success('  '), 'EMPTY_RESPONSE');
    await rejected(success('x'.repeat(STREAM_LIMITS.outputChars + 1)), 'INVALID_OUTPUT');
  });

  it('does not retry permanent HTTP errors or deadline aborts', async () => {
    let attempts = 0;
    const permanent = new AnthropicStrategy({ fetchImpl: (async () => {
      attempts += 1; return response(['bad key'], 401);
    }) as typeof fetch });
    await assert.rejects(() => permanent.enhance({ prompt: 'p' }, CONFIG), /HTTP 401/);
    assert.equal(attempts, 1);
    attempts = 0;
    const stall = new AnthropicStrategy({ fetchImpl: (async () => {
      attempts += 1;
      return new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch });
    await assert.rejects(() => stall.enhance({ prompt: 'p' }, { ...CONFIG, timeoutMs: 35 }), expectCode('PROVIDER_TIMEOUT'));
    assert.equal(attempts, 1);
  });
});
