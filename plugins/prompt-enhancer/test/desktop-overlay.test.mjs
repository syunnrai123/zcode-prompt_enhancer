import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { enhanceWorkspaceText } from "../dist/desktop/workspace-enhancer.js";

const source = fs.readFileSync(new URL("../desktop/overlay.js", import.meta.url), "utf8");

// Small DOM model: executes the real IIFE, listeners and timers. The nesting
// mirrors the installed composer toolbar (`data-composer-trailing-actions`).
class Node {
  constructor(tag = "div", document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.style = {};
    this.className = "";
    this.listeners = {};
    this.value = "";
    this.disabled = false;
    this.inert = false;
    this._html = "";
    this._text = "";
    this.classList = {
      toggle: (name, on) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (on) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = value; }
  get textContent() { return this._text; }
  set textContent(value) { this._text = value; }
  setAttribute(name, value) {
    if (name === "id") this.id = String(value);
    this.attributes[name] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (ref && ref.parentElement !== this) throw Error("NotFoundError");
    if (child === ref) return child;
    if (child.parentElement) child.remove();
    const index = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(child) { return child === this || this.children.some((n) => n.contains(child)); }
  matches(selector) {
    return selector.split(",").some((part) => {
      part = part.trim();
      if (part.startsWith(".")) return this.className.split(/\s+/).includes(part.slice(1));
      if (part.startsWith("[")) {
        const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
        return !!match && this.getAttribute(match[1]) !== null &&
          (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
      }
      return this.tagName.toLowerCase() === part;
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  fire(name, props = {}) {
    const event = { preventDefault() {}, stopPropagation() {}, ...props };
    for (const fn of this.listeners[name] || []) fn(event);
  }
  click() { if (!this.disabled) this.fire("click"); }
  focus() {}
}

function harness({ lexical = true, composers = 1, available = true } = {}) {
  let now = 10000;
  const timers = new Map();
  let nextTimer = 0;
  const document = { documentElement: { lang: "zh-CN" } };
  document.body = new Node("body", document);
  document.head = new Node("head", document);
  document.createElement = (tag) => new Node(tag, document);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  document.getElementById = (id) => [...document.head.children, ...document.body.querySelectorAll("style")]
    .find((n) => n.id === id) || null;
  const generation = {
    calls: [], cancelled: 0, pending: [],
    available: () => available,
    reasonUnavailable: () => "host patch missing",
    generate(input, draft, context) {
      generation.calls.push({ input, draft, context });
      return new Promise((resolve, reject) => generation.pending.push({ resolve, reject }));
    },
    cancel() { generation.cancelled++; },
  };
  const window = {
    __peHostBridge: generation,
    __peGetSessionContext: () => ({
      selection: { providerId: "provider-a", modelId: "model-a" },
      workspacePath: "/synthetic",
    }),
  };
  const make = (tag, attrs = {}, cls = "") => {
    const n = document.createElement(tag);
    n.className = cls;
    for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value);
    return n;
  };
  const views = Array.from({ length: composers }, (_, i) => {
    const session = make("div", { "data-session-id": "synthetic-session-" + i });
    const card = make("div", { "data-composer-layout": "stacked" });
    const input = make("div", { "data-testid": "v4-composer-input" });
    let draft = "synthetic test draft " + i;
    if (lexical) {
      input.setAttribute("data-e2e-lexical-bridge", "ready");
      input.__zcodeLexicalInputE2E = { getText: () => draft, setText: (text) => { draft = text; } };
    }
    const row = make("div", {}, "group/toolbar flex");
    const leading = make("div", { "data-composer-leading-actions": "true" });
    const trailing = make("div", { "data-composer-trailing-actions": "true" });
    const context = make("button", { "data-testid": "chat-context-usage-trigger" });
    const model = make("button", { "data-testid": "chat-model-select-trigger" });
    trailing.appendChild(context); trailing.appendChild(model);
    trailing.appendChild(make("button", { "data-testid": "v4-composer-send" }));
    row.appendChild(leading); row.appendChild(trailing);
    card.appendChild(input); card.appendChild(row);
    session.appendChild(card); document.body.appendChild(session);
    return { session, card, input, row, leading, trailing, context, model, getDraft: () => draft };
  });
  // Date shim: .now() returns the mocked clock; `new Date(at)` is only used
  // by overlay history rows to format HH:MM labels.
  function DateShim(at) { this.at = at ?? 0; }
  DateShim.now = () => now;
  DateShim.prototype.getHours = function () { return 12; };
  DateShim.prototype.getMinutes = function () { return 34; };
  const context = vm.createContext({
    window, document, navigator: { language: "zh-CN" },
    Date: DateShim,
    setInterval(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    Promise, JSON, String, Number, Object, Array, Error,
  });
  vm.runInContext(source, context);
  return {
    window, document, views, make, generation, timers,
    advance(ms) { now += ms; },
    scan() { for (const t of [...timers.values()]) if (t.ms === 800) t.fn(); },
    tick() { for (const t of [...timers.values()]) if (t.ms === 200) t.fn(); },
    async settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); },
  };
}

function controls(view) {
  const panel = view.card.querySelector(".pe-panel");
  return {
    panel,
    button: view.card.querySelector(".pe-btn"),
    textarea: panel.querySelector("textarea"),
    cancel: panel.querySelectorAll("button").find((n) => n.innerHTML === "取消"),
    retry: panel.querySelectorAll("button").find((n) => n.innerHTML === "重新生成"),
    apply: panel.querySelectorAll("button").find((n) => n.innerHTML === "使用增强结果"),
    revert: panel.querySelectorAll("button").find((n) => n.innerHTML === "恢复原稿"),
    historyToggle: panel.querySelectorAll("button").find((n) => n.innerHTML.indexOf("历史") === 0),
    historyBox: panel.querySelector(".pe-history"),
    dirtyBadge: panel.querySelector(".pe-dirty-badge"),
    close: panel.querySelector(".pe-panel-x"),
    status: panel.querySelector(".pe-panel-status"),
  };
}

test("mounts at the start of the trailing cluster; stable sweeps do not remount", () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  for (const n of v.trailing.children) n.removeAttribute("data-testid");
  v.row.appendChild(c.button);
  h.scan();
  assert.equal(v.trailing.children[0], c.button);
  assert.equal(c.button.nextSibling, v.context);
  assert.match(c.button.innerHTML, /✦.*增强/);
  assert.equal(c.panel.parentElement, v.card);
  h.scan(); h.scan();
  assert.equal(v.card.querySelectorAll(".pe-btn").length, 1);
});

test("ignores inert measurement clones and repairs a detached panel/button", () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  const clone = h.make("div", {}, "group/toolbar");
  clone.inert = true;
  clone.setAttribute("aria-hidden", "true");
  v.card.appendChild(clone);
  c.button.remove(); c.panel.remove();
  h.scan();
  assert.equal(c.button.parentElement, v.trailing);
  assert.equal(c.button.nextSibling, v.context);
  assert.equal(c.panel.parentElement, v.card);
  assert.equal(clone.querySelector(".pe-btn"), null);
});

test("generation uses the current session context; apply and revert manage the draft", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  const original = v.getDraft();
  c.button.click();
  assert.equal(h.generation.calls.length, 1);
  assert.deepEqual(h.generation.calls[0].context.selection, { providerId: "provider-a", modelId: "model-a" });
  assert.match(c.button.innerHTML, /■.*停止/);
  h.generation.pending[0].resolve({ text: "enhanced text" });
  await h.settle();
  assert.equal(c.textarea.value, "enhanced text");
  assert.equal(c.apply.disabled, false);
  c.apply.click();
  assert.equal(v.getDraft(), "enhanced text");
  c.close.click(); c.button.click();
  assert.equal(h.generation.calls.length, 1, "reopening does not regenerate");
  c.revert.click();
  assert.equal(v.getDraft(), original);
});

test("validated Host output reaches preview and applies only after confirmation", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  const original = "分析下本项目";
  v.input.__zcodeLexicalInputE2E.setText(original);
  const selection = { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "max" } };
  h.window.__peGetSessionContext = () => ({ selection, workspacePath: "/synthetic" });
  let pending;
  let calls = 0;
  h.generation.generate = (_input, draft, context) => {
    pending = enhanceWorkspaceText({ async generateWorkspaceText(args) {
      calls++;
      assert.equal(args.maxOutputTokens, 8192);
      assert.deepEqual(args.selection, selection);
      return {
        text: "优化后的提示词：只读分析本项目的架构与核心实现，不修改文件。",
        finishReason: "stop",
        usage: { outputTokens: 1131, reasoningTokens: 931 },
      };
    } }, { ...context, draft, remoteSessionId: "synthetic-remote", signal: new AbortController().signal });
    return pending;
  };
  c.button.click();
  await pending;
  await h.settle();
  assert.equal(calls, 1);
  assert.equal(c.textarea.value, "只读分析本项目的架构与核心实现，不修改文件。");
  assert.equal(c.apply.disabled, false);
  assert.equal(v.getDraft(), original);
  c.apply.click();
  assert.equal(v.getDraft(), c.textarea.value);
  c.revert.click();
  assert.equal(v.getDraft(), original);
});

