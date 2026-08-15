"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(
  macRoot,
  "assets",
  "cliproxyapi-7.2.132-darwin-aarch64.json",
);
const runtimePath = path.join(macRoot, "src", "bridge", "runtime-config.cjs");
const modelCatalogPath = path.join(
  macRoot,
  "assets",
  "cliproxyapi-model-catalog-2026-08-14.json",
);

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const BOT_ID_B = "22222222-2222-4222-8222-222222222222";
const TOKEN = "runtime-secret-".padEnd(48, "x");

function temporaryRegistry(t) {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "codex-bridge-registry-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "model-selections.v1.json");
}

test("pins the reviewed CLIProxyAPI 7.2.132 macOS arm64 release", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    product: "CLIProxyAPI",
    version: "7.2.132",
    upstreamRepository: "https://github.com/router-for-me/CLIProxyAPI",
    releaseTag: "v7.2.132",
    publishedAt: "2026-08-14T20:36:46Z",
    asset: {
      name: "CLIProxyAPI_7.2.132_darwin_aarch64.tar.gz",
      url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.132/CLIProxyAPI_7.2.132_darwin_aarch64.tar.gz",
      bytes: 19354178,
      sha256: "360f410c7a30df1dc197949bfd2f272930a9420ce9357889c27b40d8ad9f17f9",
    },
    executable: {
      name: "cli-proxy-api",
      platform: "darwin",
      architecture: "arm64",
      bytes: 58558850,
      sha256: "a46fe86e32845876832c6f2c7e66587ab7d9ee70d899ee5a7112de29f7d70cd6",
      reportedCommit: "78f0c407",
      reportedBuiltAt: "2026-08-14T20:37:41Z",
    },
    license: {
      spdx: "MIT",
      pathInArchive: "LICENSE",
      url: "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v7.2.132/LICENSE",
    },
  });
  assert.doesNotMatch(JSON.stringify(manifest), /\/Users\/|harlin|token|auth/i);
});

