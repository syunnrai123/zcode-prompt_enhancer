#!/usr/bin/env node
/* Single-source version management for the four version manifests.
 *
 *   node scripts/release.mjs                 # --check: verify all agree
 *   node scripts/release.mjs --version 0.3.2 # bump all four, no commit
 *
 * After a bump run: npm run build && npm test && npm run smoke, then commit.
 * The check also gates npm run smoke, so a forgotten bump fails CI-style.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.dirname(HERE);
const REPO = path.dirname(path.dirname(PLUGIN)); // plugins/prompt-enhancer -> plugins -> repo root

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");

const manifests = [
  {
    name: "package.json",
    file: path.join(PLUGIN, "package.json"),
    get: (j) => j.version,
    set(json, v) { json.version = v; },
  },
  {
    name: "package-lock.json",
    file: path.join(PLUGIN, "package-lock.json"),
    get: (j) => j.version,
    set(json, v) {
      json.version = v;
      if (json.packages?.[""]) json.packages[""].version = v;
    },
  },
  {
    name: ".zcode-plugin/plugin.json",
    file: path.join(PLUGIN, ".zcode-plugin", "plugin.json"),
    get: (j) => j.version,
    set(json, v) { json.version = v; },
  },
  {
    name: "marketplace.json (repo root)",
    file: path.join(REPO, "marketplace.json"),
    get: (j) => j.plugins?.find((p) => p.name === "prompt-enhancer")?.version,
    set(json, v) {
      const entry = json.plugins?.find((p) => p.name === "prompt-enhancer");
      if (!entry) throw new Error("prompt-enhancer entry missing in marketplace.json");
      entry.version = v;
    },
  },
];

function check() {
  const pkg = readJson(manifests[0].file).version;
  let ok = true;
  for (const m of manifests) {
    const v = m.get(readJson(m.file)) ?? "(missing)";
    const good = v === pkg;
    if (!good) ok = false;
    console.log(`${good ? "ok  " : "BAD "} ${m.name}: ${v}`);
  }
  const overlay = fs.readFileSync(path.join(PLUGIN, "desktop", "overlay.js"), "utf8");
  const stamp = /var VERSION = "([^"]*)";/.exec(overlay)?.[1] ?? "(missing)";
  const stampOk = stamp === pkg;
  if (!stampOk) ok = false;
  console.log(`${stampOk ? "ok  " : "BAD "} desktop/overlay.js VERSION stamp: ${stamp}${stampOk ? "" : " (run npm run build)"}`);
  console.log(ok ? "[release] all version manifests agree" : "[release] version drift detected");
  process.exitCode = ok ? 0 : 1;
  return ok;
}

function bump(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`[release] invalid version: ${version}`);
    process.exitCode = 1;
    return;
  }
  for (const m of manifests) {
    const json = readJson(m.file);
    m.set(json, version);
    writeJson(m.file, json);
    console.log(`[release] ${m.name} -> ${version}`);
  }
  console.log("[release] next: npm run build && npm test && npm run smoke, then commit");
}

const args = process.argv.slice(2);
const versionFlag = args.indexOf("--version");
if (versionFlag >= 0) bump(args[versionFlag + 1]);
else check();
