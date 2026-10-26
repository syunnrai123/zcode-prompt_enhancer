import { execFileSync } from "node:child_process";

export function isZCodeRunning() {
  if (process.platform !== "win32") return false;
  const output = execFileSync("tasklist", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return /ZCode\.exe/i.test(output);
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
