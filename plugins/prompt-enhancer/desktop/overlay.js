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
    var VERSION = "0.3.2";
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
        ".pe-dirty-badge{display:none;font-size:11px;color:var(--color-warning,#9e6a03);border:1px solid var(--color-border,#eceef2);border-radius:6px;padding:0 6px;line-height:16px}",
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
        ".pe-foot-note{color:var(--color-muted-foreground,#8a8f98);font-size:12px;margin-left:auto;white-space:nowrap}",
        ".pe-history{max-height:180px;overflow:auto;border-top:1px solid var(--color-border,#eceef2)}",
        ".pe-history-item{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer}",
        ".pe-history-item:hover{background:var(--color-surface-hover,rgba(0,0,0,.05))}",
        ".pe-history-main{flex:1;min-width:0}",
        ".pe-history-meta{display:block;color:var(--color-muted-foreground,#8a8f98);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".pe-history-text{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--color-foreground,#222)}",
        ".pe-history-del{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--color-muted-foreground,#8a8f98);cursor:pointer;font-size:13px;line-height:1}",
        ".pe-history-del:hover{background:var(--color-surface-hover,rgba(0,0,0,.06));color:var(--color-text-danger,var(--color-danger,#e5534b))}",
        ".pe-history-item:focus{outline:2px solid var(--color-primary,#5b6cff);outline-offset:-2px}"
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
        var head = el("div", "pe-panel-head");
        var title = el("span", "pe-panel-title", L("提示词增强", "Prompt enhancement"));
        var dirtyBadge = el("span", "pe-dirty-badge", L("已编辑", "Edited"));
        dirtyBadge.style.display = "none";
        var status = el("span", "pe-panel-status", "");
        var x = el("button", "pe-panel-x", "&times;");
        x.type = "button";
        x.title = L("关闭", "Close");
        head.appendChild(title);
        head.appendChild(dirtyBadge);
        head.appendChild(status);
        head.appendChild(x);
        var body = el("div", "pe-panel-body");
        var ta = document.createElement("textarea");
        ta.spellcheck = false;
        ta.placeholder = L("增强后的提示词将在这里生成,可直接修改", "The enhanced prompt appears here; edit freely");
        body.appendChild(ta);
        var foot = el("div", "pe-panel-foot");
        var cancelBtn = el("button", "pe-btn-ghost", L("取消", "Cancel"));
        cancelBtn.type = "button";
        cancelBtn.style.display = "none";
        var applyBtn = el("button", "pe-btn-primary", L("使用增强结果", "Use enhanced"));
        applyBtn.type = "button";
        applyBtn.disabled = true;
        var revertBtn = el("button", "pe-btn-ghost", L("恢复原稿", "Restore draft"));
        revertBtn.type = "button";
        var retryBtn = el("button", "pe-btn-ghost", L("重新生成", "Retry"));
        retryBtn.type = "button";
        retryBtn.style.display = "none";
        var historyBtn = el("button", "pe-btn-ghost", L("历史", "History"));
        historyBtn.type = "button";
        historyBtn.style.display = "none";
        var note = el("span", "pe-foot-note", "");
        foot.appendChild(cancelBtn);
        foot.appendChild(applyBtn);
        foot.appendChild(revertBtn);
        foot.appendChild(retryBtn);
        foot.appendChild(historyBtn);
        foot.appendChild(note);
        var historyBox = el("div", "pe-history");
        historyBox.style.display = "none";
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
        function setStatus(text, isError) {
            status.textContent = text;
            status.className = "pe-panel-status" + (isError ? " pe-error" : "");
        }
        function refreshDirty() {
            dirtyBadge.style.display = state.dirty ? "" : "none";
        }
        function openPanel() { panel.style.display = "flex"; mount(); try {
            ta.focus();
        }
        catch (e) { } }
        function closePanel() { panel.style.display = "none"; historyBox.style.display = "none"; }
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
            setStatus(L("输入框为空:请先输入提示词草稿", "Composer is empty: type a draft first"), true);
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
        function renderHistoryUi() {
            historyBtn.style.display = history.length ? "" : "none";
            historyBtn.innerHTML = L("历史", "History") + " " + history.length;
            for (var i = historyRows.length - 1; i >= 0; i--) {
                try {
                    historyRows[i].remove();
                }
                catch (e) { }
            }
            historyRows = [];
            if (!history.length) {
                historyBox.style.display = "none"; // toggle is hidden; fold here or it could never collapse
                return;
            }
            for (var idx = history.length - 1; idx >= 0; idx--) {
                (function (entry) {
                    var item = el("div", "pe-history-item");
                    item.setAttribute("role", "button");
                    item.setAttribute("tabindex", "0");
                    var main = el("span", "pe-history-main");
                    var meta = el("span", "pe-history-meta");
                    meta.textContent = (entry.draft.length > 48 ? entry.draft.slice(0, 48) + "…" : entry.draft) +
                        " · " + formatTime(entry.at);
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
                        setStatus(L("已载入历史记录", "Loaded from history"), false);
                        note.textContent = L("确认后才会替换输入框内容", "The composer is replaced only after you confirm");
                    }
                    var del = el("button", "pe-history-del", "&times;");
                    del.type = "button";
                    del.title = L("删除这条记录", "Delete this entry");
                    del.addEventListener("click", function (ev) {
                        ev.stopPropagation();
                        removeHistory(entry.id);
                    });
                    item.addEventListener("click", load);
                    item.addEventListener("keydown", function (ev) {
                        if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            load();
                        }
                    });
                    main.appendChild(meta);
                    main.appendChild(preview);
                    item.appendChild(main);
                    item.appendChild(del);
                    historyBox.appendChild(item);
                    historyRows.push(item);
                })(history[idx]);
            }
        }
        function refreshApplied() {
            var ap = appliedBySession[sessionKey];
            btn.classList.toggle("pe-applied", !!ap);
            if (ap)
                btn.title = L("提示词已增强(点击查看/撤销)", "Prompt enhanced (click to review/undo)");
            else
                btn.title = L("增强提示词", "Enhance prompt");
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
            setStatus(L("会话模型已切换，已停止旧请求；重新生成将使用新模型", "Session model changed; the previous request was stopped. Retry uses the new model"), false);
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
            btn.disabled = false;
            btn.innerHTML = LABEL;
            btn.removeAttribute("aria-busy");
            cancelBtn.style.display = "none";
            ta.readOnly = false;
            refreshApplied();
            btn.setAttribute("aria-label", btn.title);
        }
        function run() {
            if (destroyed || stale() || state.busy || !currentBinding())
                return;
            if (!bridgeOf(input)) {
                setStatus(L("输入框读写桥未就绪，请重启 ZCode；尚未发送请求", "Composer bridge is not ready; restart ZCode. No request was sent"), true);
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                openPanel();
                return;
            }
            var context;
            try {
                context = readSessionContext();
            }
            catch (e) {
                setStatus(String(e.message || e), true);
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                openPanel();
                return;
            }
            if (!hostAvailable(input)) {
                setStatus(hostUnavailableReason(input), true);
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                openPanel();
                return;
            }
            var draft = currentDraft();
            if (!draft.trim()) {
                clearPreview();
                refreshApplied();
                openPanel();
                return;
            }
            var applied = appliedBySession[sessionKey];
            state.original = applied && applied.enhanced === draft ? applied.original : draft;
            state.busy = true;
            state.dirty = false;
            state.text = "";
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
            setStatus(L("使用当前会话模型生成中…", "Generating with the current session model…"), false);
            openPanel();
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
                setStatus(L("使用当前会话模型生成中…", "Generating with the current session model…") + " " + secs + "s", false);
                if (Date.now() - t0 > HARD_TIMEOUT_MS) {
                    cancel();
                    applyBtn.disabled = !ta.value.trim();
                    retryBtn.style.display = "";
                    setStatus(L("超时未收到响应，已自动取消", "Timed out with no response; cancelled"), true);
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
                setStatus(L("已生成", "Ready") + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s", false);
                note.textContent = L("确认后才会替换输入框内容", "The composer is replaced only after you confirm");
            }, function (error) {
                if (stale() || !currentBinding() || myId !== requestId)
                    return;
                clearInterval(tick);
                resetBusyUi();
                applyBtn.disabled = true;
                retryBtn.style.display = "";
                setStatus(String(error.message || error), true);
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
            setStatus(L("已取消", "Cancelled"), false);
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
                clearPreview();
                refreshApplied();
                openPanel();
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
                setStatus(L("已复用上次增强结果", "Reused the previous result"), false);
                note.textContent = L("内容未变不重复生成;「重新生成」可强制重试", "Draft unchanged; use 「Retry」 to force regeneration");
                openPanel();
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
                setStatus(L("已替换输入框草稿", "Composer draft replaced"), false);
                note.textContent = L("可随时点「恢复原稿」撤回", "「Restore draft」 reverts anytime");
                openPanel();
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
                setStatus(L("无法写入输入框(需要 ZCode 桌面端输入桥)", "Cannot write to the composer (desktop bridge required)"), true);
                return;
            }
            sessionWrite(sessionKey, function () {
                appliedBySession[sessionKey] = { original: state.original, enhanced: text };
            });
            refreshApplied();
            setStatus(L("已替换输入框草稿", "Composer draft replaced"), false);
            note.textContent = L("可随时点「恢复原稿」撤回", "「Restore draft」 reverts anytime");
        });
        revertBtn.addEventListener("click", function () {
            var ap = appliedBySession[sessionKey];
            if (!ap)
                return;
            if (setDraft(ap.original)) {
                sessionForget(sessionKey);
                refreshApplied();
                setStatus(L("已恢复原稿", "Original draft restored"), false);
                note.textContent = "";
            }
            else {
                setStatus(L("无法写入输入框", "Cannot write to the composer"), true);
            }
        });
        ta.addEventListener("input", function () { state.dirty = true; refreshDirty(); applyBtn.disabled = !ta.value.trim(); });
        panel.addEventListener("keydown", function (e) { if (e.key === "Escape") {
            if (state.busy)
                cancel();
            closePanel();
        } });
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
