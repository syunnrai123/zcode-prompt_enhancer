/* ZCode Prompt Enhancer — desktop loader (main process, CJS).
 *
 * Loaded from one dynamic-import line appended to the tail of out/main/index.js
 * inside app.asar (see patch-desktop.mjs). It injects the renderer scripts:
 *
 *   system-prompt.generated.js  canonical enhancement rules
 *   session-context.js          current composer model / workspace lookup
 *   host-bridge.js              calls the session model through the Host
 *   overlay.js                  ✦ button, preview panel, apply/revert/cancel
 *
 * All generation happens through the app's own Host connection, so there is
 * no separate provider configuration, no API key and no child process.
 */
"use strict";

(function () {
  if (process.__peLoaderActive) return;
  var path = require("path");
  var fs = require("fs");

  var electron = null;
  try { electron = require("electron"); } catch (e) { /* not inside Electron */ }
  if (!electron || !electron.app || !electron.BrowserWindow) {
    console.error("[zcode-prompt-enhancer] electron APIs unavailable; loader inactive");
    return;
  }
  process.__peLoaderActive = true;

  var HERE = __dirname;
  var LOGFILE = path.join(HERE, "loader.log");
  var LOG_MAX = 512 * 1024;
  var SCRIPTS = [
    "system-prompt.generated.js",
    "session-context.js",
    "host-bridge.js",
    "overlay.js"
  ];

  function log() {
    var line = "[zcode-prompt-enhancer] " + [].slice.call(arguments).join(" ");
    try { console.error(line); } catch (e) { }
    try {
      try {
        var st = fs.statSync(LOGFILE);
        if (st.size > LOG_MAX) {
          try { fs.renameSync(LOGFILE, LOGFILE + ".old"); } catch (e) { fs.writeFileSync(LOGFILE, ""); }
        }
      } catch (e) { /* no log yet */ }
      fs.appendFileSync(LOGFILE, new Date().toISOString() + " " + line + "\n");
    } catch (e) { }
  }

  /* Re-read scripts when mtime changes so runtime-dir updates apply on the next
   * page load without an app restart. A syntax gate prevents half-written files
   * from ever being injected. */
  var cache = {};
  function sourceOf(name) {
    var file = path.join(HERE, name);
    try {
      var mtime = fs.statSync(file).mtimeMs;
      var hit = cache[name];
      if (!hit || hit.mtime !== mtime) {
        var src = fs.readFileSync(file, "utf8");
        new Function(src);
        cache[name] = { mtime: mtime, src: src };
      }
      return cache[name].src;
    } catch (e) {
      log("script unavailable:", name, e.message);
      return null;
    }
  }

  function inject(wc) {
    if (!wc || wc.isDestroyed()) return;
    var scripts = [];
    for (var i = 0; i < SCRIPTS.length; i++) {
      var src = sourceOf(SCRIPTS[i]);
      if (!src) return;
      scripts.push(src);
    }
    /* One executeJavaScript call keeps the definitions in a single world and
     * guarantees ordering (definitions before the overlay starts). */
    try {
      wc.executeJavaScript(scripts.join("\n;\n"), true).then(
        function () { log("scripts injected into wc", wc.id); },
        function (e) { log("inject failed:", e.message); }
      );
    } catch (e) { log("inject threw:", e.message); }
  }

  var attached = new WeakSet();
  function attach(wc) {
    if (!wc || typeof wc.isDestroyed !== "function" || attached.has(wc)) return;
    attached.add(wc);
    try {
      wc.on("did-finish-load", function () { inject(wc); });
      inject(wc);
    } catch (e) { log("attach failed:", e.message); }
  }

  electron.app.on("web-contents-created", function (_event, wc) { attach(wc); });
  electron.app.whenReady().then(function () {
    try {
      electron.BrowserWindow.getAllWindows().forEach(function (win) { attach(win.webContents); });
    } catch (e) { log("window scan failed:", e.message); }
  });
  log("desktop loader active at", HERE, "scripts:", SCRIPTS.join(", "));
})();
