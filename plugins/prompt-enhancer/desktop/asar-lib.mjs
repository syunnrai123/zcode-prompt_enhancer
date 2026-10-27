/* asar read/write primitives shared by patch-desktop.mjs and its round-trip test.
 *
 * Layout (verified against the real archive):
 * [0..3]   UInt32LE = 4
 * [4..7]   UInt32LE = 8 + align4(jsonLen)
 * [8..11]  UInt32LE = 4 + align4(jsonLen)
 * [12..15] UInt32LE = jsonLen
 * [16..]   header JSON (utf8), zero-padded to 4
 * data region starts at 16 + align4(jsonLen); packed file offsets in the JSON
 * are relative to that start. Unpacked entries have no offset and no bytes
 * inside the archive.
 */

import fs from "node:fs";
import crypto from "node:crypto";

export const ENTRY = "out/main/index.js";
export const INJECT_TAG = "zcode-prompt-enhancer";
// Matches our injection lines wherever the tag appears (URL or the error
// message), so old lines pointing at moved/deleted directories still strip.
export const INJECT_LINE_RE = new RegExp(
  String.raw`\n?;?import\("[^"]*inject-main\.cjs"\)[^\n]*${INJECT_TAG}[^\n]*;`,
  "g"
);

/* ---------- Electron asar per-file integrity ----------
 * Archives built with integrity carry, per packed file:
 *   integrity: { algorithm: "SHA256", hash, blockSize, blocks: [hex, ...] }
 * Electron validates these when reading resources. Rewriting an entry's bytes
 * without recomputing its integrity would corrupt the archive, so any entry
 * we replace gets a fresh hash/block list. */
const DEFAULT_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

export function computeIntegrity(buffer, blockSize = DEFAULT_INTEGRITY_BLOCK_SIZE) {
  const blocks = [];
  for (let off = 0; off < buffer.length; off += blockSize) {
    blocks.push(crypto.createHash("SHA256").update(buffer.subarray(off, off + blockSize)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("SHA256").update(buffer).digest("hex"),
    blockSize,
    blocks,
  };
}

/* ---------- Electron fuse wire (read-only detection) ----------
 * Layout (verified against the real ZCode executable): the ASCII sentinel is
 * followed by [version:1][one state byte per fuse]. Real builds encode each
 * state as the ASCII character '0' (=0x30, off) or '1' (=0x31, on); some
 * tooling uses raw 0/1 bytes or 0x72 ('r', removed). Accept all encodings.
 * We only need to know whether asar-integrity validation is ON, because then
 * ANY header modification breaks the boot hash embedded in the binary and the
 * patched app would not start — install must refuse up front. */
export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
];
export const ASAR_INTEGRITY_FUSE = "EnableEmbeddedAsarIntegrityValidation";

export function readElectronFuses(exePath) {
  const buf = fs.readFileSync(exePath);
  const sentinel = Buffer.from(FUSE_SENTINEL, "latin1");
  const at = buf.indexOf(sentinel);
  if (at < 0) return { found: false, states: [] };
  const base = at + sentinel.length + 1; // skip the fuse-wire version byte
  const stateBytes = buf.subarray(base, base + 32);
  if (stateBytes.length < FUSE_NAMES.length) return { found: false, states: [] };
  return { found: true, states: Array.from(stateBytes) };
}

export function fuseState(fuses, name) {
  const i = FUSE_NAMES.indexOf(name);
  if (!fuses.found || i < 0 || i >= fuses.states.length) return "unknown";
  const v = fuses.states[i];
  if (v === 0x30 || v === 0) return "disabled";       // '0' / 0
  if (v === 0x31 || v === 1) return "enabled";        // '1' / 1
  if (v === 0x72) return "removed";                   // 'r'
  return "unknown";
}

export function align4(n) {
  return n + ((4 - (n % 4)) % 4);
}

export function readArchive(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  let parsed;
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const jsonLen = prefix.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString("utf8"));
    const dataStart = 16 + align4(jsonLen);
    parsed = { fd, header, dataStart };
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { }
    throw e;
  }
  return parsed;
}

/** Flat list of packed (in-archive) files in ascending data-offset order. */
export function packedFiles(header, dataStart) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else if (typeof entry.offset === "string") {
        out.push({ path: p, node: entry, offset: dataStart + Number(entry.offset), size: entry.size | 0 });
      }
    }
  };
  walk(header, "");
  out.sort((a, b) => a.offset - b.offset);
  return out;
}

export function readEntry(fd, entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, entry.offset);
  return buf;
}

export function findEntry(parsed, entryPath) {
  return packedFiles(parsed.header, parsed.dataStart).find((f) => f.path === entryPath);
}

export function readEntryText(parsed, entryPath) {
  const entry = findEntry(parsed, entryPath);
  if (!entry) throw new Error(`${entryPath} not found in archive`);
  const buf = readEntry(parsed.fd, entry);
  return buf.toString("utf8");
}

