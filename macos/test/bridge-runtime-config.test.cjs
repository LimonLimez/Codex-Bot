"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(
  macRoot,
  "assets",
  "cliproxyapi-7.2.130-darwin-aarch64.json",
);
const runtimePath = path.join(macRoot, "src", "bridge", "runtime-config.cjs");
const modelCatalogPath = path.join(
  macRoot,
  "assets",
  "cliproxyapi-model-catalog-2026-08-14.json",
);

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "runtime-secret-".padEnd(48, "x");

function temporaryRegistry(t) {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "codex-bridge-registry-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "model-selections.v1.json");
}

test("pins the reviewed CLIProxyAPI 7.2.130 macOS arm64 release", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    product: "CLIProxyAPI",
    version: "7.2.130",
    upstreamRepository: "https://github.com/router-for-me/CLIProxyAPI",
    releaseTag: "v7.2.130",
    publishedAt: "2026-08-12T10:30:26Z",
    asset: {
      name: "CLIProxyAPI_7.2.130_darwin_aarch64.tar.gz",
      url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.130/CLIProxyAPI_7.2.130_darwin_aarch64.tar.gz",
      bytes: 19329951,
      sha256: "a644a75f70cbd045b9f7caa9ff3866353448a7ed67ef8472eacc11c48b1c86f0",
    },
    executable: {
      name: "cli-proxy-api",
      platform: "darwin",
      architecture: "arm64",
      reportedCommit: "f43aad76",
      reportedBuiltAt: "2026-08-12T10:31:20Z",
    },
    license: {
      spdx: "MIT",
      pathInArchive: "LICENSE",
      url: "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v7.2.130/LICENSE",
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
