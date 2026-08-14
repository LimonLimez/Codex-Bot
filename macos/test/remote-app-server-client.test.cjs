"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { inspect, types } = require("node:util");

let RemoteAppServerClient;
try {
  ({ RemoteAppServerClient } = require("../src/bots/remote-app-server-client.cjs"));
} catch {
  // The exhaustive RED run intentionally executes before the production module exists.
}

const PRIVATE_TOKEN = "fixture-private-token-abcdefghijklmnopqrstuvwxyz";
const ENDPOINT = "wss://bot-01.runtime.example.com/app-server?region=us-east";

function session(overrides = {}) {
  return {
    provider: "authorized-provider",
    runtimeId: "runtime-bot-01",
    endpoint: ENDPOINT,
    authToken: PRIVATE_TOKEN,
    generation: 7,
    ...overrides,
  };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.bufferedAmount = 0;
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  send(payload) {
    if (this.readyState !== 1) throw new Error("fake socket is closed");
    this.sent.push(JSON.parse(String(payload)));
  }

  receive(message, { binary = false, raw = false } = {}) {
    const data = raw ? message : JSON.stringify(message);
    this.emit("message", data, binary);
  }

  remoteClose(code = 1006, reason = "fixture raw close secret") {
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  fail(error = new Error("fixture raw socket secret")) {
    this.emit("error", error);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

class WsLikeSocket extends FakeSocket {
  constructor() {
    super();
    this.sendCallbacks = [];
    this.sendBehaviors = [];
    this.sendOptions = [];
  }

  send(payload, options, callback) {
    if (this.readyState !== 1) throw new Error("fake socket is closed");
    this.sent.push(JSON.parse(String(payload)));
    this.sendOptions.push(options);
    const behavior = this.sendBehaviors.shift();
    if (behavior) behavior(callback, this);
    else if (typeof callback === "function") callback();
  }
}

class WsArityTwoSocket extends FakeSocket {
  constructor() {
    super();
    this.sendBehaviors = [];
    this.sendCallbacks = [];
  }

  send(payload, callback) {
    if (this.readyState !== 1) throw new Error("fake socket is closed");
    this.sent.push(JSON.parse(String(payload)));
    this.sendCallbacks.push(callback);
    const behavior = this.sendBehaviors.shift();
    if (behavior) behavior(callback, this);
    else callback?.();
  }
}

class RegistrationEventSocket extends FakeSocket {
  constructor({ stage, action, synchronousInitializeResponse = false }) {
    super();
    this.stage = stage;
    this.action = action;
    this.synchronousInitializeResponse = synchronousInitializeResponse;
    this.registrationEventFired = false;
  }

  on(eventName, listener) {
    const result = super.on(eventName, listener);
    if (!this.registrationEventFired && eventName === this.stage) {
      this.registrationEventFired = true;
      if (this.action === "open") this.open();
      else if (this.action === "close") this.remoteClose();
      else this.fail();
    }
    return result;
  }

  send(payload) {
    super.send(payload);
    const message = this.sent.at(-1);
    if (this.synchronousInitializeResponse && message?.method === "initialize") {
      this.receive({ id: message.id, result: { serverInfo: { name: "sync-fixture", version: "1" } } });
    }
  }
}

class FakeEventTargetSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.bufferedAmount = 0;
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(payload) {
    if (this.readyState !== 1) throw new Error("fake socket is closed");
    this.sent.push(JSON.parse(String(payload)));
  }

  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
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

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  activeDelays() {
    return [...this.timers.values()].map(({ delay }) => delay);
  }

  fireFirst(delay) {
    const match = [...this.timers].find(([, timer]) => timer.delay === delay);
    assert.ok(match, `expected an active ${delay}ms timer`);
    this.timers.delete(match[0]);
    match[1].callback();
  }

  fireCaptured(timer) {
    timer.callback();
  }
}

function socketHarness(sockets = [new FakeSocket()]) {
  const calls = [];
  let index = 0;
  return {
    sockets,
    calls,
    factory(url, protocols, options) {
      calls.push({ url, protocols, options });
      const socket = sockets[index++];
      if (!socket) throw new Error("fixture factory exhausted private-token");
      return socket;
    },
  };
}

function makeClient({ privateSession = session(), sockets, clock, factory, ...options } = {}) {
  const harness = sockets ? socketHarness(sockets) : socketHarness();
  const webSocketFactory = factory || harness.factory.bind(harness);
  const client = new RemoteAppServerClient({
    session: privateSession,
    webSocketFactory,
    ...(clock ? { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } : {}),
    ...options,
  });
  return { client, harness };
}

async function startReady(client, socket) {
  const starting = client.start();
  socket.open();
  assert.equal(socket.sent.length, 1);
  const initializeId = socket.sent[0].id;
  assert.equal(Number.isSafeInteger(initializeId) && initializeId > 0, true);
  assert.deepEqual(socket.sent[0], {
    id: initializeId,
    method: "initialize",
    params: {
      clientInfo: { name: "codex-bot", title: "Codex Bot", version: "1.0.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  });
  assert.equal(client.initialized, false);
  socket.receive({ id: initializeId, result: { serverInfo: { name: "codex-fixture", version: "1" } } });
  await starting;
  assert.deepEqual(socket.sent[1], { method: "initialized" });
  assert.equal(client.initialized, true);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

function waitTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("opens only the authorized endpoint with a bearer header and fixed subprotocol", async () => {
  const original = session();
  const { client, harness } = makeClient({ privateSession: original });
  const ready = [];
  client.on("ready", (event) => ready.push(event));

  await startReady(client, harness.sockets[0]);

  assert.deepEqual(harness.calls, [{
    url: ENDPOINT,
    protocols: ["codex-app-server"],
    options: {
      followRedirects: false,
      handshakeTimeout: 30_000,
      headers: { Authorization: `Bearer ${PRIVATE_TOKEN}` },
      maxPayload: 1_048_576,
      perMessageDeflate: false,
    },
  }]);
  assert.deepEqual(ready, [{ runtimeId: "runtime-bot-01", generation: 7, state: "ready" }]);
  assertDeepFrozen(ready[0]);
  assert.equal(client.runtimeId, "runtime-bot-01");
  assert.equal(client.generation, 7);
  assert.equal(client.state, "ready");
  const publicText = `${JSON.stringify(client)} ${inspect(client)} ${JSON.stringify(ready)}`;
  assert.doesNotMatch(publicText, /fixture-private|wss:|region=|authorized-provider|Authorization/i);
});

test("performs one initialize flight for concurrent and repeated starts", async () => {
  const { client, harness } = makeClient();
  const first = client.start();
  const second = client.start();
  const third = client.start();
  assert.equal(harness.calls.length, 1);

  harness.sockets[0].open();
  assert.equal(harness.sockets[0].sent.filter(({ method }) => method === "initialize").length, 1);
  harness.sockets[0].receive({ id: 1, result: { serverInfo: {} } });
  assert.deepEqual(await Promise.all([first, second, third]), [undefined, undefined, undefined]);
  await client.start();
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.sockets[0].sent.filter(({ method }) => method === "initialized").length, 1);
});

test("routes numeric responses exactly once and preserves ordered frozen notifications", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const observed = [];
  client.on("notification", (message) => {
    observed.push(message);
    throw new Error("listener must be isolated");
  });
  client.on("notification", async () => { throw new Error("async listener must be isolated"); });

  const models = client.request("model/list", { includeHidden: false });
  const account = client.request("account/read");
  assert.deepEqual(harness.sockets[0].sent.slice(2), [
    { id: 2, method: "model/list", params: { includeHidden: false } },
    { id: 3, method: "account/read" },
  ]);
  harness.sockets[0].receive({ id: 3, result: { account: "ok" } });
  harness.sockets[0].receive({ id: 2, result: { data: [{ id: "gpt-test" }] } });
  assert.deepEqual(await Promise.all([models, account]), [
    { data: [{ id: "gpt-test" }] },
    { account: "ok" },
  ]);

  harness.sockets[0].receive({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      nested: {
        authToken: PRIVATE_TOKEN,
        endpoint: ENDPOINT,
        keep: "first",
        note: "bot-01.runtime.example.com must not leak",
      },
      providerDiagnostic: "raw provider secret",
    },
  });
  harness.sockets[0].receive({ method: "turn/completed", params: { threadId: "thread-1", keep: "second" } });
  await waitTurn();

  assert.deepEqual(observed, [
    {
      method: "turn/started",
      params: { threadId: "thread-1", nested: { keep: "first", note: "<redacted>" } },
    },
    { method: "turn/completed", params: { threadId: "thread-1", keep: "second" } },
  ]);
  assertDeepFrozen(observed[0]);
  assertDeepFrozen(observed[1]);
});

test("supports scoped server requests and protocol-compatible responses", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const received = [];
  client.on("server-request", (message) => received.push(message));

  harness.sockets[0].receive({
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd", credential: PRIVATE_TOKEN, threadId: "thread-1" },
  });
  assert.deepEqual(received, [{
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd", threadId: "thread-1" },
  }]);
  assertDeepFrozen(received[0]);
  assert.equal(client.respond(71, { decision: "accept" }), undefined);
  assert.deepEqual(harness.sockets[0].sent.at(-1), { id: 71, result: { decision: "accept" } });
  assert.throws(() => client.respond(71, { decision: "accept" }), /unknown or stale/i);

  harness.sockets[0].receive({ id: 72, method: "item/fileChange/requestApproval", params: { threadId: "thread-1" } });
  assert.equal(client.respondError(72, -32_000, "Request declined."), undefined);
  assert.deepEqual(harness.sockets[0].sent.at(-1), {
    id: 72,
    error: { code: -32_000, message: "Request declined." },
  });
  assert.equal(client.sendNotification("client/status", { state: "visible" }), undefined);
  assert.deepEqual(harness.sockets[0].sent.at(-1), {
    method: "client/status",
    params: { state: "visible" },
  });
});

test("keeps a server request pending after an invalid response and rejects reused IDs", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const requests = [];
  const offline = [];
  client.on("server-request", (message) => requests.push(message));
  client.on("offline", (error) => offline.push(error));
  harness.sockets[0].receive({
    id: 81,
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd", threadId: "thread-1" },
  });

  const invalid = {};
  invalid.self = invalid;
  assert.throws(() => client.respond(81, invalid), /request payload/i);
  client.respond(81, { decision: "decline" });
  assert.deepEqual(harness.sockets[0].sent.at(-1), { id: 81, result: { decision: "decline" } });

  harness.sockets[0].receive({
    id: 81,
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd", threadId: "thread-1" },
  });
  assert.equal(requests.length, 1);
  assert.equal(client.state, "offline");
  assert.equal(offline[0].code, "REMOTE_PROTOCOL_ERROR");
});

test("uses bounded request budgets and makes timeout races settle once", async () => {
  const clock = new FakeClock();
  const { client, harness } = makeClient({ clock });
  const starting = client.start();
  harness.sockets[0].open();
  assert.deepEqual(clock.activeDelays(), [30_000]);
  harness.sockets[0].receive({ id: 1, result: {} });
  await starting;
  assert.deepEqual(clock.activeDelays(), []);

  const ordinary = client.request("model/list", {});
  assert.deepEqual(clock.activeDelays(), [30_000]);
  const ordinaryId = harness.sockets[0].sent.at(-1).id;
  harness.sockets[0].receive({ id: ordinaryId, result: { data: [] } });
  await ordinary;
  assert.deepEqual(clock.activeDelays(), []);

  const threadStart = client.request("thread/start", {});
  assert.deepEqual(clock.activeDelays(), [120_000]);
  const threadStartId = harness.sockets[0].sent.at(-1).id;
  harness.sockets[0].receive({ id: threadStartId, result: { thread: { id: "thread-1" } } });
  await threadStart;

  const strict = client.request("thread/start", {}, 5_000);
  assert.deepEqual(clock.activeDelays(), [5_000]);
  const strictId = harness.sockets[0].sent.at(-1).id;
  const timer = [...clock.timers.values()][0];
  clock.fireCaptured(timer);
  await assert.rejects(strict, { code: "REMOTE_REQUEST_TIMEOUT", message: "Remote Codex request timed out." });
  harness.sockets[0].receive({ id: strictId, result: { tooLate: true } });
  assert.equal(client.state, "ready");
});

test("rejects invalid timeouts synchronously before transport", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const before = harness.sockets[0].sent.length;
  for (const timeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001, "1000", null]) {
    assert.throws(() => client.request("model/list", {}, timeout), /timeout/i);
  }
  assert.throws(() => client.request("thread/start", {}, 120_001), /timeout/i);
  assert.equal(harness.sockets[0].sent.length, before);
});

test("rejects every pending request once on remote close and emits one sanitized offline event", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const offline = [];
  client.on("offline", (error) => offline.push(error));
  const first = client.request("model/list", {});
  const second = client.request("thread/list", {});

  harness.sockets[0].remoteClose(1006, `${PRIVATE_TOKEN} ${ENDPOINT}`);
  await assert.rejects(first, { code: "REMOTE_TRANSPORT_CLOSED", message: "Remote Codex disconnected." });
  await assert.rejects(second, { code: "REMOTE_TRANSPORT_CLOSED", message: "Remote Codex disconnected." });
  assert.equal(client.initialized, false);
  assert.equal(client.state, "offline");
  assert.equal(offline.length, 1);
  assert.equal(offline[0].code, "REMOTE_TRANSPORT_CLOSED");
  assert.doesNotMatch(`${offline[0].message} ${offline[0].stack} ${JSON.stringify(offline)}`, /fixture-private|wss:|region=/i);
  harness.sockets[0].fail(new Error(`${PRIVATE_TOKEN} duplicate terminal`));
  assert.equal(offline.length, 1);
});

test("stop is idempotent, rejects pending calls, clears timers, and suppresses late activity", async () => {
  const clock = new FakeClock();
  const { client, harness } = makeClient({ clock });
  await startReady(client, harness.sockets[0]);
  const notifications = [];
  const offline = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("offline", (error) => offline.push(error));
  const pending = client.request("thread/list", {});
  const lateTimer = [...clock.timers.values()][0];

  client.stop();
  client.stop();
  await assert.rejects(pending, { code: "REMOTE_CLIENT_STOPPED", message: "Remote Codex client stopped." });
  assert.equal(harness.sockets[0].closeCalls, 1);
  assert.deepEqual(clock.activeDelays(), []);
  assert.equal(client.state, "stopped");
  clock.fireCaptured(lateTimer);
  harness.sockets[0].receive({ method: "turn/started", params: { threadId: "late" } });
  harness.sockets[0].remoteClose();
  harness.sockets[0].fail();
  await waitTurn();
  assert.deepEqual(notifications, []);
  assert.deepEqual(offline, []);
});

