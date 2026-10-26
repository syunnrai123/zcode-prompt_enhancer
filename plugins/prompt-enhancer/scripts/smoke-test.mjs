/**
 * End-to-end smoke test (no network): drives the real compiled artifacts.
 *
 *  1. MCP path — spawns `node dist/index.js`, performs the initialize
 *     handshake, lists tools and calls enhance_prompt (mock provider).
 *  2. CLI path — pipes JSON into `node dist/cli.js` and checks the
 *     [CONTENT_DELTA] / [ENHANCED] marker protocol, plus the empty-draft case.
 *  3. Consistency — the shipped artifacts agree with package.json: the MCP
 *     serverInfo version, desktop/system-prompt.generated.js and the overlay
 *     VERSION stamp must all match the manifest. Catches "edited src, forgot
 *     npm run build" for the version/generated-file class of drift.
 *
 * Run: npm run smoke
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(root, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
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
    return init.result.serverInfo;
  } finally {
    child.kill();
  }
}

function runCli(payload) {
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
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function smokeCli() {
  const out = await runCli({ prompt: '重构这段代码' });
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

async function smokeCliEmptyDraft() {
  const out = await runCli({});
  assert.equal(
    out.trim(),
    '[ENHANCED]',
    'empty draft yields exactly one [ENHANCED] marker (no [ENHANCED_ERROR], no retry)',
  );
  console.log('[smoke] CLI empty-draft path OK (single [ENHANCED] marker)');
}

async function smokeConsistency(serverInfo) {
  assert.equal(serverInfo.version, pkg.version, 'dist/index.js reports package.json version');

  const { ENHANCE_SYSTEM_PROMPT } = await import(
    pathToFileURL(path.join(pluginRoot, 'dist', 'core', 'system-prompt.js')).href
  );
  const generated = fs.readFileSync(
    path.join(pluginRoot, 'desktop', 'system-prompt.generated.js'),
    'utf8',
  );
  assert.ok(
    generated.includes(JSON.stringify(ENHANCE_SYSTEM_PROMPT)),
    'desktop/system-prompt.generated.js matches dist rules (run npm run build)',
  );

  const overlay = fs.readFileSync(path.join(pluginRoot, 'desktop', 'overlay.js'), 'utf8');
  const match = overlay.match(/var VERSION = "([^"]*)";/);
  assert.ok(match, 'overlay.js carries a VERSION stamp');
  assert.equal(match[1], pkg.version, 'overlay VERSION matches package.json (run npm run build)');

  console.log(`[smoke] consistency OK (all artifacts report v${pkg.version})`);
}

try {
  const serverInfo = await smokeMcp();
  await smokeCli();
  await smokeCliEmptyDraft();
  await smokeConsistency(serverInfo);
  console.log('[smoke] ALL PASS');
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