/** One-shot read of an entry's text; opens and always closes the archive. */
export function readEntryTextFrom(asarPath, entryPath) {
  const parsed = readArchive(asarPath);
  try {
    return readEntryText(parsed, entryPath);
  } finally {
    fs.closeSync(parsed.fd);
  }
}

export function stripInjectLines(text) {
  return text.replace(INJECT_LINE_RE, "");
}

/** Build the inject line pointing at the loader. */
export function buildInjectLine(loaderAbsPath) {
  const url = new URL("file:///" + loaderAbsPath.replace(/\\/g, "/")).href;
  return `\n;import(${JSON.stringify(url)}).then(null, e => console.error("[${INJECT_TAG}] load failed", e));`;
}

/**
 * Rewrite the archive with one or more entries replaced. Streams every packed
 * file in offset order, recomputes shifted offsets, serializes a fresh header,
 * and atomically renames over the original. Closes the parsed fd.
 */
export function writeArchive(asarPath, parsed, entryPath, newEntryText) {
  return writeArchiveEntries(asarPath, parsed, new Map([[entryPath, newEntryText]]));
}

export function writeArchiveEntries(asarPath, parsed, replacements) {
  let fd = parsed.fd;
  const { header, dataStart } = parsed;
  let integrityUpdated = 0;
  try {
    const files = packedFiles(header, dataStart);
    const encoded = new Map();
    for (const [entryPath, text] of replacements) {
      const entry = files.find((f) => f.path === entryPath);
      if (!entry) throw new Error(`entry ${entryPath} not found in archive`);
      const buffer = Buffer.from(text, "utf8");
      encoded.set(entry, buffer);
      entry.node.size = buffer.length;
      if (entry.node.integrity) {
        entry.node.integrity = computeIntegrity(buffer, entry.node.integrity.blockSize || DEFAULT_INTEGRITY_BLOCK_SIZE);
        integrityUpdated++;
      }
    }

    // Header length depends on the offset digits, and offsets depend on the
    // header length — iterate until both are stable (converges in 1-2 passes).
    let headerLen = 0;
    let json = "";
    let padded = 0;
    for (let iter = 0; iter < 5; iter++) {
      json = JSON.stringify(header);
      padded = align4(Buffer.byteLength(json, "utf8"));
      const next = 16 + padded;
      if (next === headerLen) break;
      headerLen = next;
      let cursor = headerLen;
      for (const f of files) {
        const size = encoded.get(f)?.length ?? f.size;
        f.node.offset = String(cursor - headerLen);
        cursor += size;
      }
    }

    const jsonLen = Buffer.byteLength(json, "utf8");
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(8 + padded, 4);
    prefix.writeUInt32LE(4 + padded, 8);
    prefix.writeUInt32LE(jsonLen, 12);
    const jsonOut = Buffer.alloc(padded);
    jsonOut.write(json, 0, "utf8");

    const tmpPath = asarPath + ".pe-new.tmp";
    const out = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(out, prefix);
      fs.writeSync(out, jsonOut);

      let cursor = headerLen;
      const block = 4 * 1024 * 1024;
      const buf = Buffer.alloc(block);
      for (const f of files) {
        const replacement = encoded.get(f);
        if (replacement) {
          fs.writeSync(out, replacement);
          cursor += replacement.length;
        } else {
          let remaining = f.size;
          let pos = f.offset;
          while (remaining > 0) {
            const n = Math.min(block, remaining);
            fs.readSync(fd, buf, 0, n, pos);
            fs.writeSync(out, buf, 0, n);
            pos += n;
            remaining -= n;
            cursor += n;
          }
        }
      }
    } finally {
      fs.closeSync(out);
    }
    // Windows: the rename fails with EPERM while any handle to the original
    // archive is still open, so close the read handle before replacing.
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, asarPath);
    return { changed: [...encoded.keys()].map((f) => f.path), integrityUpdated };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) { }
  }
}

/** Build a minimal valid asar from { path: Buffer } — for tests. */
export function buildArchive(filesMap, outPath) {
  const header = { files: {} };
  let offset = 0;
  const entries = [];
  for (const [p, buf] of Object.entries(filesMap)) {
    const parts = p.split("/");
    let node = header.files;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= { files: {} };
      node = node[parts[i]].files;
    }
    node[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    entries.push({ p, buf });
    offset += buf.length;
  }
  const json = JSON.stringify(header);
  const jsonLen = Buffer.byteLength(json, "utf8");
  const padded = align4(jsonLen);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(jsonLen, 12);
  const jsonOut = Buffer.alloc(padded);
  jsonOut.write(json, 0, "utf8");
  const out = Buffer.concat([prefix, jsonOut, ...entries.map((e) => e.buf)]);
  fs.writeFileSync(outPath, out);
}
