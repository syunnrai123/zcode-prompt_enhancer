import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enhanceWorkspaceText, type WorkspaceTextService } from '../src/desktop/workspace-enhancer.js';
import { ENHANCE_SYSTEM_PROMPT } from '../src/core/system-prompt.js';

function params(signal = new AbortController().signal) {
  return { draft: '修复登录', workspacePath: '/remote/workspace', remoteSessionId: 'remote-1',
    selection: { providerId: 'p', modelId: 'm' }, signal };
}

describe('Host workspace enhancement', () => {
  it('uses canonical project framing and skips local collection for remote routes', async () => {
    let sent: Record<string, unknown> | undefined;
    const service: WorkspaceTextService = {
      async generateWorkspaceText(args) { sent = args; return { text: '优化后的提示词：修复登录流程', finishReason: 'stop' }; },
    };
    const result = await enhanceWorkspaceText(service, params());
    assert.equal(result.text, '修复登录流程');
    assert.equal(sent?.draft, undefined);
    assert.equal(sent?.maxOutputTokens, 8192);
    assert.ok(Number(sent?.requestTimeoutMs) > 0 && Number(sent?.requestTimeoutMs) <= 120_000);
    assert.deepEqual(sent?.selection, { providerId: 'p', modelId: 'm', options: { reasoningLevel: 'high' } });
    const messages = sent?.messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2, 'no conversation history is implicitly added');
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
    assert.equal(messages[0]!.content, ENHANCE_SYSTEM_PROMPT);
    const input = JSON.parse(messages[1]!.content);
    assert.equal(input.draft, '修复登录');
    assert.ok(input.projectMetadata.includes('[Context Notes]'));
    assert.ok(input.projectMetadata.includes('Remote project context unavailable'));
  });

  it('uses high without changing the session selection or its other options', async () => {
    for (const reasoningLevel of ['low', 'high', 'xhigh', 'max', 'enabled', 'none']) {
      const options = Object.freeze({ reasoningLevel, temperature: 0.2 });
      const selection = Object.freeze({ providerId: 'p', modelId: 'm', options });
      let calls = 0;
      const result = await enhanceWorkspaceText({ async generateWorkspaceText(args) {
        calls++;
        assert.deepEqual(args.selection, { ...selection, options: { ...options, reasoningLevel: 'high' } });
        assert.notEqual(args.selection, selection);
        const complete = Number(args.maxOutputTokens) >= 931 + 200;
        return {
          text: complete ? '优化后的提示词：只读分析本项目的架构与核心实现，不修改文件。' : '只读分析本项目的',
          finishReason: complete ? 'stop' : 'length',
          usage: { outputTokens: complete ? 1131 : 1024, reasoningTokens: 931 },
        };
      } }, { ...params(), draft: '分析下本项目', selection });
      assert.equal(result.text, '只读分析本项目的架构与核心实现，不修改文件。');
      assert.equal(result.finishReason, 'stop');
      assert.equal(selection.options.reasoningLevel, reasoningLevel);
      assert.equal(calls, 1);
    }
  });

  it('falls back in order on Host reasoning validation errors', async () => {
    const levels = ['high', 'low', 'max', 'enabled', 'none'];
    for (const [target, accepted] of levels.entries()) {
      const attempts: string[] = [];
      const input = { ...params(), selection: { providerId: 'p', modelId: 'm', options: { reasoningLevel: 'xhigh' } } };
      const result = await enhanceWorkspaceText({ async generateWorkspaceText(args) {
        const sent = args.selection as typeof input.selection;
        const level = sent.options.reasoningLevel;
        attempts.push(level);
        if (level !== accepted) {
          throw Object.assign(new Error('Reasoning level is required for p/m'), {
            code: -32603, data: { name: 'ModelProtocolError', code: 'invalid_model_request' },
          });
        }
        return { text: 'complete output', finishReason: 'stop', selection: sent };
      } }, input);
      assert.deepEqual(attempts, levels.slice(0, target + 1));
      assert.equal(result.text, 'complete output');
      assert.equal(input.selection.options.reasoningLevel, 'xhigh');
    }
  });

  it('falls back on explicit unsupported-level and provider enum errors', async () => {
    for (const error of [
      Object.assign(new Error('Reasoning effort "high" is not supported by p/m'), { name: 'ModelProtocolError', code: 'invalid_model_request' }),
      Object.assign(new Error('HTTP 400 reasoning_effort: unsupported value high'), { status: 400 }),
      Object.assign(new Error('Request failed'), { status: 422, data: { message: 'output_config.effort: invalid enum high' } }),
    ]) {
      const attempts: string[] = [];
      await enhanceWorkspaceText({ async generateWorkspaceText(args) {
        const level = (args.selection as { options: { reasoningLevel: string } }).options.reasoningLevel;
        attempts.push(level);
        if (attempts.length === 1) throw error;
        return { text: 'complete output' };
      } }, params());
      assert.deepEqual(attempts, ['high', 'low']);
    }
  });

  it('does not change reasoning levels for unrelated failures', async () => {
    for (const [error, calls] of [
      [new Error('HTTP 400 max_tokens is too large'), 1],
      [Object.assign(new Error('HTTP 401 unsupported reasoning_effort'), { status: 401 }), 1],
      [Object.assign(new Error('HTTP 429 unsupported reasoning_effort'), { status: 429 }), 2],
      [new Error('Reasoning level is required for p/another-model'), 1],
      [new Error('Reasoning effort "max" is not supported by p/m'), 1],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 2],
    ] as const) {
      const attempts: string[] = [];
      await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText(args) {
        attempts.push((args.selection as { options: { reasoningLevel: string } }).options.reasoningLevel);
        throw error;
      } }, params()), (caught) => caught === error);
      assert.deepEqual(attempts, Array(calls).fill('high'));
    }
  });

  it('fails after none without reusing the session level', async () => {
    const attempts: string[] = [];
    await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText(args) {
      attempts.push((args.selection as { options: { reasoningLevel: string } }).options.reasoningLevel);
      throw new Error('Reasoning level is required for p/m');
    } }, { ...params(), selection: { providerId: 'p', modelId: 'm', options: { reasoningLevel: 'xhigh' } } }), /不支持.*推理档位/);
    assert.deepEqual(attempts, ['high', 'low', 'max', 'enabled', 'none']);
  });

  it('keeps the fallback level for network retries and the larger output budget', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const attempts: Array<[string, unknown]> = [];
    let reset = false;
    const result = await enhanceWorkspaceText({ async generateWorkspaceText(args) {
      const level = (args.selection as { options: { reasoningLevel: string } }).options.reasoningLevel;
      attempts.push([level, args.maxOutputTokens]);
      if (level === 'high') throw new Error('Reasoning level is required for p/m');
      if (!reset) {
        reset = true;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      now += 20_000;
      assert.ok(Number(args.requestTimeoutMs) <= 120_000 - (now - 20_000));
      return args.maxOutputTokens === 8192
        ? { text: 'partial', finishReason: 'length' }
        : { text: 'complete output', finishReason: 'stop' };
    } }, params());
    assert.equal(result.text, 'complete output');
    assert.deepEqual(attempts, [['high', 8192], ['low', 8192], ['low', 8192], ['low', 16384]]);
  });

  it('cancels during reasoning fallback without trying another level', async () => {
    const controller = new AbortController();
    const attempts: string[] = [];
    await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText(args) {
      attempts.push((args.selection as { options: { reasoningLevel: string } }).options.reasoningLevel);
      controller.abort();
      throw new Error('Reasoning level is required for p/m');
    } }, params(controller.signal)), /取消/);
    assert.deepEqual(attempts, ['high']);
  });

  it('keeps the desktop generation budget bounded for short and long drafts', async () => {
    for (const draft of ['分析下本项目', 'x'.repeat(20_000)]) {
      await enhanceWorkspaceText({ async generateWorkspaceText(args) {
        assert.equal(args.maxOutputTokens, 8192);
        return { text: 'complete output', finishReason: 'stop' };
      } }, { ...params(), draft });
    }
  });

  it('does not read local paths for opaque workspace identities', async () => {
    const input = params();
    const { remoteSessionId: _remote, ...localLooking } = input;
    let messages: Array<{ content: string }> = [];
    await enhanceWorkspaceText({ async generateWorkspaceText(args) {
      messages = args.messages as Array<{ content: string }>;
      return { text: 'valid output' };
    } }, { ...localLooking, workspaceIdentity: 'unverified-identity' });
    assert.ok(messages[1]!.content.includes('Remote project context unavailable'));
  });

  it('retries one network reset without exposing failed attempt output', async () => {
    let calls = 0;
    const result = await enhanceWorkspaceText({ async generateWorkspaceText() {
      if (++calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return { text: 'second result' };
    } }, params());
    assert.equal(result.text, 'second result');
    assert.equal(calls, 2);
  });

  it('escalates a length stop once to the larger budget when the deadline allows it', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const budgets: unknown[] = [];
    const result = await enhanceWorkspaceText({ async generateWorkspaceText(args) {
      budgets.push(args.maxOutputTokens);
      now += 30_000;
      return budgets.length === 1
        ? { text: '只读分析本项目的', finishReason: 'length' }
        : { text: '优化后的提示词：只读分析本项目的架构。', finishReason: 'stop' };
    } }, params());
    assert.deepEqual(budgets, [8192, 16384]);
    assert.equal(result.text, '只读分析本项目的架构。');
  });

  it('does not escalate when the remaining deadline cannot fit a second attempt', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const budgets: unknown[] = [];
    await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText(args) {
      budgets.push(args.maxOutputTokens);
      now += 70_000;
      return { text: '只读分析本项目的', finishReason: 'length' };
    } }, params()), /未正常完成/);
    assert.deepEqual(budgets, [8192]);
  });

  it('reports the original truncation when the escalated attempt fails', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const budgets: unknown[] = [];
    await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText(args) {
      budgets.push(args.maxOutputTokens);
      now += 30_000;
      if (budgets.length > 1) throw new Error('HTTP 400 max_tokens is too large');
      return { text: '只读分析本项目的', finishReason: 'length' };
    } }, params()), /未正常完成/);
    assert.deepEqual(budgets, [8192, 16384]);
  });

  it('stops after one escalation even when the larger budget is also truncated', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const budgets: unknown[] = [];
    await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText(args) {
      budgets.push(args.maxOutputTokens);
      now += 30_000;
      return { text: '只读分析本项目的', finishReason: 'length' };
    } }, params()), /未正常完成/);
    assert.deepEqual(budgets, [8192, 16384]);
  });

  it('does not retry authentication failures, truncated flags or malformed text', async () => {
    for (const failure of [
      new Error('HTTP 401 Unauthorized'),
      new Error('Network request returned HTTP 403 Forbidden'),
      { text: 'broken\ufffd' },
      { text: 'partial', truncated: true },
      { text: 'result', error: 'stream error' },
      { text: 'result', toolCalls: [{ name: 'unwanted_tool' }] },
      { text: '  ' },
    ]) {
      let calls = 0;
      await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText() {
        calls++;
        if (failure instanceof Error) throw failure;
        return failure;
      } }, params()));
      assert.equal(calls, 1);
    }
  });

  it('honors cancellation before and during generation without a second attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(enhanceWorkspaceText({ async generateWorkspaceText() { calls++; return { text: 'bad' }; } }, params(controller.signal)), /取消/);
    assert.equal(calls, 0);

    const running = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = enhanceWorkspaceText({ async generateWorkspaceText(args) {
      calls++;
      signal = args.signal as AbortSignal;
      queueMicrotask(() => running.abort());
      return new Promise(() => {});
    } }, params(running.signal));
    await assert.rejects(pending, /取消/);
    assert.equal(calls, 1);
    assert.equal(signal?.aborted, true);
  });
});
