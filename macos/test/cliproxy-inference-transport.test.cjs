"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const transportPath = path.join(__dirname, "..", "src", "desktop", "cliproxy-inference-transport.cjs");
const BOT_ID = "bot-11111111-1111-4111-8111-111111111111";

function request(overrides = {}) {
  return {
    selection: {
      botId: BOT_ID,
      generation: 8,
      provider: "cliproxy-anthropic",
      model: "claude-fable-5",
      reasoningEffort: "max",
      serviceTier: null,
    },
    conversationId: "conversation-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: undefined,
    invocationId: "invocation-1",
    signal: undefined,
    assertCurrent: async () => {},
    ...overrides,
  };
}

class ClientFixture {
  static options = [];
  static instances = [];
  constructor(options) {
    ClientFixture.options.push(options);
    ClientFixture.instances.push(this);
    this.disposed = false;
  }
  stream() {
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "Fable" };
        yield { type: "finish", finishReason: "stop", usage: {} };
      })(),
      usage: Promise.resolve({}),
      extendedUsage: Promise.resolve({}),
      providerMetadata: Promise.resolve({}),
      invocationId: Promise.resolve("invocation-1"),
      response: Promise.resolve({}),
    };
  }
  dispose() { this.disposed = true; }
}

test("optional inference keeps the verified sidecar session private and rechecks selection before finish", async () => {
  const { CLIProxyInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  ClientFixture.instances = [];
  const session = { endpoint: "http://127.0.0.1:43211/v1" };
  Object.defineProperty(session, "credential", { value: "f".repeat(64), enumerable: false });
  Object.freeze(session);
  let current = true;
  let checks = 0;
  const transport = new CLIProxyInferenceTransport({ session, ClientClass: ClientFixture });
  const result = transport.stream(request({
    assertCurrent: async () => {
      checks += 1;
      if (!current) {
        const error = new Error("private");
        error.code = "CODEX_INFERENCE_STALE";
        throw error;
      }
    },
  }));
  const iterator = result.fullStream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: { type: "text-delta", textDelta: "Fable" }, done: false });
  current = false;
  await assert.rejects(iterator.next(), { code: "CODEX_INFERENCE_STALE" });
  assert.ok(checks >= 2);
  assert.equal(ClientFixture.options.length, 1);
  const clientConfig = ClientFixture.options[0].config;
  assert.deepEqual(Object.keys(clientConfig), ["botId", "generation", "provider", "providerId", "model", "reasoningEffort", "serviceTier"]);
  assert.equal(clientConfig.endpoint, session.endpoint);
  assert.equal(clientConfig.credential, session.credential);
  assert.equal(clientConfig.model, "claude-fable-5");
  assert.equal(clientConfig.reasoningEffort, "max");
  assert.doesNotMatch(JSON.stringify(ClientFixture.options), /43211|ffff|credential|endpoint/);
  transport.dispose();
  assert.equal(ClientFixture.instances[0].disposed, true);
  assert.throws(() => transport.stream(request()), { code: "CODEX_INFERENCE_DISPOSED" });
});

