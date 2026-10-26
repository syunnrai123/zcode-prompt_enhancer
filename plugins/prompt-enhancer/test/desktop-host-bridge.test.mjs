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
      __peGenerateWorkspaceText: async (args) => ({ text: "enhanced text", selection: args.selection }),
      __peCancelWorkspaceText: (args) => { window.cancelled.push(args.operationId); return Promise.resolve({ cancelled: true }); }
    }
  };
  window.__peGetHostService = () => services;
  const context = vm.createContext({ window, TextEncoder, TextDecoder, Uint8Array, Date, Math, Number, Promise, Object, Error, JSON });
  vm.runInContext(source, context);
  return { bridge: window.__peHostBridge, window, services, selection };
}

test("generate uses the supplied session selection and system prompt", async () => {
  const { bridge, window, selection } = harness();
  const result = await bridge.generate({}, "优化这段代码", { selection, workspacePath: "/workspace" });
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
  finish({ text: "late" });
  const result = await pending;
  assert.equal(result.text, "late", "the renderer side ignores the late result");
});

test("unavailable reason mentions reinstall when the host patch is absent", () => {
  const { bridge, services } = harness();
  services.zcodeAgentService = {};
  assert.equal(bridge.available({}), false);
  assert.match(bridge.reasonUnavailable({}), /install\.cmd/);
});

test("empty model output is treated as an error", async () => {
  const { bridge, selection, services } = harness();
  services.zcodeAgentService.__peGenerateWorkspaceText = async () => ({ text: "   " });
  await assert.rejects(
    bridge.generate({}, "draft", { selection, workspacePath: "/w" }),
    /空结果/
  );
});
