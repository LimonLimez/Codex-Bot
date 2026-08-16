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
  await assert.rejects(
    executeRequest(request("filesystem.read", { relativePath: "../private" }), { workspacePath: workspace }),
    (error) => error?.code === "OPENBOT_LOCAL_RESOURCE_INVALID"
      && !/Users|workspace|private\/tmp/i.test(error.message),
  );
});
