import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnhancerError } from '../src/core/types.js';
import { postSse, withColdStartRetry } from '../src/strategies/http.js';

function expectCode(code: EnhancerError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof EnhancerError, `expected EnhancerError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

/**
 * Response whose body never yields data. Mirrors what real fetch does when the
 * request's AbortController fires: pending read()s reject. (A stub Response
 * built by hand is NOT wired to the signal, so the stub does it explicitly.)
 */
function stalledStreamResponse(init?: RequestInit): Response {
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
}

const NOOP_CALLBACKS = { onData() {}, onDone() {} };

describe('postSse wall-clock timeout', () => {
  it('times out when the SSE body stalls after headers', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      stalledStreamResponse(init)) as typeof fetch;

    await assert.rejects(
      () =>
        postSse(
          { url: 'https://provider.test/v1/chat/completions', headers: {}, body: {}, timeoutMs: 50 },
          NOOP_CALLBACKS,
          fetchImpl,
        ),
      expectCode('PROVIDER_TIMEOUT'),
    );
  });

  it('maps a connect-stage abort to PROVIDER_TIMEOUT', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    await assert.rejects(
      () =>
        postSse(
          { url: 'https://provider.test/v1/chat/completions', headers: {}, body: {}, timeoutMs: 30 },
          NOOP_CALLBACKS,
          fetchImpl,
        ),
      expectCode('PROVIDER_TIMEOUT'),
    );
  });

  it('maps a non-abort stream failure to PROVIDER_UNAVAILABLE', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error('socket hang up'));
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

    await assert.rejects(
      () =>
        postSse(
          { url: 'https://provider.test/v1/chat/completions', headers: {}, body: {}, timeoutMs: 1000 },
          NOOP_CALLBACKS,
          fetchImpl,
        ),
      expectCode('PROVIDER_UNAVAILABLE'),
    );
  });
});

describe('withColdStartRetry', () => {
  it('does not retry PROVIDER_TIMEOUT (a retry would double the wall-clock wait)', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withColdStartRetry(async () => {
          attempts += 1;
          throw new EnhancerError('PROVIDER_TIMEOUT', 'request aborted');
        }, () => false),
      /request aborted/,
    );
    assert.equal(attempts, 1);
  });

  it('still retries other cold-start failures once', async () => {
    let attempts = 0;
    const result = await withColdStartRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('fetch failed');
      return 'ok';
    }, () => false);
    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
  });

  it('never retries once content has been received', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withColdStartRetry(async () => {
          attempts += 1;
          throw new EnhancerError('PROVIDER_UNAVAILABLE', 'mid-stream failure');
        }, () => true),
      /mid-stream failure/,
    );
    assert.equal(attempts, 1);
  });
});
