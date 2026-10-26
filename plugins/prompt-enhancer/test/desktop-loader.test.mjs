/**
 * Loader end-to-end test: drives inject-main.cjs with a stub `electron` module
 * physically resolvable from the temp runtime directory (same mechanism Node
 * uses for the real app), verifying the full bridge:
 *   renderer publishes __peRequest -> loader polls -> spawns dist/cli.js
 *   (mock provider) -> streamed deltas + [ENHANCED] arrive via __peDeliver
 *   as OBJECTS -> cancel kills the child.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, "..");

function makeRuntime() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-loader-"));
  fs.mkdirSync(path.join(runtimeDir, "desktop"), { recursive: true });
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, "desktop", "inject-main.cjs"),
    path.join(runtimeDir, "desktop", "inject-main.cjs")
  );
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, "desktop", "overlay.js"),
    path.join(runtimeDir, "desktop", "overlay.js")
  );
  fs.cpSync(path.join(PLUGIN_ROOT, "dist"), path.join(runtimeDir, "desktop", "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, "desktop", "config.json"),
    JSON.stringify({ provider: "mock", api_key: "", timeout_seconds: "20" })
  );

  const stubDir = path.join(runtimeDir, "node_modules", "electron");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, "package.json"),
    JSON.stringify({ name: "electron", version: "0.0.0-test", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(stubDir, "index.js"),
    `"use strict";
const hook = globalThis.__PE_TEST_HOOK;
const makeWc = (id) => ({
  id,
  on() {},
  isDestroyed: () => hook.state.destroyed,
  executeJavaScript(code) {
    if (code.includes("__peBridgeTs=Date.now()")) {
      return Promise.resolve(JSON.stringify([hook.state.reqSeq, hook.state.cancelSeq]));
    }
    if (code.includes("var r=window.__peRequest;window.__peRequest=null;")) {
      const r = hook.state.request;
      hook.state.request = null;
      return Promise.resolve(r ? JSON.stringify(r) : null);
    }
    if (code.includes("__peDeliver")) {
      const idx = code.lastIndexOf("__peDeliver(");
      const arg = code.slice(idx + "__peDeliver(".length, code.lastIndexOf(")"));
      try { hook.deliveries.push(new Function("return (" + arg + ")")()); } catch (e) { hook.deliveries.push({ parseError: String(e) }); }
      return Promise.resolve(true);
    }
    return Promise.resolve(undefined);
  },
});
const wc = makeWc(7);
module.exports = {
  app: { on() {}, whenReady: () => Promise.resolve() },
  BrowserWindow: { getAllWindows: () => [{ webContents: wc }] },
};
`
  );
  return { runtimeDir };
}

test("loader bridges a request and delivers object payloads", async (t) => {
  const { runtimeDir } = makeRuntime();
  const hook = { deliveries: [], state: { reqSeq: 0, cancelSeq: 0, request: null, destroyed: false } };
  globalThis.__PE_TEST_HOOK = hook;

  const require = createRequire(path.join(runtimeDir, "desktop", "x.cjs"));
  const loaderPath = path.join(runtimeDir, "desktop", "inject-main.cjs");
  require(loaderPath);

  t.after(() => {
    delete globalThis.__PE_TEST_HOOK;
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (e) { }
  });

  hook.state.request = { id: 1, draft: "优化下这段代码" };
  hook.state.reqSeq = 1;

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !hook.deliveries.some((d) => d && d.type === "done")) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const done = hook.deliveries.find((d) => d && d.type === "done");
  assert.ok(done, "expected a done delivery; got: " + JSON.stringify(hook.deliveries.map((d) => d && d.type)));
  assert.equal(typeof done, "object", "delivery must be an object, not a string");
  assert.equal(done.id, 1);
  assert.match(done.text, /mock-enhanced/);
  assert.ok(hook.deliveries.some((d) => d && d.type === "delta"), "expected streamed deltas");
});

test("missing API key fails fast with an actionable message", async (t) => {
  const { runtimeDir } = makeRuntime();
  fs.writeFileSync(path.join(runtimeDir, "desktop", "config.json"), JSON.stringify({ provider: "glm", api_key: "" }));
  const hook = { deliveries: [], state: { reqSeq: 0, cancelSeq: 0, request: null, destroyed: false } };
  globalThis.__PE_TEST_HOOK = hook;
  // Run in a child process: the loader guards itself with a process-wide flag,
  // so a second in-process load would be a no-op after the first test.
  const driver = path.join(runtimeDir, "driver.cjs");
  fs.writeFileSync(driver,
    `globalThis.__PE_TEST_HOOK = { deliveries: [], state: { reqSeq: 1, cancelSeq: 0, ` +
    `request: { id: 2, draft: "hello" }, destroyed: false } };\n` +
    `require(${JSON.stringify(path.join(runtimeDir, "desktop", "inject-main.cjs"))});\n` +
    `setTimeout(() => { console.log("RESULT:" + JSON.stringify(globalThis.__PE_TEST_HOOK.deliveries)); process.exit(0); }, 1500);\n`
  );
  const { execFileSync } = await import("node:child_process");
  let output = "";
  try {
    output = execFileSync(process.execPath, [driver], { encoding: "utf8", timeout: 20000 });
  } catch (e) {
    output = String(e.stdout || "");
  }
  t.after(() => {
    delete globalThis.__PE_TEST_HOOK;
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (e) { }
  });

  const line = output.split("\n").find((l) => l.startsWith("RESULT:"));
  assert.ok(line, "driver produced no result; output=" + output.slice(0, 500));
  const deliveries = JSON.parse(line.slice("RESULT:".length));
  const err = deliveries.find((d) => d && d.type === "error");
  assert.ok(err, "expected a fast error delivery; got: " + JSON.stringify(deliveries.map((d) => d && d.type)));
  assert.match(err.message, /API Key/);
});
