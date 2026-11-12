#!/usr/bin/env node
/* ZCode Prompt Enhancer — desktop patcher.
 *
 * Adds/removes ONE line at the tail of out/main/index.js inside the ZCode
 * app.asar (an ESM entry; a dynamic import works regardless of module type).
 * The line loads inject-main.cjs from a self-contained runtime directory.
 *
 *   node patch-desktop.mjs install [--asar <app.asar>] [--runtime <dir>] [--reset-config] [--no-autostart]
 *   node patch-desktop.mjs ensure  [--asar <app.asar>] [--runtime <dir>]
 *   node patch-desktop.mjs remove  [--asar <app.asar>] [--purge]
 *   node patch-desktop.mjs check   [--asar <app.asar>]
 *   node patch-desktop.mjs doctor  [--runtime <dir>]
 *
 * `ensure` is the entry point used by the auto-repatch trigger (autostart.mjs):
 * it exits at once when the archive is patched, patches immediately when ZCode
 * is closed, and otherwise queues the same --after-exit install a manual run
 * would use.
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
import { spawn } from "node:child_process";
import { waitForZCodeExit, isZCodeRunning, withArchiveLock, readInstallControl, setInstallControl, installIsCurrent } from "./install-state.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ENTRY,
  buildInjectLine,
  readArchive,
  readEntryText,
  stripInjectLines,
  writeArchiveEntries,
  readElectronFuses,
  fuseState,
  ASAR_INTEGRITY_FUSE,
} from "./asar-lib.mjs";
import {
  HOST_ENTRY,
  HOST_PATCH_START,
  applyHostPatch,
  isHostPatched,
  stripHostPatch,
  hostPatchedVariant,
  resolveRegistration,
} from "./host-patch.mjs";
import {
  autostartSupported,
  registerAutostart,
  unregisterAutostart,
  autostartStatus,
} from "./autostart.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
/* These scripts also run from the self-contained runtime directory
 * (~/.zcode/zcode-prompt-enhancer), where dist/ and runtime-version.json sit
 * beside them instead of under plugins/prompt-enhancer. */
const RUNTIME_LAYOUT = fs.existsSync(path.join(HERE, "runtime-version.json")) || fs.existsSync(path.join(HERE, "dist"));
const SOURCE_DIST = RUNTIME_LAYOUT ? path.join(HERE, "dist") : path.join(PLUGIN_ROOT, "dist");
const SOURCE_ENHANCER = path.join(SOURCE_DIST, "desktop", "workspace-enhancer.js");
const SOURCE_SCRIPTS = [
  "system-prompt.generated.js",
  "session-context.js",
  "host-bridge.js",
  "overlay.js",
];
/* Shipped alongside the runtime so the scheduled `ensure` step can re-patch
 * without depending on where the plugin cache lives. */
const PATCHER_MODULES = [
  "patch-desktop.mjs",
  "asar-lib.mjs",
  "host-patch.mjs",
  "install-state.mjs",
  "autostart.mjs",
  "vendor/acorn.mjs",
  "vendor/acorn.LICENSE",
];
const SOURCE_LOADER = path.join(HERE, "inject-main.cjs");
const SOURCE_VERSION = readSourceVersion();

function readSourceVersion() {
  const files = RUNTIME_LAYOUT
    ? [path.join(HERE, "runtime-version.json")]
    : [path.join(PLUGIN_ROOT, "package.json")];
  for (const file of files) {
    try {
      const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch (e) { }
  }
  return "0.0.0";
}

const LOG_MAX_BYTES = 512 * 1024;

/* Every line is timestamped so install.log can be correlated with ZCode
 * updates, task runs and archive mtimes after the fact. */
function stamp() {
  return new Date().toISOString();
}

function fail(msg) {
  throw new Error(msg);
}
function info(msg) {
  console.log(stamp() + " [zcode-prompt-enhancer] " + msg);
}

/* The scheduled-task path runs `ensure` hidden, with no stdout to inherit, so
 * its decisions would otherwise leave no trace at all. Append them to the same
 * install.log the background installer writes (rotating once it grows). */
function ensureNote(runtimeDir, message) {
  info("ensure: " + message);
  const logPath = path.join(runtimeDir, "install.log");
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    try {
      if (fs.statSync(logPath).size > LOG_MAX_BYTES) fs.renameSync(logPath, logPath + ".old");
    } catch (e) { }
    fs.writeFileSync(logPath, `${stamp()} [zcode-prompt-enhancer] ensure: ${message}\n`, { flag: "a" });
  } catch (e) {
    // Diagnostics must never break the repair path.
  }
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

/* The executable sits next to the resources/ directory that owns app.asar.
 * Used only for read-only Electron fuse detection. */
function findAppExe(asarPath) {
  const dir = path.dirname(path.dirname(path.resolve(asarPath)));
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.exe$/i.test(n)); } catch (e) { return null; }
  for (const p of ["ZCode.exe", "electron.exe"]) {
    if (names.includes(p)) return path.join(dir, p);
  }
  return names[0] ? path.join(dir, names[0]) : null;
}

