/* Out-of-app trigger that restores the composer button after a ZCode update.
 *
 * An official update overwrites app.asar, which deletes the injection line.
 * Nothing inside ZCode can undo that — the loader itself lives in the archive
 * being replaced — so the repair has to run outside the app:
 *
 *   primary   a Scheduled Task every N minutes running `patch-desktop.mjs ensure`
 *   fallback  a Startup-folder .vbs: one check at logon, NOT periodic checks
 *
 * Both use a UTF-16LE BOM `ensure.vbs` to launch Node directly and hidden,
 * without cmd.exe or environment-variable expansion in paths. There is no
 * resident fallback process: an update after logon waits until the next logon.
 * `ensure` is cheap and idempotent (see cmdEnsure): it exits at once when the
 * archive is patched, patches immediately when ZCode is closed, and otherwise
 * queues the same --after-exit install a manual run would use.
 */
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const TASK_NAME = "ZCodePromptEnhancerEnsure";
// Kept for old-runtime cleanup and callers of launcherPaths; no CMD is written.
export const LAUNCHER_CMD = "ensure.cmd";
export const LAUNCHER_VBS = "ensure.vbs";
export const DEFAULT_INTERVAL_MINUTES = 15;

export function autostartSupported(platform = process.platform) {
  // Escape hatch: tests (and users who do not want a task) disable the whole
  // trigger path, so install/remove never touch the real Task Scheduler.
  if (/^(1|true|yes)$/i.test(String(process.env.ZCODE_PE_NO_AUTOSTART || ""))) return false;
  return platform === "win32";
}

export function launcherPaths(runtimeDir) {
  return {
    cmd: path.join(runtimeDir, LAUNCHER_CMD),
    vbs: path.join(runtimeDir, LAUNCHER_VBS),
  };
}

export function startupEntryPath(appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")) {
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "ZCodePromptEnhancerEnsure.vbs");
}

function quoteArgument(value) {
  // Windows argv quoting: double backslashes before a quote or the closing quote.
  return '"' + String(value).replace(/(\\*)"/g, (_, slashes) => slashes + slashes + '\\"').replace(/\\+$/, slashes => slashes + slashes) + '"';
}

function vbsString(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

/* Regenerated on every install with the current Node, archive and runtime paths.
 * `cmd` remains in the return value as a legacy path, but that file is removed. */
export function writeLaunchers(runtimeDir, { nodePath, asarPath }) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const { cmd, vbs } = launcherPaths(runtimeDir);
  const script = path.join(runtimeDir, "patch-desktop.mjs");
  const args = [script, "ensure", "--asar", asarPath, "--runtime", runtimeDir].map(quoteArgument).join(" ");
  // Unlike WScript.Shell.Run, ShellExecute does not expand %VAR% in paths.
  // vShow = 0 hides Node's console; no shell command or resident loop is used.
  const source = `CreateObject("Shell.Application").ShellExecute ${vbsString(nodePath)}, ${vbsString(args)}, ${vbsString(runtimeDir)}, "open", 0\r\n`;
  fs.writeFileSync(vbs, Buffer.from("\ufeff" + source, "utf16le"));
  fs.rmSync(cmd, { force: true });
  return { cmd, vbs };
}

/* Task Scheduler runs the action line itself, so a bare .vbs has to be resolved
 * through the shell's file association — which is not available in the service
 * context. The task then blocks forever on an "Open with" dialog and Node never
 * starts. Always name the interpreter, and pass //B so a failing script can
 * never park the task in a modal error box either. */
export function wscriptPath(env = process.env) {
  return path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "wscript.exe");
}

export function taskAction(vbsPath, wscript = wscriptPath()) {
  return `"${wscript}" //B //Nologo "${vbsPath}"`;
}

export function createTaskArgs(vbsPath, intervalMinutes = DEFAULT_INTERVAL_MINUTES, wscript = wscriptPath()) {
  return ["/Create", "/F", "/TN", TASK_NAME, "/TR", taskAction(vbsPath, wscript), "/SC", "MINUTE", "/MO", String(intervalMinutes)];
}

export function deleteTaskArgs() {
  return ["/Delete", "/F", "/TN", TASK_NAME];
}

export function queryTaskArgs() {
  // /Query /TN fails for both missing tasks and scheduler/access errors. Query
  // the full table instead, without localized headers, to prove absence.
  return ["/Query", "/FO", "CSV", "/NH"];
}

