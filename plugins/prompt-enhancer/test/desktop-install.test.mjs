import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitForZCodeExit } from "../desktop/install-state.mjs";
import { ENTRY, FUSE_SENTINEL, buildArchive, readEntryTextFrom, stripInjectLines } from "../desktop/asar-lib.mjs";
import { HOST_ENTRY, applyHostPatch, isHostPatched, stripHostPatch, hostPatchedVariant, deriveRegistrationVariant, resolveRegistration } from "../desktop/host-patch.mjs";

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

test("host patch wraps the @zcode/desktop 3.17 registration (er,at) and restores exactly", () => {
  const NEXT_SOURCE =
    'var at={generateWorkspaceText:async(y)=>({text:"ok"})};' +
    'var services={register:function(c,s){return this;}};' +
    'services.register(er,at);\n';
  const patched = applyHostPatch(NEXT_SOURCE);
  assert.ok(isHostPatched(patched));
  assert.match(patched, /\.register\(er,__peWrapZcodeAgentService\(at\)\)/);
  assert.equal(stripHostPatch(patched), NEXT_SOURCE);
});

test("host patch wraps the @zcode/desktop 3.17.2 registration (tr,ct) and restores exactly", () => {
  const NEXT_SOURCE =
    'var ct={generateWorkspaceText:async(y)=>({text:"ok"})};' +
    'var services={register:function(c,s){return this;}};' +
    'services.register(tr,ct);\n';
  const patched = applyHostPatch(NEXT_SOURCE);
  assert.ok(isHostPatched(patched));
  assert.match(patched, /\.register\(tr,__peWrapZcodeAgentService\(ct\)\)/);
  assert.equal(stripHostPatch(patched), NEXT_SOURCE);
});

test("host patch refuses an unknown bundle instead of guessing", () => {
  assert.throws(() => applyHostPatch("var other = 1;\n"), /unsupported ZCode host bundle/);
  assert.throws(() => applyHostPatch(HOST_SOURCE + "services.register(Kr,dt);\n"), /found 2/);
});

/* Shaped like a future release: neither minified identifier is in the literal
 * list, so the anchor can only come from auto-detection. */
const FUTURE_HOST_SOURCE =
  'function mk(){return{prepareStorage:1,async generateWorkspaceText(y){return{text:"ok"}}};}' +
  'var zz=Ne(Se.ZCodeAgent);' +
  'var yy=mk({option:1});' +
  'var services={register:function(c,s){return this;}};' +
  'services.register(zz,yy);\n';

test("auto-detects a renamed registration anchor from the ZCodeAgent token", () => {
  assert.equal(deriveRegistrationVariant(FUTURE_HOST_SOURCE), ".register(zz,yy)");
  assert.deepEqual(resolveRegistration(FUTURE_HOST_SOURCE), { variant: ".register(zz,yy)", source: "derived" });
  const patched = applyHostPatch(FUTURE_HOST_SOURCE);
  assert.ok(isHostPatched(patched));
  assert.match(patched, /\.register\(zz,__peWrapZcodeAgentService\(yy\)\)/);
  assert.equal(stripHostPatch(patched), FUTURE_HOST_SOURCE);
});

test("auto-detection refuses two equally plausible registrations", () => {
  const ambiguous =
    'function mk(){return{async generateWorkspaceText(){return{text:"a"}}};}' +
    'var a=Ne(Se.ZCodeAgent),b=Ne(Se.ZCodeAgent);' +
    'var s1=mk(),s2=mk();' +
    'var services={register:function(c,s){return this;}};' +
    'services.register(a,s1);services.register(b,s2);\n';
  assert.equal(deriveRegistrationVariant(ambiguous), null);
});

test("auto-detection refuses a service that is not a factory result", () => {
  const direct =
    'var tr=Ne(Se.ZCodeAgent);' +
    'var ct={async generateWorkspaceText(){return{text:"a"}}};' +
    'services.register(tr,ct);\n';
  assert.equal(deriveRegistrationVariant(direct), null);
});

test("strip unwraps any anchor, including one outside the literal list", () => {
  const wrapped = "services.register(zz,__peWrapZcodeAgentService(yy));";
  assert.equal(hostPatchedVariant(wrapped), ".register(zz,yy)");
  assert.equal(stripHostPatch(wrapped), "services.register(zz,yy);");
});

