/**
 * Auto-repatch trigger tests (node:test).
 *
 * Every scheduler call injects `run` and every Startup path is temporary. The
 * Windows-only VBS check executes a harmless stub, never the real ensure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  TASK_NAME,
  createTaskArgs,
  deleteTaskArgs,
  queryTaskArgs,
  taskPresent,
  launcherPaths,
  writeLaunchers,
  registerAutostart,
  unregisterAutostart,
  autostartStatus,
} from "../desktop/autostart.mjs";

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-autostart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function taskTable(...names) {
  return names.map(name => `"${name.replace(/"/g, '""')}","N/A","就绪"`).join("\r\n");
}

function startupEntry(root) {
  const startupPath = path.join(root, "Startup", "entry.vbs");
  fs.mkdirSync(path.dirname(startupPath), { recursive: true });
  fs.writeFileSync(startupPath, "stale");
  return startupPath;
}

function assertLoginOnly(detail) {
  assert.match(detail, /login-only/);
  assert.match(detail, /one check at next logon/);
  assert.match(detail, /no periodic checks/);
}

test("task arguments name the task, launch via wscript and query the full CSV table", () => {
  const vbs = "C:\\runtime\\ensure.vbs";
  const wscript = "C:\\Windows\\System32\\wscript.exe";
  const args = createTaskArgs(vbs, 15, wscript);
  assert.deepEqual(args.slice(0, 4), ["/Create", "/F", "/TN", TASK_NAME]);
  assert.equal(args[4], "/TR");
  // A bare .vbs would be resolved through the shell association, which the Task
  // Scheduler service context does not have: the task would hang on an
  // "Open with" dialog. The interpreter must be explicit and batch-silent.
  assert.equal(args[5], '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\runtime\\ensure.vbs"');
  assert.notEqual(args[5], `"${vbs}"`);
  assert.deepEqual(args.slice(6), ["/SC", "MINUTE", "/MO", "15"]);
  assert.deepEqual(deleteTaskArgs(), ["/Delete", "/F", "/TN", TASK_NAME]);
  assert.deepEqual(queryTaskArgs(), ["/Query", "/FO", "CSV", "/NH"]);
});

test("task presence matches only the exact root task name, not localized status", () => {
  const others = taskTable(`\\folder\\${TASK_NAME}`, `\\${TASK_NAME}Other`, '\\含中文,"comma"');
  const run = (args) => {
    assert.deepEqual(args, queryTaskArgs());
    return others;
  };
  assert.equal(taskPresent({ run }), false);
  assert.equal(taskPresent({ run: () => '"\\other","N/A","' + TASK_NAME + '"' }), false);
  assert.equal(taskPresent({ run: () => "" }), false);
  assert.equal(taskPresent({ run: () => Buffer.from("\ufeff" + others + "\r\n" + taskTable(`\\${TASK_NAME.toLowerCase()}`)) }), true);
});

test("task query failures and malformed responses are not treated as absence", () => {
  const error = new Error("任务计划程序服务不可用");
  assert.throws(() => taskPresent({ run: () => { throw error; } }), e => e === error);
  assert.throws(() => taskPresent({ run: () => "Access denied" }), /presence is unknown/);
  assert.throws(() => taskPresent({ run: () => taskTable(`\\${TASK_NAME}`) + "\r\ntruncated" }), /presence is unknown/);
});

test("launcher is UTF-16LE BOM VBS, directly launches Node hidden and removes old CMD", (t) => {
  const root = tmpRoot(t);
  const runtimeDir = path.join(root, "中文 runtime & %PATH%");
  fs.mkdirSync(runtimeDir);
  fs.writeFileSync(launcherPaths(runtimeDir).cmd, "old cmd /c launcher");
  const { cmd, vbs } = writeLaunchers(runtimeDir, {
    nodePath: "C:\\中文 Node & %PATH%\\node.exe",
    asarPath: "D:\\中文 app & %TEMP%\\resources\\app.asar",
  });

  assert.deepEqual({ cmd, vbs }, launcherPaths(runtimeDir), "legacy paths remain available");
  assert.equal(fs.existsSync(cmd), false, "old unsafe CMD is removed, not regenerated");
  const bytes = fs.readFileSync(vbs);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const source = bytes.subarray(2).toString("utf16le");
  assert.match(source, /^CreateObject\("Shell\.Application"\)\.ShellExecute /);
  assert.ok(source.includes('"C:\\中文 Node & %PATH%\\node.exe"'));
  assert.ok(source.includes('""D:\\中文 app & %TEMP%\\resources\\app.asar""'));
  assert.ok(source.includes('""ensure"" ""--asar""'));
  assert.ok(source.includes('""--runtime""'));
  assert.match(source, /, "open", 0\r\n$/);
  assert.equal(source.trim().split(/\r?\n/).length, 1, "no resident retry loop");
  assert.doesNotMatch(source, /cmd(?:\.exe)?|WScript\.Shell|\.Run\b/i);
});

test("temporary VBS preserves Unicode, spaces, ampersands and percent paths without a shell", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = tmpRoot(t);
  const runtimeDir = path.join(root, "中文 runtime & %ZCODE_PE_VBS_TEST%");
  const asarPath = path.join(root, "中文 archive & %ZCODE_PE_VBS_TEST%", "app.asar");
  const nodePath = path.join(root, "中文 Node & %ZCODE_PE_VBS_TEST%.exe");
  try { fs.linkSync(process.execPath, nodePath); }
  catch (e) { fs.copyFileSync(process.execPath, nodePath); }
  writeLaunchers(runtimeDir, { nodePath, asarPath });
  const outputPath = path.join(runtimeDir, "stub-argv.json");
  // This is a new stub in a fresh temp directory, not the production patcher.
  fs.writeFileSync(path.join(runtimeDir, "patch-desktop.mjs"), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-argv.json"), JSON.stringify({ args: process.argv.slice(2), execPath: process.execPath }));',
  ].join("\n"));
  execFileSync(path.join(process.env.SystemRoot, "System32", "cscript.exe"), ["//NoLogo", "//B", launcherPaths(runtimeDir).vbs], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, ZCODE_PE_VBS_TEST: "wrong-expanded-value" },
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(outputPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(outputPath), "VBS must launch the temporary Node stub");
  const actual = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.deepEqual(actual.args, ["ensure", "--asar", asarPath, "--runtime", runtimeDir]);
  assert.equal(actual.execPath, nodePath);
});

test("registers a scheduled task and removes a stale Startup entry", (t) => {
  const root = tmpRoot(t);
  const startupPath = startupEntry(root);
  const seen = [];
  const result = registerAutostart({
    runtimeDir: root,
    nodePath: "C:\\node.exe",
    asarPath: "D:\\a.asar",
    run: (args) => { seen.push(args); return ""; },
    startupPath,
  });

  assert.equal(result.mode, "task");
  assert.match(result.detail, /every 15 min/);
  assert.deepEqual(seen, [createTaskArgs(launcherPaths(root).vbs)]);
  assert.equal(fs.existsSync(startupPath), false, "no duplicate check at logon");
  assert.equal(autostartStatus({ run: () => taskTable(`\\${TASK_NAME}`), startupPath }).mode, "task");
});

test("task creation failure falls back to exactly one check at next logon", (t) => {
  const root = tmpRoot(t);
  const startupPath = path.join(root, "Startup", "entry.vbs");
  const seen = [];
  const result = registerAutostart({
    runtimeDir: root,
    nodePath: "C:\\node.exe",
    asarPath: "D:\\中文 & %PATH%\\a.asar",
    run: (args) => {
      seen.push(args);
      throw new Error("ERROR: Access is denied.\r\nmore detail");
    },
    startupPath,
  });

  assert.equal(result.mode, "startup");
  assertLoginOnly(result.detail);
  assert.deepEqual(fs.readFileSync(startupPath), fs.readFileSync(launcherPaths(root).vbs));
  assert.deepEqual(seen, [createTaskArgs(launcherPaths(root).vbs)], "no fallback scheduler or resident process");
  // Only the first error line is surfaced, so the installer message stays short.
  assert.match(result.detail, /Access is denied\./);
  assert.doesNotMatch(result.detail, /more detail/);
  const status = autostartStatus({ run: () => "", startupPath });
  assert.equal(status.mode, "startup");
  assert.equal(status.present, true);
  assertLoginOnly(status.detail);
});

test("status reports login-only fallback even when scheduler status cannot be queried", (t) => {
  const startupPath = startupEntry(tmpRoot(t));
  const status = autostartStatus({ run: () => { throw new Error("服务不可用"); }, startupPath });
  assert.equal(status.mode, "startup");
  assertLoginOnly(status.detail);
  assert.match(status.detail, /scheduled task status unknown: 服务不可用/);
});

test("failure removing a stale Startup entry does not silently install fallback", (t) => {
  const root = tmpRoot(t);
  const startupPath = path.join(root, "Startup", "entry.vbs");
  fs.mkdirSync(startupPath, { recursive: true });
  fs.writeFileSync(path.join(startupPath, "marker"), "untouched");
  const seen = [];
  assert.throws(() => registerAutostart({
    runtimeDir: root,
    nodePath: "C:\\node.exe",
    asarPath: "D:\\a.asar",
    run: (args) => { seen.push(args); return ""; },
    startupPath,
  }));
  assert.deepEqual(seen, [createTaskArgs(launcherPaths(root).vbs)]);
  assert.equal(fs.readFileSync(path.join(startupPath, "marker"), "utf8"), "untouched");
});

test("unregister preserves removed flags and reports no residue after deleting both triggers", (t) => {
  const startupPath = startupEntry(tmpRoot(t));
  const seen = [];
  const result = unregisterAutostart({ run: (args) => { seen.push(args); return ""; }, startupPath });
  assert.deepEqual(result, {
    removedTask: true,
    removedStartup: true,
    errors: [],
    remainingTask: false,
    remainingStartup: false,
  });
  assert.deepEqual(seen, [deleteTaskArgs()]);
  assert.equal(fs.existsSync(startupPath), false);
});

test("unregister ignores delete failure only when a full query proves the task absent", (t) => {
  const startupPath = path.join(tmpRoot(t), "Startup", "missing.vbs");
  const seen = [];
  const result = unregisterAutostart({
    run: (args) => {
      seen.push(args);
      if (args[0] === "/Delete") throw new Error("任意本地化错误，不依赖文案");
      assert.deepEqual(args, queryTaskArgs());
      return taskTable(`\\folder\\${TASK_NAME}`, `\\${TASK_NAME}Other`);
    },
    startupPath,
  });
  assert.deepEqual(result, {
    removedTask: false,
    removedStartup: false,
    errors: [],
    remainingTask: false,
    remainingStartup: false,
  });
  assert.deepEqual(seen, [deleteTaskArgs(), queryTaskArgs()]);
  assert.equal(autostartStatus({ run: () => "", startupPath }).mode, "none");
});

test("unregister exposes denied deletion and task residue but still removes Startup", (t) => {
  const startupPath = startupEntry(tmpRoot(t));
  const result = unregisterAutostart({
    run: (args) => {
      if (args[0] === "/Delete") throw Object.assign(new Error("command failed"), { stderr: "拒绝访问\r\nextra detail" });
      assert.deepEqual(args, queryTaskArgs());
      return taskTable(`\\${TASK_NAME}`);
    },
    startupPath,
  });
  assert.equal(result.removedTask, false);
  assert.equal(result.removedStartup, true);
  assert.equal(result.remainingTask, true);
  assert.equal(result.remainingStartup, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /remains: 拒绝访问$/);
  assert.doesNotMatch(result.errors[0], /extra detail/);
  assert.equal(fs.existsSync(startupPath), false);
});

test("unregister reports unknown task residue when deletion and scheduler query both fail", (t) => {
  const startupPath = startupEntry(tmpRoot(t));
  const result = unregisterAutostart({
    run: (args) => { throw new Error(args[0] === "/Delete" ? "删除被拒绝" : "服务不可用"); },
    startupPath,
  });
  assert.equal(result.removedTask, false);
  assert.equal(result.removedStartup, true);
  assert.equal(result.remainingTask, null);
  assert.equal(result.remainingStartup, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /删除被拒绝/);
  assert.match(result.errors[0], /could not verify absence: 服务不可用/);
});

test("unregister does not accept malformed scheduler output as proof of absence", (t) => {
  const startupPath = path.join(tmpRoot(t), "Startup", "missing.vbs");
  const result = unregisterAutostart({
    run: (args) => {
      if (args[0] === "/Delete") throw new Error("delete failed");
      return "not a CSV table";
    },
    startupPath,
  });
  assert.equal(result.remainingTask, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /presence is unknown/);
});

test("unregister reports Startup removal failures rather than swallowing them", (t) => {
  const root = tmpRoot(t);
  const startupPath = path.join(root, "Startup", "entry.vbs");
  fs.mkdirSync(startupPath, { recursive: true });
  const result = unregisterAutostart({ run: () => "", startupPath });
  assert.equal(result.removedTask, true);
  assert.equal(result.removedStartup, false);
  assert.equal(result.remainingTask, false);
  assert.equal(result.remainingStartup, true);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes(`could not remove startup entry ${startupPath}`));
  assert.equal(fs.existsSync(startupPath), true);
});

test("Startup permission errors are not mistaken for a missing entry", (t) => {
  const startupPath = startupEntry(tmpRoot(t));
  const originalRemove = fs.rmSync;
  const originalLstat = fs.lstatSync;
  const denied = () => { throw Object.assign(new Error("mock permission denied"), { code: "EACCES" }); };
  t.mock.method(fs, "rmSync", (target, ...args) => target === startupPath ? denied() : originalRemove(target, ...args));
  t.mock.method(fs, "lstatSync", (target, ...args) => target === startupPath ? denied() : originalLstat(target, ...args));
  const result = unregisterAutostart({ run: () => "", startupPath });
  assert.equal(result.removedStartup, false);
  assert.equal(result.remainingStartup, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /permission denied; could not verify absence: mock permission denied/);
  assert.throws(() => autostartStatus({ run: () => "", startupPath }), /permission denied/);
});

test("status without a fallback exposes scheduler failure instead of saying not installed", (t) => {
  const startupPath = path.join(tmpRoot(t), "Startup", "missing.vbs");
  assert.throws(() => autostartStatus({ run: () => { throw new Error("scheduler unavailable"); }, startupPath }), /scheduler unavailable/);
});