export function defaultRun(args) {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function taskPresent({ run = defaultRun } = {}) {
  const output = String(run(queryTaskArgs())).replace(/^\ufeff/, "");
  let present = false;
  for (const row of output.split(/\r?\n/).filter(line => line.trim())) {
    // Non-verbose schtasks CSV has three quoted fields. Parse the first field,
    // not localized status text or a substring in another task's name.
    const match = row.match(/^"((?:[^"]|"")*)","(?:[^"]|"")*","(?:[^"]|"")*"$/);
    if (!match) throw new Error("Unexpected schtasks CSV output; task presence is unknown");
    const name = match[1].replace(/""/g, '"');
    if (name.toLowerCase() === `\\${TASK_NAME}`.toLowerCase()) present = true;
  }
  return present;
}

function firstLine(error) {
  const stderr = error && error.stderr && String(error.stderr).trim();
  return String(stderr || (error && error.message) || error).trim().split(/\r?\n/)[0];
}

function isMissing(error) {
  return error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function startupPresent(startupPath) {
  try {
    fs.lstatSync(startupPath);
    return true;
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
}

function startupDetail(startupPath) {
  return `startup folder entry ${startupPath} (login-only: one check at next logon; no periodic checks)`;
}

export function registerAutostart({
  runtimeDir,
  nodePath,
  asarPath,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
  run = defaultRun,
  startupPath = startupEntryPath(),
} = {}) {
  const { vbs } = writeLaunchers(runtimeDir, { nodePath, asarPath });
  try {
    run(createTaskArgs(vbs, intervalMinutes));
  } catch (e) {
    fs.mkdirSync(path.dirname(startupPath), { recursive: true });
    fs.copyFileSync(vbs, startupPath);
    return {
      mode: "startup",
      detail: `${startupDetail(startupPath)}; scheduled task unavailable: ${firstLine(e)}`,
    };
  }
  // A leftover Startup entry would fire a second, useless check. Cleanup errors
  // must not be mistaken for task-creation failures or silently ignored.
  fs.rmSync(startupPath, { force: true });
  return { mode: "task", detail: `scheduled task ${TASK_NAME} every ${intervalMinutes} min` };
}

/* Keep the original removed flags; callers must also check errors before
 * removing the runtime. A remaining flag is null when presence is unknown. */
export function unregisterAutostart({ run = defaultRun, startupPath = startupEntryPath() } = {}) {
  const errors = [];
  let removedTask = false;
  let remainingTask = null;
  try {
    run(deleteTaskArgs());
    removedTask = true;
    remainingTask = false;
  } catch (deleteError) {
    try {
      remainingTask = taskPresent({ run });
      if (remainingTask) errors.push(`scheduled task ${TASK_NAME} remains: ${firstLine(deleteError)}`);
      // A successful full query proving absence is the only safe way to ignore
      // /Delete failure. No localized error-message matching is involved.
    } catch (queryError) {
      errors.push(`could not delete scheduled task ${TASK_NAME}: ${firstLine(deleteError)}; could not verify absence: ${firstLine(queryError)}`);
    }
  }
  let removedStartup = false;
  let remainingStartup = null;
  try {
    fs.rmSync(startupPath);
    removedStartup = true;
    remainingStartup = false;
  } catch (e) {
    if (isMissing(e)) {
      remainingStartup = false;
    } else {
      let detail = firstLine(e);
      try { remainingStartup = startupPresent(startupPath); }
      catch (queryError) { detail += `; could not verify absence: ${firstLine(queryError)}`; }
      errors.push(`could not remove startup entry ${startupPath}: ${detail}`);
    }
  }
  return { removedTask, removedStartup, errors, remainingTask, remainingStartup };
}

export function autostartStatus({ run = defaultRun, startupPath = startupEntryPath() } = {}) {
  const startup = startupPresent(startupPath);
  let task;
  try {
    task = taskPresent({ run });
  } catch (e) {
    if (!startup) throw e;
    return {
      mode: "startup",
      present: true,
      detail: `${startupDetail(startupPath)}; scheduled task status unknown: ${firstLine(e)}`,
    };
  }
  if (task) return { mode: "task", present: true, detail: `scheduled task ${TASK_NAME}` };
  if (startup) return { mode: "startup", present: true, detail: startupDetail(startupPath) };
  return { mode: "none", present: false, detail: "not installed" };
}
