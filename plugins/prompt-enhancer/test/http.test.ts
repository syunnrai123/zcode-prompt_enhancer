import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import { EnhancerError } from '../src/core/types.js';
import {
  postSse, ProviderUnavailableError, STREAM_LIMITS, withColdStartRetry,
} from '../src/strategies/http.js';
import type { SseCallbacks } from '../src/strategies/http.js';

const REQUEST = { url: 'https://provider.test/stream', headers: {}, body: {}, timeoutMs: 1000 };
const NOOP: SseCallbacks = { onData() {}, onDone() {} };
const encoder = new TextEncoder();

function expectCode(code: EnhancerError['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof EnhancerError);
    assert.equal(error.code, code);
    return true;
  };
}

function response(parts: readonly (string | Uint8Array)[], status = 200, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const part of parts) c.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function stalled(init?: RequestInit, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(parts: readonly (string | Uint8Array)[]) {
  const events: Array<{ data: string; type?: string; id?: string }> = [];
  let done = 0;
  await postSse(REQUEST, {
    onData: (data, event) => { events.push({ data, ...event }); },
    onDone: () => { done += 1; },
  }, (async () => response(parts)) as typeof fetch);
  return { events, done };
}

describe('SSE event framing', () => {
  it('joins multiline data and preserves event names, ids and field whitespace at every byte boundary', async () => {
    const bytes = encoder.encode('\ufeff: keepalive\r\nevent: custom\r\nid: 7\r\ndata: 中文🙂\r\ndata:  tail \r\n\r\ndata: [DONE]\r\n\r\n');
    for (let split = 0; split <= bytes.length; split += 1) {
      const result = await collect([bytes.subarray(0, split), bytes.subarray(split)]);
      assert.deepEqual(result, { events: [{ data: '中文🙂\n tail ', type: 'custom', id: '7' }], done: 1 });
    }
  });

  it('supports byte-by-byte UTF-8, LF, CRLF and lone CR without dispatching before a blank line', async () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const bytes = encoder.encode(`data: 中文🙂${newline}${newline}data: [DONE]${newline}${newline}`);
      const result = await collect(Array.from(bytes, (byte) => Uint8Array.of(byte)));
      assert.equal(result.events[0]?.data, '中文🙂');
      assert.equal(result.done, 1);
    }
    let dispatched = false;
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (step++ === 0) c.enqueue(encoder.encode('data: one\n'));
        else {
          assert.equal(dispatched, false);
          c.enqueue(encoder.encode('data: two\n\n'));
          c.close();
        }
      },
    });
    await postSse(REQUEST, { onData: () => { dispatched = true; }, onDone() {} }, (async () =>
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch);
    assert.equal(dispatched, true);
  });

  it('ignores comments/unknown fields and handles empty data, empty ids and default event types', async () => {
    assert.deepEqual(await collect([': ping\nretry: 10\nunknown: x\n\ndata\n\nid: bad\u0000id\nevent:\ndata: x\n\nid:\ndata: y\n\n']), {
      events: [
        { data: '', type: 'message' }, { data: 'x', type: 'message' }, { data: 'y', type: 'message', id: '' },
      ], done: 0,
    });
  });

  it('deduplicates only explicit repeated ids, not equal text or inherited ids', async () => {
    const result = await collect(['id: a\ndata: same\n\nid: a\ndata: same\n\ndata: same\n\ndata: same\n\n']);
    assert.deepEqual(result.events.map((event) => event.data), ['same', 'same', 'same']);
    await assert.rejects(() => collect(['id: a\ndata: one\n\nid: a\ndata: two\n\n']), expectCode('INVALID_OUTPUT'));
  });

  it('rejects truncated events and incomplete final UTF-8 rather than delivering partial data', async () => {
    for (const part of ['data: partial', 'data: partial\n']) {
      await assert.rejects(() => collect([part]), (error: unknown) => {
        assert.ok(error instanceof ProviderUnavailableError && error.retryable);
        return true;
      });
    }
    await assert.rejects(() => collect([encoder.encode('data: '), Uint8Array.of(0xe4, 0xbd)]), (error: unknown) => {
      assert.ok(error instanceof ProviderUnavailableError && error.retryable);
      assert.match(error.message, /UTF-8/);
      return true;
    });
    await assert.rejects(() => collect([Uint8Array.of(0xff)]), expectCode('INVALID_OUTPUT'));
  });

  it('bounds individual events, total response bytes and explicit-id history', async () => {
    await assert.rejects(() => collect(['data: ' + 'x'.repeat(STREAM_LIMITS.eventChars)]), expectCode('INVALID_OUTPUT'));
    await assert.rejects(() => collect(['data: x\n'.repeat(STREAM_LIMITS.eventChars / 7)]), expectCode('INVALID_OUTPUT'));
    await assert.rejects(() => collect([new Uint8Array(STREAM_LIMITS.responseBytes + 1)]), expectCode('INVALID_OUTPUT'));
    const ids = Array.from({ length: STREAM_LIMITS.eventIds + 1 }, (_, i) => `id: ${i}\ndata: x\n\n`).join('');
    await assert.rejects(() => collect([ids]), expectCode('INVALID_OUTPUT'));
  });

  it('cancels and unlocks at DONE or a provider stop and ignores subsequent chunks', async () => {
    for (const terminal of ['data: [DONE]\n\n', 'event: message_stop\ndata: {}\n\n']) {
      let cancelled = false;
      let calls = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encoder.encode(terminal + 'data: late\n\n')); },
        cancel() { cancelled = true; },
      });
      await postSse(REQUEST, { onData: () => { calls += 1; return 'stop'; }, onDone() {} }, (async () =>
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch);
      assert.equal(cancelled, true);
      assert.equal(stream.locked, false);
      assert.equal(calls, terminal.includes('[DONE]') ? 0 : 1);
    }
  });

  it('preserves typed callback errors and cancels a failed validation stream', async () => {
    const error = new EnhancerError('INVALID_OUTPUT', 'bad content');
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode('data: {}\n\n')); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(() => postSse(REQUEST, { onData: () => { throw error; }, onDone() {} }, (async () =>
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch), (caught) => caught === error);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });
});

