import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ENTRY, buildArchive, readEntryTextFrom } from "../desktop/asar-lib.mjs";
import { HOST_ENTRY, isHostPatched } from "../desktop/host-patch.mjs";
import { readInstallControl } from "../desktop/install-state.mjs";

const stateUrl = new URL("../desktop/install-state.mjs", import.meta.url).href;
const host = 'var dt={generateWorkspaceText:async()=>({text:"ok"})};services.register(Kr,dt);\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugin"), desktop = path.join(plugin, "desktop");
  fs.cpSync(new URL("../desktop", import.meta.url), desktop, { recursive: true });
  fs.cpSync(new URL("../dist", import.meta.url), path.join(plugin, "dist"), { recursive: true });
  fs.copyFileSync(new URL("../package.json", import.meta.url), path.join(plugin, "package.json"));
  // Substitute only OS-facing services in the isolated copy. Never invoke the
  // real scheduler or rely on whether the user's ZCode happens to be open.
  fs.writeFileSync(path.join(desktop, "autostart.mjs"), `
    import fs from 'node:fs';
    export const autostartSupported = () => true;
    export function registerAutostart() {
      fs.appendFileSync(process.env.PE_TEST_EVENTS, 'registered\\n');
      return {detail:'fixture trigger'};
    }
    export function unregisterAutostart() {
      fs.appendFileSync(process.env.PE_TEST_EVENTS, 'unregistered\\n');
      return {removedTask:true, removedStartup:false, errors:process.env.PE_TEST_DELETE_FAILURE ? ['Access denied fixture'] : []};
    }
    export const autostartStatus = () => ({present:false});
  `);
  fs.writeFileSync(path.join(desktop, "install-state.mjs"), `
    import fs from 'node:fs';
    import {waitForZCodeExit as wait} from ${JSON.stringify(stateUrl)};
    export {withArchiveLock, readInstallControl, setInstallControl, installIsCurrent} from ${JSON.stringify(stateUrl)};
    export const isZCodeRunning = () => fs.existsSync(process.env.PE_TEST_RUNNING);
    export const waitForZCodeExit = options => wait({...options, isRunning:isZCodeRunning, intervalMs:20});
  `);
  const asar = path.join(root, "fixture.asar"), runtime = path.join(root, "runtime");
  buildArchive({ [ENTRY]: Buffer.from("official\n"), [HOST_ENTRY]: Buffer.from(host) }, asar);
  const events = path.join(root, "events"), running = path.join(root, "running");
  const env = { ...process.env, ZCODE_PE_NO_AUTOSTART: "1", PE_TEST_EVENTS: events, PE_TEST_RUNNING: running };
  const patcher = path.join(desktop, "patch-desktop.mjs");
  const args = (cmd, extra = []) => [patcher, cmd, "--asar", asar, "--runtime", runtime, ...extra];
  const run = (cmd, extra = [], overrides = {}) => execFileSync(process.execPath, args(cmd, extra), {
    env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000, stdio: "pipe",
  });
  return { root, asar, runtime, events, running, env, patcher, args, run };
}

async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const mode of [[], ["--wait-for-exit"], ["--after-exit"]]) {
  test(`--no-autostart survives ${mode[0] || "direct install"}`, async (t) => {
    const f = fixture(t);
    f.run("install", [...mode, "--no-autostart"]);
    if (mode.includes("--after-exit")) {
      await until(() => {
        try { return JSON.parse(fs.readFileSync(path.join(f.runtime, "install-status.json"), "utf8")).state === "installed"; }
        catch { return false; }
      });
    }
    assert.equal(fs.existsSync(f.events), false, "must not register the fixture trigger");
    assert.ok(isHostPatched(readEntryTextFrom(f.asar, HOST_ENTRY)));
  });
}

test("remove cancels a live waiter before exit and old generation cannot restore after purge", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.running, "running");
  f.run("install", ["--after-exit", "--no-autostart"]);
  let status;
  await until(() => {
    try { status = JSON.parse(fs.readFileSync(path.join(f.runtime, "install-status.json"), "utf8")); return status.state === "waiting"; }
    catch { return false; }
  });
  const oldGeneration = readInstallControl(f.runtime).generation;
  f.run("remove", ["--allow-running", "--purge"]);
  assert.equal(fs.existsSync(f.runtime), false);
  assert.equal(readInstallControl(f.runtime).enabled, false);
  fs.unlinkSync(f.running);
  assert.match(f.run("install", ["--wait-for-exit", "--generation", oldGeneration]), /cancelled/);
  assert.equal(fs.existsSync(f.runtime), false, "old waiter must not recreate a purged runtime");
  f.run("ensure", ["--allow-running"]);
  assert.equal(readEntryTextFrom(f.asar, ENTRY), "official\n");
  assert.equal(readEntryTextFrom(f.asar, HOST_ENTRY), host);
  assert.equal(fs.readFileSync(f.events, "utf8"), "unregistered\n");
});

test("cleanup failure is reported and leaves runtime intact for retry", (t) => {
  const f = fixture(t);
  f.run("install");
  assert.throws(() => f.run("remove", ["--purge"], { PE_TEST_DELETE_FAILURE: "1" }), /Could not remove auto-repatch triggers.*Access denied fixture/);
  assert.equal(fs.existsSync(f.runtime), true);
  assert.equal(readInstallControl(f.runtime).enabled, false);
  f.run("remove", ["--purge"]);
  assert.equal(fs.existsSync(f.runtime), false);
  assert.equal(readEntryTextFrom(f.asar, ENTRY), "official\n");
});

test("ensure repairs missing same-version modules and rejects a damaged self-contained source", (t) => {
  const f = fixture(t);
  f.run("install", ["--no-autostart"]);
  const missing = ["overlay.js", "dist/context/path-index.js", "dist/strategies/http.js"];
  for (const file of missing) fs.unlinkSync(path.join(f.runtime, file));
  assert.match(f.run("ensure"), /runtime refreshed/);
  for (const file of missing) assert.equal(fs.existsSync(path.join(f.runtime, file)), true);
  fs.unlinkSync(path.join(f.runtime, "overlay.js"));
  assert.throws(() => execFileSync(process.execPath, [path.join(f.runtime, "patch-desktop.mjs"), "ensure", "--asar", f.asar, "--runtime", f.runtime], {
    env: f.env, encoding: "utf8", timeout: 30000, stdio: "pipe",
  }), /Source runtime file missing.*reinstall desktop integration/);
});

test("remove tolerates a truncated transient status after cancelling the durable generation", (t) => {
  const f = fixture(t);
  f.run("install", ["--no-autostart"]);
  fs.writeFileSync(path.join(f.runtime, "install-status.json"), "");
  f.run("remove", ["--purge"]);
  assert.equal(fs.existsSync(f.runtime), false);
  assert.equal(readInstallControl(f.runtime).enabled, false);
  assert.equal(readEntryTextFrom(f.asar, ENTRY), "official\n");
  assert.equal(fs.readFileSync(f.events, "utf8"), "unregistered\n");
});

test("failed background install writes failed status instead of remaining installing", (t) => {
  const f = fixture(t);
  buildArchive({ [ENTRY]: Buffer.from("official\n"), [HOST_ENTRY]: Buffer.from("unsupported();") }, f.asar);
  assert.throws(() => f.run("install", ["--wait-for-exit", "--no-autostart"]), /unsupported ZCode host bundle/);
  const status = JSON.parse(fs.readFileSync(path.join(f.runtime, "install-status.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.match(status.error, /unsupported/);
});