/* With the asar-integrity fuse on, Electron verifies a boot hash embedded in
 * the binary against the archive header; any patch (however correct) makes
 * the app refuse to start. Detect and refuse before touching anything. */
function asarIntegrityFuseBlocksInstall(asarPath) {
  const exe = findAppExe(asarPath);
  if (!exe) return { exe: null, state: "no-exe" };
  let fuses;
  try { fuses = readElectronFuses(exe); } catch (e) { return { exe, state: "unreadable", error: e.message }; }
  return { exe, state: fuseState(fuses, ASAR_INTEGRITY_FUSE), fuses };
}

function scheduleInstall(asarPath, runtimeExplicit, resetConfig, noAutostart, generation) {
  const runtimeDir = path.resolve(runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer"));
  fs.mkdirSync(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, "install.log");
  const statusPath = path.join(runtimeDir, "install-status.json");
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch (e) { }
  if (previous?.state === "waiting" && previous.pid && previous.generation === generation) {
    try { process.kill(previous.pid, 0); info(`installation already waiting (pid ${previous.pid}); log: ${logPath}`); return; } catch (e) { }
  }
  const fd = fs.openSync(logPath, "a");
  const childArgs = [fileURLToPath(import.meta.url), "install", "--wait-for-exit", "--asar", asarPath, "--runtime", runtimeDir, "--generation", generation];
  if (resetConfig) childArgs.push("--reset-config");
  if (noAutostart) childArgs.push("--no-autostart");
  try {
    const child = spawn(process.execPath, childArgs, { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    child.on("error", (e) => info("background installer failed: " + e.message));
    child.unref();
    info(`installer scheduled (pid ${child.pid}); it will wait until all ZCode processes exit, then install v${SOURCE_VERSION}.`);
    info(`ZCode will NOT be closed or restarted automatically. Log: ${logPath}`);
  } finally { fs.closeSync(fd); }
}

function sourceRuntimeFiles() {
  const files = ["inject-main.cjs", ...SOURCE_SCRIPTS, ...PATCHER_MODULES, "dist/package.json"];
  if (RUNTIME_LAYOUT) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(HERE, "runtime-version.json"), "utf8")); }
    catch (e) { fail("Runtime manifest is missing or unreadable; reinstall desktop integration from the plugin folder."); }
    if (!Array.isArray(manifest.requiredFiles)) fail("Runtime manifest is incomplete; reinstall desktop integration from the plugin folder.");
    return [...new Set([...files, ...manifest.requiredFiles])];
  }
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.name.endsWith(".js")) files.push(relative);
    }
  };
  const distMissing = ["desktop/workspace-enhancer.js", "context/project-context.js"].some((file) => !fs.existsSync(path.join(SOURCE_DIST, file)));
  if (distMissing) fail("Compiled project-context runtime missing; build or reinstall desktop integration from the plugin folder.");
  walk(SOURCE_DIST, "dist");
  return [...new Set(files)];
}

