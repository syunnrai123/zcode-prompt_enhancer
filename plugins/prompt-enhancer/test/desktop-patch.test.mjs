/**
 * Desktop patcher round-trip tests (node:test).
 *
 * Builds synthetic asar archives (including jsonLen % 4 != 0 padding cases),
 * then verifies:
 *  - writeArchive appends the inject line and every other file's bytes survive;
 *  - remove (strip + writeArchive) restores out/main/index.js to the exact
 *    original text and every other entry to identical bytes;
 *  - stripping is idempotent and tolerant of old runtime paths;
 *  - the loader and overlay sources pass a syntax check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY,
  buildArchive,
  buildInjectLine,
  readArchive,
  readEntryTextFrom,
  stripInjectLines,
  writeArchive,
  writeArchiveEntries,
  computeIntegrity,
  readElectronFuses,
  fuseState,
  FUSE_SENTINEL,
  ASAR_INTEGRITY_FUSE,
} from "../desktop/asar-lib.mjs";
import { HOST_REGISTRATION_VARIANTS, applyHostPatch } from "../desktop/host-patch.mjs";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pe-asar-test-"));

function makeFixture(name, extraFiles) {
  const files = {
    "package.json": Buffer.from('{"name":"app","main":"out/main/index.js","type":"module"}'),
    [ENTRY]: Buffer.from('import{x}from"./a.js";console.log(x);\n'),
    "out/renderer/assets/app.js": Buffer.alloc(5000, 0xab),
    ...extraFiles,
  };
  const p = path.join(tmpRoot, name + ".asar");
  buildArchive(files, p);
  return { path: p, files };
}

function rawEntry(asarPath, entryPath) {
  const parsed = readArchive(asarPath);
  try {
    const parts = entryPath.split("/");
    let node = parsed.header;
    for (let i = 0; i < parts.length - 1; i++) node = node.files[parts[i]];
    const leaf = node.files[parts[parts.length - 1]];
    const buf = Buffer.alloc(leaf.size);
    fs.readSync(parsed.fd, buf, 0, leaf.size, parsed.dataStart + Number(leaf.offset));
    return buf;
  } finally {
    fs.closeSync(parsed.fd);
  }
}

test("install appends the inject line; remove restores original bytes", () => {
  const fx = makeFixture("basic", {
    "out/main/other.js": Buffer.from("export const y = 2;\n"),
  });
  const originalEntry = rawEntry(fx.path, ENTRY);
  const originalOther = rawEntry(fx.path, "out/main/other.js");
  const originalRenderer = rawEntry(fx.path, "out/renderer/assets/app.js");

  // install
  const current = readEntryTextFrom(fx.path, ENTRY);
  const line = buildInjectLine(path.join(tmpRoot, "runtime", "inject-main.cjs"));
  writeArchive(fx.path, readArchive(fx.path), ENTRY, current + line);

  const patched = readEntryTextFrom(fx.path, ENTRY);
  assert.ok(patched.includes("zcode-prompt-enhancer"));
  assert.ok(patched.endsWith(line));

  // remove
  writeArchive(fx.path, readArchive(fx.path), ENTRY, stripInjectLines(patched));

  assert.equal(readEntryTextFrom(fx.path, ENTRY), originalEntry.toString("utf8"));
  assert.deepEqual(rawEntry(fx.path, "out/main/other.js"), originalOther);
  assert.deepEqual(rawEntry(fx.path, "out/renderer/assets/app.js"), originalRenderer);
});

test("stripInjectLines is idempotent and tolerant of old paths", () => {
  const line1 = buildInjectLine("C:\\old\\path\\zcode-prompt-enhancer\\inject-main.cjs");
  const line2 = buildInjectLine("C:\\new\\path\\inject-main.cjs"); // tag only in the error message
  const base = "original entry code;\n";
  assert.equal(stripInjectLines(base + line1), base);
  assert.equal(stripInjectLines(base + line2), base);
  assert.equal(stripInjectLines(base + line1 + line2), base);
  assert.equal(stripInjectLines(base), base);
  assert.equal(stripInjectLines(""), "");
});

test("padding edge case: header JSON length not 4-aligned", () => {
  const fx = makeFixture("pad", {
    "out/renderer/assets/zz.js": Buffer.from("1"),
    "out/renderer/assets/zzz.js": Buffer.from("22"),
    "out/renderer/assets/zzzz.js": Buffer.from("333"),
  });
  const originalEntry = rawEntry(fx.path, ENTRY);
  const originalZZ = rawEntry(fx.path, "out/renderer/assets/zzzz.js");

  const current = readEntryTextFrom(fx.path, ENTRY);
  writeArchive(fx.path, readArchive(fx.path), ENTRY, current + buildInjectLine(path.join(tmpRoot, "r2", "inject-main.cjs")));

  assert.equal(rawEntry(fx.path, "out/renderer/assets/zzzz.js").toString("utf8"), originalZZ.toString("utf8"));

  writeArchive(fx.path, readArchive(fx.path), ENTRY, stripInjectLines(readEntryTextFrom(fx.path, ENTRY)));
  assert.equal(rawEntry(fx.path, ENTRY).toString("utf8"), originalEntry.toString("utf8"));
});

test("loader and overlay pass a syntax check", () => {
  const desktopDir = path.join(HERE, "..", "desktop");
  new Function(fs.readFileSync(path.join(desktopDir, "inject-main.cjs"), "utf8"));
  new Function(fs.readFileSync(path.join(desktopDir, "overlay.js"), "utf8"));
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("loader injects every renderer script and never spawns a CLI process", () => {
  const loader = fs.readFileSync(path.join(HERE, "..", "desktop", "inject-main.cjs"), "utf8");
  for (const name of ["system-prompt.generated.js", "session-context.js", "host-bridge.js", "overlay.js"]) {
    assert.ok(loader.includes(JSON.stringify(name)), `${name} must be injected`);
  }
  assert.ok(!/spawn\(|child_process/.test(loader), "generation must not spawn a CLI child");
});

test("computeIntegrity hashes content and splits blocks at the given size", () => {
  const buf = Buffer.from("0123456789abcdef0123"); // 20 bytes
  const integrity = computeIntegrity(buf, 8);
  const sha = (b) => createHash("SHA256").update(b).digest("hex");
  assert.equal(integrity.algorithm, "SHA256");
  assert.equal(integrity.blockSize, 8);
  assert.equal(integrity.hash, sha(buf));
  assert.deepEqual(integrity.blocks, [sha(buf.subarray(0, 8)), sha(buf.subarray(8, 16)), sha(buf.subarray(16, 20))]);
});

test("writeArchiveEntries recomputes per-file asar integrity for replaced entries", () => {
  const fx = fs.mkdtempSync(path.join(tmpRoot, "int-"));
  const asar = path.join(fx, "app.asar");
  const original = "console.log('official');\n";
  buildArchive({ [ENTRY]: Buffer.from(original) }, asar);
  const parsed = readArchive(asar);
  const node = parsed.header.files.out.files.main.files["index.js"];
  node.integrity = { algorithm: "SHA256", hash: "stale-hash", blockSize: 8, blocks: ["stale-block"] };
  const patched = original + 'import("file:///x/inject-main.cjs"); // zcode-prompt-enhancer\n';
  const result = writeArchiveEntries(asar, parsed, new Map([[ENTRY, patched]]));
  assert.equal(result.integrityUpdated, 1, "one integrity field refreshed");
  const expected = computeIntegrity(Buffer.from(patched, "utf8"), 8);
  const reopened = readArchive(asar);
  fs.closeSync(reopened.fd);
  const fresh = reopened.header.files.out.files.main.files["index.js"];
  assert.equal(fresh.integrity.hash, expected.hash, "hash matches the new bytes");
  assert.deepEqual(fresh.integrity.blocks, expected.blocks, "blocks match at the preserved blockSize");
  assert.equal(fresh.integrity.blockSize, 8, "original blockSize preserved");
});

test("readElectronFuses parses the fuse wire and reports named states", () => {
  const fx = fs.mkdtempSync(path.join(tmpRoot, "fuse-"));
  const sentinel = Buffer.from(FUSE_SENTINEL, "latin1");
  const mk = (states) => {
    const exe = path.join(fx, `exe-${states.join("-")}.bin`);
    fs.writeFileSync(exe, Buffer.concat([Buffer.from("MZ junk before"), sentinel, Buffer.from([1]), Buffer.from(states)]));
    return exe;
  };
  // Real builds encode states as ASCII '0'/'1'; raw 0/1 and 'r' also accepted.
  const off = readElectronFuses(mk([0x30, 0x30, 0x30, 0x30, 0x30, 0x30]));
  assert.equal(off.found, true);
  assert.equal(fuseState(off, ASAR_INTEGRITY_FUSE), "disabled");
  const on = readElectronFuses(mk([0x30, 0x30, 0x30, 0x30, 0x31, 0x30]));
  assert.equal(fuseState(on, ASAR_INTEGRITY_FUSE), "enabled");
  const removed = readElectronFuses(mk([0, 0, 0, 0, 0x72, 0]));
  assert.equal(fuseState(removed, ASAR_INTEGRITY_FUSE), "removed");
  const nonePath = path.join(fx, "no-sentinel.bin");
  fs.writeFileSync(nonePath, Buffer.from("MZ no fuse wire here"));
  const none = readElectronFuses(nonePath);
  assert.equal(none.found, false);
  assert.equal(fuseState(none, ASAR_INTEGRITY_FUSE), "unknown");
});

test("applyHostPatch error names the anchor list for future ZCode renames", () => {
  assert.throws(
    () => applyHostPatch("services.register(Qq,zz);\n"),
    new RegExp("HOST_REGISTRATION_VARIANTS"),
  );
  assert.ok(Array.isArray(HOST_REGISTRATION_VARIANTS) && HOST_REGISTRATION_VARIANTS.length >= 1);
});
