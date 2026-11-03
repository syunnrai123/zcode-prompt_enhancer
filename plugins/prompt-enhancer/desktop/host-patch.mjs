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

// Acorn 8.15.0: unchanged npm dist/acorn.mjs; MIT license in vendor/acorn.LICENSE.
import { parse } from "./vendor/acorn.mjs";

export const HOST_ENTRY = "out/host/index.js";
export const HOST_MARKER = "zcode-prompt-enhancer-host";
export const HOST_PATCH_START = "/* zcode-prompt-enhancer-host:start */";
export const HOST_PATCH_END = "/* zcode-prompt-enhancer-host:end */";

/* Minified names change between releases. These literals only provide a
 * compatibility path for old, structure-free fixtures; they never override
 * contradictory bindings or multiple structurally valid registration calls. */
export const HOST_REGISTRATION_VARIANTS = [".register(Kr,dt)", ".register(er,at)", ".register(tr,ct)"];
const WRAPPER = "__peWrapZcodeAgentService";

function parseHost(text) {
  if (typeof text !== "string") return null;
  for (const sourceType of ["module", "script"]) {
    const comments = [];
    try {
      return { ast: parse(text, { ecmaVersion: "latest", sourceType, onComment: comments }), comments };
    } catch (_) { /* Unsupported or malformed JavaScript must fail closed. */ }
  }
  return null;
}

function isFunction(node) {
  return node && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
}

function children(node) {
  const out = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") out.push(child);
    } else if (value && typeof value.type === "string") out.push(value);
  }
  return out;
}

function patternNames(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "RestElement") return patternNames(node.argument);
  if (node.type === "AssignmentPattern") return patternNames(node.left);
  if (node.type === "ArrayPattern") return node.elements.flatMap(patternNames);
  if (node.type === "ObjectPattern") return node.properties.flatMap((p) => patternNames(p.type === "RestElement" ? p.argument : p.value));
  return [];
}

function propertyName(node) {
  return !node.computed && node.key?.type === "Identifier" ? node.key.name :
    node.key?.type === "Literal" ? node.key.value : null;
}

function tokenReference(node) {
  return node?.type === "Identifier" && node.name === "ZCodeAgent" ||
    node?.type === "MemberExpression" && !node.optional &&
    (node.computed ? node.property.type === "Literal" && node.property.value === "ZCodeAgent" : node.property.name === "ZCodeAgent");
}

function tokenInitializer(node) {
  return node?.type === "CallExpression" && !node.optional &&
    node.arguments.length === 1 && tokenReference(node.arguments[0]);
}

function serviceObject(node) {
  if (node?.type !== "ObjectExpression") return false;
  // A spread, accessor or duplicate could replace the method at runtime.
  if (node.properties.some((p) => p.type === "SpreadElement" || propertyName(p) === null)) return false;
  const methods = node.properties.filter((p) => propertyName(p) === "generateWorkspaceText");
  return methods.length === 1 && methods[0].kind === "init" && isFunction(methods[0].value);
}

function lastExpression(node) {
  return node?.type === "SequenceExpression" ? lastExpression(node.expressions.at(-1)) : node;
}

/* This is deliberately not a general data-flow evaluator. Only immutable,
 * locally declared initializers and direct factory returns are proofs. Unknown
 * aliases, assignments, branches and dynamic scopes are refused, not guessed. */
