"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("node:test");

const transportPath = path.join(__dirname, "..", "src", "local", "local-helper-transport.cjs");
const childPath = path.join(__dirname, "..", "src", "local", "local-helper-child.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const TARGET_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_A = "request-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const electronSmokeApp = path.join(__dirname, "fixtures", "electron-utility-process-smoke");

function request(operation, args) {
  return {
    requestId: REQUEST_A,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 1,
    taskId: "task-a",
    capability: operation,
    operation,
    arguments: args,
  };
}

class FakeChild extends EventEmitter {
  messages = [];
  killed = false;
  postMessage(value) { this.messages.push(value); }
  kill() { this.killed = true; }
}

function takeStartupChallenge(child) {
  const challenge = child.messages.shift();
  assert.equal(challenge?.type, "startup-challenge");
  assert.match(challenge?.nonce || "", /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(challenge).sort(), ["nonce", "type"]);
  return challenge;
}

function acknowledgeStartup(child) {
  child.emit("message", { type: "ready" });
  const challenge = takeStartupChallenge(child);
  child.emit("message", { type: "startup-ack", nonce: challenge.nonce });
  return challenge;
}

function electronExecutable() {
  const candidates = [
    process.env.OPENBOT_ELECTRON_PATH,
    path.resolve(__dirname, "../../../codex-bot/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  ].filter((value) => typeof value === "string" && path.isAbsolute(value));
  return candidates.find((value) => {
    try {
      if (!fsSync.statSync(value).isFile()) return false;
      fsSync.accessSync(value, fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

async function runElectronTransportSmoke(t, electron, helperPath) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-electron-smoke-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const child = spawn(electron, [
    "--no-sandbox",
    electronSmokeApp,
    transportPath,
    helperPath,
    workspace,
  ], {
    env: (() => {
      const value = { ...process.env };
      delete value.ELECTRON_RUN_AS_NODE;
      return value;
    })(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  let timeout;
  const outcome = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => { timeout = setTimeout(() => resolve({ timeout: true }), 8_000); }),
  ]);
  clearTimeout(timeout);
  if (outcome.timeout) {
    child.kill("SIGKILL");
    assert.fail(`Electron utilityProcess smoke timed out: ${stderr.slice(0, 512)}`);
  }
  assert.equal(outcome.code, 0, stderr.slice(0, 512));
  const marker = stdout.split("\n").find((line) => line.startsWith("OPENBOT_ELECTRON_SMOKE:"));
  assert.ok(marker, stdout.slice(0, 512));
  return JSON.parse(marker.slice("OPENBOT_ELECTRON_SMOKE:".length));
}

test("packaged Electron utilityProcess requires an acknowledged live startup", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Electron utilityProcess is unavailable on this platform");
    return;
  }
  const electron = electronExecutable();
  if (!electron) {
    t.skip("No deterministic local Electron executable is available for the smoke test");
    return;
  }
  await t.test("production helper acknowledges the parent challenge", async (subtest) => {
    assert.deepEqual(await runElectronTransportSmoke(subtest, electron, childPath), {
      outcome: "resolved",
      closed: false,
    });
  });
  await t.test("a real helper exiting on its next timer never becomes ready", async (subtest) => {
    const exitingChild = path.join(electronSmokeApp, "exit-after-ready.js");
    assert.deepEqual(await runElectronTransportSmoke(subtest, electron, exitingChild), {
      outcome: "rejected",
      code: "OPENBOT_LOCAL_HELPER_START_FAILED",
    });
  });
});

test("transport awaits an exact startup ready frame and does not run Electron as Node", async () => {
  const child = new FakeChild();
  const spawnHelper = mock.fn(() => child);
  const { createLocalHelperTransport } = require(transportPath);
  const pending = createLocalHelperTransport({
    spawnHelper,
    childPath,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 1,
    workspacePath: "/private/tmp/openbot-workspace",
    startupTimeoutMs: 25,
  });
  assert.equal(typeof pending?.then, "function");
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const options = spawnHelper.mock.calls[0].arguments[2];
  assert.deepEqual(options.env, Object.freeze({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  }));
  acknowledgeStartup(child);
  const transport = await pending;
  assert.equal(typeof transport.send, "function");
  assert.equal(transport.isClosed(), false);
  transport.dispose();
  assert.equal(transport.isClosed(), true);
});

test("transport rejects when a ready child exits before acknowledging its challenge", async (t) => {
  for (const scenario of ["synchronous", "queued"]) {
    await t.test(scenario, async () => {
      const child = new FakeChild();
      const { createLocalHelperTransport } = require(transportPath);
      const pending = createLocalHelperTransport({
        spawnHelper: mock.fn(() => child),
        childPath,
        botId: BOT_A,
        targetId: TARGET_A,
        targetGeneration: 1,
        workspacePath: "/private/tmp/openbot-workspace",
        startupTimeoutMs: 25,
      });
      child.emit("message", { type: "ready" });
      takeStartupChallenge(child);
      if (scenario === "synchronous") child.emit("exit", 1, null);
      else queueMicrotask(() => child.emit("exit", 1, null));
      await assert.rejects(pending, { code: "OPENBOT_LOCAL_HELPER_START_FAILED" });
      assert.equal(child.killed, true);
      assert.equal(child.listenerCount("message"), 0);
      assert.equal(child.listenerCount("exit"), 0);
    });
  }
});

test("transport rejects startup on fatal, malformed, or early-exit child frames", async (t) => {
  for (const scenario of ["fatal", "malformed", "exit"]) {
    await t.test(scenario, async () => {
      const child = new FakeChild();
      const spawnHelper = mock.fn(() => child);
      const { createLocalHelperTransport } = require(transportPath);
      const pending = createLocalHelperTransport({
        spawnHelper,
        childPath,
        botId: BOT_A,
        targetId: TARGET_A,
        targetGeneration: 1,
        workspacePath: "/private/tmp/openbot-workspace",
        startupTimeoutMs: 25,
      });
      if (scenario === "fatal") child.emit("message", { type: "fatal" });
      else if (scenario === "malformed") child.emit("message", { type: "ready", extra: true });
      else child.emit("exit", 1, null);
      await assert.rejects(
        pending,
        (error) => error?.code === "OPENBOT_LOCAL_HELPER_START_FAILED",
      );
      assert.equal(child.killed, true);
    });
  }
});

test("startup acknowledgement must be current, matching, and single-use", async (t) => {
  const start = (child, timeout = 25) => {
    const { createLocalHelperTransport } = require(transportPath);
    return createLocalHelperTransport({
      spawnHelper: mock.fn(() => child),
      childPath,
      botId: BOT_A,
      targetId: TARGET_A,
      targetGeneration: 1,
      workspacePath: "/private/tmp/openbot-workspace",
      startupTimeoutMs: timeout,
    });
  };

  await t.test("ack before ready", async () => {
    const child = new FakeChild();
    const pending = start(child);
    child.emit("message", { type: "startup-ack", nonce: "0".repeat(64) });
    await assert.rejects(pending, { code: "OPENBOT_LOCAL_HELPER_START_FAILED" });
  });

  await t.test("mismatched ack", async () => {
    const child = new FakeChild();
    const pending = start(child);
    child.emit("message", { type: "ready" });
    const challenge = takeStartupChallenge(child);
    const mismatch = `${challenge.nonce[0] === "0" ? "1" : "0"}${challenge.nonce.slice(1)}`;
    child.emit("message", { type: "startup-ack", nonce: mismatch });
    await assert.rejects(pending, { code: "OPENBOT_LOCAL_HELPER_START_FAILED" });
  });

  await t.test("late ack", async () => {
    const child = new FakeChild();
    const pending = start(child, 5);
    child.emit("message", { type: "ready" });
    const challenge = takeStartupChallenge(child);
    await assert.rejects(pending, { code: "OPENBOT_LOCAL_HELPER_START_FAILED" });
    child.emit("message", { type: "startup-ack", nonce: challenge.nonce });
    assert.equal(child.listenerCount("message"), 0);
  });

  await t.test("duplicate ack", async () => {
    const child = new FakeChild();
    const pending = start(child);
    const challenge = acknowledgeStartup(child);
    const transport = await pending;
    let exits = 0;
    transport.onExit(() => { exits += 1; });
    child.emit("message", { type: "startup-ack", nonce: challenge.nonce });
    assert.equal(transport.isClosed(), true);
    assert.equal(exits, 1);
  });
});

test("transport times out startup, cleans listeners, and ignores a late ready frame", async () => {
  const child = new FakeChild();
  const { createLocalHelperTransport } = require(transportPath);
  const pending = createLocalHelperTransport({
    spawnHelper: mock.fn(() => child),
    childPath,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 1,
    workspacePath: "/private/tmp/openbot-workspace",
    startupTimeoutMs: 5,
  });
  await assert.rejects(pending, { code: "OPENBOT_LOCAL_HELPER_START_FAILED" });
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  child.emit("message", { type: "ready" });
  assert.equal(child.killed, true);
});

test("transport accepts Electron's event-plus-payload message shape and closes once on post failure", async () => {
  const child = new FakeChild();
  const exits = [];
  const { createLocalHelperTransport } = require(transportPath);
  const pending = createLocalHelperTransport({
    spawnHelper: mock.fn(() => child),
    childPath,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 1,
    workspacePath: "/private/tmp/openbot-workspace",
  });
  child.emit("message", { sender: "utility-process-event" }, { type: "ready" });
  const challenge = takeStartupChallenge(child);
  child.emit("message", { sender: "utility-process-event" }, {
    type: "startup-ack",
    nonce: challenge.nonce,
  });
  const transport = await pending;
  transport.onExit(() => exits.push(true));
  child.emit("message", { sender: "utility-process-event" }, {
    type: "reply",
    reply: { requestId: REQUEST_A, ok: true, value: "ok" },
  });
  const received = [];
  transport.onMessage((value) => received.push(value));
  child.emit("message", { sender: "utility-process-event" }, {
    type: "reply",
    reply: { requestId: REQUEST_A, ok: true, value: "second" },
  });
  assert.deepEqual(received, [{ requestId: REQUEST_A, ok: true, value: "second" }]);
  child.postMessage = () => { throw new Error("/Users/private token"); };
  await assert.rejects(
    transport.send(request("shell.execute", { command: "echo late" })),
    (error) => error?.code === "OPENBOT_LOCAL_HELPER_UNAVAILABLE" && !/Users|private|token/i.test(error.message),
  );
  transport.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [true]);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("transport uses one exact utility process and closes on malformed or stale child data", async () => {
  const child = new FakeChild();
  const spawnHelper = mock.fn(() => child);
  const { createLocalHelperTransport } = require(transportPath);
  const pending = createLocalHelperTransport({
    spawnHelper,
    childPath,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 1,
    workspacePath: "/private/tmp/openbot-workspace",
  });
  acknowledgeStartup(child);
  const transport = await pending;
  assert.equal(spawnHelper.mock.callCount(), 1);
  const options = spawnHelper.mock.calls[0].arguments[2];
  assert.deepEqual(options.env, Object.freeze({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  }));
  assert.equal(options.serviceName, "OpenBot Local Helper");
  assert.doesNotMatch(JSON.stringify(options), /HOME|token|secret|Authorization/i);

  const received = [];
  let exits = 0;
  transport.onMessage((value) => received.push(value));
  transport.onExit(() => { exits += 1; });
  await transport.authorizeResource(REQUEST_A, Buffer.from("private-bookmark"));
  await transport.send(request("shell.execute", { command: "printf openbot-ok" }));
  assert.equal(child.messages[0].type, "authorize");
  assert.match(child.messages[0].bookmark, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(child.messages[1].type, "run");
  child.emit("message", { type: "reply", reply: { requestId: REQUEST_A, ok: true, value: "ok" } });
  assert.deepEqual(received, [{ requestId: REQUEST_A, ok: true, value: "ok" }]);

  await transport.cancel(REQUEST_A);
  assert.deepEqual(child.messages[2], { type: "cancel", requestId: REQUEST_A });
  child.emit("message", {
    type: "reply",
    reply: { requestId: REQUEST_A, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" },
  });
  assert.deepEqual(received, [
    { requestId: REQUEST_A, ok: true, value: "ok" },
    { requestId: REQUEST_A, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" },
  ], "the correlated cancellation reply acknowledges process-group termination");

  child.emit("message", null);
  assert.equal(child.killed, true);
  assert.equal(exits, 1);
  await assert.rejects(transport.send(request("shell.execute", { command: "echo late" })), /unavailable|closed/i);
  transport.dispose();
  assert.equal(exits, 1);
});

test("real helper executes bounded workspace terminal and rejects escapes without leaking paths", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-helper-workspace-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { executeRequest } = require(childPath);
  const shell = await executeRequest(request("shell.execute", {
    command: "printf openbot-ok",
  }), { workspacePath: workspace });
  assert.deepEqual(shell, {
    requestId: REQUEST_A,
    ok: true,
    value: { exitCode: 0, stdout: "openbot-ok", stderr: "" },
  });

  const written = await executeRequest(request("filesystem.write", {
    relativePath: "notes/result.txt",
    content: "hello",
  }), { workspacePath: workspace });
  assert.deepEqual(written.value, { bytesWritten: 5 });
  const read = await executeRequest(request("filesystem.read", {
    relativePath: "notes/result.txt",
  }), { workspacePath: workspace });
  assert.deepEqual(read.value, { content: "hello", bytesRead: 5 });
  await assert.rejects(executeRequest({
    ...request("filesystem.read", { relativePath: "notes/result.txt" }),
    taskId: "task-b",
  }, { workspacePath: workspace }), /unavailable/i);
  await executeRequest({
    ...request("filesystem.write", { relativePath: "notes/result.txt", content: "task b" }),
    taskId: "task-b",
  }, { workspacePath: workspace });
  const taskA = await executeRequest(request("filesystem.read", {
    relativePath: "notes/result.txt",
  }), { workspacePath: workspace });
  assert.equal(taskA.value.content, "hello");
  await assert.rejects(
    executeRequest(request("filesystem.read", { relativePath: "../private" }), { workspacePath: workspace }),
    (error) => error?.code === "OPENBOT_LOCAL_RESOURCE_INVALID"
      && !/Users|workspace|private\/tmp/i.test(error.message),
  );
});

test("approved shell uses an isolated deterministic environment without sourcing task dotfiles", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-helper-environment-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { executeRequest } = require(childPath);
  const taskAWorkspace = path.join(workspace, "tasks", "task-a");
  const taskBWorkspace = path.join(workspace, "tasks", "task-b");
  const expectedPath = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";

  await executeRequest(request("shell.execute", { command: "true" }), { workspacePath: workspace });
  await fs.writeFile(path.join(taskAWorkspace, ".zshenv"), "printf dotfile-zshenv >&2\n", "utf8");
  await fs.writeFile(path.join(taskAWorkspace, ".zprofile"), "printf dotfile-zprofile >&2\n", "utf8");
  await fs.writeFile(path.join(taskAWorkspace, ".zshrc"), "printf dotfile-zshrc >&2\n", "utf8");
  await fs.writeFile(path.join(taskAWorkspace, ".zlogin"), "printf dotfile-zlogin >&2\n", "utf8");

  const result = await executeRequest(request("shell.execute", {
    command: "printf '%s\\n' \"$PATH\" \"$HOME\" \"$ZDOTDIR\" \"$TMPDIR\" \"$SHELL\" \"$LANG\"; command -v sh; printf '%s' 'literal $(printf must-not-run) $HOME'",
  }), { workspacePath: workspace });
  const lines = result.value.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 7), [
    expectedPath,
    taskAWorkspace,
    taskAWorkspace,
    path.join(taskAWorkspace, "tmp"),
    "/bin/zsh",
    "C.UTF-8",
    "/bin/sh",
  ]);
  assert.equal(lines[7], "literal $(printf must-not-run) $HOME");
  assert.equal(result.value.stderr, "");
  assert.equal(result.value.exitCode, 0);

  const taskB = await executeRequest({
    ...request("shell.execute", { command: "printf '%s' \"$HOME\"" }),
    taskId: "task-b",
  }, { workspacePath: workspace });
  assert.equal(taskB.value.stdout, taskBWorkspace);
  assert.notEqual(taskAWorkspace, taskBWorkspace);

  const tempStat = await fs.stat(path.join(taskAWorkspace, "tmp"));
  assert.equal(tempStat.isDirectory(), true);
  assert.equal(tempStat.mode & 0o777, 0o700);
});

test("pre-existing workspace directories must already be private and a static tmp symlink is rejected unchanged", async (t) => {
  const { executeRequest } = require(childPath);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-helper-existing-dir-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const tasksPath = path.join(workspace, "tasks");
  await fs.mkdir(tasksPath, { mode: 0o700 });
  await fs.chmod(tasksPath, 0o755);
  await assert.rejects(
    executeRequest(request("shell.execute", { command: "true" }), { workspacePath: workspace }),
    (error) => error?.code === "OPENBOT_LOCAL_WORKSPACE_INVALID" && !/openbot-helper-existing-dir|private\/tmp/i.test(error.message),
  );
  assert.equal((await fs.stat(tasksPath)).mode & 0o777, 0o755);

  const taskPath = path.join(tasksPath, "task-a");
  await fs.chmod(tasksPath, 0o700);
  await fs.mkdir(taskPath, { mode: 0o700 });
  await fs.chmod(taskPath, 0o755);
  await assert.rejects(
    executeRequest(request("shell.execute", { command: "true" }), { workspacePath: workspace }),
    (error) => error?.code === "OPENBOT_LOCAL_WORKSPACE_INVALID",
  );
  assert.equal((await fs.stat(taskPath)).mode & 0o777, 0o755);

  await fs.chmod(taskPath, 0o700);
  const tmpPath = path.join(taskPath, "tmp");
  await fs.mkdir(tmpPath, { mode: 0o700 });
  await fs.chmod(tmpPath, 0o755);
  await assert.rejects(
    executeRequest(request("shell.execute", { command: "true" }), { workspacePath: workspace }),
    (error) => error?.code === "OPENBOT_LOCAL_WORKSPACE_INVALID",
  );
  assert.equal((await fs.stat(tmpPath)).mode & 0o777, 0o755);

  await fs.rm(tmpPath, { recursive: true, force: true });
  const outside = path.join(workspace, "outside");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, tmpPath);
  await assert.rejects(
    executeRequest(request("shell.execute", { command: "true" }), { workspacePath: workspace }),
    (error) => error?.code === "OPENBOT_LOCAL_WORKSPACE_INVALID",
  );
  assert.equal((await fs.lstat(tmpPath)).isSymbolicLink(), true);
});

test("concurrent approved shells receive distinct private HOME and TMPDIR task paths", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-helper-concurrent-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { executeRequest } = require(childPath);
  const command = "printf '%s\\n' \"$HOME\" \"$TMPDIR\"";
  const [taskA, taskB] = await Promise.all([
    executeRequest(request("shell.execute", { command }), { workspacePath: workspace }),
    executeRequest({
      ...request("shell.execute", { command }),
      requestId: "request-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      taskId: "task-b",
    }, { workspacePath: workspace }),
  ]);
  const taskAPaths = taskA.value.stdout.trimEnd().split("\n");
  const taskBPaths = taskB.value.stdout.trimEnd().split("\n");
  assert.deepEqual(taskAPaths, [
    path.join(workspace, "tasks", "task-a"),
    path.join(workspace, "tasks", "task-a", "tmp"),
  ]);
  assert.deepEqual(taskBPaths, [
    path.join(workspace, "tasks", "task-b"),
    path.join(workspace, "tasks", "task-b", "tmp"),
  ]);
  assert.notEqual(taskAPaths[0], taskBPaths[0]);
  assert.notEqual(taskAPaths[1], taskBPaths[1]);
  for (const directory of [...taskAPaths, ...taskBPaths]) {
    const stat = await fs.stat(directory);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.mode & 0o777, 0o700);
  }
});

test("helper child accepts one exact startup challenge before any operation", async (t) => {
  const { installParentPort } = require(childPath);
  const nonce = "a".repeat(64);
  class FakePort extends EventEmitter {
    replies = [];
    postMessage(value) { this.replies.push(value); }
  }

  await t.test("matching challenge", async () => {
    const port = new FakePort();
    installParentPort(port, "/private/tmp/openbot-workspace");
    const listener = port.listeners("message")[0];
    await listener({ data: { type: "startup-challenge", nonce } });
    assert.deepEqual(port.replies, [
      { type: "ready" },
      { type: "startup-ack", nonce },
    ]);
    await listener({ data: { type: "startup-challenge", nonce } });
    assert.deepEqual(port.replies.at(-1), { type: "fatal" });
  });

  await t.test("operation before challenge", async () => {
    const port = new FakePort();
    installParentPort(port, "/private/tmp/openbot-workspace");
    const listener = port.listeners("message")[0];
    await listener({ data: { type: "run", request: request("shell.execute", { command: "true" }) } });
    assert.deepEqual(port.replies, [{ type: "ready" }, { type: "fatal" }]);
  });
});

test("helper cancel kills an in-flight shell process group before descendants can write", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-helper-cancel-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { installParentPort } = require(childPath);
  class FakePort extends EventEmitter {
    replies = [];
    postMessage(value) { this.replies.push(value); this.emit("posted", value); }
  }
  const port = new FakePort();
  installParentPort(port, workspace);
  assert.deepEqual(port.replies.shift(), { type: "ready" });
  const startupNonce = "b".repeat(64);
  await port.listeners("message")[0]({
    data: { type: "startup-challenge", nonce: startupNonce },
  });
  assert.deepEqual(port.replies.shift(), { type: "startup-ack", nonce: startupNonce });
  const started = path.join(workspace, "tasks", "task-a", "started.txt");
  const late = path.join(workspace, "tasks", "task-a", "late.txt");
  const completion = new Promise((resolve) => port.on("posted", (message) => {
    if (message.type === "reply" && message.reply.requestId === REQUEST_A) resolve(message.reply);
  }));
  port.emit("message", { data: { type: "run", request: request("shell.execute", {
    command: "printf started > started.txt; (sleep 0.35; printf late > late.txt) & wait",
  }) } });
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (await fs.access(started).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await fs.access(started).then(() => true, () => false), true);
  port.emit("message", { data: { type: "cancel", requestId: REQUEST_A } });
  assert.deepEqual(await completion, {
    requestId: REQUEST_A,
    ok: false,
    errorCode: "OPENBOT_LOCAL_CANCELLED",
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(await fs.access(late).then(() => true, () => false), false);
  assert.equal(port.replies.some(({ type }) => type === "fatal"), false);
});

test("broken parent-port reply delivery cannot escape as an unhandled rejection", async (t) => {
  const { installParentPort } = require(childPath);
  for (const scenario of ["success", "error"]) {
    await t.test(scenario, async (subtest) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `openbot-helper-broken-port-${scenario}-`));
      subtest.after(() => fs.rm(workspace, { recursive: true, force: true }));
      class BrokenPort extends EventEmitter {
        attempts = [];
        postMessage(value) {
          this.attempts.push(value);
          if (value?.type === "ready" || value?.type === "startup-ack") return;
          throw new Error("/Users/private token");
        }
      }
      const port = new BrokenPort();
      installParentPort(port, workspace);
      const listener = port.listeners("message")[0];
      const startupNonce = "c".repeat(64);
      await listener({ data: { type: "startup-challenge", nonce: startupNonce } });
      const operation = scenario === "success"
        ? request("shell.execute", { command: "true" })
        : request("filesystem.read", { relativePath: "missing.txt" });
      await assert.doesNotReject(Promise.resolve(listener({ data: { type: "run", request: operation } })));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(port.attempts.map((value) => value.type), [
        "ready", "startup-ack", "reply", "fatal",
      ]);
    });
  }

  class StartupBrokenPort extends EventEmitter {
    attempts = [];
    postMessage(value) { this.attempts.push(value); throw new Error("private startup failure"); }
  }
  const startupPort = new StartupBrokenPort();
  assert.doesNotThrow(() => installParentPort(startupPort, "/private/tmp/openbot-workspace"));
  assert.deepEqual(startupPort.attempts.map((value) => value.type), ["ready", "fatal"]);
});
