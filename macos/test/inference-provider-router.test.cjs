"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const routerPath = path.resolve(
  __dirname,
  "..",
  "src",
  "desktop",
  "inference-provider-router.cjs",
);

const BOT_ID = "bot-11111111-1111-4111-8111-111111111111";

function selection(overrides = {}) {
  return Object.freeze({
    botId: BOT_ID,
    generation: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    ...overrides,
  });
}

function request(overrides = {}) {
  return {
    selection: selection(),
    conversationId: "conversation-1",
    messages: [{ role: "user", content: "Hello." }],
    tools: [],
    toolChoice: "none",
    invocationId: "invocation-1",
    ...overrides,
  };
}

function transport(name, calls) {
  return Object.freeze({
    stream(value) {
      calls.push([name, value]);
      return Object.freeze({
        fullStream: (async function* () {
          await value.assertCurrent();
          yield Object.freeze({ type: "text-delta", textDelta: `${name} reply` });
          await value.assertCurrent();
          yield Object.freeze({
            type: "finish",
            finishReason: "stop",
            usage: Object.freeze({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
          });
        })(),
        usage: Promise.resolve(Object.freeze({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })),
        extendedUsage: Promise.resolve(Object.freeze({
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          maxTokens: 0,
        })),
        providerMetadata: Promise.resolve(Object.freeze({ provider: name })),
        invocationId: Promise.resolve(value.invocationId),
        response: Promise.resolve(Object.freeze({ id: value.invocationId, modelId: value.selection.model, messages: [] })),
      });
    },
  });
}

test("Codex selections use only direct app-server and never create the optional CLIProxy transport", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  const calls = [];
  let current = selection();
  let optionalCreates = 0;
  const router = new InferenceProviderRouter({
    readSelection: async () => current,
    directTransport: transport("direct", calls),
    createOptionalTransport: async () => {
      optionalCreates += 1;
      return transport("optional", calls);
    },
  });

  const result = await router.stream(request());
  const events = [];
  for await (const event of result.fullStream) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["text-delta", "finish"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "direct");
  assert.equal(optionalCreates, 0);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), [
    "assertCurrent", "conversationId", "invocationId", "messages", "selection", "signal", "toolChoice", "tools",
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /credential|authToken|endpoint|CLIProxy|private/);
});

test("a private child workspace reaches only direct Codex and is never forwarded to optional providers", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  const calls = [];
  let current = selection();
  const router = new InferenceProviderRouter({
    readSelection: async () => current,
    directTransport: transport("direct", calls),
    createOptionalTransport: async () => transport("optional", calls),
  });
  const workspaceId = `workspace-${"b".repeat(64)}`;
  const direct = await router.stream(request({ workspaceId }));
  for await (const _event of direct.fullStream) {}
  assert.equal(calls[0][0], "direct");
  assert.equal(calls[0][1].workspaceId, workspaceId);

  current = selection({
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "max",
  });
  const optional = await router.stream(request({ selection: current, workspaceId }));
  for await (const _event of optional.fullStream) {}
  assert.equal(calls[1][0], "optional");
  assert.equal(typeof calls[1][1].workspaceId, "undefined");
});

test("reviewed Fable selections create one lazy optional transport and map Ultra Code upstream without changing storage", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  const calls = [];
  let optionalCreates = 0;
  const stored = selection({
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    generation: 8,
  });
  const router = new InferenceProviderRouter({
    readSelection: async () => stored,
    directTransport: transport("direct", calls),
    createOptionalTransport: async (provider) => {
      optionalCreates += 1;
      assert.equal(provider, "cliproxy-anthropic");
      return transport("optional", calls);
    },
  });

  const first = await router.stream(request({ selection: stored }));
  for await (const _event of first.fullStream) {}
  const second = await router.stream(request({
    selection: stored,
    invocationId: "invocation-2",
  }));
  for await (const _event of second.fullStream) {}

  assert.equal(optionalCreates, 1);
  assert.deepEqual(calls.map(([name]) => name), ["optional", "optional"]);
  assert.equal(calls[0][1].selection.reasoningEffort, "max");
  assert.equal(stored.reasoningEffort, "ultra-code");
  assert.equal(calls[0][1].selection.provider, "anthropic-claude");
});

