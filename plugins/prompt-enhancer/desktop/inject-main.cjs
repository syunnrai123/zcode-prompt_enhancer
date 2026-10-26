/* ZCode Prompt Enhancer — desktop loader (main process, CJS).
 *
 * Loaded from one dynamic-import line appended to the tail of out/main/index.js
 * inside app.asar (see patch-desktop.mjs). Responsibilities:
 *   1) inject overlay.js into every renderer window;
 *   2) bridge renderer -> enhancement CLI: the overlay publishes a request on a
 *      window global, this loader polls it (one combined expression per tick
 *      that also stamps a heartbeat the overlay can watch), spawns dist/cli.js
 *      with ELECTRON_RUN_AS_NODE=1, streams [CONTENT_DELTA] markers back as
 *      __peDeliver messages;
 *   3) fail safe and observable: everything is logged to loader.log in this
 *      directory, missing API keys fail fast with an actionable message, and
 *      any error here never affects the app itself.
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
  var LOGFILE = path.join(HERE, "loader.log");
  var LOG_MAX = 512 * 1024;

  /* ---------- logging (main-process console is invisible for a GUI app) ---------- */

  function log() {
    var line = "[zcode-prompt-enhancer] " + [].slice.call(arguments).join(" ");
    try { console.error(line); } catch (e) { }
    try {
      try {
        var st = fs.statSync(LOGFILE);
        if (st.size > LOG_MAX) {
          try { fs.renameSync(LOGFILE, LOGFILE + ".old"); } catch (e) { fs.writeFileSync(LOGFILE, ""); }
        }
      } catch (e) { /* no file yet */ }
      fs.appendFileSync(LOGFILE, new Date().toISOString() + " " + line + "\n");
    } catch (e) { }
  }

  function readCfg() {
    var cfg = { provider: "", api_key: "", base_url: "", model: "", timeout_seconds: "45", lang: "" };
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) {
      if (fs.existsSync(CONFIG)) log("config.json unreadable:", e.message);
    }
    /* Reuse the values entered in ZCode → Settings → Plugins, which live in
     * the CLI config under plugins.options["prompt-enhancer@..."]. Local
     * config.json wins when it has a non-empty value. */
    try {
      var home = process.env.USERPROFILE || process.env.HOME || "";
      var cliCfgPath = path.join(home, ".zcode", "cli", "config.json");
      var cliCfg = JSON.parse(fs.readFileSync(cliCfgPath, "utf8"));
      var opts = cliCfg && cliCfg.plugins && cliCfg.plugins.options;
      var key = opts && (opts["prompt-enhancer@zcode-prompt-enhancer"] || opts["prompt-enhancer"]);
      if (key && typeof key === "object") {
        ["provider", "api_key", "base_url", "model", "timeout_seconds"].forEach(function (k) {
          if ((cfg[k] === undefined || cfg[k] === "") && key[k] !== undefined && key[k] !== "") cfg[k] = key[k];
        });
      }
    } catch (e) { /* CLI config absent — local config only */ }
    return cfg;
  }

  var PROVIDER_KEY_ENV = {
    glm: ["ZAI_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"],
    "openai-compatible": ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"]
  };
  function hasEnvKey() {
    var all = [];
    Object.keys(PROVIDER_KEY_ENV).forEach(function (p) { all = all.concat(PROVIDER_KEY_ENV[p]); });
    return all.some(function (k) {
      var v = process.env[k];
      return typeof v === "string" && v.trim() !== "";
    });
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
      log("overlay unavailable:", e.message);
      return null;
    }
  }

  function deliver(wc, msg) {
    if (!wc || wc.isDestroyed()) return;
    try {
      // Embed the message as an OBJECT literal. (Double-encoding here would
      // hand __peDeliver a string, whose .id is undefined, silently dropping
      // every result while the UI spins forever.)
      wc.executeJavaScript("window.__peDeliver && window.__peDeliver(" + JSON.stringify(msg) + ")", true)
        .catch(function (e) { log("deliver failed:", e.message); });
    } catch (e) { log("deliver threw:", e.message); }
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
    if (child) {
      inflight.delete(wcId);
      try { child.kill(); log("killed child for wc", wcId); } catch (e) { }
    }
  }

  function runEnhance(wc, req) {
    var wcId = wc.id;
    killInflight(wcId); // one generation at a time per window
    if (!fs.existsSync(CLI)) {
      log("runtime missing:", CLI);
      deliver(wc, { id: req.id, type: "error", code: "RUNTIME_MISSING", message: "运行时缺失: " + CLI + " — 请重新运行 desktop/install.cmd" });
      return;
    }
    var cfg = readCfg();
    var provider = String(cfg.provider || "").trim();
    if (provider !== "mock" && !String(cfg.api_key || "").trim() && !hasEnvKey()) {
      // Fail fast instead of spawning and timing out.
      deliver(wc, {
        id: req.id, type: "error", code: "NO_KEY",
        message: "未配置 API Key:请编辑 " + CONFIG + " 填入 provider 与 api_key(GLM 填 Z.ai 的 Key;或设置环境变量 ZAI_API_KEY;联调可先设 \"provider\":\"mock\")"
      });
      return;
    }

    var started = Date.now();
    var child;
    try {
      child = spawn(process.execPath, [CLI], { env: envFor(cfg), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      deliver(wc, { id: req.id, type: "error", code: "SPAWN_FAILED", message: String(e && e.message || e) });
      return;
    }
    inflight.set(wcId, child);
    log("spawn pid", child.pid, "for req", req.id, "provider:", provider || "auto");

    var timeoutMs = (parseInt(cfg.timeout_seconds, 10) || 45) * 1000;
    var timer = setTimeout(function () {
      deliver(wc, { id: req.id, type: "error", code: "PROVIDER_TIMEOUT", message: "增强超时(" + (timeoutMs / 1000) + "s),已终止" });
      killInflight(wcId);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    var stdoutBuf = "";
    var done = false;
    function handleLine(line) {
      if (line.indexOf("[CONTENT_DELTA] ") === 0) {
        try { deliver(wc, { id: req.id, type: "delta", text: JSON.parse(line.slice(16)) }); } catch (e) { }
      } else if (line.indexOf("[ENHANCED]") === 0) {
        finish(null, line.slice(10).replace(/\{\{NEWLINE\}\}/g, "\n"));
      } else if (line.indexOf("[ENHANCED_ERROR]") === 0) {
        finish(line.slice(16).replace(/\{\{NEWLINE\}\}/g, " "), null);
      }
    }
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
      if (msg) log("cli:", msg.slice(0, 300));
    });
    child.on("error", function (e) { log("child error:", e.message); finish(String(e && e.message || e), null); });
    child.on("close", function (code) {
      log("child exited code", code, "after", Date.now() - started, "ms");
      if (stdoutBuf.trim()) { handleLine(stdoutBuf.trim()); stdoutBuf = ""; }
      finish("增强进程退出但未返回结果(exit " + code + ")", null);
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
  /* One expression per tick: stamps the heartbeat the overlay watches and
   * returns [requestSeq, cancelSeq] in a single round trip. */
  var POLL_EXPR = '(function(){window.__peBridgeTs=Date.now();' +
    'return JSON.stringify([window.__peRequestSeq||0,window.__peCancelSeq||0])})()';
  var FETCH_EXPR = '(function(){var r=window.__peRequest;window.__peRequest=null;' +
    'return r?JSON.stringify(r):null})()';

  function attach(wc) {
    if (!wc || typeof wc.isDestroyed !== "function") return;
    var wcId;
    try { wcId = wc.id; } catch (e) { return; }
    log("attach wc", wcId);
    try {
      wc.on("did-finish-load", function () { injectOverlay(wc); });
      wc.on("destroyed", function () { killInflight(wcId); });
      injectOverlay(wc);
    } catch (e) { log("attach failed:", e.message); }

    var lastReq = 0, lastCancel = 0, errCount = 0;
    var timer = setInterval(function () {
      try {
        if (wc.isDestroyed()) { clearInterval(timer); killInflight(wcId); return; }
        wc.executeJavaScript(POLL_EXPR, true).then(function (raw) {
          var seqs;
          try { seqs = JSON.parse(raw); } catch (e) { return; }
          if (!Array.isArray(seqs)) return;
          if (typeof seqs[0] === "number" && seqs[0] > lastReq) {
            lastReq = seqs[0];
            return wc.executeJavaScript(FETCH_EXPR, true).then(function (payload) {
              if (!payload) return;
              try {
                var req = JSON.parse(payload);
                log("request", req.id, "draftLen", String(req.draft || "").length);
                runEnhance(wc, req);
              } catch (e) { log("bad request payload:", e.message); }
            });
          }
          if (typeof seqs[1] === "number" && seqs[1] > lastCancel) {
            lastCancel = seqs[1];
            log("cancel seen");
            killInflight(wcId);
          }
        }).catch(function (e) {
          errCount++;
          if (errCount === 1 || errCount % 50 === 0) log("poll error #" + errCount + ":", e.message);
        });
      } catch (e) {
        errCount++;
        if (errCount === 1) log("poll threw:", e.message);
      }
    }, POLL_MS);
    if (timer.unref) timer.unref(); // never keep the process (or tests) alive
    wc.on("destroyed", function () { clearInterval(timer); });
  }

  function injectOverlay(wc) {
    var src = overlaySrc();
    if (!src) return;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.executeJavaScript(src, true).then(
        function () { },
        function (e) { log("overlay inject failed:", e.message); }
      );
    } catch (e) { log("overlay inject failed:", e.message); }
  }

  var app = electron.app;
  app.on("web-contents-created", function (_event, wc) { attach(wc); });
  app.whenReady().then(function () {
    try {
      electron.BrowserWindow.getAllWindows().forEach(function (win) { attach(win.webContents); });
    } catch (e) { log("window scan failed:", e.message); }
  });
  log("desktop loader active at", HERE, "cli exists:", fs.existsSync(CLI));
})();
