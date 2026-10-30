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
 * except for the single zcode-agent `.register(<token>,<service>)` expression;
 * removal restores it.
 */

export const HOST_ENTRY = "out/host/index.js";
export const HOST_MARKER = "zcode-prompt-enhancer-host";
export const HOST_PATCH_START = "/* zcode-prompt-enhancer-host:start */";
export const HOST_PATCH_END = "/* zcode-prompt-enhancer-host:end */";

/* Registration anchors. The two identifiers are minified per ZCode release;
 * when a ZCode update renames them, ADD the new literal here (keep old ones
 * so remove can still undo archives patched with them). Everything else in
 * this module derives from the list.
 *   .register(Kr,dt)  earlier ZCode builds
 *   .register(er,at)  @zcode/desktop 3.17.1 (er = ZCodeAgent token, at = service) */
export const HOST_REGISTRATION_VARIANTS = [".register(Kr,dt)", ".register(er,at)"];
const GENERIC_REGISTRATION_RE = /\.register\((\w+),(\w+)\)/g;

function wrappedOf(variant) {
  return variant.replace(/\.register\((\w+),(\w+)\)$/, ".register($1,__peWrapZcodeAgentService($2))");
}

/** The variant the bundle uses, when exactly one occurrence exists. */
export function hostRegistrationVariant(text) {
  for (const variant of HOST_REGISTRATION_VARIANTS) {
    if (typeof text === "string" && text.split(variant).length - 1 === 1) return variant;
  }
  return null;
}

/** Which variant an already-patched text was patched with. */
export function hostPatchedVariant(text) {
  if (typeof text !== "string") return null;
  for (const variant of HOST_REGISTRATION_VARIANTS) {
    if (text.includes(wrappedOf(variant))) return variant;
  }
  return null;
}

function registrationSurvey(text) {
  const counts = new Map();
  for (const m of typeof text === "string" ? text.matchAll(GENERIC_REGISTRATION_RE) : []) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => `${k} x${v}`).join(", ") || "none";
}

export function buildHostPatchSource(moduleUrl = null) {
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
    "      var result;\n" +
    "      if (typeof params.draft === \"string\") {\n" +
    "        var moduleUrl = " + JSON.stringify(moduleUrl) + ";\n" +
    "        if (!moduleUrl) throw new Error(\"Project context runtime unavailable; reinstall desktop integration\");\n" +
    "        var enhancer = await import(moduleUrl);\n" +
    "        if (controller.signal.aborted) throw new Error(\"Prompt enhancement cancelled\");\n" +
    "        result = await enhancer.enhanceWorkspaceText(service, args);\n" +
    "      } else {\n" +
    "        result = await service.generateWorkspaceText(args);\n" +
    "      }\n" +
    "      return Object.assign({}, result, { operationId: operationId, promptEnhancerProtocol: 2 });\n" +
    "    } finally {\n" +
    "      if (controllers.get(operationId) === controller) controllers.delete(operationId);\n" +
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
  return typeof text === "string" && text.includes(HOST_PATCH_START + "\n") && hostPatchedVariant(text) !== null;
}

export function stripHostPatch(text) {
  let out = text;
  const block = /\n?\/\* zcode-prompt-enhancer-host:start \*\/[\s\S]*?\/\* zcode-prompt-enhancer-host:end \*\/\n?/g;
  out = out.replace(block, "");
  for (const variant of HOST_REGISTRATION_VARIANTS) {
    out = out.split(wrappedOf(variant)).join(variant);
  }
  return out;
}

export function applyHostPatch(text, moduleUrl = null) {
  if (typeof text !== "string") throw new Error("host entry is not text");
  let out = stripHostPatch(text);
  const variant = hostRegistrationVariant(out);
  if (!variant) {
    for (const known of HOST_REGISTRATION_VARIANTS) {
      const count = out.split(known).length - 1;
      if (count > 1) {
        throw new Error(`unsupported ZCode host bundle: expected exactly one ${known} registration, found ${count}`);
      }
    }
    throw new Error(
      `unsupported ZCode host bundle: no known .register(<class>,<service>) anchor ` +
      `(known: ${HOST_REGISTRATION_VARIANTS.join(", ")}; register calls found: ${registrationSurvey(out)}). ` +
      `Add the new ZCode literal to HOST_REGISTRATION_VARIANTS in desktop/host-patch.mjs.`
    );
  }
  out = out.replace(variant, wrappedOf(variant)) + buildHostPatchSource(moduleUrl);
  return out;
}
