"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const serverPath = path.join(__dirname, "..", "src", "desktop", "inference-bridge-server.cjs");
const clientPath = path.join(__dirname, "..", "src", "bridge", "inference-socket-client.cjs");

const BOT_UUID = "11111111-1111-4111-8111-111111111111";
const CAPABILITY = "a".repeat(64);

function config(overrides = {}) {
  const endpoint = overrides.endpoint;
  const credential = overrides.credential ?? CAPABILITY;
  const publicOverrides = { ...overrides };
  delete publicOverrides.endpoint;
  delete publicOverrides.credential;
  const value = {
    botId: BOT_UUID,
    generation: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: "priority",
    ...publicOverrides,
  };
  Object.defineProperties(value, {
    endpoint: { value: endpoint, enumerable: false },
    credential: { value: credential, enumerable: false },
  });
  return Object.freeze(value);
}

function prompt(overrides = {}) {
  return {
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    invocationId: "invocation-1",
    ...overrides,
  };
}

async function withBridge(t, router) {
  const { InferenceBridgeServer } = require(serverPath);
  const server = new InferenceBridgeServer({ router, capability: CAPABILITY });
  const session = await server.start();
  t.after(() => server.dispose());
  return { server, session };
}

async function collect(stream) {
  const values = [];
  for await (const value of stream) values.push(value);
  return values;
}

test("the private loopback bridge streams official inference without exposing provider credentials", async (t) => {
  const received = [];
  const router = {
    async stream(request) {
      received.push(request);
      return {
        fullStream: (async function* () {
          yield Object.freeze({ type: "text-delta", textDelta: "hello" });
          yield Object.freeze({
            type: "finish",
            finishReason: "stop",
            usage: Object.freeze({ promptTokens: 3, completionTokens: 2, totalTokens: 5 }),
          });
        })(),
        usage: Promise.resolve(Object.freeze({ promptTokens: 3, completionTokens: 2, totalTokens: 5 })),
        extendedUsage: Promise.resolve(Object.freeze({
          inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 100,
        })),
        providerMetadata: Promise.resolve(Object.freeze({ codex: Object.freeze({ model: "gpt-5.6-sol" }) })),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve(Object.freeze({
          id: "invocation-1",
          timestamp: new Date("2026-08-14T12:00:00.000Z"),
          modelId: "gpt-5.6-sol",
          messages: Object.freeze([Object.freeze({
            id: "invocation-1", role: "assistant", content: Object.freeze([Object.freeze({ type: "text", text: "hello" })]),
          })]),
        })),
      };
    },
  };
  const { session } = await withBridge(t, router);
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
  });
  t.after(() => client.dispose());
  const result = client.stream(prompt());
  assert.deepEqual(await collect(result.fullStream), [
    { type: "text-delta", textDelta: "hello" },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
  ]);
  assert.deepEqual(await result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal((await result.response).timestamp.toISOString(), "2026-08-14T12:00:00.000Z");
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].selection, {
    botId: `bot-${BOT_UUID}`,
    generation: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: "priority",
  });
  assert.equal(received[0].conversationId, "conversation-1");
  assert.equal(typeof received[0].assertCurrent, "undefined");
  assert.equal(received[0].signal instanceof AbortSignal, true);
  assert.doesNotMatch(JSON.stringify(received), /aaaa|credential|endpoint|Authorization|CLIProxy/);
});

test("an invalid capability and malformed frames fail closed before the router", async (t) => {
  let calls = 0;
  const { session } = await withBridge(t, { stream() { calls += 1; throw new Error("private"); } });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint, credential: "b".repeat(64) }),
    conversationId: "conversation-1",
  });
  const result = client.stream(prompt());
  await assert.rejects(collect(result.fullStream), (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_UNAVAILABLE");
    assert.doesNotMatch(String(error.stack), /private|Users|aaaa|bbbb|token|endpoint/);
    return true;
  });
  assert.equal(calls, 0);
  client.dispose();
});

test("cancelling or disposing a client aborts the exact main-process operation", async (t) => {
  let aborted = 0;
  let entered = 0;
  const router = {
    stream(request) {
      entered += 1;
      return {
        fullStream: (async function* () {
          await new Promise((resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              aborted += 1;
              reject(request.signal.reason);
            }, { once: true });
          });
          yield null;
        })(),
        usage: new Promise(() => {}),
        extendedUsage: new Promise(() => {}),
        providerMetadata: new Promise(() => {}),
        invocationId: Promise.resolve("invocation-1"),
        response: new Promise(() => {}),
      };
    },
  };
  const { session } = await withBridge(t, router);
  const { InferenceSocketClient } = require(clientPath);
  const controller = new AbortController();
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
  });
  const result = client.stream(prompt({ signal: controller.signal }));
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  while (entered === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("private /Users/person token"));
  await assert.rejects(pending, { code: "CODEX_BRIDGE_CANCELLED" });
  while (aborted === 0) await new Promise((resolve) => setImmediate(resolve));

  const next = client.stream(prompt({ invocationId: "invocation-2" }));
  const nextPending = next.fullStream[Symbol.asyncIterator]().next();
  while (entered < 2) await new Promise((resolve) => setImmediate(resolve));
  client.dispose();
  await assert.rejects(nextPending, { code: "CODEX_BRIDGE_DISPOSED" });
  while (aborted < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, 2);
});

test("a pre-aborted request never connects or reaches the main-process router", async (t) => {
  let entered = 0;
  const { session } = await withBridge(t, {
    stream() { entered += 1; throw new Error("must not run"); },
  });
  const { InferenceSocketClient } = require(clientPath);
  const controller = new AbortController();
  controller.abort(new Error("private /Users/person token"));
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
  });
  const result = client.stream(prompt({ signal: controller.signal }));
  await assert.rejects(Promise.race([
    collect(result.fullStream),
    new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100)),
  ]), { code: "CODEX_BRIDGE_CANCELLED" });
  assert.equal(entered, 0);
  client.dispose();
});

