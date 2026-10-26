import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnhancerError } from '../src/core/types.js';
import { OpenAiCompatibleStrategy } from '../src/strategies/openai-compatible.js';
import { resolveConfig } from '../src/config/config.js';
import type { EnhancerConfig } from '../src/core/types.js';

const CONFIG: EnhancerConfig = resolveConfig({
  PROMPT_ENHANCER_PROVIDER: 'openai-compatible',
  PROMPT_ENHANCER_API_KEY: 'test-key',
  PROMPT_ENHANCER_BASE_URL: 'https://relay.example/v1',
  PROMPT_ENHANCER_MODEL: 'test-model',
  PROMPT_ENHANCER_TIMEOUT_SECONDS: '20',
});

const SHORT_TIMEOUT_CONFIG: EnhancerConfig = { ...CONFIG, timeoutMs: 60 };

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe('OpenAiCompatibleStrategy', () => {
  it('accumulates streamed deltas into the final prompt', async () => {
    const calls: string[] = [];
    const strategy = new OpenAiCompatibleStrategy({
      id: 'openai-compatible',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(init!.body));
        return sseResponse([delta('Please '), delta('review '), delta('the parser.'), 'data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    const result = await strategy.enhance({ prompt: 'full prompt' }, CONFIG);
    assert.equal(result.enhancedPrompt, 'Please review the parser.');
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.model, 'test-model');

    const body = JSON.parse(calls[0]!) as { model: string; messages: Array<{ role: string; content: string }> };
    assert.equal(body.model, 'test-model');
    assert.equal(body.messages[0]!.role, 'system');
    assert.match(body.messages[0]!.content, /prompt optimization expert/);
    assert.equal(body.messages[1]!.content, 'full prompt');
  });

  it('retries once on a cold-start network failure', async () => {
    let attempts = 0;
    const strategy = new OpenAiCompatibleStrategy({
      id: 'glm',
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        return sseResponse([delta('ok'), 'data: [DONE]\n\n']);
      }) as typeof fetch,
    });
    const result = await strategy.enhance({ prompt: 'p' }, CONFIG);
    assert.equal(result.enhancedPrompt, 'ok');
    assert.equal(attempts, 2);
  });

  it('surfaces HTTP failures with status and truncated detail', async () => {
    const strategy = new OpenAiCompatibleStrategy({
      id: 'glm',
      fetchImpl: (async () => sseResponse(['nope'], 401)) as typeof fetch,
    });
    await assert.rejects(() => strategy.enhance({ prompt: 'p' }, CONFIG), /HTTP 401/);
  });

  it('times out a stalled stream without retrying (wall-clock budget)', async () => {
    let attempts = 0;
    const strategy = new OpenAiCompatibleStrategy({
      id: 'glm',
      // Headers arrive, then the body stalls until the abort signal fires —
      // a stub Response is not wired to the signal, so it reacts explicitly.
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        attempts += 1;
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            streamController = c;
          },
        });
        init?.signal?.addEventListener('abort', () => {
          streamController?.error(new Error('The operation was aborted.'));
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch,
    });

    await assert.rejects(
      () => strategy.enhance({ prompt: 'p' }, SHORT_TIMEOUT_CONFIG),
      (error: unknown) => {
        assert.ok(error instanceof EnhancerError);
        assert.equal(error.code, 'PROVIDER_TIMEOUT');
        return true;
      },
    );
    assert.equal(attempts, 1, 'a timeout must not be retried');
  });
});
