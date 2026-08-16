"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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

test("transport uses one exact utility process and closes on malformed or stale child data", async () => {
  const child = new FakeChild();
  const spawnHelper = mock.fn(() => child);
  const { createLocalHelperTransport } = require(transportPath);
  const transport = createLocalHelperTransport({
    spawnHelper,
    childPath,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 1,
    workspacePath: "/private/tmp/openbot-workspace",
  });
  assert.equal(spawnHelper.mock.callCount(), 1);
  const options = spawnHelper.mock.calls[0].arguments[2];
  assert.deepEqual(options.env, Object.freeze({
    ELECTRON_RUN_AS_NODE: "1",
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