test("Host validation failures leave preview empty and cannot replace the draft", async () => {
  for (const result of [
    { text: "partial output", finishReason: "length" },
    { text: "partial output", error: "stream error" },
    { text: "broken\ufffd", finishReason: "stop" },
  ]) {
    const h = harness();
    const v = h.views[0];
    const c = controls(v);
    const original = v.getDraft();
    let pending;
    let calls = 0;
    h.generation.generate = (_input, draft, context) => {
      pending = enhanceWorkspaceText({ async generateWorkspaceText() {
        calls++;
        return result;
      } }, { ...context, draft, remoteSessionId: "synthetic-remote", signal: new AbortController().signal });
      return pending;
    };
    c.button.click();
    await assert.rejects(pending);
    await h.settle();
    assert.equal(calls, 1);
    assert.equal(c.textarea.value, "");
    assert.equal(c.apply.disabled, true);
    assert.match(c.status.className, /pe-error/);
    assert.equal(c.historyBox.children.length, 0);
    c.apply.click();
    assert.equal(v.getDraft(), original);
  }
});

test("stop cancels exactly the running generation and clears the timer", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  assert.equal(h.timers.size, 2, "scan + generation watchdog");
  c.button.click();
  assert.equal(h.generation.cancelled, 1);
  assert.equal(h.timers.size, 1);
  assert.match(c.button.innerHTML, /✦.*增强/);
  assert.match(c.status.textContent, /取消/);
  h.generation.pending[0].resolve({ text: "late result" });
  await h.settle();
  assert.equal(c.textarea.value, "", "late result never reaches the preview");
});