test("cancelling or disposing while the private socket is connecting settles without sending", async (t) => {
  const { InferenceSocketClient } = require(clientPath);
  for (const scenario of [
    { name: "cancel", code: "CODEX_BRIDGE_CANCELLED" },
    { name: "dispose", code: "CODEX_BRIDGE_DISPOSED" },
  ]) {
    await t.test(scenario.name, async () => {
      class PendingSocket extends EventEmitter {
        destroyed = false;
        writes = [];
        write(value, callback) { this.writes.push(value); callback(); }
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          this.emit("close");
        }
      }
      const socket = new PendingSocket();
      const controller = new AbortController();
      const client = new InferenceSocketClient({
        config: config({ endpoint: "tcp://127.0.0.1:43123" }),
        conversationId: "conversation-1",
        netImpl: { createConnection() { return socket; } },
      });
      const result = client.stream(prompt({ signal: controller.signal }));
      const pending = result.fullStream[Symbol.asyncIterator]().next();
      await new Promise((resolve) => setImmediate(resolve));
      if (scenario.name === "cancel") controller.abort(new Error("private token /Users/person"));
      else client.dispose();
      await assert.rejects(Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100)),
      ]), { code: scenario.code });
      assert.equal(socket.destroyed, true);
      assert.deepEqual(socket.writes, []);
      client.dispose();
    });
  }
});

test("selection changes during a streamed reply suppress stale frames", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const router = {
    stream() {
      return {
        fullStream: (async function* () {
          await gate;
          yield { type: "text-delta", textDelta: "stale private" };
        })(),
        usage: Promise.resolve({}),
        extendedUsage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({}),
      };
    },
  };
  const { session } = await withBridge(t, router);
  const { InferenceSocketClient } = require(clientPath);
  let current = true;
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    isCurrent: () => current,
  });
  const result = client.stream(prompt());
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  current = false;
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_STALE");
    assert.doesNotMatch(String(error.stack), /stale private|Users|token/);
    return true;
  });
  client.dispose();
});

test("client frame queues are bounded and destroy the socket synchronously on overflow", async () => {
  const { InferenceSocketClient, MAX_QUEUED_FRAMES } = require(clientPath);
  class FakeSocket extends EventEmitter {
    destroyed = false;
    write(_value, callback) { callback(); }
    destroy() { this.destroyed = true; }
  }
  const socket = new FakeSocket();
  const client = new InferenceSocketClient({
    config: config({ endpoint: "tcp://127.0.0.1:43123" }),
    conversationId: "conversation-1",
    netImpl: {
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });
  const result = client.stream(prompt());
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  const frame = `${JSON.stringify({ type: "event", value: { type: "text-delta", textDelta: "x" } })}\n`;
  socket.emit("data", Buffer.from(frame.repeat(MAX_QUEUED_FRAMES + 2)));
  assert.equal(socket.destroyed, true);
  assert.equal((await pending).value.type, "text-delta");
  await assert.rejects(iterator.next(), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  client.dispose();
});

test("unauthenticated sockets are capped and timeout destruction releases the exact slot", async (t) => {
  const accepted = [];
  class FakeServer extends EventEmitter {
    constructor(onConnection) { super(); this.onConnection = onConnection; this.listening = false; }
    listen() { this.listening = true; queueMicrotask(() => this.emit("listening")); }
    address() { return { address: "127.0.0.1", port: 43123 }; }
    close() { this.listening = false; }
  }
  class FakeSocket extends EventEmitter {
    destroyed = false;
    timeoutMs = null;
    setNoDelay() {}
    setTimeout(value) { this.timeoutMs = value; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  let fakeServer;
  const netImpl = {
    createServer(onConnection) {
      fakeServer = new FakeServer(onConnection);
      return fakeServer;
    },
  };
  const { InferenceBridgeServer, MAX_CONNECTIONS, AUTH_TIMEOUT_MS } = require(serverPath);
  const bridge = new InferenceBridgeServer({
    router: { stream() { throw new Error("must not run"); } },
    capability: CAPABILITY,
    netImpl,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  for (let index = 0; index < MAX_CONNECTIONS; index += 1) {
    const socket = new FakeSocket();
    accepted.push(socket);
    fakeServer.onConnection(socket);
    assert.equal(socket.destroyed, false);
    assert.equal(socket.timeoutMs, AUTH_TIMEOUT_MS);
  }
  const overCapacity = new FakeSocket();
  fakeServer.onConnection(overCapacity);
  assert.equal(overCapacity.destroyed, true);
  accepted[0].emit("timeout");
  assert.equal(accepted[0].destroyed, true);
  const replacement = new FakeSocket();
  fakeServer.onConnection(replacement);
  assert.equal(replacement.destroyed, false);
});

test("disposing while the private bridge is starting rejects the exact startup promise", async () => {
  class PendingServer extends EventEmitter {
    listening = false;
    listen() {}
    close() { this.emit("close"); }
  }
  let server;
  const { InferenceBridgeServer } = require(serverPath);
  const bridge = new InferenceBridgeServer({
    router: { stream() { throw new Error("must not run"); } },
    capability: CAPABILITY,
    netImpl: {
      createServer() {
        server = new PendingServer();
        return server;
      },
    },
  });
  const pending = bridge.start();
  bridge.dispose();
  await assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100)),
  ]), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  assert.equal(server.listenerCount("listening"), 0);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("close"), 0);
});
