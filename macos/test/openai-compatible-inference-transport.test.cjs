"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const transportPath = path.join(__dirname, "..", "src", "desktop", "openai-compatible-inference-transport.cjs");
const BOT_ID = "bot-11111111-1111-4111-8111-111111111111";

function request(overrides = {}) {
  return {
    selection: {
      botId: BOT_ID,
      generation: 3,
      provider: "openai-api-key",
      model: "gpt-live-only",
      reasoningEffort: "high",
      serviceTier: null,
    },
    conversationId: "conversation-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: "none",
    invocationId: "invocation-1",
    assertCurrent: async () => {},
    ...overrides,
  };
}

class ClientFixture {
  static options = [];
  constructor(options) { ClientFixture.options.push(options); this.disposed = false; }
  stream(value) {
    return {
      fullStream: (async function* () { yield { type: "finish", finishReason: "stop", usage: {} }; })(),
      usage: Promise.resolve({}),
      extendedUsage: Promise.resolve({}),
      providerMetadata: Promise.resolve({}),
      invocationId: Promise.resolve(value.invocationId),
      response: Promise.resolve({}),
    };
  }
  dispose() { this.disposed = true; }
}

test("OpenAI-compatible transport resolves a private connection only when streaming", async () => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  let resolves = 0;
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "openai-api-key",
    resolveConnection: async () => {
      resolves += 1;
      const connection = { endpoint: "https://api.openai.com/v1" };
      Object.defineProperty(connection, "credential", { value: "s".repeat(64), enumerable: false });
      return Object.freeze(connection);
    },
    ClientClass: ClientFixture,
  });
  assert.equal(resolves, 0);
  const result = await transport.stream(request());
  assert.equal(resolves, 1);
  for await (const _event of result.fullStream) {}
  assert.equal(ClientFixture.options.length, 1);
  const config = ClientFixture.options[0].config;
  assert.deepEqual(Object.keys(config), ["botId", "generation", "model", "reasoningEffort"]);
  assert.equal(config.credential, "s".repeat(64));
  assert.doesNotMatch(JSON.stringify(ClientFixture.options), /api.openai.com|ssss|credential|endpoint/);
});

test("OpenAI-compatible transport rejects a provider mismatch before constructing its client", () => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "local-openai-compatible",
    resolveConnection: async () => ({ endpoint: "http://127.0.0.1:11434/v1", credential: "l".repeat(64) }),
    ClientClass: ClientFixture,
  });
  assert.throws(() => transport.stream(request({
    selection: { ...request().selection, provider: "openai-api-key" },
  })), { code: "CODEX_INFERENCE_PROVIDER_INVALID" });
  assert.equal(ClientFixture.options.length, 0);
});
