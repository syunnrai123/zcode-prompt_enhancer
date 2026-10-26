/**
 * End-to-end smoke test (no network): drives the real compiled artifacts.
 *
 *  1. MCP path — spawns `node dist/index.js`, performs the initialize
 *     handshake, lists tools and calls enhance_prompt (mock provider).
 *  2. CLI path — pipes JSON into `node dist/cli.js` and checks the
 *     [CONTENT_DELTA] / [ENHANCED] marker protocol.
 *
 * Run: npm run smoke
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(root, '..');
const env = { ...process.env, PROMPT_ENHANCER_PROVIDER: 'mock' };

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

async function smokeMcp() {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'dist', 'index.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  const pending = [];
  const replies = [];
  child.stdout.setEncoding('utf8');
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      replies.push(JSON.parse(line));
      pending.shift()?.();
    }
  });

  const waitForReply = () => new Promise((resolve) => pending.push(resolve));
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitForReply();
    const init = replies[0];
    assert.equal(init.result.serverInfo.name, 'prompt-enhancer');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitForReply();
    const tools = replies[1].result.tools.map((t) => t.name);
    assert.deepEqual(tools, ['enhance_prompt', 'get_enhancer_info', 'get_enhancement_rules']);

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'enhance_prompt',
        arguments: { prompt: 'fix the login bug', context: { projectType: 'React app' } },
      },
    });
    await waitForReply();
    const call = replies[2].result;
    assert.equal(call.isError, undefined);
    assert.ok(call.content[0].text.startsWith('[mock-enhanced]'), 'enhanced text present');
    assert.match(call.content[1].text, /provider=mock/);

    console.log('[smoke] MCP path OK (initialize → tools/list → tools/call)');
  } finally {
    child.kill();
  }
}

function runCli() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, 'dist', 'cli.js')], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => {
      code === 0 ? resolve(out) : reject(new Error(`cli exited with ${code}`));
    });
    child.stdin.write(JSON.stringify({ prompt: '重构这段代码' }));
    child.stdin.end();
  });
}

async function smokeCli() {
  const out = await runCli();
  assert.match(out, /\[CONTENT_DELTA\] "/, 'progressive delta markers present');
  const final = out.match(/\[ENHANCED\](.*)\n/);
  assert.ok(final, 'final [ENHANCED] marker present');
  const wire = final[1];
  assert.ok(!wire.includes('\n'), 'wire line carries no raw newline');
  assert.ok(wire.includes('{{NEWLINE}}'), 'newlines encoded as {{NEWLINE}} on the wire');
  const text = wire.replace(/\{\{NEWLINE\}\}/g, '\n');
  assert.ok(text.includes('重构这段代码'), 'draft preserved in the enhanced output');
  console.log('[smoke] CLI path OK ([CONTENT_DELTA] + [ENHANCED] markers)');
}

try {
  await smokeMcp();
  await smokeCli();
  console.log('[smoke] ALL PASS');
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
