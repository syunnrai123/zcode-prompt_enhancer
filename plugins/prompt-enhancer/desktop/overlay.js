/* ZCode Prompt Enhancer — renderer overlay (self-contained IIFE).
 *
 * Injected into renderer windows by inject-main.cjs. Adds:
 *   - an "enhance" (增强) icon button in the composer toolbar, placed just
 *     LEFT of the right-hand cluster (model selector / context capacity /
 *     send). Foreign nodes between React children are left alone by React;
 *     a rescan loop re-mounts anything a re-render dropped or reordered.
 *   - a preview container mounted inside the composer card below the toolbar
 *     row: streams the enhanced prompt as it is generated, stays editable,
 *     and only replaces the input draft when the user confirms.
 *   - apply ("使用增强结果") / revert ("恢复原稿") via the composer's built-in
 *     E2E lexical bridge (__zcodeLexicalInputE2E), cancel while generating,
 *     and a bridge watchdog so the UI can never spin forever silently.
 *
 * All colors/fonts come from the app's CSS custom properties. Communication
 * with the main process: requests via polled window globals, responses via
 * __peDeliver, liveness via the loader-stamped __peBridgeTs heartbeat.
 */
(function () {
  if (window.__peOverlay) return;
  window.__peOverlay = true;
  if (window.__peDispose) { try { window.__peDispose(); } catch (e) { } }
  var MY_GEN = (window.__peGen = (window.__peGen || 0) + 1);
  function stale() { return MY_GEN !== window.__peGen; }

  var ZH = /^zh/i.test(String(document.documentElement.lang || navigator.language || "zh"));
  function L(zh, en) { return ZH ? zh : en; }

  var INPUT_SEL = '[data-testid="v4-composer-input"]';
  /* Right-hand cluster of the toolbar: model selector, context capacity, send.
   * The button mounts immediately before the first of these. */
  var RIGHT_CLUSTER_SEL = [
    '[data-testid="chat-model-select-trigger"]',
    '[data-testid="chat-context-usage-trigger"]',
    ".chat-context-usage-trigger",
    '[data-testid="v4-composer-send"]'
  ].join(", ");
  var CUA_BTN_SEL = '[data-testid="v4-composer-cua-entry"]';

  var BRIDGE_STALE_MS = 3000;  // loader heartbeat older than this = bridge down
  var HARD_TIMEOUT_MS = 90000; // overlay-side cap: never spin forever

  /* ---------- channel ---------- */

  var routes = {}; // request id -> {onDelta,onDone,onError}
  var reqSeq = 0;
  var activeId = 0;

  window.__peDeliver = function (msg) {
    var r = routes[msg && msg.id];
    if (!r) return;
    if (msg.type === "delta" && r.onDelta) r.onDelta(msg.text || "");
    else if (msg.type === "done") { delete routes[msg.id]; r.onDone && r.onDone(msg.text || "", msg.ms || 0); }
    else if (msg.type === "error") { delete routes[msg.id]; r.onError && r.onError(msg.message || "unknown error"); }
  };

  function bridgeFresh() {
    var ts = window.__peBridgeTs;
    return typeof ts === "number" && (Date.now() - ts) < BRIDGE_STALE_MS;
  }
  function callEnhance(draft, handlers) {
    var id = ++reqSeq;
    routes[id] = handlers;
    activeId = id;
    window.__peRequest = { id: id, draft: draft };
    window.__peRequestSeq = id;
  }
  function cancelEnhance() {
    if (!activeId) return;
    delete routes[activeId];
    window.__peCancel = { id: activeId };
    window.__peCancelSeq = activeId;
    activeId = 0;
  }

  /* ---------- DOM helpers ---------- */

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function toolbarRowOf(card) {
    try {
      var kids = card.children;
      for (var i = kids.length - 1; i >= 0; i--) {
        if (String(kids[i].className || "").indexOf("group/toolbar") >= 0) return kids[i];
      }
    } catch (e) { }
    return null;
  }
  function cardOf(input) {
    var node = input;
    while (node && node !== document.body) {
      if (toolbarRowOf(node)) return node;
      node = node.parentElement;
    }
    return null;
  }
  function bridgeOf(input) {
    try {
      if (input && input.__zcodeLexicalInputE2E && input.getAttribute("data-e2e-lexical-bridge") === "ready") {
        return input.__zcodeLexicalInputE2E;
      }
    } catch (e) { }
    return null;
  }
  function sessionKeyOf(input) {
    var node = input;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute("data-session-id")) return node.getAttribute("data-session-id");
      node = node.parentElement;
    }
    return "default";
  }

  var ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"></path>' +
    '<path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path></svg>';
  var SPINNER = '<svg class="pe-spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M12 3a9 9 0 1 0 9 9"></path></svg>';

  /* ---------- styles ---------- */

  var STYLE_ID = "pe-overlay-style";
  var CSS = [
    ".pe-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--color-muted-foreground,#8a8f98);cursor:pointer;transition:background .12s ease,color .12s ease;flex:0 0 auto}",
    ".pe-btn:hover{background:var(--color-surface-hover,rgba(0,0,0,.06));color:var(--color-foreground,#222)}",
    ".pe-btn:disabled{opacity:.55;cursor:default}",
    ".pe-btn.pe-applied{color:var(--color-success,#3fb950)}",
    ".pe-spin{animation:pe-rotate .8s linear infinite}",
    "@keyframes pe-rotate{to{transform:rotate(360deg)}}",
    ".pe-panel{display:flex;flex-direction:column;gap:0;margin-top:10px;border:1px solid var(--color-popover-border,var(--color-border,#d5d8dd));border-radius:12px;background:var(--color-popover,var(--color-background,#fff));box-shadow:0 8px 28px rgba(0,0,0,.14),0 1px 4px rgba(0,0,0,.10);overflow:hidden;font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-text-sm-size,13px);line-height:1.55}",
    ".pe-panel-head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--color-border,#eceef2);color:var(--color-foreground,#222)}",
    ".pe-panel-title{font-weight:var(--font-weight-semibold,600)}",
    ".pe-panel-status{color:var(--color-muted-foreground,#8a8f98);font-size:12px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}",
    ".pe-panel-status.pe-error{color:var(--color-text-danger,var(--color-danger,#e5534b))}",
    ".pe-panel-x{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--color-muted-foreground,#8a8f98);cursor:pointer;font-size:14px;line-height:1}",
    ".pe-panel-x:hover{background:var(--color-surface-hover,rgba(0,0,0,.06));color:var(--color-foreground,#222)}",
    ".pe-panel-body{padding:0}",
    ".pe-panel textarea{display:block;width:100%;min-height:84px;max-height:260px;resize:none;border:0;outline:0;padding:10px 12px;background:transparent;color:var(--color-foreground,#222);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-text-sm-size,13px);line-height:1.6;overflow:auto}",
    ".pe-panel-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--color-border,#eceef2)}",
    ".pe-btn-primary{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:8px;background:var(--color-primary,#5b6cff);color:var(--color-primary-foreground,#fff);font-size:12.5px;font-weight:var(--font-weight-medium,500);cursor:pointer}",
    ".pe-btn-primary:hover{filter:brightness(1.06)}",
    ".pe-btn-primary:disabled{opacity:.5;cursor:default;filter:none}",
    ".pe-btn-ghost{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--color-border,#d5d8dd);border-radius:8px;background:transparent;color:var(--color-muted-foreground,#59626e);font-size:12.5px;cursor:pointer}",
    ".pe-btn-ghost:hover{background:var(--color-surface-hover,rgba(0,0,0,.05));color:var(--color-foreground,#222)}",
    ".pe-btn-ghost:disabled{opacity:.5;cursor:default}",
    ".pe-foot-note{color:var(--color-muted-foreground,#8a8f98);font-size:12px;margin-left:auto;white-space:nowrap}"
  ].join("\n");

  /* ---------- per-composer controller ---------- */

  var appliedBySession = {}; // sessionKey -> {original, enhanced}
  var ctlByInput = new WeakMap();

  function ensureCtl(input) {
    var ctl = ctlByInput.get(input);
    if (ctl && document.body.contains(ctl.btn)) return ctl;
    if (ctl) { ctl.destroy(); }
    ctl = createCtl(input);
    ctlByInput.set(input, ctl);
    return ctl;
  }

  function createCtl(input) {
    var card = cardOf(input);
    var row = card && toolbarRowOf(card);
    if (!row || !card) return null;

    var state = { busy: false, dirty: false, text: "", original: "" };
    var sessionKey = sessionKeyOf(input);

    var btn = el("button", "pe-btn", ICON);
    btn.type = "button";
    btn.title = L("增强提示词", "Enhance prompt");
    btn.setAttribute("aria-label", btn.title);

    var panel = el("div", "pe-panel");
    panel.style.display = "none";
    var head = el("div", "pe-panel-head");
    var title = el("span", "pe-panel-title", L("提示词增强", "Prompt enhancement"));
    var status = el("span", "pe-panel-status", "");
    var x = el("button", "pe-panel-x", "&times;");
    x.type = "button"; x.title = L("关闭", "Close");
    head.appendChild(title); head.appendChild(status); head.appendChild(x);

    var body = el("div", "pe-panel-body");
    var ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.placeholder = L("增强后的提示词将在这里生成,可直接修改", "The enhanced prompt appears here; edit freely");
    body.appendChild(ta);

    var foot = el("div", "pe-panel-foot");
    var cancelBtn = el("button", "pe-btn-ghost", L("取消", "Cancel"));
    cancelBtn.type = "button"; cancelBtn.style.display = "none";
    var applyBtn = el("button", "pe-btn-primary", L("使用增强结果", "Use enhanced"));
    applyBtn.type = "button"; applyBtn.disabled = true;
    var revertBtn = el("button", "pe-btn-ghost", L("恢复原稿", "Restore draft"));
    revertBtn.type = "button";
    var retryBtn = el("button", "pe-btn-ghost", L("重新生成", "Retry"));
    retryBtn.type = "button"; retryBtn.style.display = "none";
    var note = el("span", "pe-foot-note", "");
    foot.appendChild(cancelBtn); foot.appendChild(applyBtn); foot.appendChild(revertBtn); foot.appendChild(retryBtn); foot.appendChild(note);

    panel.appendChild(head); panel.appendChild(body); panel.appendChild(foot);

    /* Button sits immediately LEFT of the right-hand cluster (model selector,
     * context capacity, send). Falls back to after the CUA tool button. */
    function mount() {
      var anchor = null;
      try {
        var kids = row.children;
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if ((k.matches && k.matches(RIGHT_CLUSTER_SEL)) ||
            (k.querySelector && k.querySelector(RIGHT_CLUSTER_SEL))) { anchor = k; break; }
        }
      } catch (e) { }
      if (anchor && anchor.parentElement === row) {
        if (btn.nextSibling !== anchor) row.insertBefore(btn, anchor);
      } else {
        var cua = row.querySelector(CUA_BTN_SEL);
        if (cua && cua.parentElement === row && cua.nextSibling !== btn) row.insertBefore(btn, cua.nextSibling);
        else if (btn.parentElement !== row) row.appendChild(btn);
      }
      var ref = row.nextSibling;
      if (ref && ref.parentElement === card && ref !== panel) card.insertBefore(panel, ref);
      else if (panel.parentElement !== card) card.appendChild(panel);
    }

    function setStatus(text, isError) {
      status.textContent = text;
      status.className = "pe-panel-status" + (isError ? " pe-error" : "");
    }
    function openPanel() { panel.style.display = "flex"; mount(); try { ta.focus(); } catch (e) { } }
    function closePanel() { panel.style.display = "none"; }
    function refreshApplied() {
      var ap = appliedBySession[sessionKey];
      btn.classList.toggle("pe-applied", !!ap);
      if (ap) btn.title = L("提示词已增强(点击查看/撤销)", "Prompt enhanced (click to review/undo)");
      else btn.title = L("增强提示词", "Enhance prompt");
      revertBtn.style.display = ap && !state.busy ? "" : "none";
    }

    function currentDraft() {
      var api = bridgeOf(input);
      try { return api ? String(api.getText() || "") : ""; } catch (e) { return ""; }
    }
    function setDraft(text) {
      var api = bridgeOf(input);
      if (!api) return false;
      try { api.setText(text); return true; } catch (e) { return false; }
    }

    function resetBusyUi() {
      state.busy = false;
      btn.disabled = false; btn.innerHTML = ICON;
      cancelBtn.style.display = "none";
      ta.readOnly = false;
      refreshApplied();
    }

    function run() {
      var draft = currentDraft();
      state.original = draft;
      if (!draft.trim()) {
        ta.value = ""; state.text = ""; state.dirty = false;
        setStatus(L("输入框为空:请先输入提示词草稿", "Composer is empty: type a draft first"), true);
        applyBtn.disabled = true; retryBtn.style.display = "none"; note.textContent = "";
        openPanel();
        return;
      }
      state.busy = true; state.dirty = false; state.text = "";
      ta.value = ""; ta.readOnly = true;
      btn.disabled = false; btn.innerHTML = SPINNER;
      cancelBtn.style.display = "";
      applyBtn.disabled = true; retryBtn.style.display = "none"; revertBtn.style.display = "none";
      note.textContent = "";
      var t0 = Date.now();
      var warnedBridge = false;
      setStatus(bridgeFresh()
        ? L("生成中…", "Generating…")
        : L("等待主进程桥接…", "Waiting for main-process bridge…"), !bridgeFresh());
      openPanel();

      var tick = setInterval(function () {
        if (stale()) { clearInterval(tick); return; }
        if (!state.busy) { clearInterval(tick); return; }
        var secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (!bridgeFresh()) {
          warnedBridge = true;
          setStatus(L("主进程桥接未响应(可点取消;重启 ZCode 可修复)", "Main-process bridge not responding (cancel; restarting ZCode fixes it)"), true);
        } else {
          setStatus(L("生成中…", "Generating…") + " " + secs + "s", false);
        }
        if (Date.now() - t0 > HARD_TIMEOUT_MS) {
          clearInterval(tick);
          cancelEnhance();
          resetBusyUi();
          applyBtn.disabled = !ta.value.trim();
          retryBtn.style.display = "";
          setStatus(L("超时未收到响应,已自动取消", "Timed out with no response; cancelled"), true);
        }
      }, 200);

      callEnhance(draft, {
        onDelta: function (chunk) {
          if (stale()) return;
          state.text += chunk;
          if (!state.dirty) ta.value = state.text;
        },
        onDone: function (finalText, ms) {
          if (stale()) return;
          clearInterval(tick);
          state.text = finalText || state.text;
          if (!state.dirty) ta.value = state.text;
          resetBusyUi();
          applyBtn.disabled = !ta.value.trim();
          retryBtn.style.display = "";
          setStatus(L("已生成", "Ready") + " · " + (ms / 1000).toFixed(1) + "s", false);
          note.textContent = L("确认后才会替换输入框内容", "The composer is replaced only after you confirm");
        },
        onError: function (message) {
          if (stale()) return;
          clearInterval(tick);
          resetBusyUi();
          applyBtn.disabled = true;
          retryBtn.style.display = "";
          setStatus(message, true);
        }
      });
    }

    function cancel() {
      if (!state.busy) return;
      cancelEnhance();
      state.busy = false;
      btn.disabled = false; btn.innerHTML = ICON;
      cancelBtn.style.display = "none";
      ta.readOnly = false;
      applyBtn.disabled = !ta.value.trim();
      retryBtn.style.display = "";
      refreshApplied();
      setStatus(L("已取消", "Cancelled"), false);
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (state.busy) { cancel(); return; } // click again to cancel
      if (panel.style.display === "none") { refreshApplied(); run(); }
      else closePanel();
    });
    cancelBtn.addEventListener("click", cancel);
    x.addEventListener("click", function () { if (state.busy) cancel(); closePanel(); });
    retryBtn.addEventListener("click", function () { run(); });
    applyBtn.addEventListener("click", function () {
      var text = ta.value;
      if (!text.trim()) return;
      if (!setDraft(text)) {
        setStatus(L("无法写入输入框(需要 ZCode 桌面端输入桥)", "Cannot write to the composer (desktop bridge required)"), true);
        return;
      }
      appliedBySession[sessionKey] = { original: state.original, enhanced: text };
      refreshApplied();
      setStatus(L("已替换输入框草稿", "Composer draft replaced"), false);
      note.textContent = L("可随时点「恢复原稿」撤回", "「Restore draft」 reverts anytime");
    });
    revertBtn.addEventListener("click", function () {
      var ap = appliedBySession[sessionKey];
      if (!ap) return;
      if (setDraft(ap.original)) {
        delete appliedBySession[sessionKey];
        refreshApplied();
        setStatus(L("已恢复原稿", "Original draft restored"), false);
        note.textContent = "";
      } else {
        setStatus(L("无法写入输入框", "Cannot write to the composer"), true);
      }
    });
    ta.addEventListener("input", function () { state.dirty = true; applyBtn.disabled = !ta.value.trim(); });
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (state.busy) cancel(); closePanel(); } });

    mount();
    refreshApplied();

    return {
      btn: btn,
      panel: panel,
      rescan: function () {
        if (!document.body.contains(btn) || !document.body.contains(panel)) {
          try { mount(); } catch (e) { }
        }
      },
      destroy: function () {
        try { btn.remove(); panel.remove(); } catch (e) { }
      }
    };
  }

  /* ---------- coordinator ---------- */

  var styleTag = document.getElementById(STYLE_ID);
  if (!styleTag) {
    styleTag = el("style"); styleTag.id = STYLE_ID; styleTag.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleTag);
  }

  var ctls = [];
  function sweep() {
    if (stale()) return;
    var inputs = [];
    try { inputs = Array.prototype.slice.call(document.querySelectorAll(INPUT_SEL)); } catch (e) { }
    ctls = ctls.filter(function (ctl) { return ctl && document.body.contains(ctl.btn); });
    inputs.forEach(function (input) {
      var ctl = ctlByInput.get(input);
      if (ctl && document.body.contains(ctl.btn)) { ctl.rescan(); return; }
      if (ctl) ctl.destroy();
      var fresh = createCtl(input);
      if (fresh) { ctlByInput.set(input, fresh); ctls.push(fresh); }
    });
  }
  sweep();
  var scanTimer = setInterval(function () {
    if (stale()) { clearInterval(scanTimer); return; }
    sweep();
  }, 800);

  window.__peDispose = function () {
    clearInterval(scanTimer);
    ctls.forEach(function (ctl) { try { ctl && ctl.destroy(); } catch (e) { } });
    ctls = [];
    var s = document.getElementById(STYLE_ID); if (s) s.remove();
  };
})();
