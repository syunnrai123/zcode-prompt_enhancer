/**
 * Loader test: drives inject-main.cjs with a stub `electron` module and
 * verifies the renderer script bundle is injected in dependency order, on
 * first attach and again after navigation, and that a missing script is
 * reported without injecting partial code.
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
const SCRIPTS = ["system-prompt.generated.js", "session-context.js", "host-bridge.js", "overlay.js"];

function makeRuntime() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-loader-"));
  fs.mkdirSync(path.join(runtimeDir, "desktop"), { recursive: true });
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, "desktop", "inject-main.cjs"),
    path.join(runtimeDir, "desktop", "inject-main.cjs")
  );
  for (const name of SCRIPTS) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, "desktop", name), path.join(runtimeDir, "desktop", name));
  }
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
const listeners = {};
const wc = {
  id: 7,
  on(name, fn) { (listeners[name] ||= []).push(fn); },
  isDestroyed: () => false,
  executeJavaScript(code) { hook.injected.push(code); return Promise.resolve(true); },
  fire(name) { for (const fn of listeners[name] || []) fn(); },
};
globalThis.__PE_TEST_WC = wc;
module.exports = {
  app: { on() {}, whenReady: () => Promise.resolve() },
  BrowserWindow: { getAllWindows: () => [{ webContents: wc }] },
};
`
  );
  return { runtimeDir };
}

test("injects every renderer script in order and re-injects after navigation", async (t) => {
  const { runtimeDir } = makeRuntime();
  const hook = { injected: [] };
  globalThis.__PE_TEST_HOOK = hook;

  const require = createRequire(path.join(runtimeDir, "desktop", "x.cjs"));
  require(path.join(runtimeDir, "desktop", "inject-main.cjs"));
  await new Promise((resolve) => setTimeout(resolve, 100));

  t.after(() => {
    delete globalThis.__PE_TEST_HOOK;
    delete globalThis.__PE_TEST_WC;
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (e) { }
  });

  assert.equal(hook.injected.length, 1, "one batched injection");
  const code = hook.injected[0];
  const markers = ["__PE_SYSTEM_PROMPT", "__peGetSessionContext", "__peHostBridge", "pe-overlay-style"];
  for (const marker of markers) assert.ok(code.includes(marker), marker + " content missing");
  const order = markers.map((marker) => code.indexOf(marker));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "scripts must load in dependency order");

  globalThis.__PE_TEST_WC.fire("did-finish-load");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hook.injected.length, 2, "navigation re-injects");
});

test("missing script reports through loader.log and does not inject partial code", async (t) => {
  const { runtimeDir } = makeRuntime();
  fs.rmSync(path.join(runtimeDir, "desktop", "host-bridge.js"));
  const driver = path.join(runtimeDir, "driver.cjs");
  fs.writeFileSync(
    driver,
    `globalThis.__PE_TEST_HOOK = { injected: [] };\n` +
    `require(${JSON.stringify(path.join(runtimeDir, "desktop", "inject-main.cjs"))});\n` +
    `setTimeout(() => process.exit(0), 200);\n`
  );
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [driver], { stdio: "pipe", timeout: 20000 });
  t.after(() => {
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (e) { }
  });
  const log = fs.readFileSync(path.join(runtimeDir, "desktop", "loader.log"), "utf8");
  assert.match(log, /script unavailable: host-bridge\.js/);
  assert.doesNotMatch(log, /scripts injected/);
});
