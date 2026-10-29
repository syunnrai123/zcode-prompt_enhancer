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
    assert.deepEqual(sent?.selection, { providerId: 'p', modelId: 'm' });
    const messages = sent?.messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2, 'no conversation history is implicitly added');
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
    assert.equal(messages[0]!.content, ENHANCE_SYSTEM_PROMPT);
    const input = JSON.parse(messages[1]!.content);
    assert.equal(input.draft, '修复登录');
    assert.ok(input.projectMetadata.includes('[Context Notes]'));
    assert.ok(input.projectMetadata.includes('Remote project context unavailable'));
  });

  it('leaves room for reasoning and final text even when the draft is short', async () => {
    for (const reasoningLevel of ['high', 'xhigh', 'max']) {
      const selection = { providerId: 'p', modelId: 'm', options: { reasoningLevel } };
      let calls = 0;
      const result = await enhanceWorkspaceText({ async generateWorkspaceText(args) {
        calls++;
        assert.deepEqual(args.selection, selection);
        const complete = Number(args.maxOutputTokens) >= 931 + 200;
        return {
          text: complete ? '优化后的提示词：只读分析本项目的架构与核心实现，不修改文件。' : '只读分析本项目的',
          finishReason: complete ? 'stop' : 'length',
          usage: { outputTokens: complete ? 1131 : 1024, reasoningTokens: 931 },
        };
      } }, { ...params(), draft: '分析下本项目', selection });
      assert.equal(result.text, '只读分析本项目的架构与核心实现，不修改文件。');
      assert.equal(result.finishReason, 'stop');
      assert.equal(calls, 1);
    }
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

  it('does not retry authentication failures, token truncation or malformed text', async () => {
    for (const failure of [
      new Error('HTTP 401 Unauthorized'),
      new Error('Network request returned HTTP 403 Forbidden'),
      { text: 'partial', finishReason: 'length' },
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
