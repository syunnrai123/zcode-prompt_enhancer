import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHostPatchSource } from '../desktop/host-patch.mjs';

function wrapper(moduleUrl) {
  return new Function(buildHostPatchSource(moduleUrl) + '\nreturn __peWrapZcodeAgentService;')();
}

test('Host wrapper imports the copied ESM runtime and assembles project metadata', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-host-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  fs.cpSync(new URL('../dist', import.meta.url), path.join(runtime, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'dist', 'package.json'), '{"type":"module"}\n');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{"dependencies":{"react":"19"}}');
  let sent;
  const service = {
    existing() { return 'preserved'; },
    async generateWorkspaceText(args) { sent = args; return { text: 'Optimized prompt: complete output', finishReason: 'stop' }; },
  };
  const wrapped = wrapper(pathToFileURL(path.join(runtime, 'dist', 'desktop', 'workspace-enhancer.js')).href)(service);
  const result = await wrapped.__peGenerateWorkspaceText({ operationId: 'op', draft: 'fix', workspacePath: project });
  assert.equal(result.text, 'complete output');
  assert.equal(result.promptEnhancerProtocol, 2);
  assert.equal(result.operationId, 'op');
  assert.equal(wrapped.existing(), 'preserved');
  assert.equal(sent.operationId, undefined);
  assert.equal(sent.draft, undefined);
  assert.equal(sent.maxOutputTokens, 8192);
  const input = JSON.parse(sent.messages[1].content);
  assert.equal(input.draft, 'fix');
  assert.ok(input.projectMetadata.includes('[Tech Stack]'));
  assert.ok(input.projectMetadata.includes('React'));
});

test('Host wrapper cancellation aborts generation and disposes its operation', async () => {
  const moduleUrl = new URL('../dist/desktop/workspace-enhancer.js', import.meta.url).href;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let signal;
  const service = {
    async generateWorkspaceText(args) {
      signal = args.signal;
      began();
      return new Promise(() => {});
    },
  };
  const wrapped = wrapper(moduleUrl)(service);
  const pending = wrapped.__peGenerateWorkspaceText({ operationId: 'cancel', draft: 'fix', workspacePath: '/remote', remoteSessionId: 'r' });
  await started;
  assert.deepEqual(wrapped.__peCancelWorkspaceText({ operationId: 'cancel' }), { cancelled: true });
  await assert.rejects(pending, /取消/);
  assert.equal(signal.aborted, true);
  assert.deepEqual(wrapped.__peCancelWorkspaceText({ operationId: 'cancel' }), { cancelled: false });
});