test("official selections and malformed sidecar sessions fail before client construction", () => {
  const { CLIProxyInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  assert.throws(() => new CLIProxyInferenceTransport({
    session: { endpoint: "http://127.0.0.1:1/v1", credential: "short" },
    ClientClass: ClientFixture,
  }), { code: "CODEX_INFERENCE_CONFIGURATION" });
  const session = { endpoint: "http://127.0.0.1:43211/v1" };
  Object.defineProperty(session, "credential", { value: "f".repeat(64), enumerable: false });
  const transport = new CLIProxyInferenceTransport({ session, ClientClass: ClientFixture });
  assert.throws(() => transport.stream(request({
    selection: { ...request().selection, provider: "openai-codex", model: "gpt-5.6-sol" },
  })), { code: "CODEX_INFERENCE_PROVIDER_INVALID" });
  assert.equal(ClientFixture.options.length, 0);
});

test("provider-scoped CLIProxy transport resolves its private session lazily for hosted routes", async () => {
  const { CLIProxyInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  let resolves = 0;
  const transport = new CLIProxyInferenceTransport({
    providerId: "xai",
    resolveConnection: async () => {
      resolves += 1;
      const session = { endpoint: "http://127.0.0.1:43211/v1" };
      Object.defineProperty(session, "credential", { value: "x".repeat(64), enumerable: false });
      return Object.freeze(session);
    },
    ClientClass: ClientFixture,
  });
  assert.equal(resolves, 0);
  const result = await transport.stream(request({
    selection: { ...request().selection, provider: "xai", model: "grok-4.5", reasoningEffort: "high" },
  }));
  assert.equal(resolves, 1);
  for await (const _event of result.fullStream) {}
  assert.equal(ClientFixture.options[0].config.model, "grok-4.5");
});

test("provider-scoped CLIProxy transport carries the canonical provider identity to its client", async () => {
  const { CLIProxyInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  const transport = new CLIProxyInferenceTransport({
    providerId: "xai",
    resolveConnection: () => ({ endpoint: "http://127.0.0.1:43211/v1", credential: "x".repeat(64) }),
    ClientClass: ClientFixture,
  });
  const result = await transport.stream(request({
    selection: { ...request().selection, provider: "xai", model: "grok-4.5", reasoningEffort: "high" },
  }));
  for await (const _event of result.fullStream) {}
  const config = ClientFixture.options[0].config;
  assert.equal(config.provider, "xai");
  assert.equal(config.providerId, "xai");
});

test("CLIProxy transport re-fences provider authority before client construction", async () => {
  const { CLIProxyInferenceTransport } = require(transportPath);
  ClientFixture.options = [];
  const transport = new CLIProxyInferenceTransport({
    providerId: "xai",
    resolveConnection: () => ({ endpoint: "http://127.0.0.1:43211/v1", credential: "x".repeat(64) }),
    assertConnectionCurrent: () => false,
    ClientClass: ClientFixture,
  });
  assert.throws(() => transport.stream(request({
    selection: { ...request().selection, provider: "xai", model: "grok-4.5", reasoningEffort: "high" },
  })), { code: "CODEX_INFERENCE_STALE" });
  assert.equal(ClientFixture.options.length, 0);
});

test("CLIProxy default client carries the canonical provider into the upstream request", async (t) => {
  const { CLIProxyInferenceTransport } = require(transportPath);
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
  const transport = new CLIProxyInferenceTransport({
    providerId: "xai",
    resolveConnection: async () => ({ endpoint: "http://127.0.0.1:43211/v1", credential: "x".repeat(64) }),
  });
  const result = await transport.stream(request({
    selection: { ...request().selection, provider: "xai", model: "grok-4.5", reasoningEffort: "high" },
  }));
  for await (const _event of result.fullStream) {}
  assert.equal(captured.payload.provider, "xai");
  assert.equal(captured.options.headers.get("X-OpenBot-Provider"), "xai");
});

test("CLIProxy transport re-fences again after client construction and before send", async () => {
  const { CLIProxyInferenceTransport } = require(transportPath);
  let checks = 0;
  let constructed = 0;
  let sends = 0;
  class SendFixture {
    constructor() { constructed += 1; }
    stream() { sends += 1; return { fullStream: (async function* () {})() }; }
    dispose() {}
  }
  const transport = new CLIProxyInferenceTransport({
    providerId: "xai",
    resolveConnection: () => ({ endpoint: "http://127.0.0.1:43211/v1", credential: "x".repeat(64) }),
    assertConnectionCurrent: () => {
      checks += 1;
      return checks < 3;
    },
    ClientClass: SendFixture,
  });
  assert.throws(() => transport.stream(request({
    selection: { ...request().selection, provider: "xai", model: "grok-4.5", reasoningEffort: "high" },
  })), { code: "CODEX_INFERENCE_STALE" });
  assert.equal(constructed, 1);
  assert.equal(sends, 0);
});