describe('HTTP classification and deadline', () => {
  it('times out during connect, streamed data, and an HTTP error body without retry', async () => {
    const fetches: typeof fetch[] = [
      (async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch,
      (async (_url, init) => stalled(init)) as typeof fetch,
      (async (_url, init) => stalled(init, 503)) as typeof fetch,
      (async () => stalled()) as typeof fetch, // Injection cannot bypass the wall-clock budget.
    ];
    for (const fetchImpl of fetches) {
      let attempts = 0;
      await assert.rejects(() => withColdStartRetry(async (remainingMs) => {
        attempts += 1;
        await postSse({ ...REQUEST, timeoutMs: remainingMs }, NOOP, fetchImpl);
      }, () => false, { timeoutMs: 35, retryDelayMs: 0 }), expectCode('PROVIDER_TIMEOUT'));
      assert.equal(attempts, 1);
    }
  });

  it('cancels responses from an injected fetch that resolves after its deadline', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(() => postSse({ ...REQUEST, timeoutMs: 10 }, NOOP, (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch), expectCode('PROVIDER_TIMEOUT'));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(cancelled, true);
  });

  it('retries HTTP 408/429/5xx once, never permanent 4xx, and preserves status and bounded detail', async () => {
    for (const status of [400, 401, 403, 404, 422, 408, 429, 500, 503, 529]) {
      const transient = status === 408 || status === 429 || status >= 500;
      let attempts = 0;
      await assert.rejects(() => withColdStartRetry(async (remainingMs) => {
        attempts += 1;
        await postSse({ ...REQUEST, timeoutMs: remainingMs }, NOOP, (async () => response(['x'.repeat(8000)], status)) as typeof fetch);
      }, () => false, { timeoutMs: 1000, retryDelayMs: 0 }), (error: unknown) => {
        assert.ok(error instanceof ProviderUnavailableError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, transient);
        assert.match(error.message, /x{300}\.\.\.$/);
        return true;
      });
      assert.equal(attempts, transient ? 2 : 1);
    }
  });

  it('cancels oversized diagnostic bodies and preserves a permanent status when that body resets', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode('x'.repeat(STREAM_LIMITS.errorBodyBytes + 10))); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(() => postSse(REQUEST, NOOP, (async () => new Response(stream, { status: 401 })) as typeof fetch),
      (error: unknown) => error instanceof ProviderUnavailableError && error.status === 401 && !error.retryable);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
    const reset = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('socket reset')); } });
    await assert.rejects(() => postSse(REQUEST, NOOP, (async () => new Response(reset, { status: 403 })) as typeof fetch),
      (error: unknown) => error instanceof ProviderUnavailableError && error.status === 403 && !error.retryable);
  });

  it('rejects wrong content types without retry and maps empty bodies to transient unavailable', async () => {
    let attempts = 0;
    await assert.rejects(() => withColdStartRetry(async (remainingMs) => {
      attempts += 1;
      await postSse({ ...REQUEST, timeoutMs: remainingMs }, NOOP, (async () =>
        new Response('{"choices":[]}', { headers: { 'content-type': 'application/json' } })) as typeof fetch);
    }, () => false, { timeoutMs: 1000, retryDelayMs: 0 }), expectCode('INVALID_OUTPUT'));
    assert.equal(attempts, 1);
    await assert.rejects(() => postSse(REQUEST, NOOP, (async () => new Response(null)) as typeof fetch),
      (error: unknown) => error instanceof ProviderUnavailableError && error.retryable);
  });
});

