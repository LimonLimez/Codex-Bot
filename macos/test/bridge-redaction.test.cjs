"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const redactionPath = path.resolve(
  __dirname,
  "..",
  "src",
  "bridge",
  "redaction.cjs",
);
const TOKEN = "bridge-token-".padEnd(52, "s");
const ENDPOINT = "http://127.0.0.1:43123/v1";

test("text redaction removes exact runtime secrets, credential forms, URLs, and local paths without rejecting prose", () => {
  const { redactText } = require(redactionPath);
  const input = [
    `runtime ${TOKEN}`,
    `endpoint=${ENDPOINT}`,
    "Authorization: Bearer unrelated-private-token",
    "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "file=/Users/alice/private/work/release.txt",
    "temp=/private/tmp/codex-secret/build.log",
  ].join("; ");
  const output = redactText(input, [TOKEN, ENDPOINT]);
  for (const forbidden of [
    TOKEN,
    ENDPOINT,
    "unrelated-private-token",
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "/Users/alice",
    "/private/tmp/codex-secret",
  ]) {
    assert.equal(output.includes(forbidden), false, forbidden);
  }
  assert.match(output, /\[REDACTED/);
  assert.equal(
    redactText("ordinary basic reasoning and bearer instrument prose", []),
    "ordinary basic reasoning and bearer instrument prose",
  );
});

test("diagnostic sanitization is recursive, bounded, cycle-safe, frozen, and keeps token usage metrics", () => {
  const { sanitizeDetails } = require(redactionPath);
  const source = {
    state: "failed",
    inputTokens: 12,
    lastTokenUsage: 13,
    endpoint: ENDPOINT,
    authToken: TOKEN,
    providerDiagnostic: "private provider stack",
    nested: {
      headers: { Authorization: `Bearer ${TOKEN}` },
      message: `request failed at ${ENDPOINT}`,
    },
  };
  source.cycle = source;
  const result = sanitizeDetails(source, [TOKEN, ENDPOINT]);
  assert.deepEqual(Object.keys(result), [
    "state",
    "inputTokens",
    "lastTokenUsage",
    "nested",
    "cycle",
  ]);
  assert.equal(result.state, "failed");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.lastTokenUsage, 13);
  assert.equal(Object.hasOwn(result, "endpoint"), false);
  assert.equal(Object.hasOwn(result, "authToken"), false);
  assert.equal(Object.hasOwn(result, "providerDiagnostic"), false);
  assert.equal(Object.hasOwn(result.nested, "headers"), false);
  assert.match(result.nested.message, /\[REDACTED/);
  assert.equal(result.cycle, "[Circular]");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nested), true);
  assert.doesNotMatch(JSON.stringify(result), /43123|bridge-token|provider stack/);
});

test("hostile getters and proxies are never invoked for public diagnostics", () => {
  const { sanitizeDetails } = require(redactionPath);
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(`getter leaked ${TOKEN}`);
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(`proxy leaked ${TOKEN}`);
      },
    },
  );
  assert.equal(sanitizeDetails(hostile, [TOKEN]), "[Untrusted diagnostic]");
  assert.equal(sanitizeDetails(proxy, [TOKEN]), "[Untrusted diagnostic]");
  assert.equal(getterCalls, 0);
});

test("sanitized errors expose a fixed code and no stack, endpoint, token, or provider details", () => {
  const { sanitizeError } = require(redactionPath);
  const source = new Error(
    `provider diagnostic from ${ENDPOINT} Authorization: Bearer ${TOKEN}`,
  );
  source.code = "PRIVATE_PROVIDER_ERROR";
  source.endpoint = ENDPOINT;
  const result = sanitizeError(source, [TOKEN, ENDPOINT]);
  assert.equal(result.name, "CodexBridgeError");
  assert.equal(result.code, "CODEX_BRIDGE_FAILED");
  assert.equal(result.message, "Codex bridge request failed.");
  assert.equal(Object.hasOwn(result, "endpoint"), false);
  assert.equal(Object.hasOwn(result, "providerDiagnostic"), false);
  assert.doesNotMatch(String(result.stack), /43123|bridge-token|provider diagnostic/i);
});