test("stale sockets cannot settle, notify, or close a restarted generation", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const { client } = makeClient({ sockets: [first, second] });
  await startReady(client, first);
  client.stop();
  await assert.rejects(client.request("model/list", {}), { code: "REMOTE_CLIENT_NOT_READY" });

  const restarting = client.start();
  second.open();
  const initializeId = second.sent[0].id;
  first.emit("open");
  first.receive({ id: initializeId, result: { stale: true } });
  first.receive({ method: "turn/started", params: { threadId: "stale" } });
  first.remoteClose();
  first.fail();
  assert.equal(client.initialized, false);
  second.receive({ id: initializeId, result: {} });
  await restarting;

  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  const request = client.request("thread/list", {});
  const requestId = second.sent.at(-1).id;
  first.receive({ id: requestId, result: { stale: true } });
  first.receive({ method: "turn/started", params: { threadId: "stale-2" } });
  second.receive({ id: requestId, result: { data: ["current"] } });
  assert.deepEqual(await request, { data: ["current"] });
  assert.deepEqual(notifications, []);
  assert.equal(client.state, "ready");
});

test("fails closed on malformed, binary, oversized, and hostile frames", async (t) => {
  const cases = [
    ["malformed JSON", (socket) => socket.receive("{not-json", { raw: true })],
    ["binary", (socket) => socket.receive(Buffer.from("{}"), { raw: true, binary: true })],
    ["oversized", (socket) => socket.receive("x".repeat(1_048_577), { raw: true })],
    ["non-object", (socket) => socket.receive("hello")],
    ["invalid response id", (socket) => socket.receive({ id: "2", result: {} })],
    ["response with result and error", (socket) => socket.receive({ id: 2, result: {}, error: { code: 1 } })],
    ["notification with id", (socket) => socket.receive({ id: 4, method: "turn/started", params: {} })],
  ];

  for (const [name, send] of cases) {
    await t.test(name, async () => {
      const { client, harness } = makeClient();
      await startReady(client, harness.sockets[0]);
      const offline = [];
      client.on("offline", (error) => offline.push(error));
      send(harness.sockets[0]);
      assert.equal(client.state, "offline");
      assert.equal(offline.length, 1);
      assert.equal(offline[0].code, "REMOTE_PROTOCOL_ERROR");
      assert.equal(offline[0].message, "Remote Codex protocol error.");
    });
  }

  await t.test("hostile event getter", async () => {
    const { client, harness } = makeClient();
    await startReady(client, harness.sockets[0]);
    let calls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "data", { get() { calls += 1; throw new Error(PRIVATE_TOKEN); } });
    harness.sockets[0].emit("message", hostile);
    assert.equal(calls, 0);
    assert.equal(client.state, "offline");
  });
});

test("duplicate responses fail closed without resettling a request", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const request = client.request("model/list", {});
  const id = harness.sockets[0].sent.at(-1).id;
  harness.sockets[0].receive({ id, result: { data: [] } });
  assert.deepEqual(await request, { data: [] });
  harness.sockets[0].receive({ id, result: { duplicate: true } });
  assert.equal(client.state, "offline");
});

test("unknown response IDs fail closed before affecting later requests", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const offline = [];
  client.on("offline", (error) => offline.push(error));
  harness.sockets[0].receive({ id: 999, result: { unknown: true } });
  assert.equal(client.state, "offline");
  assert.equal(offline.length, 1);
  assert.equal(offline[0].code, "REMOTE_PROTOCOL_ERROR");
  await assert.rejects(client.request("model/list", {}), { code: "REMOTE_CLIENT_NOT_READY" });
});

test("sanitizes remote request errors instead of exposing payloads", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const request = client.request("model/list", {});
  const id = harness.sockets[0].sent.at(-1).id;
  harness.sockets[0].receive({
    id,
    error: { code: -32_000, message: `${PRIVATE_TOKEN} ${ENDPOINT}`, data: { diagnostics: "raw" } },
  });
  const error = await request.then(() => null, (failure) => failure);
  assert.equal(error.code, "REMOTE_REQUEST_FAILED");
  assert.equal(error.message, "Remote Codex request failed.");
  assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /fixture-private|wss:|region=|raw/i);
  assert.equal(client.state, "ready");
});

test("rejects requests and compatibility writes outside the ready generation", async () => {
  const { client, harness } = makeClient();
  await assert.rejects(client.request("model/list", {}), { code: "REMOTE_CLIENT_NOT_READY" });
  assert.throws(() => client.respond(1, {}), /not ready/i);
  assert.throws(() => client.respondError(1, -32_000, "No"), /not ready/i);
  assert.throws(() => client.sendNotification("client/status", {}), /not ready/i);
  assert.equal(harness.sockets[0].sent.length, 0);
});

test("validates the exact controller session without running accessors or proxy traps", () => {
  const invalidSessions = [
    null,
    {},
    session({ extra: true }),
    session({ provider: "" }),
    session({ provider: "provider with spaces" }),
    session({ runtimeId: "" }),
    session({ runtimeId: "runtime with spaces" }),
    session({ endpoint: "ws://bot.runtime.example.com/app-server" }),
    session({ endpoint: "wss://localhost/app-server" }),
    session({ endpoint: "wss://127.0.0.1/app-server" }),
    session({ endpoint: "wss://user:password@bot.runtime.example.com/app-server" }),
    session({ endpoint: "wss://bot.runtime.example.com/app-server?access_token=secret" }),
    session({ authToken: "" }),
    session({ authToken: "token\r\nInjected: yes" }),
    session({ authToken: "x".repeat(8_193) }),
    session({ generation: 0 }),
    session({ generation: 1.5 }),
  ];
  for (const invalid of invalidSessions) {
    assert.throws(() => makeClient({ privateSession: invalid }), /remote runtime session/i);
  }

  let getterCalls = 0;
  const accessor = session();
  Object.defineProperty(accessor, "authToken", {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(PRIVATE_TOKEN); },
  });
  assert.throws(() => makeClient({ privateSession: accessor }), /remote runtime session/i);
  assert.equal(getterCalls, 0);

  const symbolSession = session();
  symbolSession[Symbol("private")] = PRIVATE_TOKEN;
  assert.throws(() => makeClient({ privateSession: symbolSession }), /remote runtime session/i);
  const proxied = new Proxy(session(), {});
  assert.equal(types.isProxy(proxied), true);
  assert.throws(() => makeClient({ privateSession: proxied }), /remote runtime session/i);
  const cyclic = session();
  cyclic.extra = cyclic;
  assert.throws(() => makeClient({ privateSession: cyclic }), /remote runtime session/i);
});

test("rejects degenerate canonical auth tokens before socket creation", () => {
  const invalidTokens = [
    ["encoded space", String.raw`\u0020`],
    ["encoded single letter", String.raw`\u0061`],
    ["hex-encoded single letter", String.raw`\x61`],
    ["encoded newline", String.raw`\n`],
    ["short raw token", "short-token"],
    ["15-byte raw token", "a".repeat(15)],
    ["canonical leading whitespace", `${String.raw`\u0020`}${"a".repeat(16)}`],
    ["canonical trailing whitespace", `${"a".repeat(16)}${String.raw`\x20`}`],
    ["canonical NUL", `${"a".repeat(16)}${String.raw`\u0000`}tail`],
    ["canonical control whitespace", `${"a".repeat(16)}${String.raw`\t`}tail`],
  ];
  for (const [label, authToken] of invalidTokens) {
    let socketCreations = 0;
    assert.throws(
      () => makeClient({
        privateSession: session({ authToken }),
        factory() {
          socketCreations += 1;
          return new FakeSocket();
        },
      }),
      /remote runtime session/i,
      label,
    );
    assert.equal(socketCreations, 0, label);
  }

  assert.doesNotThrow(() => makeClient({
    privateSession: session({ authToken: "a".repeat(16) }),
  }));
  assert.doesNotThrow(() => makeClient({
    privateSession: session({ authToken: "é".repeat(8) }),
  }));
  assert.doesNotThrow(() => makeClient({
    privateSession: session({ authToken: String.raw`opaque\u002dprivatevalue` }),
  }));
});

test("accepts the controller session's non-enumerable credential descriptors", async () => {
  const privateSession = {
    provider: "authorized-provider",
    runtimeId: "runtime-bot-01",
    generation: 7,
  };
  Object.defineProperties(privateSession, {
    endpoint: { value: ENDPOINT, enumerable: false },
    authToken: { value: PRIVATE_TOKEN, enumerable: false },
  });
  Object.freeze(privateSession);
  const { client, harness } = makeClient({ privateSession });
  await startReady(client, harness.sockets[0]);
  assert.equal(client.runtimeId, "runtime-bot-01");
  assert.equal(harness.calls[0].options.headers.Authorization, `Bearer ${PRIVATE_TOKEN}`);
  assert.doesNotMatch(JSON.stringify(privateSession), /fixture-private|wss:/i);
});

test("detaches the accepted session from later caller mutation", async () => {
  const privateSession = session();
  const { client, harness } = makeClient({ privateSession });
  privateSession.provider = "mutated-provider";
  privateSession.runtimeId = "mutated-runtime";
  privateSession.endpoint = "wss://mutated.example.com/socket";
  privateSession.authToken = "mutated-token";
  privateSession.generation = 99;

  await startReady(client, harness.sockets[0]);
  assert.equal(client.runtimeId, "runtime-bot-01");
  assert.equal(client.generation, 7);
  assert.equal(harness.calls[0].url, ENDPOINT);
  assert.equal(harness.calls[0].options.headers.Authorization, `Bearer ${PRIVATE_TOKEN}`);
});

test("rejects hostile outbound payloads without invoking getters, proxies, symbols, cycles, or thenables", async () => {
  const { client, harness } = makeClient();
  await startReady(client, harness.sockets[0]);
  const before = harness.sockets[0].sent.length;
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { getterCalls += 1; return PRIVATE_TOKEN; } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error(PRIVATE_TOKEN); } });
  const symbolValue = { [Symbol("secret")]: PRIVATE_TOKEN };
  const cyclic = {};
  cyclic.self = cyclic;
  let thenCalls = 0;
  const thenable = { then() { thenCalls += 1; } };

  for (const value of [accessor, proxy, symbolValue, cyclic, thenable, { bad: BigInt(1) }, { fn() {} }]) {
    assert.throws(() => client.request("model/list", value), /request payload/i);
  }
  assert.equal(getterCalls, 0);
  assert.equal(thenCalls, 0);
  assert.equal(harness.sockets[0].sent.length, before);
});

test("sanitizes socket factory, open, send, and socket error failures", async (t) => {
  for (const [name, arrange] of [
    ["factory", () => ({
      factory() { throw new Error(`${PRIVATE_TOKEN} ${ENDPOINT}`); },
      act: async (client) => client.start(),
    })],
    ["listener registration", () => {
      const socket = new Proxy({}, { get() { throw new Error(`${PRIVATE_TOKEN} ${ENDPOINT}`); } });
      return { factory: () => socket, act: async (client) => client.start() };
    }],
    ["send", () => {
      const socket = new FakeSocket();
      socket.send = () => { throw new Error(`${PRIVATE_TOKEN} ${ENDPOINT}`); };
      return { factory: () => socket, act: async (client) => { const starting = client.start(); socket.open(); return starting; } };
    }],
    ["socket error", () => {
      const socket = new FakeSocket();
      return { factory: () => socket, act: async (client) => { const starting = client.start(); socket.fail(new Error(`${PRIVATE_TOKEN} ${ENDPOINT}`)); return starting; } };
    }],
  ]) {
    await t.test(name, async () => {
      const setup = arrange();
      const { client } = makeClient({ factory: setup.factory });
      const offline = [];
      client.on("offline", (failure) => offline.push(failure));
      const error = await setup.act(client).then(() => null, (failure) => failure);
      assert.ok(error instanceof Error);
      assert.match(error.code, /^REMOTE_/);
      assert.doesNotMatch(`${error.message} ${error.stack} ${JSON.stringify(error)}`, /fixture-private|wss:|region=/i);
      assert.equal(client.initialized, false);
      assert.equal(offline.length, 1);
      assert.equal(offline[0], error);
    });
  }
});

test("isolates throwing and rejecting ready, offline, notification, and meta-event listeners", async () => {
  const { client, harness } = makeClient();
  client.on("newListener", () => { throw new Error("meta listener"); });
  client.on("ready", () => { throw new Error("ready listener"); });
  client.on("ready", async () => { throw new Error("async ready listener"); });
  client.on("offline", () => { throw new Error("offline listener"); });
  client.on("notification", () => { throw new Error("notification listener"); });
  await startReady(client, harness.sockets[0]);
  harness.sockets[0].receive({ method: "turn/started", params: { threadId: "thread-1" } });
  harness.sockets[0].remoteClose();
  await waitTurn();
  assert.equal(client.state, "offline");
});

test("never starts local processes, persists files, or calls a local Codex fallback", () => {
  const { client } = makeClient();
  assert.equal(Object.hasOwn(client, "process"), false);
  assert.equal(Object.hasOwn(client, "binaryPath"), false);
  assert.equal(Object.hasOwn(client, "spawnProcess"), false);
  assert.doesNotMatch(inspect(client), /localhost|127\.0\.0\.1|child_process|app-server --stdio/i);
});

test("declares the verified stable ws release as a direct production dependency", () => {
  const packageDocument = require("../package.json");
  assert.equal(packageDocument.dependencies?.ws, "8.21.3");
  assert.equal(require("ws/package.json").version, "8.21.3");
});

test("the default factory constructs ws with bounded authenticated options", async (t) => {
  const wsPath = require.resolve("ws");
  const clientPath = require.resolve("../src/bots/remote-app-server-client.cjs");
  const priorWs = require.cache[wsPath];
  const priorClient = require.cache[clientPath];
  const calls = [];
  let socket;
  class CapturingWebSocket extends FakeSocket {
    constructor(url, protocols, options) {
      super();
      socket = this;
      calls.push({ url, protocols, options });
    }
  }
  require.cache[wsPath] = {
    id: wsPath,
    filename: wsPath,
    loaded: true,
    exports: CapturingWebSocket,
    children: [],
    paths: [],
  };
  delete require.cache[clientPath];
  t.after(() => {
    if (priorWs) require.cache[wsPath] = priorWs;
    else delete require.cache[wsPath];
    if (priorClient) require.cache[clientPath] = priorClient;
    else delete require.cache[clientPath];
  });
  const { RemoteAppServerClient: FreshClient } = require(clientPath);
  const client = new FreshClient({ session: session() });
  t.after(() => client.stop());
  const starting = client.start();
  socket.open();
  socket.receive({ id: 1, result: {} });
  await starting;
  assert.deepEqual(calls, [{
    url: ENDPOINT,
    protocols: ["codex-app-server"],
    options: {
      followRedirects: false,
      handshakeTimeout: 30_000,
      headers: { Authorization: `Bearer ${PRIVATE_TOKEN}` },
      maxPayload: 1_048_576,
      perMessageDeflate: false,
    },
  }]);
});

