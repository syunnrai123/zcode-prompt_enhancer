/* ZCode Prompt Enhancer — renderer overlay (typed source).
 *
 * Compiled to desktop/overlay.js by `tsc -p tsconfig.overlay.json` (part of
 * npm run build / npm test); the compiled file is the committed artifact that
 * install.cmd ships and inject-main.cjs injects. VERSION is a placeholder
 * here and stamped onto the compiled output by scripts/embed-system-prompt.mjs.
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
 *   - result reuse: clicking the button while the composer still holds the
 *     draft of the last completed generation reopens that result without a
 *     new request; only the panel's retry button regenerates. An empty
 *     composer clears the preview synchronously (no stale prompts).
 *   - a history of the last 10 enhanced prompts (oldest dropped first) with
 *     per-entry delete; entries dedupe by (session, draft) so retries
 *     replace, not pile up.
 *
 * Generation uses the current session model through the Host service exposed
 * by host-bridge.js (window.__peHostBridge), never a separate API key.
 */
(function () {
    /* ---------- ZCode DOM anchors (single adaptation point) ----------
     * When a ZCode update renames a testid, class or attribute, adapt this
     * table only; nothing else in the file hardcodes an anchor name. */
    const ANCHORS = {
        input: '[data-testid="v4-composer-input"]',
        /* Right-hand cluster of the toolbar: model selector, context capacity,
         * send. The button mounts immediately before the first of these. */
        rightCluster: [
            '[data-testid="chat-model-select-trigger"]',
            '[data-testid="chat-context-usage-trigger"]',
            ".chat-context-usage-trigger",
            '[data-testid="v4-composer-send"]',
        ].join(", "),
        cuaButton: '[data-testid="v4-composer-cua-entry"]',
        trailingActions: "[data-composer-trailing-actions]",
        toolbarClass: "group/toolbar",
        sessionAttr: "data-session-id",
        lexicalBridgeAttr: "data-e2e-lexical-bridge",
    };
    const W = window;
    /* VERSION is stamped from package.json onto the compiled output by
     * scripts/embed-system-prompt.mjs during `npm run build` — do not bump it
     * by hand. */
    var VERSION = "0.0.6";
    if (W.__peOverlay && W.__peOverlayVersion === VERSION)
        return;
    if (W.__peDispose) {
        try {
            W.__peDispose();
        }
        catch (e) { }
    }
    W.__peOverlay = true;
    W.__peOverlayVersion = VERSION;
    var MY_GEN = (W.__peGen = (W.__peGen || 0) + 1);
    var disposed = false;
    function stale() { return disposed || MY_GEN !== W.__peGen; }
    var ZH = /^zh/i.test(String(document.documentElement.lang || navigator.language || "zh"));
    function L(zh, en) { return ZH ? zh : en; }
    var HARD_TIMEOUT_MS = 120000;
    /* ---------- host generation bridge ---------- */
    function hostBridge() {
        return W.__peHostBridge || null;
    }
    function hostAvailable(input) {
        var bridge = hostBridge();
        if (!bridge)
            return false;
        try {
            return typeof bridge.available === "function" ? bridge.available(input) : false;
        }
        catch (e) {
            return false;
        }
    }
    function hostUnavailableReason(input) {
        var bridge = hostBridge();
        try {
            if (bridge && typeof bridge.reasonUnavailable === "function")
                return bridge.reasonUnavailable(input);
        }
        catch (e) { }
        return L("桌面增强桥未就绪，请重新运行 desktop/install.cmd 并重启 ZCode", "Desktop enhancement bridge is not ready; re-run desktop/install.cmd and restart ZCode");
    }
    /* ---------- DOM helpers ---------- */
    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls)
            n.className = cls;
        if (html !== undefined)
            n.innerHTML = html;
        return n;
    }
    function isLive(node) {
        if (!node || !document.body || !document.body.contains(node))
            return false;
        for (var p = node; p && p !== document.body; p = p.parentElement) {
            if (p.inert || (p.getAttribute && p.getAttribute("aria-hidden") === "true"))
                return false;
        }
        return true;
    }
    function toolbarRowOf(card) {
        try {
            var kids = card.children;
            for (var i = 0; i < kids.length; i++) {
                if (String(kids[i].className || "").indexOf(ANCHORS.toolbarClass) >= 0 && isLive(kids[i]))
                    return kids[i];
            }
        }
        catch (e) { }
        return null;
    }
    function cardOf(input) {
        var node = input;
        while (node && node !== document.body) {
            if (toolbarRowOf(node))
                return node;
            node = node.parentElement;
        }
        return null;
    }
    function bridgeOf(input) {
        try {
            var api = input.__zcodeLexicalInputE2E;
            if (api && input.getAttribute(ANCHORS.lexicalBridgeAttr) === "ready") {
                return api;
            }
        }
        catch (e) { }
        return null;
    }
    function sessionKeyOf(input) {
        var node = input;
        while (node && node !== document.body) {
            if (node.getAttribute(ANCHORS.sessionAttr))
                return node.getAttribute(ANCHORS.sessionAttr);
            node = node.parentElement;
        }
        return "default";
    }
    var LABEL = '<span aria-hidden="true">✦</span><span>' + L("增强", "Enhance") + '</span>';
    var STOP_LABEL = '<span aria-hidden="true">■</span><span>' + L("停止", "Stop") + '</span>';
    /* ---------- styles ---------- */
    var STYLE_ID = "pe-overlay-style";
    var overlaySeq = 0;
    var CSS = [
        /* Theme tokens: host --color-* variables always win; the fallbacks are
         * only used when the host does not define them (custom or dark themes). */
        ".pe-btn,.pe-panel{--pe-fg:var(--color-foreground,#24262b);--pe-muted:var(--color-muted-foreground,#6f7682);--pe-border:var(--color-border,#e4e7ec);--pe-border-strong:var(--color-popover-border,var(--color-border,#d7dbe2));--pe-surface:var(--color-popover,var(--color-background,#fff));--pe-hover:var(--color-surface-hover,rgba(0,0,0,.055));--pe-primary:var(--color-primary,#5b6cff);--pe-primary-fg:var(--color-primary-foreground,#fff);--pe-danger:var(--color-text-danger,var(--color-danger,#e5534b));--pe-success:var(--color-success,#2f9e57);--pe-warning:var(--color-warning,#9e6a03);--pe-ring:var(--pe-primary)}",
        "@media (prefers-color-scheme:dark){.pe-btn,.pe-panel{--pe-fg:var(--color-foreground,#e6e8ec);--pe-muted:var(--color-muted-foreground,#9aa1ac);--pe-border:var(--color-border,#2b2f36);--pe-border-strong:var(--color-popover-border,var(--color-border,#3a3f48));--pe-surface:var(--color-popover,var(--color-background,#1c1f24));--pe-hover:var(--color-surface-hover,rgba(255,255,255,.07));--pe-danger:var(--color-text-danger,var(--color-danger,#ff6b63));--pe-success:var(--color-success,#46c07f);--pe-warning:var(--color-warning,#d9a441)}}",
        ".pe-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:28px;height:28px;padding:0 7px;border:0;border-radius:8px;background:transparent;color:var(--pe-muted);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;flex:0 0 auto;transition:background-color .12s ease,color .12s ease}",
        ".pe-btn:hover{background:var(--pe-hover);color:var(--pe-fg)}",
        ".pe-btn:disabled{opacity:.55;cursor:default}",
        ".pe-btn.pe-applied{color:var(--pe-success)}",
        ".pe-btn.pe-busy{color:var(--pe-danger)}",
        "@keyframes pe-rotate{to{transform:rotate(360deg)}}",
        ".pe-panel{display:flex;flex-direction:column;gap:0;margin-top:10px;border:1px solid var(--pe-border-strong);border-radius:12px;background:var(--pe-surface);box-shadow:0 6px 22px rgba(15,18,25,.12),0 1px 3px rgba(15,18,25,.08);overflow:hidden;font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-text-sm-size,13px);line-height:1.55}",
        ".pe-panel,.pe-panel *{box-sizing:border-box}",
        ".pe-panel-head{display:flex;align-items:flex-start;gap:8px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--pe-border);color:var(--pe-fg)}",
        ".pe-panel-title{flex:0 0 auto;font-weight:var(--font-weight-semibold,600)}",
        ".pe-dirty-badge{flex:0 0 auto;display:none;font-size:11px;color:var(--pe-warning);border:1px solid var(--pe-border);border-radius:6px;padding:0 6px;line-height:16px}",
        /* Bounded to 3 lines so a multi-KB host error cannot stretch the composer card.
         * The text is its own scroll container (and tab stop for warn/error) so the
         * status dot stays put while a long message scrolls under it. */
        ".pe-panel-status{flex:1 1 0;min-width:0;display:flex;align-items:flex-start;justify-content:flex-end;gap:6px;color:var(--pe-muted);font-size:12px;line-height:1.5}",
        ".pe-panel-status-text{flex:0 1 auto;min-width:0;max-height:4.5em;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;text-align:start;white-space:normal;overflow-wrap:break-word;user-select:text}",
        ".pe-panel-status-text::-webkit-scrollbar{width:8px}",
        ".pe-panel-status-text::-webkit-scrollbar-track{background:transparent}",
        ".pe-panel-status-text::-webkit-scrollbar-thumb{background:var(--pe-border-strong);border-radius:4px}",
        ".pe-panel-status-text:focus-visible{outline:2px solid var(--pe-ring);outline-offset:2px;border-radius:4px}",
        ".pe-panel-status::before{content:'';flex:0 0 auto;width:6px;height:6px;margin-top:.5em;border-radius:50%;background:currentColor;opacity:.55}",
        ".pe-panel-status.pe-tone-ok{color:var(--pe-fg)}",
        ".pe-panel-status.pe-tone-ok::before{background:var(--pe-success);opacity:1}",
        ".pe-panel-status.pe-tone-warn{color:var(--pe-warning)}",
        ".pe-panel-status.pe-tone-warn::before{background:var(--pe-warning);opacity:1}",
        ".pe-panel-status.pe-tone-error{color:var(--pe-danger);font-weight:500}",
        ".pe-panel-status.pe-tone-error::before{background:var(--pe-danger);opacity:1}",
        ".pe-panel-status.pe-tone-busy::before{width:11px;height:11px;margin-top:.3em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;background:transparent;opacity:.85;animation:pe-rotate .75s linear infinite}",
        ".pe-panel-x{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--pe-muted);cursor:pointer;font-size:14px;line-height:1}",
        ".pe-panel-x:hover{background:var(--pe-hover);color:var(--pe-fg)}",
        ".pe-panel-body{padding:0}",
        ".pe-panel-body:focus-within{box-shadow:inset 0 0 0 2px var(--pe-ring)}",
        /* Fixed preview height: the result scrolls inside the box instead of stretching the composer. max-height is a second guard for host overrides or future auto-grow. */
        ".pe-panel textarea{display:block;width:100%;height:84px;min-height:84px;max-height:260px;resize:none;border:0;outline:0;padding:10px 12px;background:transparent;color:var(--pe-fg);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-text-sm-size,13px);line-height:1.6;overflow:auto}",
        ".pe-panel.is-busy textarea{opacity:.55;cursor:progress}",
        ".pe-panel-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;border-top:1px solid var(--pe-border)}",
        ".pe-btn-primary{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:8px;background:var(--pe-primary);color:var(--pe-primary-fg);font-size:12px;font-weight:var(--font-weight-medium,500);cursor:pointer;transition:filter .12s ease,opacity .12s ease}",
        ".pe-btn-primary:hover{filter:brightness(1.06)}",
        ".pe-btn-primary:disabled{opacity:.5;cursor:default;filter:none}",
        ".pe-btn-ghost{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--pe-border);border-radius:8px;background:transparent;color:var(--pe-muted);font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}",
        ".pe-btn-ghost:hover{background:var(--pe-hover);color:var(--pe-fg)}",
        ".pe-btn-ghost:disabled{opacity:.5;cursor:default}",
        ".pe-foot-note{flex:1 1 auto;min-width:0;margin-left:auto;color:var(--pe-muted);font-size:12px;line-height:1.45;text-align:end;white-space:normal;overflow-wrap:break-word}",
        ".pe-history{max-height:180px;overflow:auto;border-top:1px solid var(--pe-border)}",
        ".pe-history-item{display:flex;align-items:center;gap:0;padding:0;transition:background-color .12s ease}",
        ".pe-history-item+.pe-history-item{border-top:1px solid var(--pe-border)}",
        ".pe-history-item:hover{background:var(--pe-hover)}",
        ".pe-history-load{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:6px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer;transition:background-color .12s ease}",
        ".pe-history-main{flex:1;min-width:0}",
        ".pe-history-meta{display:block;color:var(--pe-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".pe-history-text{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--pe-fg)}",
        ".pe-history-del{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:20px;height:20px;margin-right:8px;border:0;border-radius:6px;background:transparent;color:var(--pe-muted);cursor:pointer;font-size:13px;line-height:1}",
        ".pe-history-del:hover{background:var(--pe-hover);color:var(--pe-danger)}",
        ".pe-btn:focus-visible,.pe-panel button:focus-visible,.pe-panel-status-text:focus-visible{outline:2px solid var(--pe-ring);outline-offset:2px}",
        ".pe-panel .pe-history-load:focus-visible{outline-offset:-2px}",
        "@media (forced-colors:active){.pe-panel-body:focus-within{outline:2px solid Highlight;outline-offset:-2px;box-shadow:none}.pe-btn:focus-visible,.pe-panel button:focus-visible,.pe-panel-status-text:focus-visible{outline:2px solid Highlight;outline-offset:2px}}",
        "@media (prefers-reduced-motion:reduce){.pe-panel-status.pe-tone-busy::before{animation:none}.pe-btn,.pe-btn-primary,.pe-btn-ghost,.pe-history-item,.pe-history-load{transition:none}}"
    ].join("\n");
    /* ---------- per-composer controller ---------- */
    /* Session-keyed tables are bounded: long-lived windows accumulate one entry
     * per session; SESSION_TABLE_LIMIT drops the oldest sessions (both tables
     * together) so memory cannot grow without end. */
    var SESSION_TABLE_LIMIT = 50;
    var appliedBySession = {}; // sessionKey -> {original, enhanced}
    var lastRunBySession = {}; // sessionKey -> {draft, enhanced} of the last completed generation
    var sessionOrder = []; // insertion order of live session keys
    var HISTORY_LIMIT = 10; // enhanced prompts kept in the panel history (default)
    var history = []; // oldest first, newest last, capped at HISTORY_LIMIT
    var historySeq = 0;
    var ctlByInput = new WeakMap();
    var activeGeneration = null; // only one generation app-wide at a time
    function sessionWrite(key, write) {
        if (!(key in lastRunBySession) && !(key in appliedBySession))
            sessionOrder.push(key);
        write();
        while (sessionOrder.length > SESSION_TABLE_LIMIT) {
            var oldest = sessionOrder[0];
            delete lastRunBySession[oldest];
            delete appliedBySession[oldest];
            sessionOrder.shift();
        }
    }
    function sessionForget(key) {
        delete lastRunBySession[key];
        delete appliedBySession[key];
        var i = sessionOrder.indexOf(key);
        if (i >= 0)
            sessionOrder.splice(i, 1);
    }
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function formatTime(at) {
        try {
            var d = new Date(at);
            return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
        }
        catch (e) {
            return "";
        }
    }
    function createCtl(input) {
        var cardRaw = cardOf(input);
        var rowRaw = cardRaw && toolbarRowOf(cardRaw);
        if (!rowRaw || !cardRaw)
            return null;
        /* Non-null aliases so the closures below keep the narrowed type (TS does
         * not preserve narrowing of the outer vars inside closures). */
        var card = cardRaw;
        var row = rowRaw;
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
        panel.setAttribute("role", "region");
        panel.setAttribute("aria-label", L("提示词增强", "Prompt enhancement"));
        var head = el("div", "pe-panel-head");
        var title = el("span", "pe-panel-title", L("提示词增强", "Prompt enhancement"));
        var dirtyBadge = el("span", "pe-dirty-badge", L("已编辑", "Edited"));
        dirtyBadge.style.display = "none";
        var status = el("span", "pe-panel-status");
        var statusText = el("span", "pe-panel-status-text");
        status.appendChild(statusText);
        status.setAttribute("aria-live", "polite");
        status.setAttribute("aria-atomic", "true");
        var x = el("button", "pe-panel-x", "&times;");
        x.type = "button";
        x.title = L("关闭", "Close");
        x.setAttribute("aria-label", x.title);
        head.appendChild(title);
        head.appendChild(dirtyBadge);
        head.appendChild(status);
        head.appendChild(x);
        var body = el("div", "pe-panel-body");
        var ta = document.createElement("textarea");
        ta.spellcheck = false;
        ta.placeholder = L("增强后的提示词将在这里生成,可直接修改", "The enhanced prompt appears here; edit freely");
        ta.setAttribute("aria-label", L("增强结果预览", "Enhanced prompt preview"));
        body.appendChild(ta);
        var foot = el("div", "pe-panel-foot");
        var cancelBtn = el("button", "pe-btn-ghost", L("取消", "Cancel"));
        cancelBtn.type = "button";
        cancelBtn.style.display = "none";
        cancelBtn.title = L("取消本次增强", "Cancel this enhancement");
        var applyBtn = el("button", "pe-btn-primary", L("使用增强结果", "Use enhanced"));
        applyBtn.type = "button";
        applyBtn.disabled = true;
        applyBtn.title = L("用增强结果替换输入框草稿", "Replace the composer draft with the enhanced result");
        var revertBtn = el("button", "pe-btn-ghost", L("恢复原稿", "Restore draft"));
        revertBtn.type = "button";
        revertBtn.title = L("恢复增强前的草稿", "Restore the draft from before enhancement");
        var retryBtn = el("button", "pe-btn-ghost", L("重新生成", "Retry"));
        retryBtn.type = "button";
        retryBtn.style.display = "none";
        retryBtn.title = L("使用当前会话模型重新生成", "Regenerate with the current session model");
        var historyBtn = el("button", "pe-btn-ghost", L("历史", "History"));
        historyBtn.type = "button";
        historyBtn.style.display = "none";
        historyBtn.title = L("查看最近 10 条增强记录", "View the 10 most recent results");
        historyBtn.setAttribute("aria-expanded", "false");
        var note = el("span", "pe-foot-note", "");
        foot.appendChild(cancelBtn);
        foot.appendChild(applyBtn);
        foot.appendChild(revertBtn);
        foot.appendChild(retryBtn);
        foot.appendChild(historyBtn);
        foot.appendChild(note);
        var historyBox = el("div", "pe-history");
        historyBox.id = "pe-history-" + (++overlaySeq);
        historyBox.style.display = "none";
        historyBtn.setAttribute("aria-controls", historyBox.id);
        var historyRows = [];
        panel.appendChild(head);
        panel.appendChild(body);
        panel.appendChild(historyBox);
        panel.appendChild(foot);
        /* Button sits immediately LEFT of the right-hand cluster (model selector,
         * context capacity, send). Falls back to after the CUA tool button. */
        function mount() {
            var trailing = row.querySelector(ANCHORS.trailingActions);
            var anchor = null;
            if (trailing) {
                if (trailing.children[0] !== btn)
                    trailing.insertBefore(btn, trailing.children[0] || null);
            }
            else {
                try {
                    var kids = row.children;
                    for (var i = 0; i < kids.length; i++) {
                        var k = kids[i];
                        if (k !== btn && ((k.matches && k.matches(ANCHORS.rightCluster)) ||
                            (k.querySelector && k.querySelector(ANCHORS.rightCluster)))) {
                            anchor = k;
                            break;
                        }
                    }
                }
                catch (e) { }
                if (anchor && anchor.parentElement === row) {
                    if (btn.nextSibling !== anchor)
                        row.insertBefore(btn, anchor);
                }
                else {
                    var cua = row.querySelector(ANCHORS.cuaButton);
                    if (cua && cua.parentElement === row && cua.nextSibling !== btn)
                        row.insertBefore(btn, cua.nextSibling);
                    else if (btn.parentElement !== row)
                        row.appendChild(btn);
                }
            }
            var ref = row.nextSibling;
            if (ref && ref.parentElement === card && ref !== panel)
                card.insertBefore(panel, ref);
            else if (panel.parentElement !== card)
                card.appendChild(panel);
        }
        function setStatus(text, tone) {
            /* Switch the live mode BEFORE the mutation: a write made while the region
             * is off is never announced, even if it is switched back on in the same
             * tick (busy -> ready/error). */
            status.setAttribute("aria-live", tone === "busy" ? "off" : "polite");
            status.className = "pe-panel-status pe-tone-" + tone + (tone === "error" ? " pe-error" : "");
            statusText.textContent = text;
            // Warnings and errors can overflow three lines; make them keyboard-scrollable.
            if (tone === "warn" || tone === "error")
                statusText.setAttribute("tabindex", "0");
            else
                statusText.removeAttribute("tabindex");
        }
        function refreshDirty() {
            dirtyBadge.style.display = state.dirty ? "" : "none";
        }
        function openPanel() { panel.style.display = "flex"; mount(); try {
            ta.focus();
        }
        catch (e) { } }
        function closePanel() {
            panel.style.display = "none";
            historyBox.style.display = "none";
            historyBtn.setAttribute("aria-expanded", "false");
            try {
                btn.focus();
            }
            catch (e) { }
        }
        function clearPreview() {
            ta.value = "";
            state.text = "";
            state.dirty = false;
            state.original = "";
            refreshDirty();
            applyBtn.disabled = true;
            retryBtn.style.display = "none";
            note.textContent = "";
            historyBox.style.display = "none";
            historyBtn.setAttribute("aria-expanded", "false");
            setStatus(L("输入框为空:请先输入提示词草稿", "Composer is empty: type a draft first"), "warn");
        }
        /* While the panel is open, a composer emptied by the user must not keep
         * showing machine-generated residue; hand-edited text (state.dirty) is left
         * alone until the next button click clears it unconditionally. */
        function syncEmptyDraft() {
            if (state.busy || state.dirty || panel.style.display === "none")
                return;
            if (currentDraft().trim())
                return;
            clearPreview();
            refreshApplied();
        }
        function refreshHistoryToggle() {
            var hasHistory = history.length > 0;
            historyBtn.style.display = hasHistory ? "" : "none";
            historyBtn.innerHTML = L("历史", "History") + " " + history.length;
            historyBtn.setAttribute("aria-expanded", hasHistory && historyBox.style.display !== "none" ? "true" : "false");
        }
        function clearHistoryRows() {
            for (var i = historyRows.length - 1; i >= 0; i--) {
                try {
                    historyRows[i].remove();
                }
                catch (e) { }
            }
            historyRows = [];
        }
        function renderHistoryUi() {
            refreshHistoryToggle();
            if (!history.length) {
                clearHistoryRows();
                historyBox.style.display = "none"; // toggle is hidden; fold here or it could never collapse
                return;
            }
            /* Rows are rebuilt on demand when the list is opened; rebuilding a
             * hidden list on every generation only burns DOM work. */
            if (historyBox.style.display === "none")
                return;
            /* Rebuilding replaces every row, which would otherwise drop keyboard
             * focus and reset the scroll position while the user browses history. */
            var restoreId = null;
            var restoreDelete = false;
            var restoreScroll = 0;
            try {
                restoreScroll = historyBox.scrollTop || 0;
            }
            catch (e) { }
            var active = document.activeElement;
            var hadFocus = !!active && historyBox.contains(active);
            if (hadFocus) {
                var focusRow = active;
                while (focusRow && focusRow.parentElement !== historyBox)
                    focusRow = focusRow.parentElement;
                if (focusRow) {
                    restoreId = focusRow.getAttribute("data-history-id");
                    var focusedDel = focusRow.querySelector(".pe-history-del");
                    restoreDelete = !!focusedDel && focusedDel.contains(active);
                }
            }
            clearHistoryRows();
            for (var idx = history.length - 1; idx >= 0; idx--) {
                (function (entry) {
                    var item = el("div", "pe-history-item");
                    item.setAttribute("data-history-id", String(entry.id));
                    var snippet = entry.draft.length > 48 ? entry.draft.slice(0, 48) + "…" : entry.draft;
                    var loadBtn = el("button", "pe-history-load");
                    loadBtn.type = "button";
                    loadBtn.setAttribute("aria-label", L("载入这条增强结果：", "Load this enhanced result: ") + snippet);
                    var main = el("span", "pe-history-main");
                    var meta = el("span", "pe-history-meta");
                    meta.textContent = snippet + " · " + formatTime(entry.at);
                    var preview = el("span", "pe-history-text");
                    preview.textContent = entry.text; // textContent only: model output is never trusted as HTML
                    preview.title = entry.text;
                    function load() {
                        ta.value = entry.text;
                        state.text = entry.text;
                        state.dirty = false;
                        refreshDirty();
                        state.original = currentDraft().trim() ? currentDraft() : entry.draft;
                        applyBtn.disabled = !ta.value.trim();
                        retryBtn.style.display = "";
                        setStatus(L("已载入历史记录", "Loaded from history"), "ok");
                        note.textContent = L("确认后才会替换输入框内容", "The composer is replaced only after you confirm");
                    }
                    var del = el("button", "pe-history-del", "&times;");
                    del.type = "button";
                    del.title = L("删除这条记录", "Delete this entry");
                    del.setAttribute("aria-label", del.title);
                    del.addEventListener("click", function (ev) {
                        ev.stopPropagation();
                        removeHistory(entry.id);
                    });
                    loadBtn.addEventListener("click", load);
                    main.appendChild(meta);
                    main.appendChild(preview);
                    loadBtn.appendChild(main);
                    item.appendChild(loadBtn);
                    item.appendChild(del);
                    historyBox.appendChild(item);
                    historyRows.push(item);
                })(history[idx]);
            }
            var restored = false;
            if (restoreId !== null) {
                for (var row = 0; row < historyRows.length; row++) {
                    if (historyRows[row].getAttribute("data-history-id") !== restoreId)
                        continue;
                    var target = restoreDelete
                        ? historyRows[row].querySelector(".pe-history-del")
                        : historyRows[row].querySelector(".pe-history-load");
                    if (target) {
                        try {
                            target.focus();
                            restored = true;
                        }
                        catch (e) { }
                    }
                    break;
                }
            }
            if (hadFocus && !restored) {
                /* The focused entry vanished (e.g. it was just deleted); keep focus in
                 * the panel instead of dropping it to the document body. */
                try {
                    (history.length ? historyBtn : btn).focus();
                }
                catch (e) { }
            }
            try {
                historyBox.scrollTop = restoreScroll;
            }
            catch (e) { }
        }
        function refreshApplied() {
            var ap = appliedBySession[sessionKey];
            btn.classList.toggle("pe-applied", !!ap);
            if (ap)
                btn.title = L("提示词已增强(点击查看/撤销)", "Prompt enhanced (click to review/undo)");
            else
                btn.title = L("增强提示词", "Enhance prompt");
            btn.setAttribute("aria-label", btn.title);
            revertBtn.style.display = ap && !state.busy ? "" : "none";
        }
        function currentBinding() {
            return !destroyed && isLive(input) && sessionKeyOf(input) === sessionKey && cardOf(input) === card && toolbarRowOf(card) === row;
        }
        function currentDraft() {
            var api = currentBinding() && bridgeOf(input);
            try {
                return api ? String(api.getText() || "") : "";
            }
            catch (e) {
                return "";
            }
        }
        function setDraft(text) {
            var api = currentBinding() && bridgeOf(input);
            if (!api)
                return false;
            try {
                api.setText(text);
                return true;
            }
            catch (e) {
                return false;
            }
        }
        function modelKey(context) {
            var selection = context && context.selection;
            return JSON.stringify([context && context.workspacePath, context && context.workspaceIdentity,
                context && context.remoteSessionId, context && context.sessionId,
                selection && selection.providerId, selection && selection.modelId, selection && selection.options]);
        }
        function readSessionContext() {
            var getter = W.__peGetSessionContext;
            if (typeof getter !== "function")
                throw new Error(L("会话模型桥未就绪，请更新桌面集成并重启 ZCode", "Session model bridge is not ready; update the desktop integration and restart ZCode"));
            return getter(input);
        }
        function followsSelection() {
            if (!state.busy || !requestContext)
                return true;
            try {
                return modelKey(readSessionContext()) === modelKey(requestContext);
            }
            catch (e) {
                return false;
            }
        }
        function stopForModelChange() {
            cancel();
            applyBtn.disabled = true;
            setStatus(L("会话模型已切换，已停止旧请求；重新生成将使用新模型", "Session model changed; the previous request was stopped. Retry uses the new model"), "warn");
        }
        function resetBusyUi() {
            if (tick !== null) {
                clearInterval(tick);
                tick = null;
            }
            state.busy = false;
            requestId = 0;
            requestContext = null;
            if (activeGeneration === api)
                activeGeneration = null;
            panel.classList.toggle("is-busy", false);
            panel.removeAttribute("aria-busy");
            btn.classList.toggle("pe-busy", false);
            btn.disabled = false;
            btn.innerHTML = LABEL;
            btn.removeAttribute("aria-busy");
            cancelBtn.style.display = "none";
            ta.readOnly = false;
            refreshApplied();
        }
        function run() {
            if (destroyed || stale() || state.busy || !currentBinding())
                return;
            if (!bridgeOf(input)) {
                openPanel();
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                setStatus(L("输入框读写桥未就绪，请重启 ZCode；尚未发送请求", "Composer bridge is not ready; restart ZCode. No request was sent"), "error");
                return;
            }
            var context;
            try {
                context = readSessionContext();
            }
            catch (e) {
                openPanel();
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                setStatus(String(e.message || e), "error");
                return;
            }
            if (!hostAvailable(input)) {
                openPanel();
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                setStatus(hostUnavailableReason(input), "error");
                return;
            }
            var draft = currentDraft();
            if (!draft.trim()) {
                openPanel();
                clearPreview();
                refreshApplied();
                return;
            }
            var applied = appliedBySession[sessionKey];
            state.original = applied && applied.enhanced === draft ? applied.original : draft;
            state.busy = true;
            state.dirty = false;
            state.text = "";
            panel.classList.toggle("is-busy", true);
            panel.setAttribute("aria-busy", "true");
            btn.classList.toggle("pe-busy", true);
            refreshDirty();
            requestContext = context;
            ta.value = "";
            ta.readOnly = true;
            btn.disabled = false;
            btn.innerHTML = STOP_LABEL;
            btn.title = L("停止增强", "Stop enhancement");
            btn.setAttribute("aria-label", btn.title);
            btn.setAttribute("aria-busy", "true");
            cancelBtn.style.display = "";
            applyBtn.disabled = true;
            retryBtn.style.display = "none";
            revertBtn.style.display = "none";
            note.textContent = context.selection.providerId + " / " + context.selection.modelId;
            var t0 = Date.now();
            openPanel();
            setStatus(L("使用当前会话模型生成中…", "Generating with the current session model…"), "busy");
            tick = setInterval(function () {
                if (stale() || !currentBinding()) {
                    cancel();
                    return;
                }
                if (!state.busy) {
                    clearInterval(tick);
                    tick = null;
                    return;
                }
                if (!followsSelection()) {
                    stopForModelChange();
                    return;
                }
                var secs = ((Date.now() - t0) / 1000).toFixed(1);
                setStatus(L("使用当前会话模型生成中…", "Generating with the current session model…") + " " + secs + "s", "busy");
                if (Date.now() - t0 > HARD_TIMEOUT_MS) {
                    cancel();
                    applyBtn.disabled = !ta.value.trim();
                    retryBtn.style.display = "";
                    setStatus(L("超时未收到响应，已自动取消", "Timed out with no response; cancelled"), "error");
                }
            }, 200);
            if (activeGeneration && activeGeneration !== api)
                activeGeneration.cancelForNewRun();
            activeGeneration = api;
            requestId = ++requestSequence;
            var myId = requestId;
            var bridge = hostBridge();
            bridge.generate(input, draft, context).then(function (result) {
                if (stale() || !currentBinding() || myId !== requestId)
                    return;
                if (!followsSelection()) {
                    stopForModelChange();
                    return;
                }
                clearInterval(tick);
                state.text = result.text || "";
                if (!state.dirty)
                    ta.value = state.text;
                sessionWrite(sessionKey, function () {
                    lastRunBySession[sessionKey] = { draft: draft, enhanced: state.text };
                });
                pushHistory(sessionKey, draft, state.text);
                resetBusyUi();
                applyBtn.disabled = !ta.value.trim();
                retryBtn.style.display = "";
                setStatus(L("已生成", "Ready") + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s", "ok");
                note.textContent = L("确认后才会替换输入框内容", "The composer is replaced only after you confirm");
            }, function (error) {
                if (stale() || !currentBinding() || myId !== requestId)
                    return;
                clearInterval(tick);
                resetBusyUi();
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                setStatus(String(error.message || error), "error");
            });
        }
        function cancel() {
            if (!state.busy)
                return;
            var bridge = hostBridge();
            if (bridge && typeof bridge.cancel === "function") {
                try {
                    bridge.cancel();
                }
                catch (e) { }
            }
            resetBusyUi();
            applyBtn.disabled = !ta.value.trim();
            retryBtn.style.display = "";
            setStatus(L("已取消", "Cancelled"), "info");
        }
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (state.busy) {
                cancel();
                return;
            }
            if (panel.style.display !== "none") {
                closePanel();
                return;
            }
            var draft = currentDraft();
            if (!draft.trim()) {
                /* Empty composer: without a readable bridge run() reports the precise
                 * setup error; otherwise clear every trace of the previous result. */
                if (!bridgeOf(input)) {
                    run();
                    return;
                }
                openPanel();
                clearPreview();
                refreshApplied();
                return;
            }
            var applied = appliedBySession[sessionKey];
            var last = lastRunBySession[sessionKey];
            if (last && last.draft.trim() === draft.trim()) {
                /* Unchanged draft: reuse the last result, no new request. Retry in the
                 * panel is the only regeneration path for the same draft; whitespace-
                 * only drift still counts as unchanged. Hand-edited preview content
                 * (state.dirty) is preserved, mirroring the run() success handler. */
                state.original = applied && applied.enhanced === draft ? applied.original : draft;
                state.text = last.enhanced;
                if (!state.dirty)
                    ta.value = last.enhanced;
                applyBtn.disabled = !ta.value.trim();
                retryBtn.style.display = "";
                refreshApplied();
                openPanel();
                setStatus(L("已复用上次增强结果", "Reused the previous result"), "ok");
                note.textContent = L("内容未变不重复生成;「重新生成」可强制重试", "Draft unchanged; use 「Retry」 to force regeneration");
                return;
            }
            if (applied && applied.enhanced === draft) {
                /* Composer holds our applied output: reopen the review panel. */
                state.original = applied.original;
                if (!ta.value.trim()) {
                    state.text = applied.enhanced;
                    ta.value = applied.enhanced;
                    state.dirty = false;
                    refreshDirty();
                }
                applyBtn.disabled = !ta.value.trim();
                retryBtn.style.display = "";
                refreshApplied();
                openPanel();
                setStatus(L("已替换输入框草稿", "Composer draft replaced"), "ok");
                note.textContent = L("可随时点「恢复原稿」撤回", "「Restore draft」 reverts anytime");
                return;
            }
            run();
        });
        cancelBtn.addEventListener("click", cancel);
        x.addEventListener("click", function () { if (state.busy)
            cancel(); closePanel(); });
        historyBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            historyBox.style.display = historyBox.style.display === "none" ? "block" : "none";
            renderHistoryUi();
        });
        retryBtn.addEventListener("click", function () { run(); });
        applyBtn.addEventListener("click", function () {
            var text = ta.value;
            if (!text.trim())
                return;
            if (!setDraft(text)) {
                setStatus(L("无法写入输入框(需要 ZCode 桌面端输入桥)", "Cannot write to the composer (desktop bridge required)"), "error");
                return;
            }
            sessionWrite(sessionKey, function () {
                appliedBySession[sessionKey] = { original: state.original, enhanced: text };
            });
            refreshApplied();
            setStatus(L("已替换输入框草稿", "Composer draft replaced"), "ok");
            note.textContent = L("可随时点「恢复原稿」撤回", "「Restore draft」 reverts anytime");
        });
        revertBtn.addEventListener("click", function () {
            var ap = appliedBySession[sessionKey];
            if (!ap)
                return;
            if (setDraft(ap.original)) {
                sessionForget(sessionKey);
                refreshApplied();
                setStatus(L("已恢复原稿", "Original draft restored"), "ok");
                note.textContent = "";
            }
            else {
                setStatus(L("无法写入输入框", "Cannot write to the composer"), "error");
            }
        });
        ta.addEventListener("input", function () { state.dirty = true; refreshDirty(); applyBtn.disabled = !ta.value.trim(); });
        panel.addEventListener("keydown", function (e) {
            if (e.key !== "Escape")
                return;
            e.preventDefault();
            e.stopPropagation();
            if (state.busy)
                cancel();
            closePanel();
        });
        mount();
        renderHistoryUi();
        refreshApplied();
        api = {
            input: input,
            btn: btn,
            panel: panel,
            valid: currentBinding,
            rescan: function () { mount(); syncEmptyDraft(); },
            renderHistory: renderHistoryUi,
            cancelForNewRun: function () { cancel(); },
            destroy: function () {
                cancel();
                destroyed = true;
                if (tick !== null) {
                    clearInterval(tick);
                    tick = null;
                }
                try {
                    btn.remove();
                    panel.remove();
                }
                catch (e) { }
            }
        };
        return api;
    }
    /* ---------- coordinator ---------- */
    var styleTag = document.getElementById(STYLE_ID);
    if (!styleTag) {
        styleTag = el("style");
        styleTag.id = STYLE_ID;
        styleTag.textContent = CSS;
        (document.head || document.documentElement).appendChild(styleTag);
    }
    var ctls = [];
    function renderHistoryAll() {
        for (var i = 0; i < ctls.length; i++) {
            try {
                ctls[i].renderHistory();
            }
            catch (e) { }
        }
    }
    function pushHistory(session, draft, text) {
        if (!text)
            return;
        for (var i = 0; i < history.length; i++) {
            if (history[i].draft === draft && history[i].session === session) {
                history.splice(i, 1);
                break;
            } // retry replaces its session's entry
        }
        history.push({ id: ++historySeq, session: session, draft: draft, text: text, at: Date.now() });
        while (history.length > HISTORY_LIMIT)
            history.shift();
        renderHistoryAll();
    }
    function removeHistory(id) {
        for (var i = 0; i < history.length; i++) {
            if (history[i].id === id) {
                history.splice(i, 1);
                break;
            }
        }
        renderHistoryAll();
    }
    function sweep() {
        if (stale())
            return;
        var inputs = [];
        try {
            inputs = Array.prototype.slice.call(document.querySelectorAll(ANCHORS.input)).filter(isLive);
        }
        catch (e) { }
        ctls = ctls.filter(function (ctl) {
            if (inputs.indexOf(ctl.input) >= 0 && ctl.valid())
                return true;
            ctl.destroy();
            ctlByInput.delete(ctl.input);
            return false;
        });
        inputs.forEach(function (input) {
            var ctl = ctlByInput.get(input);
            if (ctl) {
                ctl.rescan();
                return;
            }
            var fresh = createCtl(input);
            if (fresh) {
                ctlByInput.set(input, fresh);
                ctls.push(fresh);
            }
        });
    }
    sweep();
    var scanTimer = setInterval(function () {
        if (stale()) {
            clearInterval(scanTimer);
            return;
        }
        sweep();
    }, 800);
    W.__peDispose = function () {
        if (disposed)
            return;
        clearInterval(scanTimer);
        ctls.forEach(function (ctl) { try {
            ctl && ctl.destroy();
        }
        catch (e) { } });
        ctls = [];
        disposed = true;
        W.__peOverlay = false;
        var s = document.getElementById(STYLE_ID);
        if (s)
            s.remove();
    };
})();
