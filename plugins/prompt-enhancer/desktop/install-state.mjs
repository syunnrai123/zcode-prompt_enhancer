import { execFileSync } from "node:child_process";

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
} = {}) {
  let elapsed = 0;
  while (isRunning()) {
    if (elapsed >= timeoutMs) throw new Error("Timed out waiting for ZCode to exit; no archive changes were made.");
    await sleep(intervalMs);
    elapsed += intervalMs;
  }
}