test("retry after cancellation rejects late output from the earlier generation", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  c.button.click();
  c.retry.click();
  h.generation.pending[0].resolve({ text: "late old output" });
  await h.settle();
  assert.equal(c.textarea.value, "");
  assert.match(c.button.innerHTML, /■.*停止/);
  h.generation.pending[1].resolve({ text: "new output" });
  await h.settle();
  assert.equal(c.textarea.value, "new output");
  assert.equal(c.apply.disabled, false);
});

test("model switch stops the old generation; retry uses the new selection", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  let selection = { providerId: "provider-a", modelId: "model-a" };
  h.window.__peGetSessionContext = () => ({ selection, workspacePath: "/synthetic" });
  c.button.click();
  selection = { providerId: "provider-b", modelId: "model-b" };
  h.tick();
  assert.equal(h.generation.cancelled, 1);
  assert.match(c.status.textContent, /模型已切换/);
  c.retry.click();
  assert.equal(h.generation.calls[1].context.selection.providerId, "provider-b");
});

test("second composer cancels only the previous controller", () => {
  const h = harness({ composers: 2 });
  const a = controls(h.views[0]);
  const b = controls(h.views[1]);
  a.button.click();
  const firstDraft = h.generation.calls[0].draft;
  b.button.click();
  assert.equal(h.generation.cancelled, 1, "starting elsewhere cancels the previous generation");
  assert.equal(h.generation.calls.length, 2);
  assert.equal(h.generation.calls[1].draft, "synthetic test draft 1", "each composer owns its draft");
  assert.match(a.button.innerHTML, /✦.*增强/);
  assert.match(b.button.innerHTML, /■.*停止/);
  assert.notEqual(firstDraft, h.generation.calls[1].draft);
});