function copyRuntime(runtimeDir, resetConfig) {
  const requiredFiles = sourceRuntimeFiles();
  for (const file of requiredFiles) {
    if (file !== "dist/package.json" && !fs.existsSync(path.join(HERE, file.startsWith("dist/") && !RUNTIME_LAYOUT ? "../" + file : file))) {
      fail(`Source runtime file missing: ${file}; reinstall desktop integration from the plugin folder.`);
    }
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const loaderDst = path.join(runtimeDir, "inject-main.cjs");
  const sameFile = (a, b) => path.resolve(a) === path.resolve(b);
  if (!sameFile(SOURCE_LOADER, loaderDst)) fs.copyFileSync(SOURCE_LOADER, loaderDst);
  for (const name of SOURCE_SCRIPTS) {
    const dst = path.join(runtimeDir, name);
    if (!sameFile(path.join(HERE, name), dst)) fs.copyFileSync(path.join(HERE, name), dst);
  }
  for (const name of PATCHER_MODULES) {
    const src = path.join(HERE, name);
    const dst = path.join(runtimeDir, name);
    if (!sameFile(src, dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  const runtimeDist = path.join(runtimeDir, "dist");
  if (!sameFile(SOURCE_DIST, runtimeDist)) fs.cpSync(SOURCE_DIST, runtimeDist, { recursive: true });
  fs.writeFileSync(path.join(runtimeDist, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(runtimeDir, "runtime-version.json"), JSON.stringify({ version: SOURCE_VERSION, protocol: 2, requiredFiles, installedAt: new Date().toISOString() }, null, 2) + "\n");
  return { runtimeDir, loaderDst };
}

/** Whether the runtime directory is present and current, without touching it. */
function runtimeState(runtimeDir) {
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "runtime-version.json"), "utf8"));
  } catch (e) { }
  const files = new Set([...sourceRuntimeFiles(), ...(Array.isArray(manifest.requiredFiles) ? manifest.requiredFiles : [])]);
  const missing = [...files].filter((file) => !fs.existsSync(path.join(runtimeDir, file)));
  return {
    version: manifest.version,
    missing,
    current: manifest.version === SOURCE_VERSION && manifest.protocol === 2 && Array.isArray(manifest.requiredFiles) && missing.length === 0,
  };
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
      const variant = hostPatchedVariant(hostText);
      if (isHostPatched(hostText) && variant) info(`host anchor: ${variant} (in use)`);
      else {
        const resolved = resolveRegistration(hostText);
        info(`host anchor: ${resolved ? `${resolved.variant} (${resolved.source})` : "none — this ZCode build is not supported"}`);
      }
    } catch (e) {
      if (parsed) { try { fs.closeSync(parsed.fd); } catch (_) { } }
      info(`app.asar read failed: ${e.message}`);
    }
    const exe = findAppExe(asarPath);
    if (exe) {
      try {
        const state = fuseState(readElectronFuses(exe), ASAR_INTEGRITY_FUSE);
        info(`electron fuses (${path.basename(exe)}): ${ASAR_INTEGRITY_FUSE}=${state}` +
          (state === "enabled" ? " (install refuses; a patched asar would not boot)" : ""));
      } catch (e) { info(`electron fuses: unreadable (${e.message})`); }
    } else {
      info("electron fuses: no executable found next to app.asar (skipped)");
    }
  }

  const runtimeDir = path.resolve(
    runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer")
  );
  info("\n=== 2. runtime ===");
  info(`runtime: ${runtimeDir} ${fs.existsSync(runtimeDir) ? "" : "(MISSING — run install)"}`);
  for (const f of ["inject-main.cjs", ...SOURCE_SCRIPTS, ...PATCHER_MODULES, "dist/desktop/workspace-enhancer.js", "dist/context/project-context.js", "dist/package.json"]) {
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
  if (autostartSupported()) {
    try {
      const auto = autostartStatus();
      info(`auto-repatch: ${auto.present ? auto.detail : "not installed (run install to enable)"}`);
    } catch (e) { info(`auto-repatch: unknown (${e.message})`); }
  } else {
    info(process.platform === "win32"
      ? "auto-repatch: disabled by ZCODE_PE_NO_AUTOSTART"
      : "auto-repatch: not supported on this platform");
  }

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

function cmdInstall(asarPath, runtimeExplicit, resetConfig, allowRunning, noAutostart) {
  ensureZCodeClosed(allowRunning);
  for (const name of ["inject-main.cjs", ...SOURCE_SCRIPTS]) {
    if (!fs.existsSync(path.join(HERE, name))) fail(`${name} missing from the desktop folder.`);
  }

  if (!fs.existsSync(SOURCE_ENHANCER)) fail("Compiled project-context runtime missing; run npm run build.");
  const fuseInfo = asarIntegrityFuseBlocksInstall(asarPath);
  if (fuseInfo.state === "enabled") {
    fail(
      `refusing to patch: ${fuseInfo.exe} enables Electron ${ASAR_INTEGRITY_FUSE}. ` +
      "A patched app.asar would fail the boot-time header hash and ZCode would not start."
    );
  }
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
    const resolved = resolveRegistration(stripHostPatch(currentHost));
    const nextHost = applyHostPatch(currentHost, moduleUrl);
    if (resolved) info(`host anchor: ${resolved.variant} (${resolved.source})`);
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
      const result = writeArchiveEntries(asarPath, parsed, replacements);
      parsed = null;
      info(`patched ${changed.join(", ")}` + (result.integrityUpdated ? ` (recomputed ${result.integrityUpdated} asar integrity hashes)` : ""));
    }
  } catch (e) {
    if (parsed) { try { fs.closeSync(parsed.fd); } catch (_) { } }
    fail(e.message);
  }
  info(`runtime: ${runtimeDir}`);
  if (noAutostart) {
    info("auto-repatch: skipped (--no-autostart). The button will disappear again after a ZCode update.");
  } else if (!autostartSupported()) {
    info("auto-repatch: skipped (unsupported platform, or ZCODE_PE_NO_AUTOSTART is set). Re-run install after a ZCode update.");
  } else {
    const auto = registerAutostart({ runtimeDir, nodePath: process.execPath, asarPath });
    info(`auto-repatch: ${auto.detail}.`);
  }
  info("restart ZCode; a ✦ 增强 button appears to the left of the model/context controls.");
}