test("bounds pre-initialize notification count before any event becomes public", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  const starting = client.start();
  void starting.catch(() => {});
  harness.sockets[0].open();
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  for (let index = 0; index < 128; index += 1) {
    harness.sockets[0].receive({ method: "turn/started", params: { index } });
  }
  assert.equal(client.state, "connecting");
  assert.deepEqual(notifications, []);
  harness.sockets[0].receive({ method: "turn/started", params: { index: 128 } });
  assert.equal(client.state, "offline");
  await assert.rejects(starting, { code: "REMOTE_PROTOCOL_CAPACITY" });
});

test("bounds aggregate pre-initialize notification bytes independently of count", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  const starting = client.start();
  void starting.catch(() => {});
  harness.sockets[0].open();
  const chunk = "x".repeat(4_000);
  for (let index = 0; index < 16; index += 1) {
    harness.sockets[0].receive({ method: "turn/started", params: { index, chunk } });
  }
  assert.equal(client.state, "connecting");
  harness.sockets[0].receive({ method: "turn/started", params: { index: 16, chunk } });
  assert.equal(client.state, "offline");
  await assert.rejects(starting, { code: "REMOTE_PROTOCOL_CAPACITY" });
});

test("bounds active incoming server requests and accepts request ID zero", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const requests = [];
  client.on("server-request", (message) => requests.push(message));
  for (let id = 0; id < 128; id += 1) {
    harness.sockets[0].receive({
      id,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });
  }
  assert.equal(requests.length, 128);
  assert.equal(requests[0].id, 0);
  harness.sockets[0].receive({
    id: 128,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  assert.equal(requests.length, 128);
  assert.equal(client.state, "offline");
});

test("bounds completed approval IDs without evicting them into replay acceptance", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  let events = 0;
  client.on("server-request", () => { events += 1; });
  for (let id = 0; id < 128; id += 1) {
    harness.sockets[0].receive({
      id,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });
    client.respond(id, { decision: "decline" });
  }
  assert.equal(events, 128);
  harness.sockets[0].receive({
    id: 128,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  assert.equal(events, 128);
  assert.equal(client.state, "offline");
});

test("bounds outgoing pending requests and rejects all work at capacity", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const requests = [];
  for (let index = 0; index < 128; index += 1) {
    requests.push(client.request("model/list", { index }).then(() => null, (error) => error));
  }
  const overflow = client.request("model/list", { index: 128 }).then(() => null, (error) => error);
  assert.equal(client.state, "offline");
  const errors = await Promise.all([...requests, overflow]);
  assert.equal(errors.length, 129);
  assert.equal(errors.every((error) => error?.code === "REMOTE_REQUEST_CAPACITY"), true);
  assert.equal(harness.sockets[0].sent.length, 130);
});

test("bounds socket bufferedAmount plus the next frame before sending", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const socket = harness.sockets[0];
  const firstMessage = { id: 2, method: "model/list", params: { boundary: true } };
  const firstBytes = Buffer.byteLength(JSON.stringify(firstMessage));
  socket.bufferedAmount = 1_048_576 - firstBytes;
  const accepted = client.request("model/list", { boundary: true });
  socket.receive({ id: 2, result: { ok: true } });
  assert.deepEqual(await accepted, { ok: true });

  const secondMessage = { id: 3, method: "model/list", params: { overflow: true } };
  const secondBytes = Buffer.byteLength(JSON.stringify(secondMessage));
  socket.bufferedAmount = 1_048_576 - secondBytes + 1;
  const rejected = client.request("model/list", { overflow: true });
  await assert.rejects(rejected, { code: "REMOTE_TRANSPORT_BACKPRESSURE" });
  assert.equal(client.state, "offline");
  assert.equal(socket.sent.some(({ id }) => id === 3), false);
});

test("hostile socket accessors cannot write after synchronous terminal reentrancy", async (t) => {
  await t.test("initialize acknowledgement send getter close", async () => {
    const socket = new FakeSocket();
    const staleWire = [];
    let sendReads = 0;
    Object.defineProperty(socket, "send", {
      configurable: true,
      get() {
        sendReads += 1;
        if (sendReads === 1) return FakeSocket.prototype.send;
        socket.remoteClose();
        return (payload) => staleWire.push(String(payload));
      },
    });
    const { client } = makeClient({ sockets: [socket] });
    const ready = [];
    client.on("ready", (event) => ready.push(event));
    const starting = client.start();
    void starting.catch(() => {});
    socket.open();
    socket.receive({ id: socket.sent[0].id, result: {} });
    await assert.rejects(starting, { code: "REMOTE_TRANSPORT_CLOSED" });
    assert.deepEqual(staleWire, []);
    assert.deepEqual(ready, []);
    assert.equal(client.initialized, false);
    assert.equal(client.state, "offline");
  });

  await t.test("request send getter close rejects and clears pending work", async (subtest) => {
    const socket = new FakeSocket();
    const { client } = makeClient({ sockets: [socket] });
    subtest.after(() => client.stop());
    await startReady(client, socket);
    const staleWire = [];
    Object.defineProperty(socket, "send", {
      configurable: true,
      get() {
        socket.remoteClose();
        return (payload) => staleWire.push(String(payload));
      },
    });
    await assert.rejects(client.request("model/list", {}), { code: "REMOTE_TRANSPORT_CLOSED" });
    assert.deepEqual(staleWire, []);
    assert.equal(client.state, "offline");
  });

  await t.test("notification bufferedAmount getter error throws before a stale write", async (subtest) => {
    const socket = new FakeSocket();
    const { client } = makeClient({ sockets: [socket] });
    subtest.after(() => client.stop());
    await startReady(client, socket);
    const staleWire = [];
    Object.defineProperty(socket, "send", {
      configurable: true,
      value(payload) { staleWire.push(String(payload)); },
    });
    Object.defineProperty(socket, "bufferedAmount", {
      configurable: true,
      get() {
        socket.fail(new Error(`${PRIVATE_TOKEN} buffered getter error`));
        return 0;
      },
    });
    assert.throws(
      () => client.sendNotification("client/status", { safe: true }),
      { code: "REMOTE_TRANSPORT_ERROR", message: "Remote Codex transport failed." },
    );
    assert.deepEqual(staleWire, []);
    assert.equal(client.state, "offline");
  });

  await t.test("respond bufferedAmount getter close clears approval state", async (subtest) => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { client } = makeClient({ sockets: [first, second] });
    subtest.after(() => client.stop());
    await startReady(client, first);
    first.receive({
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });
    const staleWire = [];
    Object.defineProperty(first, "send", {
      configurable: true,
      value(payload) { staleWire.push(String(payload)); },
    });
    Object.defineProperty(first, "bufferedAmount", {
      configurable: true,
      get() {
        first.remoteClose();
        return 0;
      },
    });
    assert.throws(
      () => client.respond(0, { decision: "decline" }),
      { code: "REMOTE_TRANSPORT_CLOSED", message: "Remote Codex disconnected." },
    );
    assert.deepEqual(staleWire, []);
    await startReady(client, second);
    const requests = [];
    client.on("server-request", (message) => requests.push(message));
    second.receive({
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-2" },
    });
    assert.equal(requests.length, 1);
  });

  await t.test("send getter replacement epoch cannot write or poison a late callback", async (subtest) => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { client } = makeClient({ sockets: [first, second] });
    subtest.after(() => client.stop());
    await startReady(client, first);
    const staleWire = [];
    let staleCallback;
    let replacementStart;
    Object.defineProperty(first, "send", {
      configurable: true,
      get() {
        client.stop();
        replacementStart = client.start();
        second.open();
        second.receive({ id: second.sent[0].id, result: {} });
        return function staleSend(payload, options, callback) {
          staleWire.push(String(payload));
          staleCallback = callback;
        };
      },
    });
    assert.throws(
      () => client.sendNotification("client/status", { safe: true }),
      { code: "REMOTE_CLIENT_STOPPED", message: "Remote Codex client stopped." },
    );
    assert.deepEqual(staleWire, []);
    await replacementStart;
    staleCallback?.(new Error(`${PRIVATE_TOKEN} stale callback`));
    await waitTurn();
    assert.equal(client.state, "ready");
    assert.equal(client.initialized, true);
  });

  await t.test("throwing send and bufferedAmount getters are sanitized", async (subtest) => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { client } = makeClient({ sockets: [first, second] });
    subtest.after(() => client.stop());
    await startReady(client, first);
    Object.defineProperty(first, "send", {
      configurable: true,
      get() { throw new Error(`${PRIVATE_TOKEN} send getter`); },
    });
    await assert.rejects(client.request("model/list", {}), {
      code: "REMOTE_TRANSPORT_ERROR",
      message: "Remote Codex transport failed.",
    });

    await startReady(client, second);
    Object.defineProperty(second, "bufferedAmount", {
      configurable: true,
      get() { throw new Error(`${PRIVATE_TOKEN} buffered getter`); },
    });
    assert.throws(
      () => client.sendNotification("client/status", { safe: true }),
      { code: "REMOTE_TRANSPORT_ERROR", message: "Remote Codex transport failed." },
    );
    assert.equal(client.state, "offline");
  });

  await t.test("a getter that closes then throws preserves the established close error", async (subtest) => {
    const socket = new FakeSocket();
    const { client } = makeClient({ sockets: [socket] });
    subtest.after(() => client.stop());
    await startReady(client, socket);
    Object.defineProperty(socket, "send", {
      configurable: true,
      get() {
        socket.remoteClose();
        throw new Error(`${PRIVATE_TOKEN} close then getter throw`);
      },
    });
    assert.throws(
      () => client.sendNotification("client/status", { safe: true }),
      { code: "REMOTE_TRANSPORT_CLOSED", message: "Remote Codex disconnected." },
    );
    assert.equal(client.state, "offline");
  });

  await t.test("callback from a benign send accessor is inert after replacement", async (subtest) => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { client } = makeClient({ sockets: [first, second] });
    subtest.after(() => client.stop());
    await startReady(client, first);
    let oldCallback;
    Object.defineProperty(first, "send", {
      configurable: true,
      get() {
        return function accessorSend(payload, options, callback) {
          first.sent.push(JSON.parse(String(payload)));
          oldCallback = callback;
        };
      },
    });
    const oldRequest = client.request("model/list", {}).then(() => null, (error) => error);
    client.stop();
    assert.equal((await oldRequest).code, "REMOTE_CLIENT_STOPPED");
    await startReady(client, second);
    oldCallback(new Error(`${PRIVATE_TOKEN} late accessor callback`));
    await waitTurn();
    assert.equal(client.state, "ready");
    assert.equal(client.initialized, true);
  });
});

test("awaits ws send callbacks and cannot become ready after initialized reentrant close", async (t) => {
  const socket = new WsLikeSocket();
  socket.sendBehaviors.push((callback) => callback?.());
  socket.sendBehaviors.push((callback, active) => {
    active.remoteClose();
    callback?.();
  });
  const { client } = makeClient({ sockets: [socket] });
  t.after(() => client.stop());
  const ready = [];
  client.on("ready", (event) => ready.push(event));
  const starting = client.start();
  void starting.catch(() => {});
  socket.open();
  socket.receive({ id: 1, result: {} });
  await assert.rejects(starting, { code: "REMOTE_TRANSPORT_CLOSED" });
  assert.equal(client.initialized, false);
  assert.equal(client.state, "offline");
  assert.deepEqual(ready, []);
  assert.deepEqual(socket.sendOptions, [
    { binary: false, compress: false },
    { binary: false, compress: false },
  ]);
});

test("initialized send error reentrancy and synchronous callback failure stay offline", async (t) => {
  const cases = [
    ["socket error", (callback, socket) => { socket.fail(); callback?.(); }, "REMOTE_TRANSPORT_ERROR"],
    ["send callback error", (callback) => callback?.(new Error(`${PRIVATE_TOKEN} callback failure`)), "REMOTE_TRANSPORT_ERROR"],
  ];
  for (const [name, behavior, code] of cases) {
    await t.test(name, async () => {
      const socket = new WsLikeSocket();
      socket.sendBehaviors.push((callback) => callback?.());
      socket.sendBehaviors.push(behavior);
      const { client } = makeClient({ sockets: [socket] });
      const ready = [];
      client.on("ready", (event) => ready.push(event));
      const starting = client.start();
      void starting.catch(() => {});
      socket.open();
      socket.receive({ id: 1, result: {} });
      await assert.rejects(starting, { code });
      assert.equal(client.initialized, false);
      assert.equal(client.state, "offline");
      assert.deepEqual(ready, []);
    });
  }
});

test("an asynchronous ws send callback error terminates the request before timeout", async (t) => {
  const socket = new WsLikeSocket();
  const { client } = makeClient({ sockets: [socket] });
  t.after(() => client.stop());
  await startReady(client, socket);
  let callbackSeen = false;
  socket.sendBehaviors.push((callback) => {
    callbackSeen = typeof callback === "function";
    setImmediate(() => callback?.(new Error(`${PRIVATE_TOKEN} async send failure`)));
  });
  const request = client.request("model/list", {});
  assert.equal(callbackSeen, true);
  await assert.rejects(request, {
    code: "REMOTE_TRANSPORT_ERROR",
    message: "Remote Codex transport failed.",
  });
  assert.equal(client.state, "offline");
});

test("a stale ws send callback cannot terminate a replacement socket", async (t) => {
  const first = new WsLikeSocket();
  const second = new WsLikeSocket();
  const { client } = makeClient({ sockets: [first, second] });
  t.after(() => client.stop());
  await startReady(client, first);
  let oldCallback;
  first.sendBehaviors.push((callback) => { oldCallback = callback; });
  const oldRequest = client.request("model/list", {}).then(() => null, (error) => error);
  assert.equal(typeof oldCallback, "function");
  client.stop();
  assert.equal((await oldRequest).code, "REMOTE_CLIENT_STOPPED");
  await startReady(client, second);
  oldCallback(new Error(`${PRIVATE_TOKEN} stale callback`));
  await waitTurn();
  assert.equal(client.state, "ready");
  assert.equal(client.initialized, true);
});