test("input, session or toolbar replacement destroys the old control and cancels", () => {
  for (const change of ["input", "session", "toolbar", "removed"]) {
    const h = harness();
    const v = h.views[0];
    const old = controls(v);
    old.button.click();
    if (change === "input") {
      const replacement = h.make("div", { "data-testid": "v4-composer-input", "data-e2e-lexical-bridge": "ready" });
      replacement.__zcodeLexicalInputE2E = v.input.__zcodeLexicalInputE2E;
      v.card.insertBefore(replacement, v.input); v.input.remove();
    } else if (change === "session") v.session.setAttribute("data-session-id", "new-session");
    else if (change === "toolbar") { v.row.remove(); v.card.appendChild(h.make("div", {}, "group/toolbar")); }
    else v.session.remove();
    h.scan();
    assert.equal(h.generation.cancelled, 1, change);
    assert.equal(h.document.body.contains(old.button), false, change);
    assert.equal(old.panel.parentElement, null, change);
    if (change !== "removed") assert.equal(v.card.querySelectorAll(".pe-btn").length, 1, change);
  }
});

test("missing host bridge or lexical bridge fails before generation", () => {
  for (const options of [{ available: false }, { lexical: false }]) {
    const h = harness(options);
    const c = controls(h.views[0]);
    c.button.click();
    assert.match(c.status.textContent, /host patch missing|输入框读写桥未就绪/);
    assert.equal(h.generation.calls.length, 0);
    assert.match(c.button.innerHTML, /增强/);
  }
});

test("hard timeout cancels its own request", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  h.advance(120001);
  h.tick();
  assert.equal(h.generation.cancelled, 1);
  assert.match(c.status.textContent, /超时/);
});

test("repeated apply still restores the original draft", async () => {
  const h = harness();
  const v = h.views[0];
  const original = v.getDraft();
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "first" });
  await h.settle();
  c.apply.click();
  c.retry.click();
  h.generation.pending[1].resolve({ text: "second" });
  await h.settle();
  c.apply.click();
  assert.equal(v.getDraft(), "second");
  c.revert.click();
  assert.equal(v.getDraft(), original);
});

test("unchanged draft reuses the last result; retry is the only regeneration path", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "enhanced once" });
  await h.settle();
  c.close.click();
  c.button.click();
  assert.equal(h.generation.calls.length, 1, "same draft does not trigger a second generation");
  assert.equal(c.textarea.value, "enhanced once");
  assert.match(c.status.textContent, /复用/);
  c.retry.click();
  assert.equal(h.generation.calls.length, 2, "panel retry regenerates");
  h.generation.pending[1].resolve({ text: "enhanced twice" });
  await h.settle();
  assert.equal(c.textarea.value, "enhanced twice");
  v.input.__zcodeLexicalInputE2E.setText("a different draft");
  c.close.click();
  c.button.click();
  assert.equal(h.generation.calls.length, 3, "edited draft regenerates");
  assert.equal(h.generation.calls[2].draft, "a different draft");
});

