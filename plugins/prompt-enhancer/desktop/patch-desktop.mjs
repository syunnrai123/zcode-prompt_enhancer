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
 *
 * - install/remove are idempotent: install replaces any previous line of ours
 *   (any path), remove strips all of them and writes the archive only when a
 *   line was actually removed — after which the app behaves exactly like the
 *   official build (an official ZCode upgrade overwrites app.asar anyway).
 * - No backup files are kept; a pristine archive always comes with the app
 *   installer.
 * - The archive is rebuilt atomically (temp file + rename) and the patcher
 *   refuses to run while ZCode holds app.asar open (close the app first).
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ENTRY,
  buildInjectLine,
  readArchive,
  readEntryText,
  stripInjectLines,
  writeArchive,
} from "./asar-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const SOURCE_CLI = path.join(PLUGIN_ROOT, "dist", "cli.js");
const SOURCE_DIST = path.join(PLUGIN_ROOT, "dist");
const SOURCE_OVERLAY = path.join(HERE, "overlay.js");
const SOURCE_LOADER = path.join(HERE, "inject-main.cjs");
const SOURCE_CONFIG_EXAMPLE = path.join(HERE, "config.example.json");

function fail(msg) {
  console.error("[zcode-prompt-enhancer] " + msg);
  process.exit(1);
}
function info(msg) {
  console.log("[zcode-prompt-enhancer] " + msg);
}

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
  if (allowRunning) return; // for testing against a COPY of app.asar
  // Renaming over an asar the app holds open fails on Windows; detect early.
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (/ZCode\.exe/i.test(out)) {
        fail("ZCode is running. Close every ZCode window, then run this command again.");
      }
    }
  } catch (e) {
    /* tasklist unavailable — let the rename surface any real lock */
  }
}

function copyRuntime(runtimeDir, resetConfig) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const loaderDst = path.join(runtimeDir, "inject-main.cjs");
  fs.copyFileSync(SOURCE_LOADER, loaderDst);
  fs.copyFileSync(SOURCE_OVERLAY, path.join(runtimeDir, "overlay.js"));
  // Self-contained CLI: survives ZCode plugin-cache uninstallation.
  fs.cpSync(SOURCE_DIST, path.join(runtimeDir, "dist"), { recursive: true });

  const cfgPath = path.join(runtimeDir, "config.json");
  let cfg = {};
  if (!resetConfig && fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { cfg = {}; }
  }
  const example = JSON.parse(fs.readFileSync(SOURCE_CONFIG_EXAMPLE, "utf8"));
  for (const k of Object.keys(example)) if (!(k in cfg)) cfg[k] = example[k];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { runtimeDir, loaderDst, cfgPath };
}

function cmdCheck(asarPath) {
  let text;
  try {
    const parsed = readArchive(asarPath);
    text = readEntryText(parsed, ENTRY);
    fs.closeSync(parsed.fd);
  } catch (e) {
    fail(`check failed: ${e.message}`);
  }
  const stripped = stripInjectLines(text);
  const patched = stripped !== text;
  info(`asar: ${asarPath}`);
  info(`${ENTRY}: ${patched ? "PATCHED" : "clean (official)"}`);
  if (patched) {
    const m = text.match(/import\("file:\/\/([^"]+)"\)/);
    info(`loader: ${m ? decodeURI(m[1]) : "(unknown)"}`);
  }
  info(
    `source files: overlay ${fs.existsSync(SOURCE_OVERLAY) ? "ok" : "MISSING"}, ` +
    `dist ${fs.existsSync(SOURCE_CLI) ? "ok" : "MISSING (run npm run build)"}`
  );
}

function cmdInstall(asarPath, runtimeExplicit, resetConfig, allowRunning) {
  if (!fs.existsSync(SOURCE_CLI)) {
    fail("dist/cli.js missing — run `npm run build` in the plugin root first.");
  }
  ensureZCodeClosed(allowRunning);

  const runtimeDir = path.resolve(
    runtimeExplicit || path.join(os.homedir(), ".zcode", "zcode-prompt-enhancer")
  );
  const { loaderDst, cfgPath } = copyRuntime(runtimeDir, resetConfig);

  const parsed = readArchive(asarPath);
  const current = readEntryText(parsed, ENTRY);
  const stripped = stripInjectLines(current);
  const next = stripped + buildInjectLine(loaderDst);

  if (current === next) {
    fs.closeSync(parsed.fd);
    info("already installed and up to date — nothing to do.");
    info(`runtime: ${runtimeDir}`);
    return;
  }
  writeArchive(asarPath, parsed, ENTRY, next);
  info(`patched ${ENTRY} (injection line appended, ${Buffer.byteLength(next) - Buffer.byteLength(stripped)} bytes)`);
  info(`runtime: ${runtimeDir}`);
  info(`config:  ${cfgPath} (provider/api_key live here)`);
  info("restart ZCode; a ✦ button appears next to the composer tools.");
}

function cmdRemove(asarPath, purge, allowRunning) {
  ensureZCodeClosed(allowRunning);
  const parsed = readArchive(asarPath);
  const current = readEntryText(parsed, ENTRY);
  const stripped = stripInjectLines(current);
  if (stripped === current) {
    fs.closeSync(parsed.fd);
    info("not patched — app.asar is already in its official state.");
  } else {
    writeArchive(asarPath, parsed, ENTRY, stripped);
    info("injection line removed; app.asar restored to official contents.");
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

/* ---------- arg parsing ---------- */

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

switch (cmd) {
  case "install":
    cmdInstall(resolveAsar(opt("--asar")), opt("--runtime"), args.includes("--reset-config"), args.includes("--allow-running"));
    break;
  case "remove":
    cmdRemove(resolveAsar(opt("--asar")), args.includes("--purge"), args.includes("--allow-running"));
    break;
  case "check":
    cmdCheck(resolveAsar(opt("--asar")));
    break;
  default:
    fail("usage: node patch-desktop.mjs <install|remove|check> [--asar <app.asar>] [--runtime <dir>] [--purge] [--reset-config] [--allow-running]");
}