test("accepts standard EventTarget MessageEvent data while rejecting hostile own accessors", async (t) => {
  const socket = new FakeEventTargetSocket();
  const { client } = makeClient({ sockets: [socket] });
  t.after(() => client.stop());
  await startReady(client, socket);
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  socket.receive({ method: "turn/started", params: { threadId: "thread-1" } });
  assert.deepEqual(notifications, [{ method: "turn/started", params: { threadId: "thread-1" } }]);
});

test("timer implementation failures are sanitized and never leave an untracked send", async (t) => {
  await t.test("start setTimeout", async () => {
    const socket = new FakeSocket();
    const { client } = makeClient({
      sockets: [socket],
      setTimeout() { throw new Error(`${PRIVATE_TOKEN} timer failure`); },
      clearTimeout() {},
    });
    const starting = client.start();
    await assert.rejects(starting, { code: "REMOTE_TIMER_ERROR", message: "Remote Codex timer failed." });
    assert.deepEqual(socket.sent, []);
    assert.equal(client.state, "offline");
  });

  await t.test("open clearTimeout", async () => {
    const socket = new FakeSocket();
    const timers = new Set();
    const { client } = makeClient({
      sockets: [socket],
      setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
      clearTimeout() { throw new Error(`${PRIVATE_TOKEN} timer failure`); },
    });
    const starting = client.start();
    void starting.catch(() => {});
    assert.doesNotThrow(() => socket.open());
    await assert.rejects(starting, { code: "REMOTE_TIMER_ERROR", message: "Remote Codex timer failed." });
    assert.deepEqual(socket.sent, []);
    assert.equal(client.state, "offline");
    assert.equal(timers.size, 1);
  });

  await t.test("request setTimeout", async () => {
    const socket = new FakeSocket();
    let calls = 0;
    const { client } = makeClient({
      sockets: [socket],
      setTimeout(callback, delay) {
        calls += 1;
        if (calls === 4) throw new Error(`${PRIVATE_TOKEN} timer failure`);
        return setTimeout(callback, delay);
      },
      clearTimeout,
    });
    t.after(() => client.stop());
    await startReady(client, socket);
    const before = socket.sent.length;
    await assert.rejects(client.request("model/list", {}), {
      code: "REMOTE_TIMER_ERROR",
      message: "Remote Codex timer failed.",
    });
    assert.equal(socket.sent.length, before);
    assert.equal(client.state, "offline");
  });

  await t.test("response clearTimeout", async () => {
    const socket = new FakeSocket();
    const timers = [];
    let clearCalls = 0;
    const { client } = makeClient({
      sockets: [socket],
      setTimeout(callback) {
        const timer = { callback, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        clearCalls += 1;
        if (clearCalls === 4) throw new Error(`${PRIVATE_TOKEN} timer failure`);
        timer.active = false;
      },
    });
    t.after(() => client.stop());
    await startReady(client, socket);
    let settlements = 0;
    const request = client.request("model/list", {}).finally(() => { settlements += 1; });
    const requestId = socket.sent.at(-1).id;
    const requestTimer = timers.at(-1);
    assert.doesNotThrow(() => socket.receive({ id: requestId, result: { ok: true } }));
    await assert.rejects(request, { code: "REMOTE_TIMER_ERROR", message: "Remote Codex timer failed." });
    assert.equal(client.state, "offline");
    assert.equal(requestTimer.active, true);
    assert.doesNotThrow(() => requestTimer.callback());
    await waitTurn();
    assert.equal(settlements, 1);
  });
});

test("rejects outbound credential shapes across every public write without consuming approvals", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const before = harness.sockets[0].sent.length;
  const secretPayloads = [
    { authorization: "Bearer unrelated-secret" },
    { nested: { authToken: "unrelated-secret" } },
    { headers: { cookie: "session=unrelated-secret" } },
    { endpointHost: "bot-01.runtime.example.com" },
    { query: "region=us-east" },
    { provider: "another-provider" },
    { privateDiagnostics: "hidden" },
  ];
  for (const payload of secretPayloads) {
    assert.throws(() => client.request("model/list", payload), /credential|secret/i);
    assert.throws(() => client.sendNotification("client/status", payload), /credential|secret/i);
  }
  assert.equal(harness.sockets[0].sent.length, before);

  harness.sockets[0].receive({
    id: 0,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  for (const payload of secretPayloads) {
    assert.throws(() => client.respond(0, payload), /credential|secret/i);
  }
  client.respond(0, {
    decision: "decline",
    tokenCount: 12,
    totalTokens: 20,
    tokenUsage: { inputTokens: 8, outputTokens: 4 },
  });
  assert.deepEqual(harness.sockets[0].sent.at(-1), {
    id: 0,
    result: {
      decision: "decline",
      tokenCount: 12,
      totalTokens: 20,
      tokenUsage: { inputTokens: 8, outputTokens: 4 },
    },
  });

  harness.sockets[0].receive({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  for (const secretMessage of [
    "Bearer unrelated-secret",
    `Failed at ${ENDPOINT}`,
    "Authorization: Basic unrelated-secret",
    "cookie=session=unrelated-secret",
  ]) {
    assert.throws(() => client.respondError(1, -32_000, secretMessage), /credential|secret/i);
  }
  client.respondError(1, -32_000, "Request declined.");
  assert.deepEqual(harness.sockets[0].sent.at(-1), {
    id: 1,
    error: { code: -32_000, message: "Request declined." },
  });
});

test("incoming sanitizer strips provider and header credentials while preserving usage metrics", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      provider: "different-provider",
      headers: { authorization: "Bearer remote-secret", cookie: "session=secret" },
      providerDiagnostics: "private",
      tokenCount: 12,
      totalTokens: 20,
      tokenUsage: { inputTokens: 8, outputTokens: 4 },
    },
  });
  assert.deepEqual(notifications, [{
    method: "turn/started",
    params: {
      threadId: "thread-1",
      tokenCount: 12,
      totalTokens: 20,
      tokenUsage: { inputTokens: 8, outputTokens: 4 },
    },
  }]);
});

test("final initialized acknowledgement is timed and supports every approved send arity", async (t) => {
  await t.test("ws arity two", async () => {
    const clock = new FakeClock();
    const socket = new WsArityTwoSocket();
    const { client } = makeClient({ sockets: [socket], clock });
    t.after(() => client.stop());
    await startReady(client, socket);
    assert.equal(socket.sendCallbacks.length, 2);
    assert.equal(socket.sendCallbacks.every((callback) => typeof callback === "function"), true);
    assert.deepEqual(clock.activeDelays(), []);
  });

  await t.test("one-argument browser send", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const { client } = makeClient({ sockets: [socket], clock });
    t.after(() => client.stop());
    await startReady(client, socket);
    assert.deepEqual(clock.activeDelays(), []);
  });

  for (const [name, socket] of [
    ["ws arity three missing callback", new WsLikeSocket()],
    ["ws arity two missing callback", new WsArityTwoSocket()],
  ]) {
    await t.test(name, async () => {
      const clock = new FakeClock();
      let finalCallback;
      socket.sendBehaviors.push((callback) => callback?.());
      socket.sendBehaviors.push((callback) => { finalCallback = callback; });
      const { client } = makeClient({ sockets: [socket], clock });
      t.after(() => client.stop());
      const starting = client.start();
      void starting.catch(() => {});
      socket.open();
      const initializeId = socket.sent[0].id;
      socket.receive({ id: initializeId, result: {} });
      await waitTurn();
      assert.equal(typeof finalCallback, "function");
      assert.deepEqual(clock.activeDelays(), [30_000]);
      clock.fireFirst(30_000);
      await assert.rejects(starting, {
        code: "REMOTE_HANDSHAKE_TIMEOUT",
        message: "Remote Codex connection timed out.",
      });
      assert.equal(client.state, "offline");
      assert.equal(client.initialized, false);
      assert.deepEqual(clock.activeDelays(), []);
    });
  }
});

test("final acknowledgement callback success, error, and stale races are generation safe", async (t) => {
  await t.test("callback success clears its timer before ready", async () => {
    const clock = new FakeClock();
    const socket = new WsLikeSocket();
    let finalCallback;
    socket.sendBehaviors.push((callback) => callback?.());
    socket.sendBehaviors.push((callback) => { finalCallback = callback; });
    const { client } = makeClient({ sockets: [socket], clock });
    t.after(() => client.stop());
    const starting = client.start();
    socket.open();
    socket.receive({ id: 1, result: {} });
    await waitTurn();
    assert.deepEqual(clock.activeDelays(), [30_000]);
    finalCallback();
    await starting;
    assert.equal(client.state, "ready");
    assert.deepEqual(clock.activeDelays(), []);
  });

  await t.test("asynchronous callback error clears its timer and rejects start", async () => {
    const clock = new FakeClock();
    const socket = new WsLikeSocket();
    socket.sendBehaviors.push((callback) => callback?.());
    socket.sendBehaviors.push((callback) => {
      setImmediate(() => callback?.(new Error(`${PRIVATE_TOKEN} async final ack failure`)));
    });
    const { client } = makeClient({ sockets: [socket], clock });
    t.after(() => client.stop());
    const starting = client.start();
    void starting.catch(() => {});
    socket.open();
    socket.receive({ id: 1, result: {} });
    await waitTurn();
    await assert.rejects(starting, {
      code: "REMOTE_TRANSPORT_ERROR",
      message: "Remote Codex transport failed.",
    });
    assert.equal(client.state, "offline");
    assert.deepEqual(clock.activeDelays(), []);
  });

  await t.test("late old callback is inert after timeout and replacement", async () => {
    const clock = new FakeClock();
    const first = new WsLikeSocket();
    const second = new WsLikeSocket();
    let oldCallback;
    first.sendBehaviors.push((callback) => callback?.());
    first.sendBehaviors.push((callback) => { oldCallback = callback; });
    const { client } = makeClient({ sockets: [first, second], clock });
    t.after(() => client.stop());
    const firstStart = client.start();
    void firstStart.catch(() => {});
    first.open();
    first.receive({ id: 1, result: {} });
    await waitTurn();
    clock.fireFirst(30_000);
    await assert.rejects(firstStart, { code: "REMOTE_HANDSHAKE_TIMEOUT" });
    await startReady(client, second);
    oldCallback(new Error(`${PRIVATE_TOKEN} stale final ack failure`));
    await waitTurn();
    assert.equal(client.state, "ready");
    assert.equal(client.initialized, true);
    assert.deepEqual(clock.activeDelays(), []);
  });
});

test("final acknowledgement timer hook failures are sanitized and tracked exactly", async (t) => {
  await t.test("setTimeout throws before initialized is sent", async () => {
    const socket = new WsLikeSocket();
    let timerCalls = 0;
    const timers = new Set();
    const { client } = makeClient({
      sockets: [socket],
      setTimeout(callback) {
        timerCalls += 1;
        if (timerCalls === 3) throw new Error(`${PRIVATE_TOKEN} final ack timer setup`);
        const timer = { callback };
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer) { timers.delete(timer); },
    });
    const starting = client.start();
    void starting.catch(() => {});
    socket.open();
    socket.receive({ id: 1, result: {} });
    await assert.rejects(starting, {
      code: "REMOTE_TIMER_ERROR",
      message: "Remote Codex timer failed.",
    });
    assert.equal(socket.sent.some(({ method }) => method === "initialized"), false);
    assert.equal(timers.size, 0);
  });

  await t.test("clearTimeout throws during callback success", async () => {
    const socket = new WsLikeSocket();
    let clearCalls = 0;
    const timers = new Set();
    const { client } = makeClient({
      sockets: [socket],
      setTimeout(callback) {
        const timer = { callback };
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer) {
        clearCalls += 1;
        if (clearCalls === 3) throw new Error(`${PRIVATE_TOKEN} final ack timer cleanup`);
        timers.delete(timer);
      },
    });
    const starting = client.start();
    void starting.catch(() => {});
    socket.open();
    socket.receive({ id: 1, result: {} });
    await assert.rejects(starting, {
      code: "REMOTE_TIMER_ERROR",
      message: "Remote Codex timer failed.",
    });
    assert.equal(client.state, "offline");
    for (const timer of timers) assert.doesNotThrow(() => timer.callback());
  });

  await t.test("timer setup reentrant close cancels the returned handle without sending", async () => {
    const socket = new WsLikeSocket();
    let timerCalls = 0;
    const timers = new Set();
    const { client } = makeClient({
      sockets: [socket],
      setTimeout(callback) {
        timerCalls += 1;
        const timer = { callback };
        timers.add(timer);
        if (timerCalls === 3) socket.remoteClose();
        return timer;
      },
      clearTimeout(timer) { timers.delete(timer); },
    });
    const starting = client.start();
    void starting.catch(() => {});
    socket.open();
    socket.receive({ id: 1, result: {} });
    await assert.rejects(starting, { code: "REMOTE_TRANSPORT_CLOSED" });
    assert.equal(socket.sent.some(({ method }) => method === "initialized"), false);
    assert.equal(timers.size, 0);
  });
});

