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
  assert.deepEqual(Object.keys(config), ["botId", "generation", "provider", "providerId", "model", "reasoningEffort", "serviceTier"]);
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

test("OpenAI-compatible transport accepts a keyless local connection without exposing a credential", async () => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "local-openai-compatible",
    resolveConnection: async () => ({ endpoint: "http://127.0.0.1:11434/v1", credential: null }),
    ClientClass: ClientFixture,
  });
  const result = await transport.stream(request({
    selection: {
      ...request().selection,
      provider: "local-openai-compatible",
      model: "local-model",
      reasoningEffort: "none",
    },
  }));
  for await (const _event of result.fullStream) {}
  const config = ClientFixture.options[0].config;
  assert.equal(config.credential, null);
  assert.equal(Object.prototype.propertyIsEnumerable.call(config, "credential"), false);
  assert.doesNotMatch(JSON.stringify(ClientFixture.options), /127\.0\.0\.1|credential/);
});

test("OpenAI-compatible transport preserves provider identity and supported service tier in the client DTO", async () => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "openai-api-key",
    resolveConnection: () => ({ endpoint: "https://api.openai.com/v1", credential: "s".repeat(64) }),
    ClientClass: ClientFixture,
  });
  const result = await transport.stream(request({
    selection: { ...request().selection, serviceTier: "priority" },
  }));
  for await (const _event of result.fullStream) {}
  const config = ClientFixture.options[0].config;
  assert.equal(config.provider, "openai-api-key");
  assert.equal(config.providerId, "openai-api-key");
  assert.equal(config.serviceTier, "priority");
});

test("OpenAI-compatible transport re-fences provider authority before client construction", async () => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "openai-api-key",
    resolveConnection: async () => ({ endpoint: "https://api.openai.com/v1", credential: "s".repeat(64) }),
    assertConnectionCurrent: () => false,
    ClientClass: ClientFixture,
  });
  await assert.rejects(transport.stream(request()), { code: "CODEX_INFERENCE_STALE" });
  assert.equal(ClientFixture.options.length, 0);
});

test("keyless local default client omits Authorization while carrying the canonical upstream route", async (t) => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  const previousFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, payload: JSON.parse(options.body) };
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        yield new TextEncoder().encode("data: [DONE]\n\n");
      })(),
    };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "local-openai-compatible",
    resolveConnection: async () => ({ endpoint: "http://127.0.0.1:11434/v1", credential: null }),
  });
  const result = await transport.stream(request({
    selection: { ...request().selection, provider: "local-openai-compatible", model: "local-model", reasoningEffort: "none" },
  }));
  for await (const _event of result.fullStream) {}
  assert.equal(captured.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(captured.options.headers.get("authorization"), null);
  assert.equal(captured.payload.provider, "local-openai-compatible");
});

test("OpenAI-compatible transport re-fences again after client construction and before send", async () => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  let checks = 0;
  let constructed = 0;
  let sends = 0;
  class SendFixture {
    constructor() { constructed += 1; }
    stream() { sends += 1; return { fullStream: (async function* () {})() }; }
    dispose() {}
  }
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "openai-api-key",
    resolveConnection: async () => ({ endpoint: "https://api.openai.com/v1", credential: "s".repeat(64) }),
    assertConnectionCurrent: () => {
      checks += 1;
      return checks < 3;
    },
    ClientClass: SendFixture,
  });
  await assert.rejects(transport.stream(request()), { code: "CODEX_INFERENCE_STALE" });
  assert.equal(constructed, 1);
  assert.equal(sends, 0);
});

test("OpenAI API default client forwards the supported service tier to the upstream payload", async (t) => {
  const { OpenAICompatibleInferenceTransport } = require(transportPath);
  const previousFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        yield new TextEncoder().encode("data: [DONE]\n\n");
      })(),
    };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const transport = new OpenAICompatibleInferenceTransport({
    providerId: "openai-api-key",
    resolveConnection: async () => ({ endpoint: "https://api.openai.com/v1", credential: "s".repeat(64) }),
  });
  const result = await transport.stream(request({
    selection: { ...request().selection, serviceTier: "priority" },
  }));
  for await (const _event of result.fullStream) {}
  assert.equal(payload.service_tier, "priority");
  assert.equal(payload.provider, undefined);
});