/* Entry point for the auto-repatch trigger. Must stay cheap: it runs every
 * few minutes, so an already-patched archive is a read-only probe and exit. */
function cmdEnsure(asarPath, runtimeExplicit, allowRunning) {
  const runtimeDir = path.resolve(
    runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer")
  );
  const control = readInstallControl(runtimeDir);
  if (control && !control.enabled) {
    ensureNote(runtimeDir, "desktop integration was removed; automatic repair is disabled.");
    return;
  }
  const generation = control?.generation || setInstallControl(runtimeDir, true).generation;
  let patched;
  let parsed;
  try {
    parsed = readArchive(asarPath);
    const main = readEntryText(parsed, ENTRY);
    const host = readEntryText(parsed, HOST_ENTRY);
    fs.closeSync(parsed.fd);
    parsed = null;
    patched = stripInjectLines(main) !== main && isHostPatched(host);
  } catch (e) {
    if (parsed) { try { fs.closeSync(parsed.fd); } catch (_) { } }
    fail(`ensure: cannot read app.asar: ${e.message}`);
  }

  if (patched) {
    const state = runtimeState(runtimeDir);
    if (state.current) {
      ensureNote(runtimeDir, "already patched and runtime is current; nothing to do.");
      return;
    }
    copyRuntime(runtimeDir, false);
    ensureNote(runtimeDir, `archive is patched; runtime refreshed (${state.version ?? "unknown"} -> ${SOURCE_VERSION}).`);
    return;
  }

  ensureNote(runtimeDir, "app.asar is official — a ZCode update removed the patch.");
  if (isZCodeRunning() && !allowRunning) {
    ensureNote(runtimeDir, "ZCode is running; arming the installer for its next exit.");
    scheduleInstall(asarPath, runtimeDir, false, false, generation);
    return;
  }
  ensureNote(runtimeDir, "patching now.");
  cmdInstall(asarPath, runtimeDir, false, allowRunning, false);
}

/** Tell a background installer that is still waiting for ZCode to exit to stop. */
function markPendingInstallCancelled(runtimeDir) {
  const statusPath = path.join(runtimeDir, "install-status.json");
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (!["waiting", "installing"].includes(status.state)) return;
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ state: "cancelled", pid: status.pid, version: status.version, updatedAt: new Date().toISOString() }, null, 2) + "\n"
    );
    info("cancelled the pending background installer; it will not re-patch after ZCode exits.");
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
}

