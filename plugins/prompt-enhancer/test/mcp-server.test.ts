import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleMessage } from '../src/mcp/server.js';
import { parseMessage } from '../src/mcp/stdio.js';
import { PromptEnhancerService } from '../src/core/enhancer.js';
import { ProviderStrategyRegistry } from '../src/strategies/provider-strategy.js';
import { MockStrategy } from '../src/strategies/mock.js';
import { resolveConfig } from '../src/config/config.js';

function deps() {
  const enhancer = new PromptEnhancerService(
    new ProviderStrategyRegistry().register(new MockStrategy()),
    resolveConfig({ PROMPT_ENHANCER_PROVIDER: 'mock' }),
  );
  return { enhancer };
}

function msg(method: string, params?: unknown, id: string | number = 1) {
  return parseMessage(JSON.stringify({ jsonrpc: '2.0', id, method, params }))!;
}

describe('MCP dispatch', () => {
  it('answers initialize with protocol info', async () => {
    const reply = await handleMessage(msg('initialize'), deps());
    assert.equal(reply?.jsonrpc, '2.0');
    const result = reply!.result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(result.protocolVersion, '2024-11-05');
    assert.equal(result.serverInfo.name, 'prompt-enhancer');
  });

  it('lists all four tools with project-only schemas', async () => {
    const reply = await handleMessage(msg('tools/list'), deps());
    const tools = (reply!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.deepEqual(tools, ['enhance_prompt', 'get_project_context', 'get_enhancer_info', 'get_enhancement_rules']);
  });

  it('calls enhance_prompt and returns content blocks', async () => {
    const reply = await handleMessage(
      msg('tools/call', {
        name: 'enhance_prompt',
        arguments: { prompt: 'fix the login bug', context: { projectType: 'React app' } },
      }),
      deps(),
    );
    const result = reply!.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.startsWith('[mock-enhanced]'));
    assert.match(result.content[1]!.text, /provider=mock/);
  });

  it('drops legacy editor state before invoking the enhancer', async () => {
    const reply = await handleMessage(msg('tools/call', { name: 'enhance_prompt', arguments: {
      prompt: 'review auth', context: {
        techStack: ['React'], directoryStructure: ['src/auth/'],
        gitChanges: { workingTree: ['M src/auth/session.ts'] },
        selectedCode: 'EDITOR_SECRET', cursorContext: 'EDITOR_SECRET',
        currentFile: { content: 'EDITOR_SECRET' },
      },
    } }), deps());
    const text = (reply!.result as { content: Array<{ text: string }> }).content[0]!.text;
    assert.ok(text.includes('React'));
    assert.ok(text.includes('[Recent Git Changes]'));
    assert.ok(!text.includes('EDITOR_SECRET'));
  });

  it('gets project metadata without a configured provider and rejects unspecified roots', async () => {
    const reply = await handleMessage(msg('tools/call', { name: 'get_project_context', arguments: {} }), deps());
    assert.equal((reply!.result as { isError?: boolean }).isError, true);
    const info = await handleMessage(msg('tools/call', { name: 'get_project_context', arguments: { workspacePath: '/pe-definitely-missing' } }), deps());
    const result = info!.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /Project directory is unavailable/);
  });

  it('reports tool-level errors with isError instead of a protocol error', async () => {
    const reply = await handleMessage(
      msg('tools/call', { name: 'enhance_prompt', arguments: { prompt: '' } }),
      deps(),
    );
    const result = reply!.result as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /EMPTY_PROMPT/);
  });

  it('exposes the canonical rules for agent-side enhancement', async () => {
    const reply = await handleMessage(msg('tools/call', { name: 'get_enhancement_rules' }), deps());
    const text = (reply!.result as { content: Array<{ text: string }> }).content[0]!.text;
    assert.match(text, /Output Rules/);
    assert.match(text, /Brevity Contract/);
    assert.match(text, /File Reference Policy/);
    assert.match(text, /Chinese in, Chinese out; English in, English out/);
  });

  it('returns null for notifications and METHOD_NOT_FOUND for unknown methods', async () => {
    const notification = parseMessage(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )!;
    assert.equal(notification.id, null);
    assert.equal(await handleMessage(notification, deps()), null);

    const unknown = (await handleMessage(msg('no/such/method'), deps()))!;
    assert.equal(unknown.error!.code, -32601);
  });
});
