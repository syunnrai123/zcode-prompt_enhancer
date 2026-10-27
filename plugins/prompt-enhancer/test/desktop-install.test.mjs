import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitForZCodeExit } from "../desktop/install-state.mjs";
import { ENTRY, buildArchive, readEntryTextFrom, stripInjectLines } from "../desktop/asar-lib.mjs";
import { HOST_ENTRY, applyHostPatch, isHostPatched, stripHostPatch } from "../desktop/host-patch.mjs";

const patcher = fileURLToPath(new URL("../desktop/patch-desktop.mjs", import.meta.url));
const HOST_SOURCE =
  'var dt={generateWorkspaceText:async(y)=>({text:"ok"})};' +
  'var services={register:function(c,s){return this;}};' +
  'services.register(Kr,dt);\n';

test("waits without modifying state until ZCode has exited", async () => {
  let probes = 0, waits = 0;
  await waitForZCodeExit({ isRunning: () => ++probes < 4, sleep: async () => { waits++; } });
  assert.equal(probes, 4);
  assert.equal(waits, 3);
});

test("waiting times out explicitly instead of continuing to install", async () => {
  await assert.rejects(waitForZCodeExit({ isRunning: () => true, sleep: async () => {}, timeoutMs: 2000 }), /no archive changes/);
});

test("host patch wraps only the zcode-agent registration and restores exactly", () => {
  const patched = applyHostPatch(HOST_SOURCE);
  assert.ok(isHostPatched(patched));
  assert.match(patched, /\.register\(Kr,__peWrapZcodeAgentService\(dt\)\)/);
  assert.match(patched, /__peGenerateWorkspaceText/);
  assert.match(patched, /__peCancelWorkspaceText/);
  assert.equal(stripHostPatch(patched), HOST_SOURCE);
});

test("host patch refuses an unknown bundle instead of guessing", () => {
  assert.throws(() => applyHostPatch("var other = 1;\n"), /unsupported ZCode host bundle/);
  assert.throws(() => applyHostPatch(HOST_SOURCE + "services.register(Kr,dt);\n"), /found 2/);
});

test("installer patches main and host, then remove restores both entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  const originalMain = 'console.log("fixture");\n';
  buildArchive({ [ENTRY]: Buffer.from(originalMain), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  const args = ["--asar", asar, "--runtime", runtime];
  const run = (command) => execFileSync(process.execPath, [patcher, command, ...args, "--allow-running"], { encoding: "utf8", timeout: 30000 });

  const install = run("install");
  assert.match(install, /patched out\/main\/index\.js, out\/host\/index\.js/);
  assert.ok(readEntryTextFrom(asar, ENTRY).includes("zcode-prompt-enhancer"));
  assert.ok(isHostPatched(readEntryTextFrom(asar, HOST_ENTRY)));
  for (const name of ["inject-main.cjs", "system-prompt.generated.js", "session-context.js", "host-bridge.js", "overlay.js", "dist/desktop/workspace-enhancer.js", "dist/context/project-context.js", "dist/package.json"]) {
    assert.ok(fs.existsSync(path.join(runtime, name)), name + " copied");
  }
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(runtime, "runtime-version.json"), "utf8")).version, "string");

  const doctor = run("doctor");
  assert.match(doctor, /injection: PATCHED/);
  assert.match(doctor, /host bridge: PATCHED/);
  assert.match(doctor, /runtime version:/);

  const check = run("check");
  assert.match(check, /out\/main\/index\.js: PATCHED/);
  assert.match(check, /out\/host\/index\.js host bridge: PATCHED/);

  run("remove");
  assert.equal(readEntryTextFrom(asar, ENTRY), originalMain);
  assert.equal(readEntryTextFrom(asar, HOST_ENTRY), HOST_SOURCE);
});

test("install is idempotent and updates runtime without rewriting official entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-idempotent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  buildArchive({ [ENTRY]: Buffer.from("official\n"), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  const args = ["--asar", asar, "--runtime", runtime, "--allow-running"];
  const run = (command) => execFileSync(process.execPath, [patcher, command, ...args], { encoding: "utf8", timeout: 30000 });
  run("install");
  const before = fs.statSync(asar).mtimeMs;
  const second = run("install");
  assert.match(second, /archive already patched; runtime files updated/);
  assert.equal(fs.statSync(asar).mtimeMs, before);
});
