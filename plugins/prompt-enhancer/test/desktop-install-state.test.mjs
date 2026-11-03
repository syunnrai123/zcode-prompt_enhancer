import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withArchiveLock, readInstallControl, setInstallControl, installIsCurrent, waitForZCodeExit } from "../desktop/install-state.mjs";

const stateUrl = new URL("../desktop/install-state.mjs", import.meta.url).href;

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-install-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("archive lock serializes processes and releases after an exception", async (t) => {
  const root = rootFor(t);
  const archive = path.join(root, "app.asar");
  const lockRoot = path.join(root, "locks");
  const ready = path.join(root, "ready");
  const childScript = `
    import fs from 'node:fs';
    import { withArchiveLock } from ${JSON.stringify(stateUrl)};
    await withArchiveLock(${JSON.stringify(archive)}, async () => {
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      await new Promise(resolve => process.stdin.once('data', resolve));
    }, {lockRoot:${JSON.stringify(lockRoot)}});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`)));
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error("lock child did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let entered = false;
  const waiting = withArchiveLock(archive, () => { entered = true; }, { lockRoot });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(entered, false);
  child.stdin.end("release\n");
  await ended;
  await waiting;
  assert.equal(entered, true);
  await assert.rejects(withArchiveLock(archive, () => { throw new Error("fixture error"); }, { lockRoot }), /fixture error/);
  await withArchiveLock(archive, () => {}, { lockRoot });
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test("archive lock times out rather than deleting an unverified owner", async (t) => {
  const root = rootFor(t);
  const archive = path.join(root, "app.asar");
  const lockRoot = path.join(root, "locks");
  await withArchiveLock(archive, async () => {
    await assert.rejects(withArchiveLock(archive, () => assert.fail("lock acquired twice"), {
      lockRoot, timeoutMs: 20, intervalMs: 5,
    }), /Timed out waiting/);
  }, { lockRoot });
});

test("cancellation generation survives purge and cannot authorize an old waiter", async (t) => {
  const root = rootFor(t);
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime);
  assert.equal(readInstallControl(runtime), null);
  const first = setInstallControl(runtime, true);
  assert.equal(installIsCurrent(runtime, first.generation), true);
  setInstallControl(runtime, false);
  fs.rmSync(runtime, { recursive: true });
  assert.equal(installIsCurrent(runtime, first.generation), false);
  assert.equal(readInstallControl(runtime).enabled, false);
  const next = setInstallControl(runtime, true);
  assert.notEqual(next.generation, first.generation);
  assert.equal(installIsCurrent(runtime, first.generation), false);
  assert.equal(installIsCurrent(runtime, next.generation), true);
});

test("waiting stops promptly when removed instead of keeping a background process alive", async () => {
  let cancelled = false, probes = 0;
  await waitForZCodeExit({
    isRunning: () => { probes++; return true; },
    isCancelled: () => cancelled,
    sleep: async () => { cancelled = true; },
  });
  assert.equal(probes, 1);
});

test("invalid cancellation state is an error, not permission to reinstall", (t) => {
  const root = rootFor(t);
  const runtime = path.join(root, "runtime");
  fs.writeFileSync(runtime + ".install-control.json", "{}");
  assert.throws(() => readInstallControl(runtime), /invalid installation control/);
});
