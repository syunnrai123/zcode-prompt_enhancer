#!/usr/bin/env node
/* ZCode Prompt Enhancer — desktop patcher.
 *
 * Adds/removes ONE line at the tail of out/main/index.js inside the ZCode
 * app.asar (an ESM entry; a dynamic import works regardless of module type).
 * The line loads inject-main.cjs from a self-contained runtime directory.
 *
 *   node patch-desktop.mjs install [--asar <app.asar>] [--runtime <dir>] [--reset-config]
 *   node patch-desktop.mjs remove  [--asar <app.asar>] [--purge]
 *   node patch-desktop.mjs check   [--asar <app.asar>]
 *   node patch-desktop.mjs doctor  [--runtime <dir>]
 *
 * `doctor` reports patch state, runtime files, effective provider/key source
 * (never the key itself) and the tail of loader.log — use it first when the
 * composer button spins or never appears.
 * - install/remove are idempotent: install replaces any previous line of ours
 *   (any path), remove strips all of them and writes the archive only when a
 *   line was actually removed — after which the app behaves exactly like the
 *   official build (an official ZCode upgrade overwrites app.asar anyway).
 * - No backup files are kept; a pristine archive always comes with the app
 *   installer.
 * - The archive is rebuilt atomically (temp file + rename) and the patcher
 *   refuses to run while ZCode holds app.asar open (close the app first).
 *   `--allow-running` skips that check as an escape hatch (e.g. patching a
 *   COPY of the archive): on Windows the rename usually still fails with EPERM,
 *   and a running app keeps the old archive until its next restart either way.
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawn } from "node:child_process";
import { waitForZCodeExit, isZCodeRunning } from "./install-state.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ENTRY,
  buildInjectLine,
  readArchive,
  readEntryText,
  stripInjectLines,
  writeArchiveEntries,
} from "./asar-lib.mjs";
import {
  HOST_ENTRY,
  HOST_PATCH_START,
  applyHostPatch,
  isHostPatched,
  stripHostPatch,
} from "./host-patch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const SOURCE_DIST = path.join(PLUGIN_ROOT, "dist");
const SOURCE_ENHANCER = path.join(SOURCE_DIST, "desktop", "workspace-enhancer.js");
const SOURCE_SCRIPTS = [
  "system-prompt.generated.js",
  "session-context.js",
  "host-bridge.js",
  "overlay.js",
];
const SOURCE_LOADER = path.join(HERE, "inject-main.cjs");
const SOURCE_VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")).version;

function fail(msg) {
  console.error("[zcode-prompt-enhancer] " + msg);
  process.exit(1);
}
function info(msg) {
  console.log("[zcode-prompt-enhancer] " + msg);
}

/* Discovery order: ZCODE_ASAR env override wins, then the common install
 * locations. The D:\ZCode entry is a machine-specific fallback (a portable /
 * custom-drive install); existence checks are cheap, unknown paths are
 * skipped. Pass --asar (or set ZCODE_ASAR) on any other layout. */
function defaultAsarCandidates() {
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };
  if (process.env.ZCODE_ASAR) push(process.env.ZCODE_ASAR);
  push(process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "ZCode", "resources", "app.asar")
    : null);
  push("C:\\Program Files\\ZCode\\resources\\app.asar");
  push("D:\\ZCode\\resources\\app.asar");
  push("/Applications/ZCode.app/Contents/Resources/app.asar");
  return cands;
}

function resolveAsar(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`--asar path not found: ${explicit}`);
    return path.resolve(explicit);
  }
  for (const c of defaultAsarCandidates()) {
    if (c && fs.existsSync(c)) return path.resolve(c);
  }
  fail(
    "app.asar not found. Pass it explicitly: node patch-desktop.mjs <cmd> --asar <path-to-ZCode>\\resources\\app.asar"
  );
}

