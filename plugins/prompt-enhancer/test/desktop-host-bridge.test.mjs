import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../desktop/host-bridge.js", import.meta.url), "utf8");

function harness(selection = { providerId: "custom-provider", modelId: "custom-model" }) {
  const window = {
    __PE_SYSTEM_PROMPT: "SYSTEM",
    cancelled: []
  };
  const services = {
    zcodeAgentService: {
      __peGenerateWorkspaceText: async (args) => ({ text: "enhanced text", selection: args.selection, promptEnhancerProtocol: 2 }),
      __peCancelWorkspaceText: (args) => { window.cancelled.push(args.operationId); return Promise.resolve({ cancelled: true }); }
    }
  };
  window.__peGetHostService = () => services;
  const context = vm.createContext({ window, TextEncoder, TextDecoder, Uint8Array, Date, Math, Number, Promise, Object, Error, JSON });
  vm.runInContext(source, context);
  return { bridge: window.__peHostBridge, window, services, selection };
}

test("generate forwards the draft and workspace to Host project-context assembly", async () => {
  const { bridge, window, selection, services } = harness();
  let args;
  services.zcodeAgentService.__peGenerateWorkspaceText = async (input) => {
    args = input;
    return { text: "enhanced text", selection: input.selection, promptEnhancerProtocol: 2 };
  };
  const result = await bridge.generate({}, "优化这段代码", { selection, workspacePath: "/workspace" });
  assert.equal(args.draft, "优化这段代码");
  assert.equal(args.workspacePath, "/workspace");
  assert.equal(args.messages, undefined);
  assert.equal(args.maxOutputTokens, undefined);
  assert.equal(result.text, "enhanced text");
  assert.equal(result.provider, "custom-provider");
  assert.equal(result.model, "custom-model");
  assert.deepEqual(window.cancelled, []);
});

test("cancel aborts only the active operation", async () => {
  let finish;
  const { bridge, window, services } = harness();
  let operationId = null;
  services.zcodeAgentService.__peGenerateWorkspaceText = (args) => {
    operationId = args.operationId;
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = bridge.generate({}, "draft", { selection: { providerId: "p", modelId: "m" }, workspacePath: "/w" });
  await Promise.resolve();
  assert.equal(bridge.available({}), true);
  assert.equal(await bridge.cancel(), true);
  assert.deepEqual(window.cancelled, [operationId]);
  finish({ text: "late", promptEnhancerProtocol: 2 });
  await assert.rejects(pending, /取消/, "cancelled late output is never returned");
});

test("unavailable reason mentions reinstall when the host patch is absent", () => {
  const { bridge, services } = harness();
  services.zcodeAgentService = {};
  assert.equal(bridge.available({}), false);
  assert.match(bridge.reasonUnavailable({}), /install\.cmd/);
});

test("old Host protocol fails with a clear reinstall error instead of generating without context", async () => {
  const { bridge, selection, services } = harness();
  services.zcodeAgentService.__peGenerateWorkspaceText = async () => ({ text: "old output" });
  await assert.rejects(bridge.generate({}, "draft", { selection, workspacePath: "/w" }), /项目上下文接口未启用/);
});

test("synchronous service failure leaves the bridge ready for retry", async () => {
  const { bridge, selection, services } = harness();
  services.zcodeAgentService.__peGenerateWorkspaceText = () => { throw new Error("connection reset"); };
  await assert.rejects(bridge.generate({}, "draft", { selection, workspacePath: "/w" }), /connection reset/);
  services.zcodeAgentService.__peGenerateWorkspaceText = async () => ({ text: "valid", promptEnhancerProtocol: 2 });
  assert.equal((await bridge.generate({}, "draft", { selection, workspacePath: "/w" })).text, "valid");
});

test("cancel before dispatch prevents a model request", async () => {
  const { bridge, selection, services } = harness();
  let calls = 0;
  services.zcodeAgentService.__peGenerateWorkspaceText = async () => { calls++; return { text: "late", promptEnhancerProtocol: 2 }; };
  const pending = bridge.generate({}, "draft", { selection, workspacePath: "/w" });
  await bridge.cancel();
  await assert.rejects(pending, /取消/);
  assert.equal(calls, 0);
});

test("empty model output is treated as an error", async () => {
  const { bridge, selection, services } = harness();
  services.zcodeAgentService.__peGenerateWorkspaceText = async () => ({ text: "   ", promptEnhancerProtocol: 2 });
  await assert.rejects(
    bridge.generate({}, "draft", { selection, workspacePath: "/w" }),
    /空结果/
  );
});