test("secret strings are found anywhere and token-usage keys match the provider contract", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const credentialStrings = [
    "prefix sk-live_ABC123 suffix",
    "embedded sess-live_ABC123 done",
    "please use Bearer abc.def here",
    "credentials Basic Zm9vOmJhcg== trailing",
    "note Authorization: Bearer xyz",
  ];
  for (const value of credentialStrings) {
    assert.throws(() => client.request("model/list", { note: value }), /credential|secret/i);
    assert.throws(() => client.sendNotification("client/status", { note: value }), /credential|secret/i);
  }

  harness.sockets[0].receive({
    id: 0,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  for (const value of credentialStrings) {
    assert.throws(() => client.respond(0, { note: value }), /credential|secret/i);
    assert.throws(() => client.respondError(0, -32_000, value), /credential|secret/i);
  }
  client.respond(0, {
    decision: "decline",
    last_token_usage: { inputTokens: 8 },
    lastTokenUsage: { outputTokens: 4 },
    tokenUsageBreakdown: { totalTokens: 12 },
    latestEvent: "thread/tokenUsage/updated",
    note: "ordinary sketch and session notes",
    ordinaryLabels: ["Basic-reasoning", "Bearer-free", "Authorization guidance"],
  });
  assert.deepEqual(harness.sockets[0].sent.at(-1).result, {
    decision: "decline",
    last_token_usage: { inputTokens: 8 },
    lastTokenUsage: { outputTokens: 4 },
    tokenUsageBreakdown: { totalTokens: 12 },
    latestEvent: "thread/tokenUsage/updated",
    note: "ordinary sketch and session notes",
    ordinaryLabels: ["Basic-reasoning", "Bearer-free", "Authorization guidance"],
  });
  for (const key of ["accessTokenUsage", "authTokenUsage", "token", "tokens"]) {
    assert.throws(() => client.sendNotification("client/status", { [key]: 1 }), /credential|secret/i);
  }

  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({
    method: "thread/tokenUsage/updated",
    params: {
      last_token_usage: { inputTokens: 8 },
      lastTokenUsage: { outputTokens: 4 },
      tokenUsageBreakdown: { totalTokens: 12 },
      latestEvent: "thread/tokenUsage/updated",
      accessTokenUsage: "private",
      authTokenUsage: "private",
      embedded: credentialStrings,
    },
  });
  assert.deepEqual(notifications, [{
    method: "thread/tokenUsage/updated",
    params: {
      last_token_usage: { inputTokens: 8 },
      lastTokenUsage: { outputTokens: 4 },
      tokenUsageBreakdown: { totalTokens: 12 },
      latestEvent: "thread/tokenUsage/updated",
      embedded: credentialStrings.map(() => "<redacted>"),
    },
  }]);
});

test("credential string matching catches explicit secrets without treating ordinary Basic or Bearer prose as private", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const mustDetect = [
    "prefix access_token=abc suffix",
    "punctuation (ACCESS-TOKEN: abc123), suffix",
    "prefix refresh_token = abc.def suffix",
    "prefix id-token='abc_123' suffix",
    "prefix auth_token=abc123 suffix",
    "prefix session-token = \"abc123\" suffix",
    "prefix password=hunter2 suffix",
    "metadata Cookie: session=abc suffix",
    "metadata X-Api-Key: abc suffix",
    "metadata Authorization: Basic Zm9vOmJhcg== suffix",
    "prefix Bearer unrelated-secret suffix",
    "embedded sk-live_ABC123 done",
    "embedded sess-live_ABC123 done",
    "line one\nReFrEsH_ToKeN=abc123\nline three",
    "before\u0000access_token=abc\u0000after",
  ];
  const ordinary = [
    "ordinary basic reasoning request",
    "ordinary bearer instrument note",
    "basic model capability",
    "bearer instrument",
    "Basic-reasoning remains a model label",
    "Authorization guidance without a credential",
  ];

  for (const value of mustDetect) {
    assert.throws(() => client.request("model/list", { note: value }), /credential|secret/i);
    assert.throws(() => client.sendNotification("client/status", { note: value }), /credential|secret/i);
  }
  for (const value of ordinary) {
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: value }));
  }

  harness.sockets[0].receive({
    id: 0,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  });
  for (const value of mustDetect) {
    assert.throws(() => client.respond(0, { note: value }), /credential|secret/i);
    assert.throws(
      () => client.respondError(0, -32_000, value),
      /[\u0000\r\n]/.test(value) ? /invalid/i : /credential|secret/i,
    );
  }
  client.respond(0, { decision: "decline", ordinary });
  assert.deepEqual(harness.sockets[0].sent.at(-1).result, { decision: "decline", ordinary });

  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({
    method: "thread/tokenUsage/updated",
    params: {
      detected: mustDetect,
      ordinary,
      last_token_usage: { inputTokens: 8 },
      tokenUsageBreakdown: { outputTokens: 4, totalTokens: 12 },
    },
  });
  assert.deepEqual(notifications, [{
    method: "thread/tokenUsage/updated",
    params: {
      detected: mustDetect.map(() => "<redacted>"),
      ordinary,
      last_token_usage: { inputTokens: 8 },
      tokenUsageBreakdown: { outputTokens: 4, totalTokens: 12 },
    },
  }]);

  const boundedOrdinary = `${"ordinary prose ".repeat(4_000)}basic reasoning request`;
  assert.doesNotThrow(() => client.sendNotification("client/status", { note: boundedOrdinary }));
});