function analyzeHost(text) {
  const parsed = parseHost(text);
  if (!parsed) return null;
  const scopes = new WeakMap(), parents = new WeakMap(), nodes = [], writes = [];
  let structuralEvidence = false, dynamicScope = false;
  const makeScope = (parent, kind) => ({ parent, kind, bindings: new Map() });
  const root = makeScope(null, "function");
  const declare = (scope, name, init = null, declaration = null) => {
    const binding = scope.bindings.get(name);
    if (binding) { binding.conflict = true; return; }
    scope.bindings.set(name, { init, declaration, scope, conflict: false, written: false });
  };
  const visit = (node, scope, parent = null) => {
    nodes.push(node);
    parents.set(node, parent);
    if (tokenReference(node)) structuralEvidence = true;
    if (node.type === "WithStatement" || node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval") dynamicScope = true;
    if (isFunction(node)) {
      if (node.type === "FunctionDeclaration" && node.id) declare(scope, node.id.name, node, node);
      scope = makeScope(scope, "function");
      if (node.type === "FunctionExpression" && node.id) declare(scope, node.id.name);
      for (const param of node.params) for (const name of patternNames(param)) declare(scope, name);
    } else if (["BlockStatement", "SwitchStatement", "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause", "ClassExpression", "ClassDeclaration", "StaticBlock"].includes(node.type)) {
      if (node.type === "ClassDeclaration" && node.id) declare(scope, node.id.name);
      scope = makeScope(scope, node.type === "StaticBlock" ? "function" : "block");
      if ((node.type === "ClassExpression" || node.type === "ClassDeclaration") && node.id) declare(scope, node.id.name);
      if (node.type === "CatchClause") for (const name of patternNames(node.param)) declare(scope, name);
    }
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration") {
      let target = scope;
      if (node.kind === "var") while (target.parent && target.kind !== "function") target = target.parent;
      for (const decl of node.declarations) {
        for (const name of patternNames(decl.id)) declare(target, name, decl.id.type === "Identifier" ? decl.init : null, decl);
      }
    }
    if (node.type === "ImportDeclaration") for (const spec of node.specifiers) declare(scope, spec.local.name);
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") writes.push(node);
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      if (node.left.type !== "VariableDeclaration") writes.push({ left: node.left, scope });
      else for (const decl of node.left.declarations) writes.push({ left: decl.id, scope });
    }
    for (const child of children(node)) visit(child, scope, node);
  };
  visit(parsed.ast, root);
  const lookup = (name, scope) => {
    for (let at = scope; at; at = at.parent) if (at.bindings.has(name)) return at.bindings.get(name);
    return null;
  };
  const bindingOf = (node) => node?.type === "Identifier" ? lookup(node.name, scopes.get(node)) : null;
  for (const write of writes) {
    for (const name of patternNames(write.left ?? write.argument)) {
      const binding = lookup(name, write.scope ?? scopes.get(write));
      if (binding) binding.written = true;
    }
  }
  const stable = (binding, use) => {
    if (!binding || binding.conflict || binding.written || !binding.init) return false;
    if (binding.init.type === "FunctionDeclaration") return true;
    if (binding.declaration.end >= use.start) return false;
    // No conditional/loop/catch initialization can prove a value reaches a use.
    for (let at = parents.get(binding.declaration); at; at = parents.get(at)) {
      if (at.type === "Program" || isFunction(at)) break;
      if (!["VariableDeclaration", "BlockStatement", "ExportNamedDeclaration"].includes(at.type)) return false;
    }
    return true;
  };
  const factoryReturnsService = (callee) => {
    const binding = bindingOf(callee);
    if (!stable(binding, callee) || !isFunction(binding.init) || binding.init.async || binding.init.generator) return false;
    const fn = binding.init;
    if (fn.body.type !== "BlockStatement") return serviceObject(lastExpression(fn.body));
    if (fn.body.body.at(-1)?.type !== "ReturnStatement") return false;
    const returns = [];
    const collect = (node) => {
      if (isFunction(node)) return;
      if (node.type === "ReturnStatement") returns.push(node.argument);
      for (const child of children(node)) collect(child);
    };
    collect(fn.body);
    return returns.length > 0 && returns.every((value) => serviceObject(lastExpression(value)));
  };
  const registrations = [], wrapped = [];
  for (const call of nodes) {
    if (call.type !== "CallExpression" || call.optional || call.callee.type !== "MemberExpression" || call.callee.optional ||
        call.callee.computed || call.callee.property.name !== "register" || call.arguments.length !== 2) continue;
    const [token, service] = call.arguments;
    if (token.type !== "Identifier") continue;
    if (service.type === "CallExpression" && !service.optional && service.callee.type === "Identifier" && service.callee.name === WRAPPER &&
        service.arguments.length === 1 && service.arguments[0].type === "Identifier") {
      wrapped.push({ call, wrapper: service, service: service.arguments[0], variant: `.register(${token.name},${service.arguments[0].name})` });
    }
    if (service.type !== "Identifier") continue;
    const tokenBinding = bindingOf(token), serviceBinding = bindingOf(service);
    const factory = serviceBinding?.init;
    const proven = !dynamicScope && stable(tokenBinding, token) && tokenInitializer(tokenBinding.init) &&
      stable(serviceBinding, service) && factory?.type === "CallExpression" && !factory.optional &&
      factory.callee.type === "Identifier" && factoryReturnsService(factory.callee);
    registrations.push({ call, token, service, tokenBinding, serviceBinding, proven, variant: `.register(${token.name},${service.name})` });
  }
  return { ...parsed, registrations, wrapped, structuralEvidence, dynamicScope, stable };
}