test("empty composer clears the preview instead of keeping stale results", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "stale enhanced" });
  await h.settle();
  v.input.__zcodeLexicalInputE2E.setText("");
  c.close.click();
  c.button.click();
  assert.equal(h.generation.calls.length, 1, "no generation for an empty composer");
  assert.equal(c.textarea.value, "");
  assert.match(c.status.textContent, /输入框为空/);
  assert.equal(c.apply.disabled, true);

  // applied results must not leak back either once the composer is emptied
  c.close.click();
  v.input.__zcodeLexicalInputE2E.setText("draft again");
  c.button.click();
  h.generation.pending[1].resolve({ text: "applied text" });
  await h.settle();
  c.apply.click();
  assert.equal(v.getDraft(), "applied text");
  v.input.__zcodeLexicalInputE2E.setText("");
  c.close.click();
  c.button.click();
  assert.equal(c.textarea.value, "", "applied result does not leak back either");
  assert.equal(h.generation.calls.length, 2);
});

test("sweep clears stale panel content once the composer is emptied", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "generated" });
  await h.settle();
  v.input.__zcodeLexicalInputE2E.setText("");
  h.scan();
  assert.equal(c.textarea.value, "", "open panel drops non-dirty residue within one sweep");
});

test("history keeps the 10 most recent results and deletes single entries", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  for (let i = 1; i <= 12; i++) {
    c.close.click();
    c.button.click();
    h.generation.pending[i - 1].resolve({ text: "enhanced " + i });
    await h.settle();
    v.input.__zcodeLexicalInputE2E.setText("draft " + (i + 1));
  }
  c.historyToggle.click();
  const items = c.historyBox.querySelectorAll(".pe-history-item");
  assert.equal(items.length, 10, "capped at 10 entries");
  assert.equal(items[0].querySelector(".pe-history-text").textContent, "enhanced 12", "newest first");
  assert.equal(items[9].querySelector(".pe-history-text").textContent, "enhanced 3", "oldest trimmed");
  c.historyBox.querySelectorAll(".pe-history-del")[4].click();
  const after = c.historyBox.querySelectorAll(".pe-history-item");
  assert.equal(after.length, 9, "exactly one entry removed");
  assert.equal(after[4].querySelector(".pe-history-text").textContent, "enhanced 7", "only the targeted entry is gone");
});

test("history entry click loads the text; regenerating replaces the entry", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  h.generation.pending[0].resolve({ text: "first" });
  await h.settle();
  c.retry.click();
  h.generation.pending[1].resolve({ text: "second" });
  await h.settle();
  c.historyToggle.click();
  const items = c.historyBox.querySelectorAll(".pe-history-item");
  assert.equal(items.length, 1, "retry on the same draft replaces, not duplicates");
  assert.equal(items[0].querySelector(".pe-history-text").textContent, "second");
  items[0].click();
  assert.equal(c.textarea.value, "second");
  assert.equal(c.apply.disabled, false);
});

test("reuse keeps hand-edited preview content", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "raw result" });
  await h.settle();
  c.textarea.value = "my hand edit";
  c.textarea.fire("input");
  c.close.click();
  c.button.click();
  assert.equal(h.generation.calls.length, 1, "no regeneration");
  assert.equal(c.textarea.value, "my hand edit", "hand edit survives the reuse reopen");
  assert.match(c.status.textContent, /复用/);
});

test("whitespace-only draft drift still reuses the last result", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "result" });
  await h.settle();
  c.close.click();
  v.input.__zcodeLexicalInputE2E.setText(v.getDraft() + "  ");
  c.button.click();
  assert.equal(h.generation.calls.length, 1, "trailing-space draft does not regenerate");
  assert.equal(c.textarea.value, "result");
});

