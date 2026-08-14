"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createRuntimeConfig } = require(path.resolve(
  __dirname,
  "..",
  "src",
  "bridge",
  "runtime-config.cjs",
));
const serverPath = path.resolve(
  __dirname,
  "..",
  "src",
  "bridge",
  "server.cjs",
);

const BOT_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "server-secret-".padEnd(52, "u");

function runtime(generation = 1) {
  return createRuntimeConfig({
    botId: BOT_ID,
    generation,
    endpoint: "http://127.0.0.1:43123/v1",
    credential: TOKEN,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  });
}

function response() {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield Buffer.from('data: {"id":"r1","choices":[{"delta":{"content":"Done"}}]}\n\n');
      yield Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n');
      yield Buffer.from("data: [DONE]\n\n");
    })(),
  };
}

test("host-facing prompt sessions preserve the Grok executor contract without public secrets", async () => {
  const { createBridge } = require(serverPath);
  const bridge = createBridge({
    loadConfig: () => runtime(),
    fetchImpl: async () => response(),
    isCurrent: () => true,
  });
  let middlewareCalls = 0;
  const session = bridge.createPromptSession(
    { botId: BOT_ID, modelId: "gpt-5.6-sol" },
    (executor) => {
      middlewareCalls += 1;
      return executor;
    },
  );
  assert.equal(session.getModelId(), "gpt-5.6-sol");
  assert.deepEqual(Object.keys(session), []);
  assert.equal(JSON.stringify(session), "{}");

  const executor = session.getExecutor([
    { role: "user", content: "Start." },
  ]);
  assert.equal(middlewareCalls, 1);
  assert.deepEqual(executor.getState(), [{ role: "user", content: "Start." }]);
  executor.appendMessages([{ role: "user", content: "Continue." }]);
  assert.equal(executor.getMessages().length, 2);
  const result = executor.stream(
    { signal: new AbortController().signal },
    "invocation-server-1",
    [],
    { toolChoice: "none" },
  );
  const events = [];
  for await (const event of result.fullStream) events.push(event);
  assert.deepEqual(events, [
    { type: "text-delta", textDelta: "Done" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    },
  ]);
  assert.deepEqual(await result.usage, {
    promptTokens: 2,
    completionTokens: 1,
    totalTokens: 3,
  });
  executor.clearMessages();
  assert.deepEqual(executor.getState(), []);
});

test("session ownership rejects mismatched bots and hostile options before transport", () => {
  const { createBridge } = require(serverPath);
  let fetchCalls = 0;
  const bridge = createBridge({
    loadConfig: () => runtime(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return response();
    },
  });
  for (const options of [
    { botId: "44444444-4444-4444-8444-444444444444" },
    Object.create({ botId: BOT_ID }),
    { get botId() { throw new Error(`leak ${TOKEN}`); } },
  ]) {
    assert.throws(() => bridge.createPromptSession(options), {
      code: "CODEX_BRIDGE_SESSION_INVALID",
    });
  }
  assert.equal(fetchCalls, 0);
});

test("bridge disposal cancels exact sessions and rejects every later session", async () => {
  const { createBridge } = require(serverPath);
  let signal;
  const bridge = createBridge({
    loadConfig: () => runtime(),
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const session = bridge.createPromptSession({ botId: BOT_ID });
  const result = session
    .getExecutor([{ role: "user", content: "Wait." }])
    .stream({}, "invocation-dispose", [], {});
  const operation = (async () => {
    for await (const _event of result.fullStream) {
      // No event is expected.
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  bridge.dispose();
  assert.equal(signal.aborted, true);
  await assert.rejects(operation, { code: "CODEX_BRIDGE_DISPOSED" });
  assert.throws(() => bridge.createPromptSession({ botId: BOT_ID }), {
    code: "CODEX_BRIDGE_DISPOSED",
  });
});

test("default module does not create a hidden endpoint or token when configuration is absent", () => {
  const server = require(serverPath);
  assert.equal(typeof server.createPromptSession, "function");
  assert.throws(() => server.createPromptSession(), {
    code: "CODEX_BRIDGE_CONFIG_INVALID",
  });
});