function selectRegistration(analysis) {
  if (!analysis || analysis.dynamicScope) return null;
  const derived = analysis.registrations.filter((r) => r.proven);
  // Count occurrences, not distinct spellings. Duplicates are ambiguity too.
  if (derived.length > 1) return null;
  if (derived.length === 1) {
    const registration = derived[0];
    return { registration, source: HOST_REGISTRATION_VARIANTS.includes(registration.variant) ? "known" : "derived" };
  }
  if (analysis.structuralEvidence) return null;
  const legacy = analysis.registrations.filter((r) => {
    if (!HOST_REGISTRATION_VARIANTS.includes(r.variant) || r.tokenBinding) return false;
    return !r.serviceBinding || analysis.stable(r.serviceBinding, r.service) && serviceObject(r.serviceBinding.init);
  });
  return legacy.length === 1 ? { registration: legacy[0], source: "known" } : null;
}

/** Known spellings are accepted only after the same structural validation. */
export function hostRegistrationVariant(text) {
  const selected = selectRegistration(analyzeHost(text));
  return selected?.source === "known" ? selected.registration.variant : null;
}

export function deriveRegistrationVariant(text) {
  const candidates = analyzeHost(text)?.registrations.filter((r) => r.proven) ?? [];
  return candidates.length === 1 ? candidates[0].variant : null;
}

export function resolveRegistration(text) {
  const selected = selectRegistration(analyzeHost(text));
  return selected ? { variant: selected.registration.variant, source: selected.source } : null;
}

/** String/comment lookalikes and multiple wrapper calls are not patch state. */
export function hostPatchedVariant(text) {
  const wrapped = analyzeHost(text)?.wrapped ?? [];
  return wrapped.length === 1 ? wrapped[0].variant : null;
}

function registrationSurvey(analysis) {
  const counts = new Map();
  for (const { variant } of analysis?.registrations ?? []) counts.set(variant, (counts.get(variant) ?? 0) + 1);
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

function patchBlocks(text, analysis) {
  const blocks = [];
  const comments = analysis?.comments ?? [];
  for (let i = 0; i < comments.length; i++) {
    const start = comments[i];
    if (text.slice(start.start, start.end) !== HOST_PATCH_START) continue;
    const end = comments[i + 1];
    if (!end || text.slice(end.start, end.end) !== HOST_PATCH_END) continue;
    const body = analysis.ast.body.filter((n) => n.start >= start.end && n.end <= end.start);
    if (body.length !== 1 || body[0].type !== "FunctionDeclaration" || body[0].id?.name !== WRAPPER ||
        text.slice(start.end, body[0].start).trim() || text.slice(body[0].end, end.start).trim()) continue;
    blocks.push({
      start: start.start - (text[start.start - 1] === "\n" ? 1 : 0),
      end: end.end + (text[end.end] === "\n" ? 1 : 0)
    });
  }
  return blocks;
}

export function isHostPatched(text) {
  const analysis = analyzeHost(text);
  return !!analysis && analysis.wrapped.length === 1 && patchBlocks(text, analysis).length === 1;
}

export function stripHostPatch(text) {
  const analysis = analyzeHost(text);
  if (!analysis) return text;
  const edits = patchBlocks(text, analysis);
  for (const { wrapper, service } of analysis.wrapped) {
    if (edits.some((e) => wrapper.start >= e.start && wrapper.end <= e.end)) continue;
    // Remove only the inserted call delimiters. Original argument spelling,
    // comments, whitespace and every '$' byte survive without replacement rules.
    edits.push({ start: wrapper.start, end: service.start }, { start: service.end, end: wrapper.end });
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + out.slice(edit.end);
  return out;
}

export function applyHostPatch(text, moduleUrl = null) {
  if (typeof text !== "string") throw new Error("host entry is not text");
  const out = stripHostPatch(text);
  const analysis = analyzeHost(out);
  const selected = selectRegistration(analysis);
  if (!selected) {
    for (const known of HOST_REGISTRATION_VARIANTS) {
      const count = analysis?.registrations.filter((r) => r.variant === known).length ?? 0;
      if (count > 1) {
        throw new Error(`unsupported ZCode host bundle: expected exactly one ${known} registration, found ${count}`);
      }
    }
    throw new Error(
      `unsupported ZCode host bundle: no unique, structurally proven .register(<class>,<service>) anchor ` +
      `(known: ${HOST_REGISTRATION_VARIANTS.join(", ")}; register calls found: ${registrationSurvey(analysis)}). ` +
      `Conflicting or unproven bindings require reviewing desktop/host-patch.mjs, not adding a literal.`
    );
  }
  const { service } = selected.registration;
  return out.slice(0, service.start) + WRAPPER + "(" + out.slice(service.start, service.end) + ")" +
    out.slice(service.end) + buildHostPatchSource(moduleUrl);
}