test("credential matching follows deterministic canonical schemes, assignments, and exact usage keys", async (t) => {
  const credentialStrings = [
    ["canonical Bearer with alphabetic value", "prefix Bearer abcdef suffix"],
    ["canonical Basic with alphabetic base64", "prefix Basic dXNlcjpwYXNz suffix"],
    ["bare token assignment", "prefix token=abc123 suffix"],
    ["bare tokens assignment", "prefix tokens: abc123 suffix"],
    ["URL token query", "https://runtime.example.invalid/log?token=abc123&mode=brief"],
    ["JSON quoted access token", '{"access_token": "abc123"}'],
    ["single-quoted access token", "log {'access_token': 'abc123'} done"],
    ["backtick access token", "log `access_token`=`abc123` done"],
    ["punctuated ID token", "prefix ('ID-TOKEN'): 'abc123' suffix"],
    ["punctuated refresh token", "prefix [`refresh_token`]=`abc123` suffix"],
    ["mixed-case auth token", 'prefix "AuTh_ToKeN" = "abc123" suffix'],
    ["punctuated session token", "prefix (session-token): abc123 suffix"],
    ["password assignment", "prefix PASSWORD=hunter2 suffix"],
    ["cookie assignment", "prefix cookie = session123 suffix"],
    ["API key assignment", "prefix 'Api-Key': 'abc123' suffix"],
    ["case-insensitive Authorization header", "metadata aUtHoRiZaTiOn: basic abcdef"],
    ["case-insensitive Cookie header", "metadata cOoKiE: session=abc123"],
    ["case-insensitive API key header", "metadata X-aPi-KeY: abc123"],
    ["CRLF quoted assignment", "line one\r\n{\"refresh_token\":\"abc123\"}\r\nline three"],
    ["NUL assignment boundary", "before\u0000`session_token`=`abc123`\u0000after"],
  ];

  for (const [label, value] of credentialStrings) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note: value }), /credential|secret/i);

      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note: value } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { note: "<redacted>" } }]);
    });
  }

  const ordinaryStrings = [
    "basic gpt-5.6 model",
    "bearer long-standing tradition",
    "basic model-configuration choice",
    "ordinary basic reasoning request",
    "ordinary bearer instrument note",
    "basic model capability",
    "bearer instrument",
    "Basic-reasoning remains a model label",
    "Authorization guidance without a credential",
  ];
  await t.test("allows and preserves lowercase scheme prose", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    for (const value of ordinaryStrings) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note: value }));
    }
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { ordinaryStrings } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { ordinaryStrings } }]);
  });

  await t.test("keeps long scans bounded and finds a credential at the end", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const longOrdinary = `${"ordinary lowercase prose. ".repeat(2_500)}basic gpt-5.6 model`;
    const tailValue = `${longOrdinary}\r\n\u0000{\"token\":\"abc123\"}`;
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: longOrdinary }));
    assert.throws(() => client.sendNotification("client/status", { note: tailValue }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { longOrdinary, tailValue } });
    assert.equal(notifications[0].params.longOrdinary, longOrdinary);
    assert.equal(notifications[0].params.tailValue, "<redacted>");
  });

  const forbiddenUsageKeys = [
    "idTokenUsage",
    "csrfTokenUsage",
    "privateTokenUsage",
    "accessTokenUsage",
    "authTokenUsage",
    "refreshTokenUsage",
    "bearerTokenUsage",
    "sessionTokenUsage",
    "apiTokenUsage",
    "secretTokenUsage",
    "credentialTokenUsage",
    "evilTokenUsage",
  ];
  for (const key of forbiddenUsageKeys) {
    await t.test(`rejects and strips ${key}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { [key]: 1 }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { safe: true, [key]: 1 } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { safe: true } }]);
    });
  }

  await t.test("allows only approved token-usage metrics and still scans their values recursively", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const approvedMetrics = {
      tokenUsage: { inputTokens: 8, outputTokens: 4 },
      last_token_usage: { reasoningTokens: 2 },
      lastTokenUsage: { cachedInputTokens: 3 },
      tokenUsageBreakdown: { totalTokens: 17, maxOutputTokens: 9 },
      tokenCount: 17,
      totalTokens: 17,
      lifetimeTokens: 9000,
    };
    assert.doesNotThrow(() => client.sendNotification("client/status", approvedMetrics));
    assert.throws(
      () => client.sendNotification("client/status", { tokenUsage: { note: "Bearer abcdef" } }),
      /credential|secret/i,
    );
    assert.throws(
      () => client.sendNotification("client/status", { tokenUsage: { accessToken: "abc123" } }),
      /credential|secret/i,
    );

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({
      method: "thread/tokenUsage/updated",
      params: {
        approvedMetrics,
        tokenUsage: {
          inputTokens: 8,
          note: "Bearer abcdef",
          accessToken: "abc123",
        },
      },
    });
    assert.deepEqual(notifications, [{
      method: "thread/tokenUsage/updated",
      params: {
        approvedMetrics,
        tokenUsage: { inputTokens: 8, note: "<redacted>" },
      },
    }]);
  });
});

test("deterministic scanners keep string and object credential policy in parity at bounded scale", async (t) => {
  const stringVectors = [
    ["backtick Bearer", "prefix Bearer `abc123` suffix"],
    ["backtick Basic", "prefix Basic `dXNlcjpwYXNz` suffix"],
    ["camel-case CSRF token", "prefix csrfToken=abc123 suffix"],
    ["separated private token", "prefix private_token: abc123 suffix"],
    ["separated secret token", "prefix secret-token='abc123' suffix"],
    ["quoted credential token", "prefix `credentialToken`=`abc123` suffix"],
    ["OAuth token", "prefix oauthToken = abc123 suffix"],
    ["unclosed quoted key", 'prefix "accessToken=abc123 suffix'],
    ["mismatched quoted key", "prefix 'refreshToken\"=abc123 suffix"],
  ];
  for (const [label, value] of stringVectors) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note: value }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note: value } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { note: "<redacted>" } }]);
    });
  }

  await t.test("uses the same secret-key policy for string assignments and object keys", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const keys = ["csrfToken", "privateToken", "secretToken", "credentialToken", "oauthToken"];
    for (const key of keys) {
      assert.throws(() => client.sendNotification("client/status", { [key]: "abc123" }), /credential|secret/i);
    }
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({
      method: "client/status",
      params: Object.fromEntries([["safe", true], ...keys.map((key) => [key, "abc123"])]),
    });
    assert.deepEqual(notifications, [{ method: "client/status", params: { safe: true } }]);
  });

  await t.test("scales near-linearly across whitespace and repeated near misses", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const sizes = [1_000, 10_000, 40_000, 250_000, 900_000];

    const measure = (value, shouldReject) => {
      const sentBefore = harness.sockets[0].sent.length;
      const started = process.hrtime.bigint();
      let rejected = false;
      try {
        client.sendNotification("client/status", { note: value });
      } catch (error) {
        assert.match(error.message, /credential|secret/i);
        rejected = true;
      }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(rejected, shouldReject);
      harness.sockets[0].sent.splice(sentBefore);
      return elapsedMs;
    };

    for (const size of sizes) {
      const ordinary = `token${" ".repeat(size)}ordinary`;
      const nearMissUnit = "csrfTokex=abc privateTokex=def oauthTokex=ghi ";
      const nearMiss = nearMissUnit.repeat(Math.ceil(size / nearMissUnit.length)).slice(0, size);
      const credentialAtEnd = `${"ordinary ".repeat(Math.ceil(size / 9)).slice(0, size)}oauthToken=abc123`;
      const observed = [
        measure(ordinary, false),
        measure(nearMiss, false),
        measure(credentialAtEnd, true),
      ];
      const absoluteLimitMs = 250 + (size / 2_000);
      for (const elapsedMs of observed) {
        assert.ok(elapsedMs < absoluteLimitMs, `${size}-byte scan took ${elapsedMs.toFixed(1)}ms`);
      }
    }
  });
});

test("nested assignments and non-ASCII key tails cannot bypass object-key credential policy", async (t) => {
  const nestedLeaks = [
    ["password", "safe=password=hunter2"],
    ["cookie", "safe=cookie=session123"],
    ["secret", "safe=secret=abc123"],
    ["credential", "safe=credential=abc123"],
    ["session", "safe=session=abc123"],
    ["API key", "safe=apiKey=abc123"],
    ["token", "safe=token=abc123"],
    ["quoted outer and value", "`safe`=`password=hunter2`"],
    ["single-quoted outer and value", "'safe'='cookie=session123'"],
    ["token-usage outer", "tokenUsage=password=hunter2"],
    ["multi-level safe outer", "safe=safe=password=hunter2"],
  ];
  for (const [label, value] of nestedLeaks) {
    await t.test(`rejects and redacts nested ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note: value }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note: value } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { note: "<redacted>" } }]);
    });
  }

  await t.test("keeps plain session assignment and object-key policy in parity", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    assert.throws(() => client.sendNotification("client/status", { session: "abc123" }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { safe: true, session: "abc123" } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { safe: true } }]);
  });

  const nonAsciiKeys = [
    ["Latin suffix", "accessTokené"],
    ["quoted Latin suffix", "accessTokené"],
    ["zero-width suffix", "accessToken\u200B"],
    ["NUL token suffix", "accessToken\u0000"],
    ["NUL password suffix", "password\u0000"],
    ["combining-mark suffix", "accessToken\u0301"],
  ];
  for (const [label, key] of nonAsciiKeys) {
    await t.test(`keeps string and object parity for ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      const quoted = label.startsWith("quoted") ? `\`${key}\`=\`abc123\`` : `${key}=abc123`;
      assert.throws(() => client.sendNotification("client/status", { note: quoted }), /credential|secret/i);
      assert.throws(() => client.sendNotification("client/status", { [key]: "abc123" }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note: quoted, safe: true, [key]: "abc123" } });
      assert.deepEqual(notifications, [{
        method: "client/status",
        params: { note: "<redacted>", safe: true },
      }]);
    });
  }

  await t.test("preserves ordinary Unicode prose and normalized usage allowlist keys", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const ordinary = [
      "résumé café 你好 — ordinary",
      "ordinary\u200Bprose with a zero-width join",
      "tokenUsage\u00A0ordinary",
      "tokenUsage = 12",
      "tokenUsageBreakdown:\u200912",
    ];
    for (const note of ordinary) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }
    assert.doesNotThrow(() => client.sendNotification("client/status", {
      "tokenUsageé": { inputTokens: 8 },
      "lastTokenUsage\u0301": { outputTokens: 4 },
    }));
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { ordinary } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { ordinary } }]);
  });

  await t.test("handles ten-thousand nested assignments and a 900 KB near miss in bounded time", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const deeplyNested = `${"safe=".repeat(10_000)}password=hunter2`;
    const nearMissUnit = "accessTokemé=abc tokenUsageé=12 ordinary\u200Btext ";
    const nearMiss = nearMissUnit.repeat(Math.ceil(900_000 / nearMissUnit.length)).slice(0, 900_000);
    const started = process.hrtime.bigint();
    assert.throws(() => client.sendNotification("client/status", { note: deeplyNested }), /credential|secret/i);
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `deep and near-miss scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("quoted assignment keys decode to the same credential policy as object keys", async (t) => {
  const vectors = [
    ["space-split password", 'prefix "pass word"="abc123" suffix', "pass word"],
    ["dot-split password", 'prefix "pass.word":"abc123" suffix', "pass.word"],
    ["space-split API key", "prefix 'api key'='abc123' suffix", "api key"],
    ["dot-split API key", "prefix `api.key`=`abc123` suffix", "api.key"],
    ["split cookie", 'prefix "coo kie"="abc123" suffix', "coo kie"],
    ["split credential", 'prefix "cre.den_tial"="abc123" suffix', "cre.den_tial"],
    ["split diagnostic", 'prefix "diag nostic"="abc123" suffix', "diag nostic"],
    ["NBSP password", `prefix "pass\u00a0word"="abc123" suffix`, "pass\u00a0word"],
    ["em-space API key", `prefix "api\u2003key"="abc123" suffix`, "api\u2003key"],
    ["zero-width access token", `prefix "access\u200bToken"="abc123" suffix`, "access\u200bToken"],
    ["NUL password", `prefix "pass\u0000word"="abc123" suffix`, "pass\u0000word"],
    ["JSON Unicode escape", String.raw`prefix "pass\u0077ord"="abc123" suffix`, "password"],
    ["JSON access-token escape", String.raw`prefix "access\u0054oken"="abc123" suffix`, "accessToken"],
    ["braced Unicode escape", String.raw`prefix "api\u{004b}ey"="abc123" suffix`, "apiKey"],
    ["hex escape", String.raw`prefix "pass\x77ord"="abc123" suffix`, "password"],
    ["escaped quote", String.raw`prefix "pass\"word"="abc123" suffix`, 'pass"word'],
    ["escaped backslash", String.raw`prefix "api\\key"="abc123" suffix`, "api\\key"],
    ["escaped slash", String.raw`prefix "api\/key"="abc123" suffix`, "api/key"],
    ["JSON backspace escape", String.raw`prefix "pass\bword"="abc123" suffix`, "pass\bword"],
    ["JSON form-feed escape", String.raw`prefix "pass\fword"="abc123" suffix`, "pass\fword"],
    ["JSON newline escape", String.raw`prefix "pass\nword"="abc123" suffix`, "pass\nword"],
    ["JSON carriage-return escape", String.raw`prefix "pass\rword"="abc123" suffix`, "pass\rword"],
    ["JSON tab API key escape", String.raw`prefix "api\tkey"="abc123" suffix`, "api\tkey"],
    ["JSON newline cookie escape", String.raw`prefix "coo\nkie"="abc123" suffix`, "coo\nkie"],
    ["JSON tab credential escape", String.raw`prefix "creden\ttial"="abc123" suffix`, "creden\ttial"],
    ["JSON newline diagnostic escape", String.raw`prefix "diag\nnostic"="abc123" suffix`, "diag\nnostic"],
    ["escaped cookie", String.raw`prefix "coo\u006bie"="abc123" suffix`, "cookie"],
    ["escaped credential", String.raw`prefix "cre\u0064ential"="abc123" suffix`, "credential"],
    ["escaped diagnostic", String.raw`prefix "diag\u006eostic"="abc123" suffix`, "diagnostic"],
  ];
  for (const [label, value, objectKey] of vectors) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note: value }), /credential|secret/i);
      assert.throws(() => client.sendNotification("client/status", { [objectKey]: "abc123" }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note: value, safe: true, [objectKey]: "abc123" } });
      assert.deepEqual(notifications, [{
        method: "client/status",
        params: { note: "<redacted>", safe: true },
      }]);
    });
  }

  await t.test("preserves ordinary quoted prose and still scans a non-secret quoted value", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const ordinary = [
      '"ordinary quoted prose"',
      '"ordinary key"="ordinary value"',
      String.raw`"ordinary\u0020label"="ordinary value"`,
      "`ordinary.key`=`ordinary value`",
    ];
    for (const note of ordinary) assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    assert.throws(
      () => client.sendNotification("client/status", { note: '"ordinary key"="password=hunter2"' }),
      /credential|secret/i,
    );
    const quotedAssignmentProse = [
      '"ordinary password=hunter2 prose"',
      "don't hide password=hunter2 but don't",
    ];
    for (const note of quotedAssignmentProse) {
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
    }
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { ordinary, quotedAssignmentProse } });
    assert.deepEqual(notifications, [{
      method: "client/status",
      params: { ordinary, quotedAssignmentProse: ["<redacted>", "<redacted>"] },
    }]);
  });

  await t.test("preserves ordinary assignments after unmatched prose quotes", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unmatchedOrdinary = [
      "don't set mode=fast",
      "the user's choice is model=gpt-5.6",
      "we'll use temperature=high",
      'unclosed " ordinary label=preview mode=fast',
      "unclosed ` ordinary label=preview mode=fast",
    ];
    for (const note of unmatchedOrdinary) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { unmatchedOrdinary } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { unmatchedOrdinary } }]);
  });

  await t.test("still rejects secret assignments inside and after unmatched prose quotes", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unmatchedAssignmentLeaks = [
      "don't share password=abc",
      "unclosed ` prose token=abc",
      'unmatched " password=abc',
    ];
    for (const note of unmatchedAssignmentLeaks) {
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
    }
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { unmatchedAssignmentLeaks } });
    assert.deepEqual(notifications, [{
      method: "client/status",
      params: { unmatchedAssignmentLeaks: ["<redacted>", "<redacted>", "<redacted>"] },
    }]);
  });

  await t.test("keeps a near-max unmatched-prose scan bounded and finds its credential tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = "ordinary label=preview mode=fast; ";
    const nearMiss = `unclosed " ${unit.repeat(Math.ceil(899_000 / unit.length))}`.slice(0, 899_000);
    const leakAtEnd = `${nearMiss} password=abc123`;
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
    harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
    assert.deepEqual(notifications, [
      { method: "client/status", params: { note: nearMiss } },
      { method: "client/status", params: { note: "<redacted>" } },
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `unmatched near-max scans took ${elapsedMs.toFixed(1)}ms`);
  });

  await t.test("handles a 900 KB quoted near miss and credential tail within an absolute bound", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = '"ordinary key"="ordinary value" ';
    const nearMiss = unit.repeat(Math.ceil(899_000 / unit.length)).slice(0, 899_000);
    const credentialTail = `${nearMiss}"pass\\u0077ord"="abc123"`;
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: credentialTail }), /credential|secret/i);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `quoted near-max scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("backslash-escaped outer delimiters preserve credential policy and ordinary logs", async (t) => {
  const escapedLeaks = [
    ["double-quoted password", String.raw`\"password\"=\"abc\"`, "password"],
    ["double-quoted access token", String.raw`\"access_token\"=\"abc\"`, "access_token"],
    ["single-quoted password", String.raw`\'password\'=\'abc\'`, "password"],
    ["backtick password", "\\`password\\`=\\`abc\\`", "password"],
    ["spaced colon access token", String.raw`prefix \"access_token\" : \"abc\" suffix`, "access_token"],
    ["nested after safe assignments", String.raw`safe=mode=fast note=\"password\"=\"abc\"`, "password"],
    ["uppercase punctuated password", String.raw`\"PASS.WORD\"=\"abc\"`, "PASS.WORD"],
    ["zero-width access token", `\\"access\u200bToken\\"=\\"abc\\"`, "access\u200bToken"],
    ["NUL password", `\\"pass\u0000word\\"=\\"abc\\"`, "pass\u0000word"],
    ["short-escaped password", String.raw`\"pass\nword\"=\"abc\"`, "pass\nword"],
    ["credential after unmatched escaped delimiter", String.raw`prefix \" ordinary mode=fast password=abc`, "password"],
  ];
  for (const [label, note, objectKey] of escapedLeaks) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      assert.throws(() => client.sendNotification("client/status", { [objectKey]: "abc" }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note, safe: true, [objectKey]: "abc" } });
      assert.deepEqual(notifications, [{
        method: "client/status",
        params: { note: "<redacted>", safe: true },
      }]);
    });
  }

  await t.test("preserves escaped nonsecret fields and ordinary prose", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const escapedOrdinary = [
      String.raw`\"mode\"=\"fast\"`,
      String.raw`\"model\"=\"gpt-5.6\"`,
      String.raw`\'temperature\' : \'high\'`,
      "\\`label\\`=\\`preview\\`",
      String.raw`\"tokenUsage\"=\"12\"`,
      String.raw`safe=mode=fast log=\"ordinary\"`,
      String.raw`ordinary prose with \"quoted words\"`,
      String.raw`unmatched \" ordinary label=preview mode=fast`,
    ];
    const allowedObject = {
      mode: "fast",
      model: "gpt-5.6",
      temperature: "high",
      label: "preview",
      tokenUsage: { inputTokens: 12 },
    };
    for (const note of escapedOrdinary) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }
    assert.doesNotThrow(() => client.sendNotification("client/status", allowedObject));
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { escapedOrdinary, allowedObject } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { escapedOrdinary, allowedObject } }]);
  });

  await t.test("keeps near-max escaped fields bounded and finds an escaped credential tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = String.raw`\"mode\"=\"fast\" `;
    const nearMiss = unit.repeat(Math.ceil(700_000 / unit.length)).slice(0, 700_000);
    const leakAtEnd = `${nearMiss}${String.raw` \"password\"=\"abc\"`}`;
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
    harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
    assert.deepEqual(notifications, [
      { method: "client/status", params: { note: nearMiss } },
      { method: "client/status", params: { note: "<redacted>" } },
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `escaped near-max scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("mixed raw and escaped delimiter tokens close keys only at assignment boundaries", async (t) => {
  const styles = [
    { name: "double", raw: '"', escaped: '\\"' },
    { name: "single", raw: "'", escaped: "\\'" },
    { name: "backtick", raw: "`", escaped: "\\`" },
  ];
  const pairs = [];
  for (const open of styles) {
    for (const close of styles) {
      pairs.push([`escaped ${open.name} to escaped ${close.name}`, open.escaped, close.escaped]);
      pairs.push([`raw ${open.name} to escaped ${close.name}`, open.raw, close.escaped]);
      pairs.push([`escaped ${open.name} to raw ${close.name}`, open.escaped, close.raw]);
      if (open.name !== close.name) pairs.push([`raw ${open.name} to raw ${close.name}`, open.raw, close.raw]);
    }
  }

  for (const [label, open, close] of pairs) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      const note = `prefix ${open}password${close}=abc suffix`;
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { note: "<redacted>" } }]);
    });
  }

  const escapedDouble = '\\"';
  const escapedSingle = "\\'";
  const escapedBacktick = "\\`";
  const variants = [
    ["wrapper and spaced colon", `${escapedDouble}access_token' ] : abc`],
    ["spaced equals", `"PASSWORD${escapedBacktick}   = abc`],
    ["nested after safe assignments", `safe=mode=fast note=${escapedSingle}password"=abc`],
    ["embedded escaped quote in secret key", `${escapedDouble}pass${escapedDouble}word${escapedSingle}=abc`],
  ];
  for (const [label, note] of variants) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { note: "<redacted>" } }]);
    });
  }

  await t.test("preserves embedded quote tokens and prose without assignment lookahead", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const ordinary = [
      `${escapedDouble}display${escapedDouble}name${escapedSingle}=ordinary`,
      `${escapedDouble}display'name${escapedSingle}=ordinary`,
      `"display${escapedSingle}name"=ordinary`,
      `ordinary ${escapedDouble}quoted' prose without assignment`,
      `don't call it "mode" in prose`,
      `code field ${escapedBacktick}model' remains ordinary prose`,
    ];
    for (const note of ordinary) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { ordinary } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { ordinary } }]);
  });

  await t.test("keeps a near-limit mixed-delimiter scan linear and finds its secret tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = `${escapedDouble}mode'=fast `;
    const nearMiss = unit.repeat(Math.ceil(850_000 / unit.length)).slice(0, 850_000);
    const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: nearMiss } }));
    assert.ok(encodedBytes > 950_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
    const leakAtEnd = `${nearMiss} ${escapedDouble}password${escapedSingle}=abc`;
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
    harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
    assert.deepEqual(notifications, [
      { method: "client/status", params: { note: nearMiss } },
      { method: "client/status", params: { note: "<redacted>" } },
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `mixed near-limit scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("escaped separators and arbitrary wrapper chains preserve assignment policy", async (t) => {
  const vectors = [
    ["unquoted escaped equals", String.raw`password\=abc`, "password"],
    ["unquoted escaped colon", String.raw`password\:abc`, "password"],
    ["raw quoted escaped equals", String.raw`"password"\=abc`, "password"],
    ["escaped quoted escaped colon", String.raw`\"password\"\:abc`, "password"],
    ["raw wrapper chain", String.raw`"password" }) ] } = abc`, "password"],
    ["escaped mixed wrapper chain", String.raw`\"access_token' }) ] } \= abc`, "access_token"],
    ["unquoted wrapper chain", String.raw`password } ) ] } \: abc`, "password"],
    ["nested escaped assignment", String.raw`safe=mode\=fast note=\"password' } ] ) \=abc`, "password"],
  ];
  for (const [label, note, objectKey] of vectors) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      assert.throws(() => client.sendNotification("client/status", { [objectKey]: "abc" }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note, safe: true, [objectKey]: "abc" } });
      assert.deepEqual(notifications, [{
        method: "client/status",
        params: { note: "<redacted>", safe: true },
      }]);
    });
  }

  await t.test("preserves ordinary escaped separators wrappers quotes and usage metrics", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const ordinary = [
      String.raw`mode\=fast`,
      String.raw`model } ) ] } \: gpt-5.6`,
      String.raw`"temperature" }) ] } \= high`,
      String.raw`\"label' } ] ) : preview`,
      String.raw`\"tokenUsage\" }) ] } \: 12`,
      String.raw`ordinary "quoted' prose }) ] } without assignment`,
      String.raw`separators \= \: and wrappers }) ] } in prose`,
    ];
    const allowedObject = {
      mode: "fast",
      model: "gpt-5.6",
      temperature: "high",
      label: "preview",
      tokenUsage: { totalTokens: 12 },
    };
    for (const note of ordinary) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }
    assert.doesNotThrow(() => client.sendNotification("client/status", allowedObject));
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { ordinary, allowedObject } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { ordinary, allowedObject } }]);
  });
});