test("pins the reviewed CLIProxyAPI model catalog and explicit Ultra Code mapping", () => {
  const catalog = JSON.parse(fs.readFileSync(modelCatalogPath, "utf8"));
  assert.deepEqual(catalog.models.map(({ id, upstreamReasoningLevels }) => [id, upstreamReasoningLevels]), [
    ["claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
    ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max"]],
  ]);
  assert.deepEqual(catalog.clientModes, { "ultra-code": { upstreamReasoningEffort: "max", visualEffect: "ultra" } });
  assert.equal(catalog.source.commit, "cbe1e6c59429bc92dd8d6654873670fc0c274cad");
  assert.doesNotMatch(JSON.stringify(catalog), /\/Users\/|harlin|Bearer|authToken|credential/i);
});

test("runtime config is exact, frozen, generation scoped, and keeps connection secrets private", () => {
  const { createRuntimeConfig } = require(runtimePath);
  const config = createRuntimeConfig({
    botId: BOT_ID,
    generation: 3,
    endpoint: "http://127.0.0.1:43123/v1",
    credential: TOKEN,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  });

  assert.deepEqual(Object.keys(config), [
    "botId",
    "generation",
    "model",
    "reasoningEffort",
  ]);
  assert.equal(config.endpoint, "http://127.0.0.1:43123/v1");
  assert.equal(config.credential, TOKEN);
  assert.equal(
    Object.getOwnPropertyDescriptor(config, "endpoint").enumerable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(config, "credential").enumerable,
    false,
  );
  assert.equal(Object.isFrozen(config), true);
  assert.doesNotMatch(JSON.stringify(config), /43123|runtime-secret/);
  assert.throws(() => {
    config.generation = 4;
  }, TypeError);
});

test("runtime config has no permissive endpoint, token, identity, or model fallback", () => {
  const { createRuntimeConfig, loadRuntimeConfig } = require(runtimePath);
  const valid = {
    botId: BOT_ID,
    generation: 1,
    endpoint: "http://127.0.0.1:43123/v1",
    credential: TOKEN,
    model: "gpt-5.6-terra",
    reasoningEffort: "ultra",
  };
  const invalid = [
    {},
    { ...valid, extra: true },
    { ...valid, botId: "bot-1" },
    { ...valid, generation: 0 },
    { ...valid, endpoint: "https://127.0.0.1:43123/v1" },
    { ...valid, endpoint: "http://localhost:43123/v1" },
    { ...valid, endpoint: "http://127.0.0.1:43123/v1?token=leak" },
    { ...valid, endpoint: "http://127.0.0.1:43123/" },
    { ...valid, credential: "too-short" },
    { ...valid, credential: `${TOKEN}\n` },
    { ...valid, model: "grok-4" },
    { ...valid, reasoningEffort: "extreme" },
  ];
  for (const value of invalid) {
    assert.throws(() => createRuntimeConfig(value), {
      code: "CODEX_BRIDGE_CONFIG_INVALID",
    });
  }
  assert.throws(() => loadRuntimeConfig({}), {
    code: "CODEX_BRIDGE_CONFIG_INVALID",
  });
  assert.equal(createRuntimeConfig({ ...valid, reasoningEffort: "none" }).reasoningEffort, "none");
});

test("direct runtime config accepts every model advertised by the pinned official Codex catalog", () => {
  const { loadRuntimeConfig } = require(runtimePath);
  const advertised = [
    ["gpt-5.6-sol", "ultra"],
    ["gpt-5.6-terra", "ultra"],
    ["gpt-5.6-luna", "max"],
    ["gpt-5.5", "xhigh"],
    ["gpt-5.4", "xhigh"],
    ["gpt-5.4-mini", "xhigh"],
    ["gpt-5.3-codex-spark", "xhigh"],
  ];
  for (const [model, reasoningEffort] of advertised) {
    const registry = temporaryRegistry({ after() {} });
    fs.writeFileSync(registry, `${JSON.stringify({
      schemaVersion: 1,
      activeBotId: `bot-${BOT_ID}`,
      selections: {
        [`bot-${BOT_ID}`]: { model, reasoningEffort, generation: 0, updatedAt: null },
      },
    })}\n`, { mode: 0o600 });
    const config = loadRuntimeConfig({
      CODEX_BOT_MODEL_SELECTIONS: registry,
      CODEX_BOT_INFERENCE_ENDPOINT: "tcp://127.0.0.1:43123",
      CODEX_BOT_INFERENCE_CAPABILITY: "a".repeat(64),
    });
    assert.equal(config.model, model);
    assert.equal(config.reasoningEffort, reasoningEffort);
    assert.equal(config.generation, 0);
    fs.rmSync(path.dirname(registry), { recursive: true, force: true });
  }
});

test("environment loading requires all exact private fields and a fresh strong credential can be generated", () => {
  const { generateCredential, loadRuntimeConfig } = require(runtimePath);
  const first = generateCredential();
  const second = generateCredential();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);

  const config = loadRuntimeConfig({
    CODEX_BOT_ID: BOT_ID,
    CODEX_BOT_RUNTIME_GENERATION: "9",
    CODEX_BOT_CLIPROXY_URL: "http://127.0.0.1:43123/v1",
    CODEX_BOT_CLIPROXY_TOKEN: first,
    CODEX_BOT_MODEL: "gpt-5.5",
    CODEX_BOT_REASONING_EFFORT: "xhigh",
  });
  assert.equal(config.botId, BOT_ID);
  assert.equal(config.generation, 9);
  assert.equal(config.model, "gpt-5.5");
  assert.equal(config.reasoningEffort, "xhigh");
  assert.equal(config.credential, first);
});

