"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const managerPath = path.join(__dirname, "..", "src", "desktop", "codex-app-server-manager.cjs");

let CodexAppServerManager;
try {
  ({ CodexAppServerManager } = require(managerPath));
} catch {
  // The first TDD run intentionally executes before the production module exists.
}

const DISABLED_LOCAL_FEATURES = Object.freeze([
  "apps",
  "apps_mcp_path_override",
  "apply_patch_freeform",
  "apply_patch_streaming_events",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_only",
  "codex_git_commit",
  "computer_use",
  "default_mode_request_user_input",
  "deferred_executor",
  "deferred_tool_world_state",
  "enable_fanout",
  "enable_mcp_apps",
  "exec_permission_approvals",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "goals",
  "guardian_approval",
  "guardianv2",
  "hooks",
  "image_generation",
  "in_app_browser",
  "js_repl",
  "js_repl_tools_only",
  "mcp_2026_07_28",
  "memories",
  "multi_agent",
  "multi_agent_mode",
  "multi_agent_v2",
  "non_prefixed_mcp_tool_names",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "recommended_plugins",
  "remote_control",
  "remote_plugin",
  "request_permissions_tool",
  "request_rule",
  "search_tool",
  "shell_snapshot",
  "shell_tool",
  "shell_zsh_fork",
  "skill_env_var_dependency_prompt",
  "skill_mcp_dependency_install",
  "skill_search",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "tool_suggest",
  "unavailable_dummy_tools",
  "unified_exec",
  "unified_exec_zsh_fork",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies",
]);

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-app-server-manager-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

class FakeChild extends EventEmitter {
  constructor({ writeResult = true } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.writes = [];
    this.stdin = {
      destroyed: false,
      write: (value) => {
        this.writes.push(JSON.parse(String(value).trimEnd()));
        return writeResult;
      },
      end: () => { this.stdin.destroyed = true; },
    };
  }

  receive(value) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  receiveRaw(value) {
    this.stdout.write(value);
  }

  fail(error = new Error("private /Users/person/.codex authToken=secret")) {
    this.emit("error", error);
  }