test("quote-dense scanner growth remains bounded", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const sizes = [1_000, 2_000, 4_000, 16_000];
  const medians = [];
  for (const size of sizes) {
    const samples = [];
    const note = '"'.repeat(size);
    for (let run = 0; run < 3; run += 1) {
      const sentBefore = harness.sockets[0].sent.length;
      const started = process.hrtime.bigint();
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      harness.sockets[0].sent.splice(sentBefore);
    }
    samples.sort((left, right) => left - right);
    medians.push(samples[1]);
  }
  assert.ok(medians[3] < 250, `16KB quote scan took ${medians[3].toFixed(1)}ms`);
  assert.ok(
    medians[3] < 100 + (medians[2] * 8),
    `quote growth ${medians[2].toFixed(1)}ms -> ${medians[3].toFixed(1)}ms exceeded bound`,
  );
});

test("quote-dense near-cap input remains bounded", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const note = '"'.repeat(490_000);
  const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note } }));
  assert.ok(encodedBytes > 950_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
  const started = process.hrtime.bigint();
  assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({ method: "client/status", params: { note } });
  assert.deepEqual(notifications, [{ method: "client/status", params: { note } }]);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1_500, `quote-dense near-cap scans took ${elapsedMs.toFixed(1)}ms`);
});

test("separator wrapper and near-miss dense input finds only a secret tail", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const unit = String.raw`passworx\=abc accessTokem }) ] } \: abc mode\=fast `;
  const nearMiss = unit.repeat(Math.ceil(900_000 / unit.length)).slice(0, 900_000);
  const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: nearMiss } }));
  assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
  const leakAtEnd = `${nearMiss}${String.raw` password }) ] } \=abc`}`;
  const started = process.hrtime.bigint();
  assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
  assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
  harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
  assert.deepEqual(notifications, [
    { method: "client/status", params: { note: nearMiss } },
    { method: "client/status", params: { note: "<redacted>" } },
  ]);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1_500, `separator/wrapper near-cap scans took ${elapsedMs.toFixed(1)}ms`);
});

test("assignment scanning uses only the local field context after stale quotes", async (t) => {
  const staleContextLeaks = [
    '"ordinary "session"=abc',
    '"ordinary "search"=abc',
    '"ordinary" note "session"=abc',
    String.raw`\"ordinary \"session\"\=abc`,
    String.raw`\"ordinary\" note \"search\"\:abc`,
  ];
  const localUsageMetrics = [
    '"ordinary "tokenUsage"=12',
    '"ordinary "inputTokens"=8',
    '"ordinary" note "tokenUsage"=12',
    String.raw`\"ordinary \"inputTokens\"\=8`,
  ];
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);

  for (const note of staleContextLeaks) {
    assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
  }
  for (const note of localUsageMetrics) {
    assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
  }
  assert.doesNotThrow(() => client.sendNotification("client/status", {
    tokenUsage: { inputTokens: 8 },
    inputTokens: 8,
  }));

  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({
    method: "client/status",
    params: {
      staleContextLeaks,
      localUsageMetrics,
      tokenUsage: { inputTokens: 8 },
      inputTokens: 8,
    },
  });
  assert.deepEqual(notifications, [{
    method: "client/status",
    params: {
      staleContextLeaks: staleContextLeaks.map(() => "<redacted>"),
      localUsageMetrics,
      tokenUsage: { inputTokens: 8 },
      inputTokens: 8,
    },
  }]);
});

test("encoded structural tokens preserve credential and usage policy", async (t) => {
  const encodedLeaks = [
    String.raw`\u0022password\u0022\u003dabc`,
    String.raw`\u0027access_token\u0027\u003aabc`,
    String.raw`\x60session\x60\x3dabc`,
    String.raw`\u{22}password\u{27}\u{3d}abc`,
    String.raw`"password"\u003dabc`,
    String.raw`mode\u003dfast\u0020password\u003dabc`,
    String.raw`\u0022mode\u0022\u003dfast \u0022session\u0022\u003aabc`,
    String.raw`Basic\u0020dXNlcjpwYXNz`,
    String.raw`Bearer\x20abcdef`,
    String.raw`Bearer\tabc123`,
    PRIVATE_TOKEN.replace("-", String.raw`\u002d`),
    ENDPOINT.replace(":", String.raw`\u003a`),
  ];
  const encodedUsageMetrics = [
    String.raw`\u0022tokenUsage\u0022\u003a12`,
    String.raw`\u0022inputTokens\u0022\x3d8`,
    String.raw`\u{22}tokenUsageBreakdown\u{27}\u{3a}12`,
  ];
  const malformedOrdinary = [
    String.raw`\u002 mode=fast`,
    String.raw`\u00000022mode\u003dfast`,
    String.raw`\u{110000} mode=fast`,
    String.raw`\u{00000022} mode=fast`,
    String.raw`\x2 mode=fast`,
    String.raw`literal \u002X and \xG1 prose`,
    String.raw`Basic\u002X ordinary`,
    String.raw`ordinary C:\users\name literal backslash prose`,
    String.raw`\\u0022mode\\u0022\\u003dfast`,
  ];
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);

  for (const note of encodedLeaks) {
    assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
  }
  for (const note of [...encodedUsageMetrics, ...malformedOrdinary]) {
    assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
  }
  assert.throws(() => client.sendNotification("client/status", { password: "abc" }), /credential|secret/i);
  assert.doesNotThrow(() => client.sendNotification("client/status", {
    tokenUsage: { inputTokens: 8 },
    inputTokens: 8,
  }));

  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({
    method: "client/status",
    params: {
      encodedLeaks,
      encodedUsageMetrics,
      malformedOrdinary,
      password: "abc",
      tokenUsage: { inputTokens: 8 },
      inputTokens: 8,
    },
  });
  assert.deepEqual(notifications, [{
    method: "client/status",
    params: {
      encodedLeaks: encodedLeaks.map(() => "<redacted>"),
      encodedUsageMetrics,
      malformedOrdinary,
      tokenUsage: { inputTokens: 8 },
      inputTokens: 8,
    },
  }]);
});

test("canonical structural stream stays bounded under dense malformed input", async (t) => {
  const { client, harness } = makeClient();
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const unit = String.raw`\u0022mode\u0022})]}\u003dfast \u00ZZ \xG1 \u{00000022} `;
  const nearMiss = unit.repeat(Math.ceil(850_000 / unit.length)).slice(0, 850_000);
  const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: nearMiss } }));
  assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
  const leakAtEnd = `${nearMiss}${String.raw` \u0022password\u0022})]}\u003dabc`}`;
  const started = process.hrtime.bigint();
  assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
  assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
  harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
  assert.deepEqual(notifications, [
    { method: "client/status", params: { note: nearMiss } },
    { method: "client/status", params: { note: "<redacted>" } },
  ]);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1_500, `canonical near-cap scans took ${elapsedMs.toFixed(1)}ms`);
});

test("raw and canonical session secrets are both rejected before publication", async (t) => {
  const rawToken = String.raw`opaque\u002dprivate\x2dvalue`;
  const canonicalToken = "opaque-private-value";
  const rawEndpoint = String.raw`wss://bot-01.runtime.example.com/app-server?opaque=private\u002dquery\x2dpart`;
  const rawSearch = String.raw`?opaque=private\u002dquery\x2dpart`;
  const rawQuery = rawSearch.slice(1);
  const canonicalSearch = "?opaque=private-query-part";
  const canonicalQuery = canonicalSearch.slice(1);
  const rawLeaks = [
    rawToken,
    `prefix ${rawToken} suffix`,
    `\u0000${rawToken}\u0008`,
    rawEndpoint,
    rawSearch,
    rawQuery,
  ];
  const canonicalLeaks = [
    canonicalToken,
    `prefix ${canonicalToken} suffix`,
    canonicalSearch,
    canonicalQuery,
  ];
  const ordinary = [
    "opaque but unrelated prose",
    "private value discussion",
    "ordinary model token usage",
  ];
  const { client, harness } = makeClient({
    privateSession: session({ endpoint: rawEndpoint, authToken: rawToken }),
  });
  t.after(() => client.stop());
  await startReady(client, harness.sockets[0]);
  const sentBefore = harness.sockets[0].sent.length;
  const thrown = [];

  for (const note of [...rawLeaks, ...canonicalLeaks]) {
    assert.throws(() => client.sendNotification("client/status", { note }), (error) => {
      thrown.push(error);
      assert.match(error.message, /credential|secret/i);
      return true;
    });
    assert.throws(() => client.request("model/list", { note }), /credential|secret/i);
  }
  assert.equal(harness.sockets[0].sent.length, sentBefore);
  for (const note of ordinary) {
    assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
  }

  const notifications = [];
  const offline = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("offline", (error) => offline.push(error));
  harness.sockets[0].receive({
    method: "client/status",
    params: { rawLeaks, canonicalLeaks, ordinary, safe: "ordinary" },
  });
  assert.deepEqual(notifications, [{
    method: "client/status",
    params: {
      rawLeaks: rawLeaks.map(() => "<redacted>"),
      canonicalLeaks: canonicalLeaks.map(() => "<redacted>"),
      ordinary,
      safe: "ordinary",
    },
  }]);
  harness.sockets[0].fail(new Error(`${rawToken} ${rawSearch}`));
  assert.equal(offline.length, 1);

  const publicText = inspect({ thrown, notifications, offline, wire: harness.sockets[0].sent });
  for (const secret of [rawToken, canonicalToken, rawSearch, rawQuery, canonicalSearch, canonicalQuery]) {
    assert.equal(publicText.includes(secret), false);
  }
});

test("one-pass additive redaction covers non-idempotent session secrets", async (t) => {
  const rawToken = String.raw`opaque\\u002dprivate\\x2dvalue\\nmarker`;
  const canonicalToken = String.raw`opaque\u002dprivate\x2dvalue\nmarker`;
  const twiceDecodedToken = "opaque-private-value\nmarker";
  const rawEndpoint = String.raw`wss://bot-01.runtime.example.com/app-server?opaque=private\\u002dquery\\x2dpart\\nmarker`;
  const canonicalEndpoint = String.raw`wss://bot-01.runtime.example.com/app-server?opaque=private\u002dquery\x2dpart\nmarker`;
  const rawSearch = String.raw`?opaque=private\\u002dquery\\x2dpart\\nmarker`;
  const canonicalSearch = String.raw`?opaque=private\u002dquery\x2dpart\nmarker`;
  const rawQuery = rawSearch.slice(1);
  const canonicalQuery = canonicalSearch.slice(1);
  const privateSession = session({ endpoint: rawEndpoint, authToken: rawToken });
  const secretForms = [
    rawToken,
    canonicalToken,
    rawEndpoint,
    canonicalEndpoint,
    rawSearch,
    canonicalSearch,
    rawQuery,
    canonicalQuery,
  ];

  await t.test("accepts a strong token and rejects every raw/canonical outbound form", async (subtest) => {
    const { client, harness } = makeClient({ privateSession });
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const sentBefore = harness.sockets[0].sent.length;
    for (const secret of secretForms) {
      assert.throws(() => client.sendNotification("client/status", { note: `head ${secret} tail` }), /credential|secret/i);
      assert.throws(() => client.request("model/list", { note: secret }), /credential|secret/i);
    }
    assert.equal(harness.sockets[0].sent.length, sentBefore);
  });

  await t.test("rejects raw and canonical token/query forms at every near-cap position", async (subtest) => {
    const { client, harness } = makeClient({ privateSession });
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const padding = "ordinary model discussion ".repeat(40_000).slice(0, 900_000);
    const sentBefore = harness.sockets[0].sent.length;
    for (const secret of [rawToken, canonicalToken, rawQuery, canonicalQuery]) {
      const placements = [
        `${secret}${padding}`,
        `${padding.slice(0, 450_000)}${secret}${padding.slice(450_000)}`,
        `${padding}${secret}`,
      ];
      for (const note of placements) {
        const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note } }));
        assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
        assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      }
    }
    assert.equal(harness.sockets[0].sent.length, sentBefore);
  });

  await t.test("redacts every raw/canonical inbound form without iterative decoding", async (subtest) => {
    const { client, harness } = makeClient({ privateSession });
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    let notification;
    client.on("notification", (message) => { notification = message; });
    for (const secret of secretForms) {
      harness.sockets[0].receive({ method: "client/status", params: { note: `head ${secret} tail` } });
      assert.deepEqual(notification, { method: "client/status", params: { note: "<redacted>" } });
    }
    const ordinary = [
      "ordinary opaque private value query marker prose",
      "ordinary literal u002d x2d n marker discussion",
      twiceDecodedToken,
    ];
    harness.sockets[0].receive({ method: "client/status", params: { ordinary } });
    assert.deepEqual(notification, { method: "client/status", params: { ordinary } });
    assert.doesNotThrow(() => client.sendNotification("client/status", { ordinary }));
  });

  await t.test("sanitizes raw and canonical secret forms in transport errors", async (subtest) => {
    const { client, harness } = makeClient({ privateSession });
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const offline = [];
    client.on("offline", (error) => offline.push(error));
    harness.sockets[0].fail(new Error(`${rawToken} ${canonicalToken} ${rawQuery} ${canonicalQuery}`));
    assert.equal(offline.length, 1);
    const publicText = inspect({ offline, wire: harness.sockets[0].sent });
    for (const secret of secretForms) assert.equal(publicText.includes(secret), false);
  });
});