test("bridge loads the active main-owned bot model from the private registry without storing connection secrets", (t) => {
  const { loadRuntimeConfig } = require(runtimePath);
  const registry = temporaryRegistry(t);
  fs.writeFileSync(registry, `${JSON.stringify({
    schemaVersion: 1,
    activeBotId: `bot-${BOT_ID}`,
    selections: {
      [`bot-${BOT_ID}`]: {
        model: "gpt-5.6-terra",
        reasoningEffort: "ultra",
        generation: 12,
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    },
  })}\n`, { mode: 0o600 });
  const config = loadRuntimeConfig({
    CODEX_BOT_MODEL_SELECTIONS: registry,
    CODEX_BOT_CLIPROXY_URL: "http://127.0.0.1:43123/v1",
    CODEX_BOT_CLIPROXY_TOKEN: TOKEN,
  });
  assert.equal(config.botId, BOT_ID);
  assert.equal(config.generation, 12);
  assert.equal(config.model, "gpt-5.6-terra");
  assert.equal(config.reasoningEffort, "ultra");
  assert.doesNotMatch(fs.readFileSync(registry, "utf8"), /43123|runtime-secret|endpoint|credential/);
});

test("official and optional selections use only the private main-process inference bridge", (t) => {
  const { loadRuntimeConfig } = require(runtimePath);
  const registry = temporaryRegistry(t);
  fs.writeFileSync(registry, `${JSON.stringify({
    schemaVersion: 1,
    activeBotId: `bot-${BOT_ID}`,
    selections: {
      [`bot-${BOT_ID}`]: {
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        generation: 31,
        updatedAt: null,
      },
      [`bot-${BOT_ID_B}`]: {
        model: "claude-fable-5",
        reasoningEffort: "ultra-code",
        generation: 32,
        updatedAt: null,
      },
    },
  })}\n`, { mode: 0o600 });
  const environment = {
    CODEX_BOT_MODEL_SELECTIONS: registry,
    CODEX_BOT_CONVERSATION_BINDINGS: path.join(path.dirname(registry), "bindings.json"),
    CODEX_BOT_INFERENCE_ENDPOINT: "tcp://127.0.0.1:43210",
    CODEX_BOT_INFERENCE_CAPABILITY: "a".repeat(64),
  };
  const direct = loadRuntimeConfig(environment, { conversationId: "official" });
  assert.deepEqual(Object.keys(direct), [
    "botId", "generation", "provider", "model", "reasoningEffort", "serviceTier",
  ]);
  assert.equal(direct.provider, "openai-codex");
  assert.equal(direct.reasoningEffort, "ultra");
  assert.equal(direct.serviceTier, null);
  assert.equal(direct.endpoint, "tcp://127.0.0.1:43210");
  assert.equal(direct.credential, "a".repeat(64));
  assert.doesNotMatch(JSON.stringify(direct), /43210|aaaa|credential|endpoint/);

  fs.writeFileSync(registry, `${JSON.stringify({
    schemaVersion: 1,
    activeBotId: `bot-${BOT_ID_B}`,
    selections: JSON.parse(fs.readFileSync(registry, "utf8")).selections,
  })}\n`, { mode: 0o600 });
  const optional = loadRuntimeConfig(environment, { conversationId: "optional" });
  assert.equal(optional.provider, "cliproxy-anthropic");
  assert.equal(optional.model, "claude-fable-5");
  assert.equal(optional.reasoningEffort, "ultra-code");
  assert.equal(optional.serviceTier, null);
  assert.equal(environment.CODEX_BOT_CLIPROXY_URL, undefined);
  assert.equal(environment.CODEX_BOT_CLIPROXY_TOKEN, undefined);
});

test("the private inference bridge accepts a live official model not compiled into the app", (t) => {
  const { loadRuntimeConfig } = require(runtimePath);
  const registry = temporaryRegistry(t);
  fs.writeFileSync(registry, `${JSON.stringify({
    schemaVersion: 1,
    activeBotId: `bot-${BOT_ID}`,
    selections: {
      [`bot-${BOT_ID}`]: {
        provider: "openai-codex",
        model: "gpt-live-only",
        reasoningEffort: "high",
        serviceTier: null,
        catalogGeneration: 44,
        generation: 9,
        updatedAt: null,
      },
    },
  })}\n`, { mode: 0o600 });
  const config = loadRuntimeConfig({
    CODEX_BOT_MODEL_SELECTIONS: registry,
    CODEX_BOT_INFERENCE_ENDPOINT: "tcp://127.0.0.1:43210",
    CODEX_BOT_INFERENCE_CAPABILITY: "b".repeat(64),
  });
  assert.equal(config.provider, "openai-codex");
  assert.equal(config.model, "gpt-live-only");
  assert.equal(config.reasoningEffort, "high");
});

