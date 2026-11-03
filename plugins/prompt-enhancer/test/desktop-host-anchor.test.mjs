import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  HOST_PATCH_START,
  HOST_PATCH_END,
  HOST_REGISTRATION_VARIANTS,
  applyHostPatch,
  deriveRegistrationVariant,
  hostPatchedVariant,
  hostRegistrationVariant,
  isHostPatched,
  resolveRegistration,
  stripHostPatch
} from "../desktop/host-patch.mjs";

const FACTORY = 'function mk(){return{async generateWorkspaceText(){return{text:"ok"}}}}';
const TOKEN = 'var zz=Ne(Se.ZCodeAgent);';
const SERVICE = 'var yy=mk();';
const CALL = 'services.register(zz,yy);';
const SOURCE = FACTORY + TOKEN + SERVICE + CALL;

function refuses(source) {
  assert.equal(deriveRegistrationVariant(source), null);
  assert.equal(resolveRegistration(source), null);
  assert.equal(hostRegistrationVariant(source), null);
  assert.throws(() => applyHostPatch(source), /unsupported ZCode host bundle/);
}

function roundTrip(source, variant = ".register(zz,yy)") {
  const url = 'file:///runtime/$$/workspace-enhancer.js';
  const patched = applyHostPatch(source, url);
  assert.equal(hostPatchedVariant(patched), variant);
  assert.equal(isHostPatched(patched), true);
  assert.equal(stripHostPatch(patched), source);
  assert.equal(stripHostPatch(stripHostPatch(patched)), source);
  assert.equal(applyHostPatch(patched, url), patched);
  new vm.Script(patched);
  return patched;
}

test("AST proves renamed token and returned service factory", () => {
  assert.equal(deriveRegistrationVariant(SOURCE), ".register(zz,yy)");
  assert.deepEqual(resolveRegistration(SOURCE), { variant: ".register(zz,yy)", source: "derived" });
  roundTrip(SOURCE);
});

test("dollar identifiers and replacement metacharacters survive exact, executable round trips", () => {
  for (const [token, service] of [["$z", "$s"], ["z$", "s$"], ["$$", "$$s"], ["z$$", "s$$"], ["$", "s$"]]) {
    const source = FACTORY + `var ${token}=Ne(Se.ZCodeAgent),${service}=mk();services.register(${token},${service});\n`;
    const variant = `.register(${token},${service})`;
    assert.equal(deriveRegistrationVariant(source), variant);
    const patched = roundTrip(source, variant);
    let captured;
    vm.runInNewContext(patched, {
      Ne: (value) => value,
      Se: { ZCodeAgent: "agent-token" },
      services: { register: (value, service) => { assert.equal(value, "agent-token"); captured = service; } }
    });
    assert.equal(typeof captured.generateWorkspaceText, "function");
    assert.equal(typeof captured.__peGenerateWorkspaceText, "function");
  }
});

test("factory proof accepts declarations, expressions, arrows and real minifier sequence returns", () => {
  for (const factory of [
    FACTORY,
    'const mk=function(){return{generateWorkspaceText:async function(){}}};',
    'const mk=()=>({async generateWorkspaceText(){}});',
    'function mk(){function helper(){return 0}return name(helper,"helper"),{async generateWorkspaceText(){}}}',
    'function mk(){if(flag)return{async generateWorkspaceText(){}};return{async generateWorkspaceText(){}}}'
  ]) {
    assert.equal(deriveRegistrationVariant(factory + TOKEN + SERVICE + CALL), ".register(zz,yy)");
    roundTrip(factory + TOKEN + SERVICE + CALL);
  }
});

test("factory result must itself expose the method, not an unrelated literal elsewhere", () => {
  for (const factory of [
    'function mk(){return{}}',
    'function mk(){return 1}',
    'function mk(){return "generateWorkspaceText"}',
    'function mk(){return{nested:{async generateWorkspaceText(){}}}}',
    'function mk(){function nested(){return{async generateWorkspaceText(){}}}return{}}',
    'function mk(){if(flag)return{async generateWorkspaceText(){}}}',
    'function mk(){if(flag)return{};return{async generateWorkspaceText(){}}}',
    'function mk(){return{generateWorkspaceText:1}}',
    'function mk(){return{get generateWorkspaceText(){return async()=>{}}}}',
    'function mk(){return{async generateWorkspaceText(){},...other}}',
    'function mk(){return{async generateWorkspaceText(){},generateWorkspaceText:0}}',
    'async function mk(){return{async generateWorkspaceText(){}}}',
    'function* mk(){return{async generateWorkspaceText(){}}}'
  ]) refuses('var unrelated="generateWorkspaceText";' + factory + TOKEN + SERVICE + CALL);
  refuses(TOKEN + 'var yy=externalFactory();var hint="generateWorkspaceText";' + CALL);
  refuses(FACTORY + TOKEN + 'var yy={async generateWorkspaceText(){}};' + CALL);
});