test("quoted assignment separators stay literal and match structured key policy", async (t) => {
  const punctuation = [];
  for (let code = 33; code <= 126; code += 1) {
    if ((code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)) continue;
    punctuation.push(String.fromCharCode(code));
  }

  for (const character of punctuation) {
    await t.test(`blocks quoted password split by ASCII ${character.charCodeAt(0)}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      const key = `pass${character}word`;
      const note = `${JSON.stringify(key)}=abc123`;
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      assert.throws(() => client.sendNotification("client/status", { [key]: "abc123" }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({ method: "client/status", params: { note, [key]: "abc123" } });
      assert.deepEqual(notifications, [{ method: "client/status", params: { note: "<redacted>" } }]);
    });
  }

  await t.test("allows quoted separator token-usage metrics like structured keys", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const allowed = [
      '"token:usage"=12',
      '"token=usage"=12',
      "'input:tokens'=8",
      "`last=token=usage`=12",
      String.raw`"token\u003ausage"=12`,
      String.raw`"token\x3dusage"=12`,
    ];
    for (const note of allowed) assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    assert.doesNotThrow(() => client.sendNotification("client/status", {
      "token:usage": 12,
      "token=usage": 12,
      "input:tokens": 8,
      "last=token=usage": 12,
    }));
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { allowed } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { allowed } }]);
  });

  await t.test("keeps a quoted-separator near-cap scan linear and finds its tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = '"token:usage"=12 "input=tokens"=8 ordinary model note ';
    const nearMiss = unit.repeat(Math.ceil(900_000 / unit.length)).slice(0, 900_000);
    const leakAtEnd = `${nearMiss} "pass:word"=abc123`;
    const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: leakAtEnd } }));
    assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `quoted separator near-cap scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("nested assignments inside quoted values classify their complete local keys", async (t) => {
  const blocked = [
    'note="pass:word=abc123"',
    'note="pass=word=abc123"',
    'note="api:key=abc123"',
    "note='api=key:abc123'",
    'note="pass:word:abc123"',
    String.raw`note="p\u0061ss\u003aword=abc123"`,
    String.raw`note=\u0022pass\x3dword\u003dabc123\u0022`,
    String.raw`note=\x60api\u003akey\x3dabc123\x60`,
    String.raw`note="pass\:word\=abc123"`,
  ];
  const allowed = [
    'note="token:usage=12"',
    'note="token=usage=12"',
    'note="input:tokens=8"',
    "note='last=token=usage=12'",
    String.raw`note="token\u003ausage\x3d12"`,
    String.raw`note=\u0022input\x3atokens\u003d8\u0022`,
  ];

  await t.test("rejects and redacts private complete local keys", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const sentBefore = harness.sockets[0].sent.length;
    for (const note of blocked) {
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
    }
    assert.equal(harness.sockets[0].sent.length, sentBefore);

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    for (const note of blocked) {
      harness.sockets[0].receive({ method: "client/status", params: { note, keep: true } });
      assert.deepEqual(notifications.at(-1), {
        method: "client/status",
        params: { note: "<redacted>", keep: true },
      });
    }
  });

  await t.test("preserves complete token-usage local keys", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    for (const note of allowed) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { allowed } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { allowed } }]);
  });

  await t.test("keeps nested local-key scanning bounded and finds a private tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = 'note="token:usage=12" note="input=tokens=8" ordinary model prose ';
    const nearMiss = unit.repeat(Math.ceil(900_000 / unit.length)).slice(0, 900_000);
    const leakAtEnd = `${nearMiss} note="pass:word=abc123"`;
    const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: leakAtEnd } }));
    assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
    harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
    assert.deepEqual(notifications, [
      { method: "client/status", params: { note: nearMiss } },
      { method: "client/status", params: { note: "<redacted>" } },
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `nested quoted-value scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("spaced nested quoted assignments retain their pending local boundary", async (t) => {
  const blocked = [
    'note="password= abc123"',
    'note="password =abc123"',
    'note="pass:word = abc123"',
    'note="api:key : abc123"',
    'note="mode = fast password = abc123"',
    'note="token:usage = 12 password = abc123"',
    'note="password = abc123 token:usage = 12"',
    'note="mode = fast api:key : abc123 output:tokens = 8"',
    String.raw`note=\"password\u0020=\x20abc123\"`,
    String.raw`note=\u0022pass\u003aword\u0020\u003d\x20abc123\u0022`,
    String.raw`note=\x60api\x3akey\t\:\u0020abc123\x60`,
  ];
  const allowed = [
    'note="token:usage = 12"',
    'note="token=usage =12"',
    'note="input:tokens= 8"',
    'note="mode = fast token:usage = 12"',
    'note="token:usage = 12 input:tokens = 8"',
    'note="temperature = high model = gpt-5.6"',
    String.raw`note=\"token\u003ausage\u0020=\x2012\"`,
    String.raw`note=\u0022input\x3atokens\t\u003d\u00208\u0022`,
  ];

  await t.test("blocks spaced private local fields outbound and inbound", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const sentBefore = harness.sockets[0].sent.length;
    for (const note of blocked) {
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
    }
    assert.equal(harness.sockets[0].sent.length, sentBefore);

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    for (const note of blocked) {
      harness.sockets[0].receive({ method: "client/status", params: { note, keep: true } });
      assert.deepEqual(notifications.at(-1), {
        method: "client/status",
        params: { note: "<redacted>", keep: true },
      });
    }
  });

  await t.test("keeps spaced usage and ordinary local fields public", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    for (const note of allowed) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { allowed } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { allowed } }]);
  });

  await t.test("keeps spaced local-field scanning bounded and finds its private tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = 'note="token:usage = 12" note="input:tokens = 8" note="mode = fast" ';
    const nearMiss = unit.repeat(Math.ceil(900_000 / unit.length)).slice(0, 900_000);
    const leakAtEnd = `${nearMiss} note="pass:word = abc123"`;
    const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: leakAtEnd } }));
    assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
    harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
    assert.deepEqual(notifications, [
      { method: "client/status", params: { note: nearMiss } },
      { method: "client/status", params: { note: "<redacted>" } },
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `spaced nested scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("quoted local values retain the complete pending assignment key", async (t) => {
  const blocked = [
    `note='password = "abc123"'`,
    `note='pass:word = "abc123"'`,
    `note='api:key : "abc123"'`,
    `note='mode = "fast" password = "abc123" token:usage = "12"'`,
    String.raw`note=\u0027pass\u003aword\u0020\u003d\u0020\u0022abc123\u0022\u0027`,
    String.raw`note=\'api\x3akey\x20\:\x20\"abc123\"\'`,
  ];
  const allowed = [
    `note='token:usage = "12"'`,
    `note='input:tokens = "8"'`,
    `note='mode = "fast" token:usage = "12" output:tokens = "8"'`,
    String.raw`note=\u0027token\u003ausage\u0020\u003d\u0020\u002212\u0022\u0027`,
    String.raw`note=\'input\x3atokens\x20\=\x20\"8\"\'`,
  ];

  await t.test("blocks private keys before raw encoded and escaped quoted values", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const sentBefore = harness.sockets[0].sent.length;
    for (const note of blocked) {
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i, note);
    }
    assert.equal(harness.sockets[0].sent.length, sentBefore);

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    for (const note of blocked) {
      harness.sockets[0].receive({ method: "client/status", params: { note, keep: true } });
      assert.deepEqual(notifications.at(-1), {
        method: "client/status",
        params: { note: "<redacted>", keep: true },
      });
    }
  });

  await t.test("keeps quoted token-usage values public across raw and encoded forms", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    for (const note of allowed) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }), note);
    }

    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { allowed } });
    assert.deepEqual(notifications, [{ method: "client/status", params: { allowed } }]);
  });

  await t.test("keeps quoted-value scanning bounded and finds a private near-cap tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = `note='token:usage = "12"' note='input:tokens = "8"' `;
    const nearMiss = unit.repeat(Math.ceil(900_000 / unit.length)).slice(0, 900_000);
    const leakAtEnd = `${nearMiss} note='password = "abc123"'`;
    const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: leakAtEnd } }));
    assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({ method: "client/status", params: { note: nearMiss } });
    harness.sockets[0].receive({ method: "client/status", params: { note: leakAtEnd } });
    assert.deepEqual(notifications, [
      { method: "client/status", params: { note: nearMiss } },
      { method: "client/status", params: { note: "<redacted>" } },
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `quoted local-value scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("punctuation and quote split assignment keys retain object-key parity", async (t) => {
  const secretKeys = [
    ["dot password", "pass.word", "pass.word"],
    ["dot API key", "api.key", "api.key"],
    ["dot credential", "creden.tial", "creden.tial"],
    ["dot diagnostic", "diag.nostic", "diag.nostic"],
    ["encoded dot password", String.raw`pass\u002eword`, "pass.word"],
    ["embedded quote password", 'pass"word', 'pass"word'],
    ["quoted password suffix", 'x"password"', 'x"password"'],
    ["evil token usage prefix", "evil.tokenUsage", "evil.tokenUsage"],
    ["access token usage prefix", "access.tokenUsage", "access.tokenUsage"],
    ["CSRF token usage prefix", "csrf.tokenUsage", "csrf.tokenUsage"],
    ["slash password", "pass/word", "pass/word"],
    ["at-sign API key", "api@key", "api@key"],
    ["hash credential", "creden#tial", "creden#tial"],
    ["plus diagnostic", "diag+nostic", "diag+nostic"],
    ["encoded slash password", String.raw`pass\u002fword`, "pass/word"],
    ["encoded at-sign API key", String.raw`api\x40key`, "api@key"],
    ["private token punctuation", "private/access-token", "private/access-token"],
    ["access token punctuation", "access@token", "access@token"],
  ];
  for (const [label, stringKey, objectKey] of secretKeys) {
    await t.test(`rejects and redacts ${label}`, async (subtest) => {
      const { client, harness } = makeClient();
      subtest.after(() => client.stop());
      await startReady(client, harness.sockets[0]);
      const note = `${stringKey}=abc123`;
      assert.throws(() => client.sendNotification("client/status", { note }), /credential|secret/i);
      assert.throws(() => client.sendNotification("client/status", { [objectKey]: "abc123" }), /credential|secret/i);
      const notifications = [];
      client.on("notification", (message) => notifications.push(message));
      harness.sockets[0].receive({
        method: "client/status",
        params: { note, safe: true, [objectKey]: "abc123" },
      });
      assert.deepEqual(notifications, [{
        method: "client/status",
        params: { note: "<redacted>", safe: true },
      }]);
    });
  }

  await t.test("keeps punctuated usage metrics and ordinary prose public", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const allowedAssignments = [
      "token.usage=12",
      "last.token.usage=12",
      "token.usage.breakdown=12",
      "input.tokens=8",
      "token/usage=12",
      "last@token#usage=12",
      "token+usage+breakdown=12",
      "input/tokens=8",
    ];
    const ordinary = [
      "ordinary pass.word discussion without assignment",
      "ordinary api.key naming guidance",
      'x"password" is quoted prose without an assignment',
      "mode.name=fast",
      "path/to/model=fast",
      "ratio+mode=high",
      "note@label=chat",
      "equation/a+b=ordinary",
      "basic gpt-5.6 model",
    ];
    for (const note of [...allowedAssignments, ...ordinary]) {
      assert.doesNotThrow(() => client.sendNotification("client/status", { note }));
    }
    assert.doesNotThrow(() => client.sendNotification("client/status", {
      "token.usage": 12,
      "last.token.usage": 12,
      "token.usage.breakdown": 12,
      "input.tokens": 8,
      "token/usage": 12,
      "last@token#usage": 12,
      "token+usage+breakdown": 12,
      "input/tokens": 8,
    }));
    const notifications = [];
    client.on("notification", (message) => notifications.push(message));
    harness.sockets[0].receive({
      method: "client/status",
      params: { allowedAssignments, ordinary },
    });
    assert.deepEqual(notifications, [{
      method: "client/status",
      params: { allowedAssignments, ordinary },
    }]);
  });

  await t.test("keeps a punctuation-dense near-cap scan linear and finds its tail", async (subtest) => {
    const { client, harness } = makeClient();
    subtest.after(() => client.stop());
    await startReady(client, harness.sockets[0]);
    const unit = String.raw`mode/name=fast token/usage=12 pass/worx=abc x"ordinary"=note ratio+mode=high `;
    const nearMiss = unit.repeat(Math.ceil(900_000 / unit.length)).slice(0, 900_000);
    const encodedBytes = Buffer.byteLength(JSON.stringify({ method: "client/status", params: { note: nearMiss } }));
    assert.ok(encodedBytes > 900_000 && encodedBytes < 1_048_576, `encoded fixture was ${encodedBytes} bytes`);
    const leakAtEnd = `${nearMiss} pass/word=abc123`;
    const started = process.hrtime.bigint();
    assert.doesNotThrow(() => client.sendNotification("client/status", { note: nearMiss }));
    assert.throws(() => client.sendNotification("client/status", { note: leakAtEnd }), /credential|secret/i);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1_500, `punctuation near-cap scans took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("synchronous close and error during every listener registration stage fail closed", async (t) => {
  for (const action of ["close", "error"]) {
    for (const stage of ["close", "error", "message", "open"]) {
      await t.test(`${action} during ${stage}`, async () => {
        const clock = new FakeClock();
        const socket = new RegistrationEventSocket({ stage, action });
        const { client } = makeClient({ sockets: [socket], clock });
        const ready = [];
        client.on("ready", (event) => ready.push(event));
        const starting = client.start();
        void starting.catch(() => {});
        if (client.state === "connecting" && clock.timers.size > 0) clock.fireFirst(30_000);
        await assert.rejects(starting, {
          code: action === "close" ? "REMOTE_TRANSPORT_CLOSED" : "REMOTE_TRANSPORT_ERROR",
        });
        assert.equal(client.state, "offline");
        assert.equal(client.initialized, false);
        assert.deepEqual(ready, []);
        assert.equal(clock.timers.size, 0);
        assert.equal(socket.listenerCount("close"), 0);
        assert.equal(socket.listenerCount("message"), 0);
        assert.equal(socket.listenerCount("open"), 0);
        assert.equal(socket.listenerCount("error"), 1);
      });
    }
  }
});

test("synchronous open at every registration stage preserves initialize response and skips open timer", async (t) => {
  for (const stage of ["close", "error", "message", "open"]) {
    await t.test(`open during ${stage}`, async () => {
      const clock = new FakeClock();
      const socket = new RegistrationEventSocket({
        stage,
        action: "open",
        synchronousInitializeResponse: true,
      });
      const { client } = makeClient({ sockets: [socket], clock });
      const starting = client.start();
      void starting.catch(() => {});
      await waitTurn();
      if (!client.initialized && clock.timers.size > 0) clock.fireFirst(30_000);
      await starting;
      assert.equal(client.state, "ready");
      assert.equal(client.initialized, true);
      assert.deepEqual(socket.sent.map(({ method }) => method), ["initialize", "initialized"]);
      assert.deepEqual(clock.activeDelays(), []);
      assert.equal(clock.nextId, 3);
      assert.equal(socket.listenerCount("close"), 1);
      assert.equal(socket.listenerCount("error"), 1);
      assert.equal(socket.listenerCount("message"), 1);
      assert.equal(socket.listenerCount("open"), 1);
      client.stop();
      assert.equal(socket.listenerCount("close"), 0);
      assert.equal(socket.listenerCount("message"), 0);
      assert.equal(socket.listenerCount("open"), 0);
      assert.equal(socket.listenerCount("error"), 1);
      assert.equal(clock.timers.size, 0);
    });
  }
});
