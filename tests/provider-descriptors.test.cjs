"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PROVIDER_IDS,
  PROVIDER_DESCRIPTORS,
  canonicalProviderId,
  providerDescriptor,
  providerModelIdentity,
} = require("../src/provider-descriptors.cjs");

test("shared descriptors expose the exact eight-route semantic matrix", () => {
  assert.deepEqual(PROVIDER_IDS, [
    "openai-codex",
    "anthropic-claude",
    "google-antigravity",
    "moonshot-kimi",
    "xai",
    "google-vertex-ai",
    "openai-api-key",
    "local-openai-compatible",
  ]);
  assert.deepEqual(
    PROVIDER_DESCRIPTORS.map(({ providerId }) => providerId),
    PROVIDER_IDS,
  );
  assert.deepEqual(PROVIDER_DESCRIPTORS.map(({ loginKind }) => loginKind), [
    "account",
    "oauth",
    "oauth",
    "device",
    "device",
    "service-account",
    "api-key",
    "local",
  ]);
  assert.equal(new Set(PROVIDER_IDS).size, 8);
  assert.deepEqual(
    PROVIDER_DESCRIPTORS.map(({ windowsProviderId }) => windowsProviderId),
    [
      "codex",
      "claude",
      "antigravity",
      "kimi",
      "xai",
      "vertex",
      "openai-api-key",
      "local",
    ],
  );
  assert.equal(providerDescriptor("anthropic-claude").loginFlag, "-claude-login");
  assert.equal(providerDescriptor("google-antigravity").loginFlag, "-antigravity-login");
  assert.equal(providerDescriptor("moonshot-kimi").loginFlag, "-kimi-login");
  assert.equal(providerDescriptor("xai").loginFlag, "-xai-login");
  assert.equal(providerDescriptor("google-vertex-ai").loginFlag, "-vertex-import");
  assert.equal(canonicalProviderId("cliproxy-anthropic"), "anthropic-claude");
  assert.equal(canonicalProviderId("local"), "local-openai-compatible");
  assert.equal(
    providerDescriptor("local").providerId,
    "local-openai-compatible",
  );
  assert.equal(
    providerDescriptor("local-openai-compatible").windowsProviderId,
    "local",
  );
  assert.deepEqual(
    {
      codex: canonicalProviderId("codex"),
      claude: canonicalProviderId("claude"),
      antigravity: canonicalProviderId("antigravity"),
      kimi: canonicalProviderId("kimi"),
      xai: canonicalProviderId("xai"),
      vertex: canonicalProviderId("vertex"),
      "openai-api-key": canonicalProviderId("openai-api-key"),
      local: canonicalProviderId("local"),
    },
    {
      codex: "openai-codex",
      claude: "anthropic-claude",
      antigravity: "google-antigravity",
      kimi: "moonshot-kimi",
      xai: "xai",
      vertex: "google-vertex-ai",
      "openai-api-key": "openai-api-key",
      local: "local-openai-compatible",
    },
  );
  assert.equal(
    providerModelIdentity("openai-codex", "shared-name"),
    '["openai-codex","shared-name"]',
  );
  assert.equal(
    providerModelIdentity("anthropic-claude", "shared-name"),
    '["anthropic-claude","shared-name"]',
  );
});