test("token proof rejects comparisons, property writes, strings and incidental class mentions", () => {
  for (const token of [
    'var zz=1;zz==Se.ZCodeAgent;',
    'var zz=1;zz===Se.ZCodeAgent;',
    'var zz=Se.ZCodeAgent===other;',
    'var zz;zz=Ne(Se.ZCodeAgent);',
    'var zz;obj.zz=Ne(Se.ZCodeAgent);',
    'var zz="ZCodeAgent";',
    'var zz=Ne("ZCodeAgent");',
    'var zz=Ne(Se.ZCodeAgent===other);',
    'var zz=other(1,Se.ZCodeAgent);',
    'var zz={ZCodeAgent:1};',
    'var zz=1;/* zz=Ne(Se.ZCodeAgent) */',
    'var zz=1;var hint="zz=Ne(Se.ZCodeAgent)";'
  ]) refuses(FACTORY + token + SERVICE + CALL);
});

test("service proof rejects comparisons, property writes and strings posing as factory assignments", () => {
  for (const service of [
    'var yy=1;yy==mk();',
    'var yy=1;yy===mk();',
    'var yy;yy=mk();',
    'var yy;obj.yy=mk();',
    'var yy=mk()===other;',
    'var yy=1;var hint="yy=mk()";',
    'var yy=1;/* yy=mk() */',
    'var yy=new mk();'
  ]) refuses(FACTORY + TOKEN + service + CALL);
});

test("binding resolution rejects evidence from sibling, parameter, catch, block and loop scopes", () => {
  for (const source of [
    FACTORY + 'function unrelated(){' + TOKEN + SERVICE + '}' + CALL,
    FACTORY + TOKEN + 'function unrelated(){' + SERVICE + '}' + CALL,
    FACTORY + SERVICE + 'function unrelated(){' + TOKEN + '}' + CALL,
    FACTORY + TOKEN + SERVICE + 'function run(zz){' + CALL + '}',
    FACTORY + TOKEN + SERVICE + 'function run(yy){' + CALL + '}',
    FACTORY + TOKEN + SERVICE + 'function run(mk){var yy=mk();' + CALL + '}',
    FACTORY + TOKEN + SERVICE + 'try{}catch(zz){' + CALL + '}',
    FACTORY + TOKEN + SERVICE + '{let zz=other;' + CALL + '}',
    FACTORY + TOKEN + SERVICE + 'for(let yy of values){' + CALL + '}',
    FACTORY + TOKEN + SERVICE + 'function run({zz}){' + CALL + '}',
    FACTORY + 'if(flag){var zz=Ne(Se.ZCodeAgent)}' + SERVICE + CALL,
    FACTORY + TOKEN + 'if(flag){var yy=mk()}' + CALL,
    FACTORY + TOKEN + 'for(var yy of values){}' + CALL
  ]) refuses(source);
});

test("valid function-local, closure and block bindings are supported", () => {
  for (const source of [
    FACTORY + 'function run(){' + TOKEN + SERVICE + CALL + '}',
    FACTORY + TOKEN + 'function run(){' + SERVICE + CALL + '}',
    FACTORY + '{let zz=Ne(Se.ZCodeAgent),yy=mk();' + CALL + '}',
    'function unrelated(zz,yy){return 0}' + SOURCE,
    FACTORY + TOKEN + SERVICE + 'function unrelated(){let zz=0,yy=0;zz=1;yy=1}' + CALL
  ]) roundTrip(source);
});

test("rebinding, duplicate declarations, use-before-init and dynamic scope fail closed", () => {
  for (const source of [
    SOURCE.replace(CALL, 'zz=other;' + CALL),
    SOURCE.replace(CALL, 'yy=other;' + CALL),
    SOURCE.replace(CALL, 'mk=other;' + CALL),
    SOURCE.replace(CALL, 'zz++;' + CALL),
    SOURCE.replace(CALL, '[yy]=other;' + CALL),
    SOURCE.replace(CALL, '({zz}=other);' + CALL),
    SOURCE.replace(CALL, 'var yy=mk();' + CALL),
    FACTORY + CALL + TOKEN + SERVICE,
    SOURCE.replace(CALL, 'eval(input);' + CALL),
    FACTORY + TOKEN + SERVICE + 'with(other){' + CALL + '}'
  ]) refuses(source);
});

test("strings, comments, regex and templates cannot create registration candidates", () => {
  for (const fake of [
    'var hint="services.register(zz,yy)";',
    '/* services.register(zz,yy) */',
    'var hint=`services.register(zz,yy)`;',
    'var hint=/services.register(zz,yy)/;'
  ]) {
    refuses(FACTORY + TOKEN + SERVICE + fake);
    roundTrip(fake + SOURCE);
  }
  roundTrip(FACTORY + TOKEN + SERVICE + '`value=${services.register(zz,yy)}`;');
});