describe('withColdStartRetry shared budget', () => {
  it('passes only the remaining budget after a transient attempt and backoff', async () => {
    let time = 0;
    const budgets: number[] = [];
    const delays: number[] = [];
    const result = await withColdStartRetry(async (remainingMs) => {
      budgets.push(remainingMs);
      if (budgets.length === 1) {
        time += 40;
        throw new ProviderUnavailableError('reset', { retryable: true });
      }
      time += 49;
      return 'ok';
    }, () => false, {
      timeoutMs: 100, retryDelayMs: 10, now: () => time,
      sleep: async (ms) => { delays.push(ms); time += ms; },
    });
    assert.equal(result, 'ok');
    assert.deepEqual(budgets, [100, 50]);
    assert.deepEqual(delays, [10]);
  });

  it('does not retry timeout, invalid output, permanent errors, arbitrary errors or published content', async () => {
    for (const error of [
      new EnhancerError('PROVIDER_TIMEOUT', 'timeout'), new EnhancerError('INVALID_OUTPUT', 'invalid'),
      new ProviderUnavailableError('auth', { retryable: false }), new Error('programming error'),
    ]) {
      let attempts = 0;
      await assert.rejects(() => withColdStartRetry(async () => {
        attempts += 1; throw error;
      }, () => false, { retryDelayMs: 0 }), (caught) => caught === error);
      assert.equal(attempts, 1);
    }
    let attempts = 0;
    await assert.rejects(() => withColdStartRetry(async () => {
      attempts += 1; throw new ProviderUnavailableError('reset', { retryable: true });
    }, () => true), expectCode('PROVIDER_UNAVAILABLE'));
    assert.equal(attempts, 1);
  });

  it('limits retries to two attempts and never starts one after the shared deadline', async () => {
    let attempts = 0;
    await assert.rejects(() => withColdStartRetry(async () => {
      attempts += 1; throw new ProviderUnavailableError('reset', { retryable: true });
    }, () => false, { retryDelayMs: 0 }), expectCode('PROVIDER_UNAVAILABLE'));
    assert.equal(attempts, 2);
    let time = 0;
    attempts = 0;
    await assert.rejects(() => withColdStartRetry(async () => {
      attempts += 1; time = 100; throw new ProviderUnavailableError('reset', { retryable: true });
    }, () => false, { timeoutMs: 100, now: () => time }), expectCode('PROVIDER_TIMEOUT'));
    assert.equal(attempts, 1);
  });

  it('honors Retry-After within the deadline and skips a retry whose delay cannot fit', async () => {
    for (const retryAfterMs of [30, 101]) {
      let time = 0;
      let attempts = 0;
      const delays: number[] = [];
      const run = () => withColdStartRetry(async () => {
        attempts += 1;
        if (attempts === 1) throw new ProviderUnavailableError('rate limit', { retryable: true, retryAfterMs });
        return 'ok';
      }, () => false, {
        timeoutMs: 100, retryDelayMs: 0, now: () => time,
        sleep: async (ms) => { delays.push(ms); time += ms; },
      });
      if (retryAfterMs > 100) {
        await assert.rejects(run, expectCode('PROVIDER_UNAVAILABLE'));
        assert.equal(attempts, 1);
        assert.deepEqual(delays, []);
      } else {
        assert.equal(await run(), 'ok');
        assert.equal(attempts, 2);
        assert.deepEqual(delays, [30]);
      }
    }
    await assert.rejects(() => postSse(REQUEST, NOOP, (async () => response(['busy'], 429, { 'retry-after': '2' })) as typeof fetch),
      (error: unknown) => error instanceof ProviderUnavailableError && error.retryAfterMs === 2000);
  });
});

async function withLoopback(handler: (res: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => { req.resume(); handler(res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}/stream`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('native fetch loopback cleanup', () => {
  it('aborts a real post-header body stall and closes the server connection', { timeout: 3000 }, async () => {
    let closed!: () => void;
    const closure = new Promise<void>((resolve) => { closed = resolve; });
    await withLoopback((res) => {
      res.on('close', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    }, async (url) => {
      await assert.rejects(() => postSse({ ...REQUEST, url, timeoutMs: 100 }, NOOP), expectCode('PROVIDER_TIMEOUT'));
      await closure;
    });
  });

  it('surfaces a real mid-body reset rather than treating the received prefix as success', { timeout: 3000 }, async () => {
    let text = '';
    await withLoopback((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: prefix\n\n');
      const timer = setTimeout(() => res.destroy(), 25);
      res.on('close', () => clearTimeout(timer));
    }, async (url) => {
      await assert.rejects(() => postSse({ ...REQUEST, url }, { onData: (data) => { text += data; }, onDone() {} }),
        (error: unknown) => error instanceof ProviderUnavailableError && error.retryable);
      assert.equal(text, 'prefix');
    });
  });

  it('returns at semantic DONE and closes a real connection that would otherwise stay open', { timeout: 3000 }, async () => {
    let closed!: () => void;
    const closure = new Promise<void>((resolve) => { closed = resolve; });
    let done = false;
    await withLoopback((res) => {
      res.on('close', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: [DONE]\n\n');
    }, async (url) => {
      await postSse({ ...REQUEST, url }, { onData() {}, onDone: () => { done = true; } });
      assert.equal(done, true);
      await closure;
    });
  });
});