test("ensure patches an official archive, then leaves a patched one untouched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-ensure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  buildArchive({ [ENTRY]: Buffer.from('console.log("fixture");\n'), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  const env = { ...process.env, ZCODE_PE_NO_AUTOSTART: "1" };
  const run = (command) =>
    execFileSync(process.execPath, [patcher, command, "--asar", asar, "--runtime", runtime, "--allow-running"], { encoding: "utf8", timeout: 30000, env });

  const first = run("ensure");
  assert.match(first, /official/);
  assert.ok(isHostPatched(readEntryTextFrom(asar, HOST_ENTRY)));
  assert.ok(readEntryTextFrom(asar, ENTRY).includes("zcode-prompt-enhancer"));

  const before = fs.readFileSync(asar);
  const second = run("ensure");
  assert.match(second, /nothing to do/);
  assert.ok(fs.readFileSync(asar).equals(before), "ensure must not rewrite a patched archive");

  // The scheduled task runs ensure hidden, with no stdout to inherit: the
  // decision has to survive in install.log, timestamped, or a missed repair
  // leaves no evidence at all.
  const log = fs.readFileSync(path.join(runtime, "install.log"), "utf8");
  assert.match(log, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[zcode-prompt-enhancer\] ensure: app\.asar is official/m);
  assert.match(log, /\[zcode-prompt-enhancer\] ensure: patching now\./);
  assert.match(log, /\[zcode-prompt-enhancer\] ensure: already patched and runtime is current; nothing to do\./);
  assert.match(first, /^\d{4}-\d{2}-\d{2}T\S+ \[zcode-prompt-enhancer\] ensure: /m, "stdout lines carry the timestamp too");
});

test("installer patches main and host, then remove restores both entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  const originalMain = 'console.log("fixture");\n';
  buildArchive({ [ENTRY]: Buffer.from(originalMain), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  const args = ["--asar", asar, "--runtime", runtime];
  // Never touch the real Task Scheduler / Startup folder from a test run.
  const env = { ...process.env, ZCODE_PE_NO_AUTOSTART: "1" };
  const run = (command) => execFileSync(process.execPath, [patcher, command, ...args, "--allow-running"], { encoding: "utf8", timeout: 30000, env });

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

test("remove cancels a background installer that is still waiting", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  buildArchive({ [ENTRY]: Buffer.from("official\n"), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  fs.mkdirSync(runtime, { recursive: true });
  const statusPath = path.join(runtime, "install-status.json");
  fs.writeFileSync(statusPath, JSON.stringify({ state: "waiting", pid: process.pid, version: "0.0.5" }));

  execFileSync(process.execPath, [patcher, "remove", "--asar", asar, "--runtime", runtime, "--allow-running"], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ZCODE_PE_NO_AUTOSTART: "1" },
  });

  assert.equal(JSON.parse(fs.readFileSync(statusPath, "utf8")).state, "cancelled");
});

test("install is idempotent and updates runtime without rewriting official entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-idempotent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  buildArchive({ [ENTRY]: Buffer.from("official\n"), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  const args = ["--asar", asar, "--runtime", runtime, "--allow-running"];
  const env = { ...process.env, ZCODE_PE_NO_AUTOSTART: "1" };
  const run = (command) => execFileSync(process.execPath, [patcher, command, ...args], { encoding: "utf8", timeout: 30000, env });
  run("install");
  const before = fs.statSync(asar).mtimeMs;
  const second = run("install");
  assert.match(second, /archive already patched; runtime files updated/);
  assert.equal(fs.statSync(asar).mtimeMs, before);
});

test("installer refuses to patch when the asar-integrity fuse is enabled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-fuse-refuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const asar = path.join(resources, "app.asar");
  buildArchive({ [ENTRY]: Buffer.from("official\n"), [HOST_ENTRY]: Buffer.from(HOST_SOURCE) }, asar);
  // Electron fuse wire: sentinel + version byte + one state byte per fuse,
  // EnableEmbeddedAsarIntegrityValidation (index 4) = 1.
  fs.writeFileSync(
    path.join(root, "ZCode.exe"),
    Buffer.concat([Buffer.from("MZ"), Buffer.from(FUSE_SENTINEL, "latin1"), Buffer.from([1, 0x30, 0x30, 0x30, 0x30, 0x31, 0x30])]),
  );
  assert.throws(
    () => execFileSync(process.execPath, [patcher, "install", "--asar", asar, "--runtime", path.join(root, "rt"), "--allow-running"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: "pipe",
      env: { ...process.env, ZCODE_PE_NO_AUTOSTART: "1" },
    }),
    /refusing to patch|EnableEmbeddedAsarIntegrityValidation/,
  );
  assert.equal(readEntryTextFrom(asar, ENTRY), "official\n", "archive left untouched");
});
