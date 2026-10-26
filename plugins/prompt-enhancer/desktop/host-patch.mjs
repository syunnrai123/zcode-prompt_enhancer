/* Reversible patch for the ZCode Host bundle (out/host/index.js).
 *
 * Wraps the registered zcode-agent service with two extra RPC methods so the
 * renderer overlay can generate text with the current session model and abort
 * that exact generation:
 *
 *   __peGenerateWorkspaceText({ operationId?, ...generateTextParams })
 *   __peCancelWorkspaceText({ operationId })
 *
 * All original methods are preserved. The original ZCode flow is untouched
 * except for the single `.register(Kr,dt)` expression; removal restores it.
 */

export const HOST_ENTRY = "out/host/index.js";
export const HOST_MARKER = "zcode-prompt-enhancer-host";
export const HOST_PATCH_START = "/* zcode-prompt-enhancer-host:start */";
export const HOST_PATCH_END = "/* zcode-prompt-enhancer-host:end */";

const REGISTRATION = ".register(Kr,dt)";
const WRAPPED_REGISTRATION = ".register(Kr,__peWrapZcodeAgentService(dt))";
const REGISTRATION_RE = /\.register\(Kr,__peWrapZcodeAgentService\(dt\)\)/g;

export function buildHostPatchSource() {
  return (
    "\n" + HOST_PATCH_START + "\n" +
    "function __peWrapZcodeAgentService(service) {\n" +
    "  var controllers = new Map();\n" +
    "  var nextOperationId = function () {\n" +
    "    return \"pe-\" + Date.now().toString(36) + \"-\" + Math.random().toString(36).slice(2, 10);\n" +
    "  };\n" +
    "  var generate = async function (params) {\n" +
    "    params = params || {};\n" +
    "    var operationId = typeof params.operationId === \"string\" && params.operationId.trim()\n" +
    "      ? params.operationId.trim() : nextOperationId();\n" +
    "    var controller = new AbortController();\n" +
    "    controllers.set(operationId, controller);\n" +
    "    var args = Object.assign({}, params, {\n" +
    "      querySource: params.querySource || \"prompt_enhancer\",\n" +
    "      signal: controller.signal\n" +
    "    });\n" +
    "    delete args.operationId;\n" +
    "    try {\n" +
    "      var result = await service.generateWorkspaceText(args);\n" +
    "      return Object.assign({}, result, { operationId: operationId });\n" +
    "    } finally {\n" +
    "      controllers.delete(operationId);\n" +
    "    }\n" +
    "  };\n" +
    "  var cancel = function (params) {\n" +
    "    var operationId = params && params.operationId;\n" +
    "    var controller = operationId ? controllers.get(operationId) : null;\n" +
    "    if (!controller) return { cancelled: false };\n" +
    "    controllers.delete(operationId);\n" +
    "    controller.abort();\n" +
    "    return { cancelled: true };\n" +
    "  };\n" +
    "  return new Proxy(service, {\n" +
    "    get: function (target, key, receiver) {\n" +
    "      if (key === \"__peGenerateWorkspaceText\") return generate;\n" +
    "      if (key === \"__peCancelWorkspaceText\") return cancel;\n" +
    "      return Reflect.get(target, key, receiver);\n" +
    "    }\n" +
    "  });\n" +
    "}\n" +
    HOST_PATCH_END + "\n"
  );
}

export function isHostPatched(text) {
  return typeof text === "string" && text.includes(HOST_PATCH_START + "\n") && text.includes(WRAPPED_REGISTRATION);
}

export function stripHostPatch(text) {
  let out = text;
  const block = /\n?\/\* zcode-prompt-enhancer-host:start \*\/[\s\S]*?\/\* zcode-prompt-enhancer-host:end \*\/\n?/g;
  out = out.replace(block, "");
  out = out.replace(REGISTRATION_RE, REGISTRATION);
  return out;
}

export function applyHostPatch(text) {
  if (typeof text !== "string") throw new Error("host entry is not text");
  let out = stripHostPatch(text);
  const matches = out.split(REGISTRATION).length - 1;
  if (matches !== 1) {
    throw new Error(
      `unsupported ZCode host bundle: expected exactly one ${REGISTRATION} registration, found ${matches}`
    );
  }
  out = out.replace(REGISTRATION, WRAPPED_REGISTRATION) + buildHostPatchSource();
  return out;
}