function cmdRemove(asarPath, runtimeExplicit, purge, allowRunning) {
  const runtimeDir = path.resolve(
    runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer")
  );
  ensureZCodeClosed(allowRunning);
  setInstallControl(runtimeDir, false);
  markPendingInstallCancelled(runtimeDir);
  if (autostartSupported()) {
    const auto = unregisterAutostart();
    if (auto.errors.length) fail(`Could not remove auto-repatch triggers: ${auto.errors.join("; ")}. Automatic repair is disabled; resolve these errors and retry remove before purging.`);
    if (auto.removedTask || auto.removedStartup) info("auto-repatch trigger removed.");
  }
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
    if (fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
      info(`runtime removed: ${runtimeDir}`);
    }
  }
  info("for a fully stock app, also uninstall the plugin in ZCode → Settings → Plugins.");
}

async function installAfterExit(asarPath, runtimeExplicit, resetConfig, noAutostart, expectedGeneration) {
  const runtimeDir = path.resolve(runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer"));
  const statusPath = path.join(runtimeDir, "install-status.json");
  let generation = expectedGeneration;
  const status = (state, error) => fs.writeFileSync(statusPath, JSON.stringify({ state, pid: process.pid, generation, version: SOURCE_VERSION, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) }, null, 2) + "\n");
  const waiting = await withArchiveLock(asarPath, () => {
    if (generation && !installIsCurrent(runtimeDir, generation)) return false;
    generation ||= setInstallControl(runtimeDir, true).generation;
    fs.mkdirSync(runtimeDir, { recursive: true });
    status("waiting");
    return true;
  });
  if (!waiting) {
    info("installation cancelled before waiting; app.asar left untouched.");
    return;
  }
  info(`waiting for ZCode to exit before installing v${SOURCE_VERSION}; app.asar is unchanged while waiting.`);
  try {
    await waitForZCodeExit({ isCancelled: () => !installIsCurrent(runtimeDir, generation) });
    await withArchiveLock(asarPath, () => {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch (e) { }
      if (!installIsCurrent(runtimeDir, generation) || current?.state !== "waiting" || current.pid !== process.pid) {
        info("installation cancelled while waiting; app.asar left untouched.");
        return;
      }
      status("installing");
      cmdInstall(asarPath, runtimeDir, resetConfig, false, noAutostart);
      status("installed");
      info("installation finished; start ZCode normally.");
    });
  } catch (e) {
    await withArchiveLock(asarPath, () => {
      if (installIsCurrent(runtimeDir, generation)) status("failed", e.message);
    });
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

try {
  switch (cmd) {
    case "install": {
      const asarPath = resolveAsar(opt("--asar"));
      const runtimeDir = path.resolve(opt("--runtime") || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer"));
      const noAutostart = args.includes("--no-autostart");
      const resetConfig = args.includes("--reset-config");
      if (args.includes("--wait-for-exit")) {
        await installAfterExit(asarPath, runtimeDir, resetConfig, noAutostart, opt("--generation"));
      } else {
        await withArchiveLock(asarPath, () => {
          const control = setInstallControl(runtimeDir, true);
          if (args.includes("--after-exit")) scheduleInstall(asarPath, runtimeDir, resetConfig, noAutostart, control.generation);
          else cmdInstall(asarPath, runtimeDir, resetConfig, args.includes("--allow-running"), noAutostart);
        });
      }
      break;
    }
    case "ensure": {
      const asarPath = resolveAsar(opt("--asar"));
      await withArchiveLock(asarPath, () => cmdEnsure(asarPath, opt("--runtime"), args.includes("--allow-running")));
      break;
    }
    case "remove": {
      const asarPath = resolveAsar(opt("--asar"));
      await withArchiveLock(asarPath, () => cmdRemove(asarPath, opt("--runtime"), args.includes("--purge"), args.includes("--allow-running")));
      break;
    }
    case "check":
      cmdCheck(resolveAsar(opt("--asar")));
      break;
    case "doctor":
      cmdDoctor(opt("--runtime"), opt("--asar"));
      break;
    default:
      fail("usage: node patch-desktop.mjs <install|ensure|remove|check|doctor> [--asar <app.asar>] [--runtime <dir>] [--purge] [--reset-config] [--no-autostart] [--after-exit] [--allow-running (skip the running-app check; see header)]");
  }
} catch (e) {
  console.error(stamp() + " [zcode-prompt-enhancer] " + e.message);
  process.exitCode = 1;
}
