/* ZCode Prompt Enhancer — renderer overlay (self-contained IIFE).
 *
 * Injected into renderer windows by inject-main.cjs. Adds:
 *   - an "enhance" (增强) icon button in the composer toolbar, placed just
 *     LEFT of the right-hand cluster (model selector / context capacity /
 *     send). Foreign nodes between React children are left alone by React;
 *     a rescan loop re-mounts anything a re-render dropped or reordered.
 *   - a preview container mounted inside the composer card below the toolbar
 *     row: displays the validated result when generation completes, stays
 *     editable, and only replaces the input draft when the user confirms.
 *   - apply ("使用增强结果") / revert ("恢复原稿") via the composer's built-in
 *     E2E lexical bridge (__zcodeLexicalInputE2E), cancel while generating,
 *     and a watchdog so the UI can never spin forever silently.
 *
 * Generation uses the current session model through the Host service exposed
 * by host-bridge.js (window.__peHostBridge), never a separate API key.
 */
(function () {
  /* VERSION is stamped from package.json by scripts/embed-system-prompt.mjs
   * during `npm run build` — do not bump it by hand. */
  var VERSION = "0.3.0";  if (window.__peOverlay && window.__peOverlayVersion === VERSION) return;
  if (window.__peDispose) { try { window.__peDispose(); } catch (e) { } }
  window.__peOverlay = true;
  window.__peOverlayVersion = VERSION;
  var MY_GEN = (window.__peGen = (window.__peGen || 0) + 1);
  var disposed = false;
  function stale() { return disposed || MY_GEN !== window.__peGen; }

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

  var HARD_TIMEOUT_MS = 120000;

  /* ---------- host generation bridge ---------- */

  function hostBridge() {
    return window.__peHostBridge || null;
  }
  function hostAvailable(input) {
    var bridge = hostBridge();
    if (!bridge) return false;
    try { return typeof bridge.available === "function" ? bridge.available(input) : false; } catch (e) { return false; }
  }
  function hostUnavailableReason(input) {
    var bridge = hostBridge();
    try {
      if (bridge && typeof bridge.reasonUnavailable === "function") return bridge.reasonUnavailable(input);
    } catch (e) { }
    return L("桌面增强桥未就绪，请重新运行 desktop/install.cmd 并重启 ZCode", "Desktop enhancement bridge is not ready; re-run desktop/install.cmd and restart ZCode");
  }

  /* ---------- DOM helpers ---------- */

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function isLive(node) {
    if (!node || !document.body || !document.body.contains(node)) return false;
    for (var p = node; p && p !== document.body; p = p.parentElement) {
      if (p.inert || (p.getAttribute && p.getAttribute("aria-hidden") === "true")) return false;
    }
    return true;
  }
  function toolbarRowOf(card) {
    try {
      var kids = card.children;
      for (var i = 0; i < kids.length; i++) {
        if (String(kids[i].className || "").indexOf("group/toolbar") >= 0 && isLive(kids[i])) return kids[i];
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

  var LABEL = '<span aria-hidden="true">✦</span><span>' + L("增强", "Enhance") + '</span>';
  var STOP_LABEL = '<span aria-hidden="true">■</span><span>' + L("停止", "Stop") + '</span>';

  /* ---------- styles ---------- */

  var STYLE_ID = "pe-overlay-style";
  var CSS = [
    ".pe-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:28px;height:28px;padding:0 7px;border:0;border-radius:8px;background:transparent;color:var(--color-muted-foreground,#8a8f98);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;flex:0 0 auto}",
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
  var activeGeneration = null; // only one generation app-wide at a time

  function createCtl(input) {
    var card = cardOf(input);
    var row = card && toolbarRowOf(card);
    if (!row || !card) return null;

    var state = { busy: false, dirty: false, text: "", original: "" };
    var sessionKey = sessionKeyOf(input);
    var requestId = 0;
    var requestSequence = 0;
    var requestContext = null;
    var tick = null;
    var destroyed = false;
    var api = null;

    var btn = el("button", "pe-btn", LABEL);
    btn.setAttribute("data-pe-overlay-button", VERSION);
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
      var trailing = row.querySelector("[data-composer-trailing-actions]");
      var anchor = null;
      if (trailing) {
        if (trailing.children[0] !== btn) trailing.insertBefore(btn, trailing.children[0] || null);
      } else {
        try {
          var kids = row.children;
          for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (k !== btn && ((k.matches && k.matches(RIGHT_CLUSTER_SEL)) ||
              (k.querySelector && k.querySelector(RIGHT_CLUSTER_SEL)))) { anchor = k; break; }
          }
        } catch (e) { }
        if (anchor && anchor.parentElement === row) {
          if (btn.nextSibling !== anchor) row.insertBefore(btn, anchor);
        } else {
          var cua = row.querySelector(CUA_BTN_SEL);
          if (cua && cua.parentElement === row && cua.nextSibling !== btn) row.insertBefore(btn, cua.nextSibling);
          else if (btn.parentElement !== row) row.appendChild(btn);
        }
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

    function currentBinding() {
      return !destroyed && isLive(input) && sessionKeyOf(input) === sessionKey && cardOf(input) === card && toolbarRowOf(card) === row;
    }
    function currentDraft() {
      var api = currentBinding() && bridgeOf(input);
      try { return api ? String(api.getText() || "") : ""; } catch (e) { return ""; }
    }
    function setDraft(text) {
      var api = currentBinding() && bridgeOf(input);
      if (!api) return false;
      try { api.setText(text); return true; } catch (e) { return false; }
    }

    function modelKey(context) {
      var selection = context && context.selection;
      return JSON.stringify([context && context.workspacePath, context && context.workspaceIdentity,
        context && context.remoteSessionId, context && context.sessionId,
        selection && selection.providerId, selection && selection.modelId, selection && selection.options]);
    }
    function readSessionContext() {
      if (typeof window.__peGetSessionContext !== "function") throw new Error(L("会话模型桥未就绪，请更新桌面集成并重启 ZCode", "Session model bridge is not ready; update the desktop integration and restart ZCode"));
      return window.__peGetSessionContext(input);
    }
    function followsSelection() {
      if (!state.busy || !requestContext) return true;
      try { return modelKey(readSessionContext()) === modelKey(requestContext); } catch (e) { return false; }
    }
    function stopForModelChange() {
      cancel();
      applyBtn.disabled = true;
      setStatus(L("会话模型已切换，已停止旧请求；重新生成将使用新模型", "Session model changed; the previous request was stopped. Retry uses the new model"), false);
    }
    function resetBusyUi() {
      if (tick !== null) { clearInterval(tick); tick = null; }
      state.busy = false;
      requestId = 0;
      requestContext = null;
      if (activeGeneration === api) activeGeneration = null;
      btn.disabled = false; btn.innerHTML = LABEL;
      btn.removeAttribute("aria-busy");
      cancelBtn.style.display = "none";
      ta.readOnly = false;
      refreshApplied();
      btn.setAttribute("aria-label", btn.title);
    }

    function run() {
      if (destroyed || stale() || state.busy || !currentBinding()) return;
      if (!bridgeOf(input)) {
        setStatus(L("输入框读写桥未就绪，请重启 ZCode；尚未发送请求", "Composer bridge is not ready; restart ZCode. No request was sent"), true);
        applyBtn.disabled = true; retryBtn.style.display = "";
        openPanel();
        return;
      }
      var context;
      try { context = readSessionContext(); }
      catch (e) {
        setStatus(String(e && e.message || e), true);
        applyBtn.disabled = true; retryBtn.style.display = "";
        openPanel();
        return;
      }
      if (!hostAvailable(input)) {
        setStatus(hostUnavailableReason(input), true);
        applyBtn.disabled = true; retryBtn.style.display = "";
        openPanel();
        return;
      }
      var draft = currentDraft();
      var applied = appliedBySession[sessionKey];
      state.original = applied && applied.enhanced === draft ? applied.original : draft;
      if (!draft.trim()) {
        ta.value = ""; state.text = ""; state.dirty = false;
        setStatus(L("输入框为空:请先输入提示词草稿", "Composer is empty: type a draft first"), true);
        applyBtn.disabled = true; retryBtn.style.display = "none"; note.textContent = "";
        openPanel();
        return;
      }
      state.busy = true; state.dirty = false; state.text = "";
      requestContext = context;
      ta.value = ""; ta.readOnly = true;
      btn.disabled = false; btn.innerHTML = STOP_LABEL;
      btn.title = L("停止增强", "Stop enhancement");
      btn.setAttribute("aria-label", btn.title); btn.setAttribute("aria-busy", "true");
      cancelBtn.style.display = "";
      applyBtn.disabled = true; retryBtn.style.display = "none"; revertBtn.style.display = "none";
      note.textContent = context.selection.providerId + " / " + context.selection.modelId;
      var t0 = Date.now();
      setStatus(L("使用当前会话模型生成中…", "Generating with the current session model…"), false);
      openPanel();

      tick = setInterval(function () {
        if (stale() || !currentBinding()) { cancel(); return; }
        if (!state.busy) { clearInterval(tick); tick = null; return; }
        if (!followsSelection()) { stopForModelChange(); return; }
        var secs = ((Date.now() - t0) / 1000).toFixed(1);
        setStatus(L("使用当前会话模型生成中…", "Generating with the current session model…") + " " + secs + "s", false);
        if (Date.now() - t0 > HARD_TIMEOUT_MS) {
          cancel();
          applyBtn.disabled = !ta.value.trim();
          retryBtn.style.display = "";
          setStatus(L("超时未收到响应，已自动取消", "Timed out with no response; cancelled"), true);
        }
      }, 200);

      if (activeGeneration && activeGeneration !== api) activeGeneration.cancelForNewRun();
      activeGeneration = api;
      requestId = ++requestSequence;
      var myId = requestId;
      var bridge = hostBridge();
      bridge.generate(input, draft, context).then(function (result) {
        if (stale() || !currentBinding() || myId !== requestId) return;
        if (!followsSelection()) { stopForModelChange(); return; }
        clearInterval(tick);
        state.text = result.text || "";
        if (!state.dirty) ta.value = state.text;
        resetBusyUi();
        applyBtn.disabled = !ta.value.trim();
        retryBtn.style.display = "";
        setStatus(L("已生成", "Ready") + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s", false);
        note.textContent = L("确认后才会替换输入框内容", "The composer is replaced only after you confirm");
      }, function (error) {
        if (stale() || !currentBinding() || myId !== requestId) return;
        clearInterval(tick);
        resetBusyUi();
        applyBtn.disabled = true;
        retryBtn.style.display = "";
        setStatus(String(error && error.message || error), true);
      });
    }

    function cancel() {
      if (!state.busy) return;
      var bridge = hostBridge();
      if (bridge && typeof bridge.cancel === "function") { try { bridge.cancel(); } catch (e) { } }
      resetBusyUi();
      applyBtn.disabled = !ta.value.trim();
      retryBtn.style.display = "";
      setStatus(L("已取消", "Cancelled"), false);
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (state.busy) { cancel(); return; }
      if (panel.style.display !== "none") { closePanel(); return; }
      var applied = appliedBySession[sessionKey];
      if (applied) {
        state.original = applied.original;
        if (!ta.value.trim()) {
          state.text = applied.enhanced;
          ta.value = applied.enhanced;
        }
        applyBtn.disabled = !ta.value.trim();
        retryBtn.style.display = "";
        refreshApplied();
        setStatus(L("已替换输入框草稿", "Composer draft replaced"), false);
        note.textContent = L("可随时点「恢复原稿」撤回", "「Restore draft」 reverts anytime");
        openPanel();
      } else if (ta.value.trim()) { refreshApplied(); openPanel(); }
      else run();
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

    api = {
      input: input,
      btn: btn,
      panel: panel,
      valid: currentBinding,
      rescan: mount,
      cancelForNewRun: function () { cancel(); },
      destroy: function () {
        cancel(); destroyed = true;
        if (tick !== null) { clearInterval(tick); tick = null; }
        try { btn.remove(); panel.remove(); } catch (e) { }
      }
    };
    return api;
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
    try { inputs = Array.prototype.slice.call(document.querySelectorAll(INPUT_SEL)).filter(isLive); } catch (e) { }
    ctls = ctls.filter(function (ctl) {
      if (inputs.indexOf(ctl.input) >= 0 && ctl.valid()) return true;
      ctl.destroy(); ctlByInput.delete(ctl.input); return false;
    });
    inputs.forEach(function (input) {
      var ctl = ctlByInput.get(input);
      if (ctl) { ctl.rescan(); return; }
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
    if (disposed) return;
    clearInterval(scanTimer);
    ctls.forEach(function (ctl) { try { ctl && ctl.destroy(); } catch (e) { } });
    ctls = [];
    disposed = true;
    window.__peOverlay = false;
    var s = document.getElementById(STYLE_ID); if (s) s.remove();
  };
})();