test("occurrences, not distinct spellings or prematurely filtered duplicates, determine uniqueness", () => {
  refuses(SOURCE + CALL);
  const second = 'var aa=Ne(Se.ZCodeAgent),bb=mk();services.register(aa,bb);';
  refuses(SOURCE + CALL + second);
  refuses(SOURCE + second);
  refuses(SOURCE + 'function another(){' + TOKEN + SERVICE + CALL + '}');
});

test("known literal does not steal a structurally proven renamed registration", () => {
  const source = 'services.register(Kr,dt);' + SOURCE;
  assert.deepEqual(resolveRegistration(source), { variant: ".register(zz,yy)", source: "derived" });
  const patched = roundTrip(source);
  assert.ok(patched.startsWith('services.register(Kr,dt);'));
  assert.equal(hostRegistrationVariant(source), null);
});

test("known literal never bypasses conflicting bindings or structural ambiguity", () => {
  const knownSource = SOURCE.replaceAll("zz", "Kr").replaceAll("yy", "dt");
  for (const source of [
    knownSource + SOURCE.slice(FACTORY.length),
    knownSource.replace(TOKEN.replace("zz", "Kr"), 'var Kr=Ne(Se.OtherAgent);'),
    knownSource.replace(SERVICE.replace("yy", "dt"), 'var dt={async generateWorkspaceText(){}};'),
    'services.register(Kr,dt);' + SOURCE + CALL,
    'var Kr=0,dt=0;services.register(Kr,dt);',
    'var Kr;var dt={async generateWorkspaceText(){}};services.register(Kr,dt);',
    'var dt={async generateWorkspaceText(){}};dt=other;services.register(Kr,dt);',
    'var x=Ne(Se.ZCodeAgent);services.register(Kr,dt);',
    'services.register(Kr,dt);services.register(er,at);'
  ]) refuses(source);
});

test("old structure-free known literal fixtures still patch and restore", () => {
  for (const variant of HOST_REGISTRATION_VARIANTS) {
    const service = /,([^,)]+)\)/.exec(variant)[1];
    const source = `var ${service}={generateWorkspaceText:async()=>({text:"ok"})};services${variant};\n`;
    assert.deepEqual(resolveRegistration(source), { variant, source: "known" });
    roundTrip(source, variant);
    roundTrip(`services${variant};`, variant);
  }
});

test("known literal lookalikes neither count as calls nor get replaced", () => {
  const source = 'var hint="services.register(Kr,dt)";/* services.register(Kr,dt) */services.register(Kr,dt);';
  const patched = roundTrip(source, ".register(Kr,dt)");
  assert.ok(patched.startsWith('var hint="services.register(Kr,dt)";/* services.register(Kr,dt) */'));
  refuses('var hint="services.register(Kr,dt)";');
});

test("patch edits preserve whitespace, comments, parentheses, escaped names and line endings", () => {
  for (const call of [
    'services . register ( zz , yy );',
    'services/*a*/.register(/*b*/zz,/*c*/yy/*d*/);',
    'services.register((zz),((yy)));',
    'services.register(zz,y\\u0079);'
  ]) {
    for (const ending of ["", "\n", "\r\n", "\n\n"]) roundTrip(FACTORY + TOKEN + SERVICE + call + ending);
  }
});

test("strip and patch state ignore fake wrapper calls and fake marker blocks in strings", () => {
  const fakeBlock = `${HOST_PATCH_START}\nfunction __peWrapZcodeAgentService(service){}\n${HOST_PATCH_END}\n`;
  const source = 'var call="services.register($$,__peWrapZcodeAgentService(s$$))";' +
    `var block=${JSON.stringify(fakeBlock)};` +
    'var template=`services.register(zz,__peWrapZcodeAgentService(yy))`;' +
    '/* services.register(zz,__peWrapZcodeAgentService(yy)) */';
  assert.equal(hostPatchedVariant(source), null);
  assert.equal(isHostPatched(source), false);
  assert.equal(stripHostPatch(source), source);
  roundTrip(source + SOURCE);
});

test("strip unwraps actual unknown dollar anchors without requiring marker or factory proof", () => {
  const source = 'var hint="services.register($$,__peWrapZcodeAgentService(s$$))";' +
    'services.register($$,__peWrapZcodeAgentService(s$$));';
  assert.equal(hostPatchedVariant(source), ".register($$,s$$)");
  assert.equal(stripHostPatch(source), 'var hint="services.register($$,__peWrapZcodeAgentService(s$$))";services.register($$,s$$);');
  assert.equal(isHostPatched(source), false);
});

test("malformed JavaScript fails closed without partially stripping content", () => {
  const invalid = SOURCE + '"unterminated';
  refuses(invalid);
  assert.equal(hostPatchedVariant(invalid), null);
  assert.equal(isHostPatched(invalid), false);
  assert.equal(stripHostPatch(invalid), invalid);
});
