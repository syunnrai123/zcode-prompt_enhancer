/* ZCode Prompt Enhancer — desktop loader (main process, CJS).
 *
 * Loaded from one dynamic-import line appended to the tail of out/main/index.js
 * inside app.asar (see patch-desktop.mjs). Responsibilities:
 *   1) inject overlay.js into every renderer window (composer input-box button,
 *      preview panel, apply/revert);
 *   2) bridge renderer -> enhancement CLI: the overlay publishes a request on a
 *      window global, this loader polls it, spawns dist/cli.js with
 *      ELECTRON_RUN_AS_NODE=1 (the bundled executable behaves as plain node),
 *      streams [CONTENT_DELTA] markers back as __peDeliver messages;
 *   3) fail safe: any error here only logs; the app itself is never affected.
 *
 * The loader is self-locating (__dirname = runtime dir), so it survives ZCode
 * plugin cache updates. Removing the inject line restores the app to its
 * official state; a stale line pointing at deleted files just logs one error.
 */
"use strict";

(function () {
  if (process.__peLoaderActive) return;
  var path = require("path");
  var fs = require("fs");
  var spawn = require("child_process").spawn;

  var electron = null;
  try { electron = require("electron"); } catch (e) { /* not inside Electron */ }
  if (!electron || !electron.app || !electron.BrowserWindow) {
    console.error("[zcode-prompt-enhancer] electron APIs unavailable; loader inactive");
    return;
  }
  process.__peLoaderActive = true;

  var HERE = __dirname;
  var OVERLAY = path.join(HERE, "overlay.js");
  var CLI = path.join(HERE, "dist", "cli.js");
  var CONFIG = path.join(HERE, "config.json");
  var LOG = function () {
    try { console.error.apply(console, ["[zcode-prompt-enhancer]"].concat([].slice.call(arguments))); } catch (e) { }
  };

  function readCfg() {
    var cfg = { provider: "", api_key: "", base_url: "", model: "", timeout_seconds: "45", lang: "" };
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
    return cfg;
  }

  /* Overlay source cache: re-read on mtime change so a runtime-dir update
   * applies to the next window load without an app restart. */
  var overlayCache = { mtime: 0, src: "" };
  function overlaySrc() {
    try {
      var m = fs.statSync(OVERLAY).mtimeMs;
      if (overlayCache.mtime !== m) {
        var src = fs.readFileSync(OVERLAY, "utf8");
        new Function(src); // syntax gate: never load a half-written file
        overlayCache = { mtime: m, src: src };
      }
      return overlayCache.src;
    } catch (e) {
      LOG("overlay unavailable:", e.message);
      return null;
    }
  }

  function deliver(wc, msg) {
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.executeJavaScript("window.__peDeliver && window.__peDeliver(" + JSON.stringify(JSON.stringify(msg)) + ")", true)
        .catch(function () { });
    } catch (e) { }
  }

  /* ---------- enhancement execution ---------- */

  var inflight = new Map(); // webContents.id -> child process

  function envFor(cfg) {
    var env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" });
    var map = {
      PROMPT_ENHANCER_PROVIDER: cfg.provider,
      PROMPT_ENHANCER_API_KEY: cfg.api_key,
      PROMPT_ENHANCER_BASE_URL: cfg.base_url,
      PROMPT_ENHANCER_MODEL: cfg.model,
      PROMPT_ENHANCER_TIMEOUT_SECONDS: cfg.timeout_seconds
    };
    Object.keys(map).forEach(function (k) {
      if (typeof map[k] === "string" && map[k] !== "") env[k] = map[k];
    });
    return env;
  }

  function killInflight(wcId) {
    var child = inflight.get(wcId);
    if (child) { inflight.delete(wcId); try { child.kill(); } catch (e) { } }
  }

  function runEnhance(wc, req) {
    var wcId = wc.id;
    killInflight(wcId); // one generation at a time per window
    if (!fs.existsSync(CLI)) {
      deliver(wc, { id: req.id, type: "error", code: "RUNTIME_MISSING", message: "dist/cli.js not found under " + HERE });
      return;
    }
    var cfg = readCfg();
    var started = Date.now();
    var child;
    try {
      child = spawn(process.execPath, [CLI], { env: envFor(cfg), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      deliver(wc, { id: req.id, type: "error", code: "SPAWN_FAILED", message: String(e && e.message || e) });
      return;
    }
    inflight.set(wcId, child);

    var timeoutMs = (parseInt(cfg.timeout_seconds, 10) || 45) * 1000;
    var timer = setTimeout(function () {
      deliver(wc, { id: req.id, type: "error", code: "PROVIDER_TIMEOUT", message: "enhancement timed out after " + (timeoutMs / 1000) + "s" });
      killInflight(wcId);
    }, timeoutMs);

    var stdoutBuf = "";
    function handleLine(line) {
      if (line.indexOf("[CONTENT_DELTA] ") === 0) {
        try { deliver(wc, { id: req.id, type: "delta", text: JSON.parse(line.slice(16)) }); } catch (e) { }
      } else if (line.indexOf("[ENHANCED]") === 0) {
        var text = line.slice(10).replace(/\{\{NEWLINE\}\}/g, "\n");
        finish(null, text);
      } else if (line.indexOf("[ENHANCED_ERROR]") === 0) {
        finish(line.slice(16).replace(/\{\{NEWLINE\}\}/g, " "), null);
      }
    }
    var done = false;
    function finish(errText, okText) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      inflight.delete(wcId);
      if (errText !== null) deliver(wc, { id: req.id, type: "error", message: errText });
      else deliver(wc, { id: req.id, type: "done", text: okText, ms: Date.now() - started });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", function (chunk) {
      stdoutBuf += chunk;
      var nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        handleLine(stdoutBuf.slice(0, nl).replace(/\r$/, ""));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", function (chunk) {
      var msg = String(chunk).trim();
      if (msg) LOG("cli:", msg.slice(0, 300));
    });
    child.on("error", function (e) { finish(String(e && e.message || e), null); });
    child.on("close", function () {
      // Drain any final markerless buffer, then resolve outstanding requests.
      if (stdoutBuf.trim()) { handleLine(stdoutBuf.trim()); stdoutBuf = ""; }
      finish("enhancement process exited without a result", null);
    });

    try {
      child.stdin.write(JSON.stringify({ prompt: String(req.draft || "") }) + "\n");
      child.stdin.end();
    } catch (e) {
      finish(String(e && e.message || e), null);
    }
  }

  /* ---------- renderer attach + request pump ---------- */

  var POLL_MS = 150;

  function attach(wc) {
    if (!wc || wc.isDestroyed === undefined) return;
    try {
      wc.on("did-finish-load", function () { injectOverlay(wc); });
      wc.on("destroyed", function () { killInflight(wc.id); });
      injectOverlay(wc);
    } catch (e) { LOG("attach failed:", e.message); }

    var lastReq = 0, lastCancel = 0;
    var timer = setInterval(function () {
      if (wc.isDestroyed()) { clearInterval(timer); killInflight(wc.id); return; }
      wc.executeJavaScript("(window.__peRequestSeq||0)", true).then(function (seq) {
        if (typeof seq === "number" && seq > lastReq) {
          lastReq = seq;
          return wc.executeJavaScript(
            "(function(){var r=window.__peRequest;window.__peRequest=null;return r?JSON.stringify(r):null})()",
            true
          ).then(function (raw) {
            if (!raw) return;
            try { runEnhance(wc, JSON.parse(raw)); } catch (e) { LOG("bad request:", e.message); }
          });
        }
        return wc.executeJavaScript("(window.__peCancelSeq||0)", true).then(function (cseq) {
          if (typeof cseq === "number" && cseq > lastCancel) { lastCancel = cseq; killInflight(wc.id); }
        });
      }).catch(function () { /* window navigated away mid-poll */ });
    }, POLL_MS);
    wc.on("destroyed", function () { clearInterval(timer); });
  }

  function injectOverlay(wc) {
    var src = overlaySrc();
    if (!src) return;
    if (wc.isDestroyed()) return;
    try {
      wc.executeJavaScript(src, true).catch(function (e) { LOG("overlay inject failed:", e.message); });
    } catch (e) { LOG("overlay inject failed:", e.message); }
  }

  var app = electron.app;
  app.on("web-contents-created", function (_event, wc) { attach(wc); });
  app.whenReady().then(function () {
    try {
      electron.BrowserWindow.getAllWindows().forEach(function (win) { attach(win.webContents); });
    } catch (e) { LOG("window scan failed:", e.message); }
  });
  LOG("desktop loader active at", HERE);
})();