test("unknown providers and stale or mismatched tuples fail closed before either transport", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  const calls = [];
  let current = selection();
  const router = new InferenceProviderRouter({
    readSelection: async () => current,
    directTransport: transport("direct", calls),
    createOptionalTransport: async () => transport("optional", calls),
  });

  for (const candidate of [
    selection({ provider: "xai" }),
    selection({ model: "gpt-5.6-terra" }),
    selection({ reasoningEffort: "max" }),
    selection({ serviceTier: "fast" }),
    selection({ generation: 6 }),
  ]) {
    await assert.rejects(
      router.stream(request({ selection: candidate })),
      (error) => {
        assert.match(error.code, /^CODEX_INFERENCE_/);
        assert.doesNotMatch(String(error.stack), /gpt-5\.6|private|endpoint|token|Users/);
        return true;
      },
    );
  }
  assert.equal(calls.length, 0);

  const result = await router.stream(request());
  current = selection({ generation: 8 });
  await assert.rejects(async () => {
    for await (const _event of result.fullStream) {}
  }, { code: "CODEX_INFERENCE_STALE" });
  assert.equal(calls.length, 1);
});

test("hostile requests and disposed routers fail with a fixed sanitized boundary", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  let reads = 0;
  const router = new InferenceProviderRouter({
    readSelection: async () => { reads += 1; return selection(); },
    directTransport: transport("direct", []),
    createOptionalTransport: async () => transport("optional", []),
  });
  const hostile = new Proxy({}, { ownKeys() { throw new Error("private /Users/person token"); } });
  await assert.rejects(router.stream(hostile), (error) => {
    assert.equal(error.code, "CODEX_INFERENCE_INVALID");
    assert.doesNotMatch(String(error.stack), /private|Users|token/);
    return true;
  });
  assert.equal(reads, 0);
  router.dispose();
  router.dispose();
  await assert.rejects(router.stream(request()), { code: "CODEX_INFERENCE_DISPOSED" });
});

test("every canonical provider selects only its declared transport and omits unsupported options", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  const providers = [
    ["openai-codex", "gpt-5.6-sol", "ultra"],
    ["anthropic-claude", "claude-fable-5", "max"],
    ["google-antigravity", "gemini-3.6-flash-high", "high"],
    ["moonshot-kimi", "kimi-k3", "high"],
    ["xai", "grok-4.5", "high"],
    ["google-vertex-ai", "gemini-3.1-pro", "high"],
    ["openai-api-key", "gpt-5.6-sol", "high"],
    ["local-openai-compatible", "local-model", "none"],
  ];
  const calls = [];
  let current;
  const descriptorForProvider = (provider) => ({
    providerId: provider,
    reasoningEfforts: provider === "local-openai-compatible" ? ["none"] : ["none", "high", "max", "ultra"],
    reasoningMap: provider === "anthropic-claude" ? { "ultra-code": "max" } : undefined,
    fastModeSupported: provider === "openai-codex" || provider === "openai-api-key",
    models: [],
  });
  const router = new InferenceProviderRouter({
    readSelection: async () => current,
    descriptorForProvider,
    transportForProvider: async (provider) => {
      calls.push(provider);
      return transport(provider, []);
    },
  });
  for (const [provider, model, reasoningEffort] of providers) {
    current = selection({ provider, model, reasoningEffort, serviceTier: null });
    const result = await router.stream(request({ selection: current }));
    for await (const _event of result.fullStream) {}
  }
  assert.deepEqual(calls, providers.map(([provider]) => provider));
});

test("disconnected selection fails before transport construction", async () => {
  const { InferenceProviderRouter } = require(routerPath);
  let transportCalls = 0;
  const current = selection({ provider: "moonshot-kimi", model: "kimi-k3", reasoningEffort: "high" });
  const router = new InferenceProviderRouter({
    readSelection: async () => current,
    descriptorForProvider: () => ({ reasoningEfforts: ["high"], fastModeSupported: false, models: [] }),
    transportForProvider: async () => {
      throw new (require(routerPath).InferenceProviderError)(
        "CODEX_INFERENCE_PROVIDER_UNAVAILABLE",
        "Codex inference provider is unavailable.",
      );
    },
  });
  await assert.rejects(router.stream(request({ selection: current })), {
    code: "CODEX_INFERENCE_PROVIDER_UNAVAILABLE",
  });
  assert.equal(transportCalls, 0);
});
