import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* All archive mutations share a lock outside the runtime, so --purge cannot
 * remove the lock while a waiter or another ensure process still uses it. */
export async function withArchiveLock(asarPath, operation, {
  lockRoot = path.join(os.tmpdir(), "zcode-prompt-enhancer-locks"),
  timeoutMs = 60000,
  intervalMs = 50,
} = {}) {
  const archive = path.resolve(asarPath);
  const key = createHash("sha256").update(process.platform === "win32" ? archive.toLowerCase() : archive).digest("hex");
  fs.mkdirSync(lockRoot, { recursive: true });
  const lockPath = path.join(lockRoot, key + ".lock");
  const started = Date.now();
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lockPath, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for another desktop installer. If no installer is running, remove the stale lock: ${lockPath}`);
      }
      await sleep(intervalMs);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, archive, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

/* Keep cancellation outside runtimeDir: a queued process must remain cancelled
 * even after remove --purge deletes its scripts and status file. */
export function readInstallControl(runtimeDir) {
  try {
    const state = JSON.parse(fs.readFileSync(runtimeDir + ".install-control.json", "utf8"));
    if (typeof state.generation !== "string" || typeof state.enabled !== "boolean") throw new Error("invalid installation control state");
    return state;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function setInstallControl(runtimeDir, enabled) {
  const state = { generation: randomUUID(), enabled };
  const file = runtimeDir + ".install-control.json";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(state) + "\n");
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return state;
}

export function installIsCurrent(runtimeDir, generation) {
  const state = readInstallControl(runtimeDir);
  return state?.enabled === true && state.generation === generation;
}

/**
 * Best-effort "is the ZCode desktop app running" check, used to avoid patching
 * an archive the running app still depends on: on Windows the rename fails
 * with EPERM while ZCode holds app.asar open; on other platforms the running
 * app would silently keep the old contents until restart. Returns false when
 * detection is unavailable — the caller's rename is the real safety net.
 */
export function isZCodeRunning() {
  if (process.platform === "win32") {
    const output = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /ZCode\.exe/i.test(output);
  }
  if (process.platform === "darwin") {
    try {
      // pgrep exits 0 when a process named exactly "ZCode" exists, 1 otherwise.
      execFileSync("pgrep", ["-x", "ZCode"], { stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch (e) {
      return e.status === 0;
    }
  }
  return false;
}

export async function waitForZCodeExit({
  isRunning = isZCodeRunning,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 24 * 60 * 60 * 1000,
  intervalMs = 1000,
  isCancelled = () => false,
} = {}) {
  let elapsed = 0;
  while (true) {
    if (isCancelled()) return;
    if (!isRunning()) return;
    if (elapsed >= timeoutMs) throw new Error("Timed out waiting for ZCode to exit; no archive changes were made.");
    await sleep(intervalMs);
    elapsed += intervalMs;
  }
}