function ensureZCodeClosed(allowRunning) {
  if (allowRunning) return;
  let running;
  try { running = isZCodeRunning(); }
  catch (e) { throw new Error("Cannot verify whether ZCode is running: " + e.message); }
  if (running) throw new Error("ZCode is running. Close it first, or use install --after-exit to install automatically after exit.");
}

function scheduleInstall(asarPath, runtimeExplicit, resetConfig) {
  const runtimeDir = path.resolve(runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer"));
  fs.mkdirSync(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, "install.log");
  const statusPath = path.join(runtimeDir, "install-status.json");
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch (e) { }
  if (previous?.state === "waiting" && previous.pid) {
    try { process.kill(previous.pid, 0); info(`installation already waiting (pid ${previous.pid}); log: ${logPath}`); return; } catch (e) { }
  }
  const fd = fs.openSync(logPath, "a");
  const childArgs = [fileURLToPath(import.meta.url), "install", "--wait-for-exit", "--asar", asarPath, "--runtime", runtimeDir];
  if (resetConfig) childArgs.push("--reset-config");
  try {
    const child = spawn(process.execPath, childArgs, { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    child.on("error", (e) => info("background installer failed: " + e.message));
    child.unref();
    info(`installer scheduled (pid ${child.pid}); it will wait until all ZCode processes exit, then install v${SOURCE_VERSION}.`);
    info(`ZCode will NOT be closed or restarted automatically. Log: ${logPath}`);
  } finally { fs.closeSync(fd); }
}

function copyRuntime(runtimeDir, resetConfig) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const loaderDst = path.join(runtimeDir, "inject-main.cjs");
  fs.copyFileSync(SOURCE_LOADER, loaderDst);
  for (const name of SOURCE_SCRIPTS) {
    fs.copyFileSync(path.join(HERE, name), path.join(runtimeDir, name));
  }
  fs.cpSync(SOURCE_DIST, path.join(runtimeDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "dist", "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(runtimeDir, "runtime-version.json"), JSON.stringify({ version: SOURCE_VERSION, protocol: 2, installedAt: new Date().toISOString() }, null, 2) + "\n");
  return { runtimeDir, loaderDst };
}

function cmdDoctor(runtimeExplicit, asarExplicit) {
  const asarPath = asarExplicit || defaultAsarCandidates().find((c) => c && fs.existsSync(c));
  info(`source version: ${SOURCE_VERSION}`);
  info("=== 1. app.asar patch ===");
  if (!asarPath) {
    info("app.asar: NOT FOUND (pass ZCODE_ASAR env var)");
  } else {
    let parsed;
    try {
      parsed = readArchive(asarPath);
      const mainText = readEntryText(parsed, ENTRY);
      const hostText = readEntryText(parsed, HOST_ENTRY);
      fs.closeSync(parsed.fd);
      parsed = null;
      info(`app.asar: ${asarPath}`);
      info(`injection: ${stripInjectLines(mainText) !== mainText ? "PATCHED" : "clean (button will not appear)"}`);
      info(`host bridge: ${isHostPatched(hostText) ? "PATCHED" : "clean (cannot reuse session model)"}`);
    } catch (e) {
      if (parsed) { try { fs.closeSync(parsed.fd); } catch (_) { } }
      info(`app.asar read failed: ${e.message}`);
    }
  }

  const runtimeDir = path.resolve(
    runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer")
  );
  info("\n=== 2. runtime ===");
  info(`runtime: ${runtimeDir} ${fs.existsSync(runtimeDir) ? "" : "(MISSING — run install)"}`);
  for (const f of ["inject-main.cjs", ...SOURCE_SCRIPTS, "dist/desktop/workspace-enhancer.js", "dist/context/project-context.js", "dist/package.json"]) {
    info(`  ${f}: ${fs.existsSync(path.join(runtimeDir, f)) ? "ok" : "MISSING"}`);
  }
  try {
    const version = JSON.parse(fs.readFileSync(path.join(runtimeDir, "runtime-version.json"), "utf8"));
    info(`runtime version: ${version.version}${version.version !== SOURCE_VERSION ? " (outdated — run install)" : ""}`);
    info(`project context protocol: ${version.protocol === 2 ? "2" : "legacy (run install to update)"}`);
  } catch (e) { info("runtime version: unknown / not installed"); }
  try {
    const status = JSON.parse(fs.readFileSync(path.join(runtimeDir, "install-status.json"), "utf8"));
    let state = status.state;
    if (state === "waiting") {
      try { process.kill(status.pid, 0); } catch (e) { state = "interrupted (run install again)"; }
    }
    info(`background installer: ${state}; log: ${path.join(runtimeDir, "install.log")}`);
  } catch (e) { }

  info("\n=== 3. model source ===");
  info("  prompt generation: current session model (ZCode Host; no separate key)");
  info("  /enhance-prompt & MCP tool: optional external provider (ZCode plugin settings or env)");

  info("\n=== 4. loader.log (last 15 lines) ===");
  try {
    const lines = fs.readFileSync(path.join(runtimeDir, "loader.log"), "utf8").trim().split("\n");
    info(lines.slice(-15).join("\n"));
  } catch (e) {
    info("(no loader.log yet — ZCode may not have been restarted after install)");
  }
}

function cmdCheck(asarPath) {
  let mainText, hostText;
  try {
    const parsed = readArchive(asarPath);
    mainText = readEntryText(parsed, ENTRY);
    hostText = readEntryText(parsed, HOST_ENTRY);
    fs.closeSync(parsed.fd);
  } catch (e) {
    fail(`check failed: ${e.message}`);
  }
  const patched = stripInjectLines(mainText) !== mainText;
  info(`asar: ${asarPath}`);
  info(`${ENTRY}: ${patched ? "PATCHED" : "clean (official)"}`);
  info(`${HOST_ENTRY} host bridge: ${isHostPatched(hostText) ? "PATCHED" : "clean (official)"}`);
  if (patched) {
    const m = mainText.match(/import\("file:\/\/([^"]+)"\)/);
    info(`loader: ${m ? decodeURI(m[1]) : "(unknown)"}`);
  }
  info(
    `source files: scripts ${SOURCE_SCRIPTS.every((n) => fs.existsSync(path.join(HERE, n))) ? "ok" : "MISSING"}, ` +
    `dist ${fs.existsSync(SOURCE_ENHANCER) ? "ok" : "MISSING (run npm run build)"}`
  );
}

function cmdInstall(asarPath, runtimeExplicit, resetConfig, allowRunning) {
  ensureZCodeClosed(allowRunning);
  for (const name of ["inject-main.cjs", ...SOURCE_SCRIPTS]) {
    if (!fs.existsSync(path.join(HERE, name))) fail(`${name} missing from the desktop folder.`);
  }

  if (!fs.existsSync(SOURCE_ENHANCER)) fail("Compiled project-context runtime missing; run npm run build.");
  const runtimeDir = path.resolve(
    runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer")
  );
  const { loaderDst } = copyRuntime(runtimeDir, resetConfig);

  let parsed;
  let changed;
  try {
    parsed = readArchive(asarPath);
    const currentMain = readEntryText(parsed, ENTRY);
    const currentHost = readEntryText(parsed, HOST_ENTRY);
    const nextMain = stripInjectLines(currentMain) + buildInjectLine(loaderDst);
    const moduleUrl = pathToFileURL(path.join(runtimeDir, "dist", "desktop", "workspace-enhancer.js")).href;
    const nextHost = applyHostPatch(currentHost, moduleUrl);
    changed = [];
    if (nextMain !== currentMain) changed.push(ENTRY);
    if (nextHost !== currentHost) changed.push(HOST_ENTRY);
    if (changed.length === 0) {
      fs.closeSync(parsed.fd);
      parsed = null;
      info("archive already patched; runtime files updated.");
    } else {
      const replacements = new Map();
      if (changed.includes(ENTRY)) replacements.set(ENTRY, nextMain);
      if (changed.includes(HOST_ENTRY)) replacements.set(HOST_ENTRY, nextHost);
      writeArchiveEntries(asarPath, parsed, replacements);
      parsed = null;
      info(`patched ${changed.join(", ")}`);
    }
  } catch (e) {
    if (parsed) { try { fs.closeSync(parsed.fd); } catch (_) { } }
    fail(e.message);
  }
  info(`runtime: ${runtimeDir}`);
  info("restart ZCode; a ✦ 增强 button appears to the left of the model/context controls.");
}

function cmdRemove(asarPath, purge, allowRunning) {
  ensureZCodeClosed(allowRunning);
  let parsed;
  try {
    parsed = readArchive(asarPath);
    const currentMain = readEntryText(parsed, ENTRY);
    const currentHost = readEntryText(parsed, HOST_ENTRY);
    const nextMain = stripInjectLines(currentMain);
    const nextHost = stripHostPatch(currentHost);
    if (nextMain === currentMain && nextHost === currentHost) {
      fs.closeSync(parsed.fd);
      parsed = null;
      info("not patched — app.asar is already in its official state.");
    } else {
      const replacements = new Map();
      if (nextMain !== currentMain) replacements.set(ENTRY, nextMain);
      if (nextHost !== currentHost) replacements.set(HOST_ENTRY, nextHost);
      writeArchiveEntries(asarPath, parsed, replacements);
      parsed = null;
      info("injection and host bridge removed; app.asar restored to official contents.");
    }
  } catch (e) {
    if (parsed) { try { fs.closeSync(parsed.fd); } catch (_) { } }
    fail(e.message);
  }
  if (purge) {
    const runtimeDir = path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer");
    if (fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      info(`runtime removed: ${runtimeDir}`);
    }
  }
  info("for a fully stock app, also uninstall the plugin in ZCode → Settings → Plugins.");
}

async function installAfterExit(asarPath, runtimeExplicit, resetConfig) {
  const runtimeDir = path.resolve(runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer"));
  fs.mkdirSync(runtimeDir, { recursive: true });
  const statusPath = path.join(runtimeDir, "install-status.json");
  const status = (state, error) => fs.writeFileSync(statusPath, JSON.stringify({ state, pid: process.pid, version: SOURCE_VERSION, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) }, null, 2) + "\n");
  try {
    status("waiting");
    info(`waiting for ZCode to exit before installing v${SOURCE_VERSION}; app.asar is unchanged while waiting.`);
    await waitForZCodeExit();
    status("installing");
    cmdInstall(asarPath, runtimeDir, resetConfig, false);
    status("installed");
    info("installation finished; start ZCode normally.");
  } catch (e) {
    status("failed", e.message);
    throw e;
  }
}

/* ---------- arg parsing ---------- */

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

switch (cmd) {
  case "install": {
    const asarPath = resolveAsar(opt("--asar"));
    if (args.includes("--after-exit")) scheduleInstall(asarPath, opt("--runtime"), args.includes("--reset-config"));
    else if (args.includes("--wait-for-exit")) await installAfterExit(asarPath, opt("--runtime"), args.includes("--reset-config"));
    else cmdInstall(asarPath, opt("--runtime"), args.includes("--reset-config"), args.includes("--allow-running"));
    break;
  }
  case "remove":
    cmdRemove(resolveAsar(opt("--asar")), args.includes("--purge"), args.includes("--allow-running"));
    break;
  case "check":
    cmdCheck(resolveAsar(opt("--asar")));
    break;
  case "doctor":
    cmdDoctor(opt("--runtime"), opt("--asar"));
    break;
  default:
    fail("usage: node patch-desktop.mjs <install|remove|check|doctor> [--asar <app.asar>] [--runtime <dir>] [--purge] [--reset-config] [--after-exit] [--allow-running (skip the running-app check; see header)]");
}
