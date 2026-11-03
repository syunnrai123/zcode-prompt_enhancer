import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withArchiveLock, readInstallControl, setInstallControl, installIsCurrent } from "../desktop/install-state.mjs";

const stateUrl = new URL("../desktop/install-state.mjs", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const first of ["install", "remove"]) {
  test(`concurrent ${first} first leaves archive removed without resurrecting the trigger`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-interleaved-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archive = path.join(root, "archive"), runtime = path.join(root, "runtime");
    const lockRoot = path.join(root, "locks"), ready = path.join(root, "ready"), trigger = path.join(root, "trigger");
    const initial = setInstallControl(runtime, true);
    fs.writeFileSync(archive, "official");
    const childScript = `
      import fs from 'node:fs';
      import { withArchiveLock, setInstallControl, installIsCurrent } from ${JSON.stringify(stateUrl)};
      await withArchiveLock(${JSON.stringify(archive)}, async () => {
        if (${JSON.stringify(first)} === 'remove') {
          setInstallControl(${JSON.stringify(runtime)}, false);
          fs.rmSync(${JSON.stringify(trigger)}, {force:true});
          fs.writeFileSync(${JSON.stringify(archive)}, 'official');
        }
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        await new Promise(resolve => process.stdin.once('data', resolve));
        if (${JSON.stringify(first)} === 'install' && installIsCurrent(${JSON.stringify(runtime)}, ${JSON.stringify(initial.generation)})) {
          fs.writeFileSync(${JSON.stringify(archive)}, 'patched');
          fs.writeFileSync(${JSON.stringify(trigger)}, 'registered');
        }
      }, {lockRoot:${JSON.stringify(lockRoot)}});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const ended = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)));
    });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("child did not acquire archive lock");
      await sleep(20);
    }
    let secondEntered = false;
    const second = withArchiveLock(archive, () => {
      secondEntered = true;
      if (first === "install") {
        setInstallControl(runtime, false);
        fs.rmSync(trigger, { force: true });
        fs.writeFileSync(archive, "official");
      } else if (installIsCurrent(runtime, initial.generation)) {
        fs.writeFileSync(archive, "patched");
        fs.writeFileSync(trigger, "registered");
      }
    }, { lockRoot });
    await sleep(100);
    assert.equal(secondEntered, false);
    child.stdin.end("release\n");
    await ended;
    await second;
    assert.equal(fs.readFileSync(archive, "utf8"), "official");
    assert.equal(fs.existsSync(trigger), false);
    assert.equal(readInstallControl(runtime).enabled, false);
  });
}