test("CLIProxyAPI-backed Fable Ultra Code stays distinct in UI storage and maps to upstream max reasoning", (t) => {
  const { loadRuntimeConfig } = require(runtimePath);
  const registry = temporaryRegistry(t);
  fs.writeFileSync(registry, `${JSON.stringify({
    schemaVersion: 1,
    activeBotId: `bot-${BOT_ID}`,
    selections: {
      [`bot-${BOT_ID}`]: {
        model: "claude-fable-5",
        reasoningEffort: "ultra-code",
        generation: 13,
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    },
  })}\n`, { mode: 0o600 });
  const config = loadRuntimeConfig({
    CODEX_BOT_MODEL_SELECTIONS: registry,
    CODEX_BOT_CLIPROXY_URL: "http://127.0.0.1:43123/v1",
    CODEX_BOT_CLIPROXY_TOKEN: TOKEN,
  });
  assert.equal(config.model, "claude-fable-5");
  assert.equal(config.reasoningEffort, "max");
  assert.match(fs.readFileSync(registry, "utf8"), /"reasoningEffort":"ultra-code"/);
});

test("stock Grok conversations stay bound to their original bot across active-bot switches and restarts", (t) => {
  const { loadRuntimeConfig } = require(runtimePath);
  const registry = temporaryRegistry(t);
  const bindings = path.join(path.dirname(registry), "conversation-bindings.v1.json");
  const writeRegistry = (activeBotId) => fs.writeFileSync(registry, `${JSON.stringify({
    schemaVersion: 1,
    activeBotId,
    selections: {
      [`bot-${BOT_ID}`]: {
        model: "gpt-5.6-sol", reasoningEffort: "high", generation: 21, updatedAt: null,
      },
      [`bot-${BOT_ID_B}`]: {
        model: "claude-fable-5", reasoningEffort: "ultra-code", generation: 22, updatedAt: null,
      },
    },
  })}\n`, { mode: 0o600 });
  const environment = {
    CODEX_BOT_MODEL_SELECTIONS: registry,
    CODEX_BOT_CONVERSATION_BINDINGS: bindings,
    CODEX_BOT_CLIPROXY_URL: "http://127.0.0.1:43123/v1",
    CODEX_BOT_CLIPROXY_TOKEN: TOKEN,
  };

  writeRegistry(`bot-${BOT_ID}`);
  const first = loadRuntimeConfig(environment, { conversationId: "stock-conversation-a" });
  assert.equal(first.botId, BOT_ID);
  writeRegistry(`bot-${BOT_ID_B}`);
  const retained = loadRuntimeConfig(environment, { conversationId: "stock-conversation-a" });
  const second = loadRuntimeConfig(environment, { conversationId: "stock-conversation-b" });
  assert.equal(retained.botId, BOT_ID);
  assert.equal(retained.generation, 21);
  assert.equal(second.botId, BOT_ID_B);
  assert.equal(second.generation, 22);
  assert.equal(second.reasoningEffort, "max");
  const persisted = fs.readFileSync(bindings, "utf8");
  assert.match(persisted, new RegExp(`"stock-conversation-a": "bot-${BOT_ID}"`));
  assert.match(persisted, new RegExp(`"stock-conversation-b": "bot-${BOT_ID_B}"`));
  assert.doesNotMatch(persisted, /43123|runtime-secret|endpoint|credential|model/i);
  assert.equal(fs.statSync(bindings).mode & 0o077, 0);
});
