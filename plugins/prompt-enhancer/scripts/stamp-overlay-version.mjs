#!/usr/bin/env node
/* Stamp desktop/overlay.js VERSION from package.json.
 *
 * overlay.ts carries a placeholder ("0.0.0") because the renderer cannot read
 * package.json at runtime; tsc overwrites the compiled artifact on every
 * build/test, so this runs after each compile (build AND test) to keep the
 * shipped file and the working tree consistent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.dirname(HERE);
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, "package.json"), "utf8"));
const OVERLAY = path.join(PLUGIN, "desktop", "overlay.js");

const src = fs.readFileSync(OVERLAY, "utf8");
const match = /var VERSION = "([^"]*)";/.exec(src);
if (!match) throw new Error("overlay.js has no 'var VERSION = \"...\";' line to stamp");
if (match[1] === pkg.version) {
  console.log(`[prompt-enhancer] overlay VERSION already ${pkg.version}`);
} else {
  fs.writeFileSync(OVERLAY, src.replace(/var VERSION = "[^"]*";/, `var VERSION = ${JSON.stringify(pkg.version)};`), "utf8");
  console.log(`[prompt-enhancer] overlay VERSION stamped to ${pkg.version}`);
}