test("retry with an empty composer clears the panel and collapses history", async () => {
  const h = harness();
  const v = h.views[0];
  const c = controls(v);
  c.button.click();
  h.generation.pending[0].resolve({ text: "one" });
  await h.settle();
  c.historyToggle.click();
  assert.equal(c.historyBox.style.display, "block");
  v.input.__zcodeLexicalInputE2E.setText("");
  c.retry.click();
  assert.equal(h.generation.calls.length, 1, "no generation for an empty composer");
  assert.equal(c.textarea.value, "");
  assert.match(c.status.textContent, /输入框为空/);
  assert.equal(c.historyBox.style.display, "none", "clear path folds the history box");
});

test("deleting the last history entry collapses the list and hides the toggle", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  h.generation.pending[0].resolve({ text: "only" });
  await h.settle();
  c.historyToggle.click();
  assert.equal(c.historyBox.style.display, "block");
  c.historyBox.querySelectorAll(".pe-history-del")[0].click();
  assert.equal(c.historyBox.style.display, "none", "box folds when emptied");
  assert.equal(c.historyToggle.style.display, "none", "toggle hides when empty");
});

test("history entries are keyboard operable", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  h.generation.pending[0].resolve({ text: "kbd result" });
  await h.settle();
  c.historyToggle.click();
  const item = c.historyBox.querySelectorAll(".pe-history-item")[0];
  assert.equal(item.getAttribute("role"), "button");
  assert.equal(item.getAttribute("tabindex"), "0");
  item.fire("keydown", { key: "Enter" });
  assert.equal(c.textarea.value, "kbd result");
});

test("history dedupes per session: the same draft in two sessions keeps both entries", async () => {
  const h = harness({ composers: 2 });
  const a = controls(h.views[0]);
  const b = controls(h.views[1]);
  h.views[1].input.__zcodeLexicalInputE2E.setText("synthetic test draft 0"); // same draft as composer 0
  a.button.click();
  h.generation.pending[0].resolve({ text: "from session a" });
  await h.settle();
  b.button.click();
  h.generation.pending[1].resolve({ text: "from session b" });
  await h.settle();
  b.historyToggle.click();
  const items = b.historyBox.querySelectorAll(".pe-history-item");
  assert.equal(items.length, 2, "cross-session same draft does not evict");
  assert.equal(items[0].querySelector(".pe-history-text").textContent, "from session b");
  assert.equal(items[1].querySelector(".pe-history-text").textContent, "from session a");
});

test("session tables are capped: the oldest session's reuse cache is evicted", async () => {
  const N = 52; // SESSION_TABLE_LIMIT is 50
  const h = harness({ composers: N });
  for (let i = 0; i < N; i++) {
    const c = controls(h.views[i]);
    c.button.click();
    h.generation.pending[i].resolve({ text: "e" + i });
    await h.settle();
  }
  const first = controls(h.views[0]);
  first.close.click();
  first.button.click();
  assert.equal(h.generation.calls.length, N + 1, "session 0 evicted after 51 newer sessions; reuse falls back to generation");
});

test("dirty badge reflects hand edits", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  assert.equal(c.dirtyBadge.style.display, "none");
  c.button.click();
  h.generation.pending[0].resolve({ text: "generated" });
  await h.settle();
  assert.equal(c.dirtyBadge.style.display, "none", "fresh result is not dirty");
  c.textarea.value = "edited";
  c.textarea.fire("input");
  assert.equal(c.dirtyBadge.style.display, "", "hand edit shows the badge");
  c.retry.click();
  h.generation.pending[1].resolve({ text: "regenerated" });
  await h.settle();
  assert.equal(c.dirtyBadge.style.display, "none", "retry clears the badge");
});

test("history rows show draft snippet and time", async () => {
  const h = harness();
  const c = controls(h.views[0]);
  c.button.click();
  h.generation.pending[0].resolve({ text: "enhanced" });
  await h.settle();
  c.historyToggle.click();
  const meta = c.historyBox.querySelectorAll(".pe-history-item")[0].querySelector(".pe-history-meta");
  assert.ok(meta.textContent.indexOf("synthetic test draft 0") >= 0, "draft preview present");
  assert.ok(/\d{2}:\d{2}$/.test(meta.textContent), "HH:MM time present");
});