  exit(code = 1, signal = null) {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, "SIGTERM");
    return true;
  }
}

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id) => { this.timers.delete(id); };

  fire(delay) {
    const match = [...this.timers].find(([, timer]) => timer.delay === delay);
    assert.ok(match, `expected ${delay}ms timer`);
    this.timers.delete(match[0]);
    match[1].callback();
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(t, { children = [new FakeChild()], clock, environment } = {}) {
  const root = tempRoot(t);
  const resourcesPath = path.join(root, "OpenBot.app", "Contents", "Resources");
  const binaryPath = path.join(resourcesPath, "codex", "runtime", "codex");
  const stateRoot = path.join(root, "Library", "Application Support", "OpenBot", "direct-codex");
  const personalHomeDirectory = path.join(root, "person-home");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.mkdirSync(personalHomeDirectory, { recursive: true });
  fs.writeFileSync(binaryPath, "verified fixture");
  fs.chmodSync(binaryPath, 0o755);
  const spawns = [];
  let childIndex = 0;
  let loadCalls = 0;
  const manager = new CodexAppServerManager({
    resourcesPath,
    stateRoot,
    environment: environment || {
      HOME: personalHomeDirectory,
      CODEX_HOME: path.join(personalHomeDirectory, ".codex-private-history"),
      LANG: "en_US.UTF-8",
      PATH: "/private/provider/bin:/usr/bin:/bin",
      TMPDIR: path.join(root, "private-tmp"),
      OPENAI_API_KEY: "must-not-cross",
      CLIPROXY_API_KEY: "must-not-cross-either",
    },
    clientVersion: "0.2.0-macos.1",
    loadRuntime: async (actualResourcesPath) => {
      loadCalls += 1;
      assert.equal(actualResourcesPath, resourcesPath);
      return Object.freeze({ binaryPath, version: "0.147.0" });
    },
    spawnImpl(executable, args, options) {
      const child = children[childIndex++];
      assert.ok(child, "fixture child exhausted");
      spawns.push({ executable, args, options, child });
      return child;
    },
    ...(clock ? { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } : {}),
  });
  return { manager, children, spawns, binaryPath, resourcesPath, stateRoot, personalHomeDirectory, get loadCalls() { return loadCalls; } };
}

async function startReady(manager, child) {
  const starting = manager.start();
  await tick();
  const initialize = child.writes.find((message) => message.method === "initialize");
  assert.ok(initialize, "initialize request was not sent");
  child.receive({ id: initialize.id, result: { serverInfo: { name: "codex", version: "0.147.0" } } });
  await starting;
  assert.deepEqual(child.writes.at(-1), { method: "initialized" });
}

test("starts one verified packaged Codex flight with private OpenBot state, an empty cwd, a minimal account environment, and every local tool feature disabled", async (t) => {
  const fixture = harness(t);
  const { manager, children: [child], spawns } = fixture;
  const first = manager.start();
  const second = manager.start();
  assert.equal(first, second);
  await tick();
  assert.equal(fixture.loadCalls, 1);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].executable, fixture.binaryPath);
  assert.deepEqual(spawns[0].args, [
    ...DISABLED_LOCAL_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c",
    "mcp_servers={}",
    "app-server",
    "--stdio",
  ]);
  assert.equal(spawns[0].options.cwd, path.join(fixture.stateRoot, "empty-workspace"));
  assert.deepEqual(spawns[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(spawns[0].options.env, {
    CODEX_HOME: path.join(fixture.stateRoot, "codex-home"),
    HOME: path.join(fixture.stateRoot, "home"),
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: path.join(fixture.stateRoot, "tmp"),
  });
  assert.doesNotMatch(JSON.stringify(spawns[0]), /ChatGPT\.app|CLIPROXY|OPENAI_API_KEY|must-not-cross|private\/provider/);
  assert.doesNotMatch(JSON.stringify(spawns[0]), /person-home|codex-private-history/);
  assert.equal(fs.statSync(spawns[0].options.cwd).mode & 0o077, 0);
  assert.equal(fs.statSync(spawns[0].options.env.CODEX_HOME).mode & 0o077, 0);
  assert.equal(fs.statSync(spawns[0].options.env.HOME).mode & 0o077, 0);
  assert.equal(fs.statSync(spawns[0].options.env.TMPDIR).mode & 0o077, 0);
  const initialize = child.writes[0];
  assert.deepEqual(initialize, {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "openbot", title: "OpenBot", version: "0.2.0-macos.1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  });
  child.receive({ id: 1, result: { serverInfo: { name: "codex", version: "0.147.0" } } });
  await Promise.all([first, second]);
  assert.equal(manager.state, "ready");
  assert.equal(manager.initialized, true);
  assert.deepEqual(child.writes[1], { method: "initialized" });
});

test("rejects symlinked private HOME and CODEX_HOME roots before starting the packaged runtime", async (t) => {
  for (const name of ["home", "codex-home"]) {
    await t.test(name, async (subtest) => {
      const fixture = harness(subtest);
      const outside = path.join(path.dirname(fixture.stateRoot), `outside-${name}`);
      fs.mkdirSync(fixture.stateRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
      fs.symlinkSync(outside, path.join(fixture.stateRoot, name));
      await assert.rejects(fixture.manager.start(), { code: "CODEX_PROCESS_ERROR" });
      assert.equal(fixture.spawns.length, 0);
    });
  }
});

test("terminates a spawned child that does not expose the required private stdio contract", async (t) => {
  let killed = false;
  const invalidChild = new EventEmitter();
  invalidChild.kill = () => { killed = true; return true; };
  const { manager } = harness(t, { children: [invalidChild] });
  await assert.rejects(manager.start(), { code: "CODEX_PROCESS_ERROR" });
  assert.equal(killed, true);
});

test("routes bounded requests and deeply frozen sanitized notifications without exposing private keys", async (t) => {
  const notifications = [];
  const { manager, children: [child] } = harness(t);
  manager.on("notification", (message) => notifications.push(message));
  const starting = manager.start();
  await tick();
  child.receive({
    method: "remoteControl/status/changed",
    params: { status: "disabled" },
    emittedAtMs: 1_780_000_000_123,
  });
  child.receive({ id: 1, result: { serverInfo: { name: "codex", version: "0.147.0" } } });
  await starting;
  assert.deepEqual(notifications.shift(), {
    method: "remoteControl/status/changed",
    params: { status: "disabled" },
    emittedAtMs: 1_780_000_000_123,
  });
  const request = manager.request("model/list", { cursor: null }, { timeoutMs: 30_000 });
  const sent = child.writes.at(-1);
  assert.deepEqual(sent, { id: 2, method: "model/list", params: { cursor: null } });
  child.receive({ id: sent.id, result: { data: [{ id: "gpt-5.6-sol" }], nextCursor: null } });
  assert.deepEqual(await request, { data: [{ id: "gpt-5.6-sol" }], nextCursor: null });

  child.receive({
    method: "account/updated",
    params: {
      authMode: "chatgpt",
      planType: "pro",
      accessToken: "private-token",
      nested: { Authorization: "Bearer private", ok: true },
    },
  });
  await tick();
  assert.deepEqual(notifications, [{
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "pro", nested: { ok: true } },
  }]);
  assert.equal(Object.isFrozen(notifications[0]), true);
  assert.equal(Object.isFrozen(notifications[0].params.nested), true);
});

test("automatically denies every server request and never exposes a local execution callback", async (t) => {
  const { manager, children: [child] } = harness(t);
  await startReady(manager, child);
  let serverRequestEvents = 0;
  manager.on("server-request", () => { serverRequestEvents += 1; });
  for (const [id, method] of [
    [41, "item/commandExecution/requestApproval"],
    [42, "item/fileChange/requestApproval"],
    [43, "mcpServer/elicitation/request"],
    [44, "item/tool/call"],
    [45, "browser/open"],
    [46, "computer/input"],
    [47, "process/exec"],
    [48, "unknown/future/request"],
  ]) {
    child.receive({ id, method, params: { command: "open /Users/person/private" } });
  }
  await tick();
  assert.equal(serverRequestEvents, 0);
  assert.deepEqual(child.writes.slice(-8), [...Array(8)].map((_, index) => ({
    id: 41 + index,
    error: { code: -32601, message: "OpenBot does not permit local tool requests." },
  })));
  assert.equal(manager.state, "ready");
});

test("exposes only bounded dynamic tool requests for the direct inference adapter to decline", async (t) => {
  const { manager, children: [child] } = harness(t);
  await startReady(manager, child);
  const received = [];
  manager.on("dynamic-tool-call", (value) => received.push(value));
  child.receive({
    id: 44,
    method: "item/tool/call",
    params: {
      arguments: { message: "hello" },
      callId: "call-1",
      namespace: null,
      threadId: "thread-1",
      tool: "send_message",
      turnId: "turn-1",
    },
  });
  await tick();
  assert.deepEqual(received, [{
    id: 44,
    method: "item/tool/call",
    params: {
      arguments: { message: "hello" },
      callId: "call-1",
      namespace: null,
      threadId: "thread-1",
      tool: "send_message",
      turnId: "turn-1",
    },
  }]);
  assert.equal(Object.isFrozen(received[0]), true);
  assert.equal(Object.isFrozen(received[0].params.arguments), true);
  assert.equal(child.writes.some((value) => value.id === 44), false);
  manager.declineDynamicToolCall(44);
  assert.deepEqual(child.writes.at(-1), {
    id: 44,
    result: { contentItems: [], success: false },
  });
  assert.throws(() => manager.declineDynamicToolCall(44), /tool|request|available/i);
});

test("fails closed on malformed oversized and invalid UTF-8 stdout without leaking diagnostics", async (t) => {
  for (const [name, send] of [
    ["malformed", (child) => child.receiveRaw("{not-json}\n")],
    ["oversized", (child) => child.receiveRaw(`${"x".repeat(1_048_577)}\n`)],
    ["utf8", (child) => child.receiveRaw(Buffer.from([0xc3, 0x28, 0x0a]))],
  ]) {
    await t.test(name, async (subtest) => {
      const { manager, children: [child] } = harness(subtest);
      await startReady(manager, child);
      const offline = once(manager, "offline");
      send(child);
      const [error] = await offline;
      assert.equal(error.code, name === "oversized" ? "CODEX_PROTOCOL_CAPACITY" : "CODEX_PROTOCOL_ERROR");
      assert.doesNotMatch(String(error), /not-json|\/Users\/|authToken|secret|c3/i);
      assert.equal(manager.state, "offline");
      assert.equal(child.killed, true);
    });
  }
});

test("bounds stderr and sanitizes child errors exits and request timeouts", async (t) => {
  await t.test("stderr", async (subtest) => {
    const { manager, children: [child] } = harness(subtest);
    await startReady(manager, child);
    const offline = once(manager, "offline");
    child.stderr.write("s".repeat(65_537));
    const [error] = await offline;
    assert.equal(error.code, "CODEX_DIAGNOSTIC_CAPACITY");
    assert.doesNotMatch(String(error), /s{16}|\/Users\/|secret/);
  });

  await t.test("child error", async (subtest) => {
    const { manager, children: [child] } = harness(subtest);
    await startReady(manager, child);
    const offline = once(manager, "offline");
    child.fail();
    const [error] = await offline;
    assert.equal(error.code, "CODEX_PROCESS_ERROR");
    assert.doesNotMatch(String(error), /private|\/Users\/|authToken|secret/);
  });

  await t.test("request timeout", async (subtest) => {
    const clock = new FakeClock();
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const { manager } = harness(subtest, { clock, children: [firstChild, secondChild] });
    const starting = manager.start();
    await tick();
    firstChild.receive({ id: 1, result: {} });
    await starting;
    const pending = manager.request("account/read", undefined, { timeoutMs: 4567 });
    clock.fire(4567);
    await assert.rejects(pending, { code: "CODEX_REQUEST_TIMEOUT" });
    assert.equal(manager.state, "offline");
    assert.equal(firstChild.killed, true);

    const restarted = manager.start();
    await tick();
    const initialize = secondChild.writes.find((message) => message.method === "initialize");
    secondChild.receive({ id: initialize.id, result: {} });
    await restarted;
    assert.equal(manager.state, "ready");
    firstChild.receive({ id: 2, result: { private: "stale response" } });
    assert.equal(manager.state, "ready");
  });
});

test("enforces pending capacity write backpressure and hostile payload boundaries", async (t) => {
  await t.test("pending capacity", async (subtest) => {
    const { manager, children: [child] } = harness(subtest);
    await startReady(manager, child);
    const pending = [];
    for (let index = 0; index < 128; index += 1) {
      pending.push(manager.request("model/list", { cursor: String(index) }).catch(() => {}));
    }
    await assert.rejects(
      manager.request("model/list", { cursor: "overflow" }),
      { code: "CODEX_REQUEST_CAPACITY" },
    );
    manager.stop();
    await Promise.all(pending);
  });

  await t.test("backpressure", async (subtest) => {
    const child = new FakeChild({ writeResult: false });
    const { manager } = harness(subtest, { children: [child] });
    await assert.rejects(manager.start(), { code: "CODEX_TRANSPORT_BACKPRESSURE" });
    assert.equal(child.killed, true);
  });

  await t.test("hostile request payload", async (subtest) => {
    const { manager, children: [child] } = harness(subtest);
    await startReady(manager, child);
    let trap = 0;
    const hostile = new Proxy({}, { ownKeys() { trap += 1; throw new Error("private trap"); } });
    assert.throws(
      () => manager.request("model/list", hostile),
      { code: "CODEX_PAYLOAD_INVALID" },
    );
    assert.equal(trap, 0, "proxy payloads must be rejected before reflection");
  });
});

test("stop fences in-flight startup and stale generations cannot settle or publish into a restart", async (t) => {
  const firstChild = new FakeChild();
  const secondChild = new FakeChild();
  const { manager } = harness(t, { children: [firstChild, secondChild] });
  const first = manager.start();
  await tick();
  manager.stop();
  await assert.rejects(first, { code: "CODEX_MANAGER_STOPPED" });
  assert.equal(firstChild.killed, true);

  const notifications = [];
  manager.on("notification", (message) => notifications.push(message));
  const second = manager.start();
  await tick();
  firstChild.receive({ id: 1, result: {} });
  firstChild.receive({ method: "account/updated", params: { authMode: "apiKey" } });
  secondChild.receive({ id: 2, result: {} });
  await second;
  assert.equal(manager.generation, 2);
  assert.deepEqual(notifications, []);
  assert.equal(secondChild.writes.at(-1).method, "initialized");
});

test("listener failures cannot alter durable transport outcomes and stop is idempotent", async (t) => {
  const { manager, children: [child] } = harness(t);
  manager.on("ready", () => { throw new Error("observer private failure"); });
  manager.on("notification", async () => { throw new Error("observer async failure"); });
  await startReady(manager, child);
  child.receive({ method: "model/list/updated", params: { reason: "catalog" } });
  await tick();
  assert.equal(manager.state, "ready");
  manager.stop();
  manager.stop();
  assert.equal(manager.state, "stopped");
  assert.equal(child.killed, true);
});
