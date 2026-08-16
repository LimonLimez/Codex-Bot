"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const connectionPath = path.join(root, "src", "codex-connection.cjs");
const stateKey = Symbol.for("codexbot.connection.state");

function environment(t) {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "open-bot-local-model-"),
  );
  const previous = {
    stateRoot: process.env.CODEX_BOT_STATE_ROOT,
    proxyUrl: process.env.GROK_BOT_CLIPROXY_URL,
    gatewayUrl: process.env.GROK_BOT_GATEWAY_URL,
    sandGatewayUrl: process.env.SAND_HOST_GATEWAY_URL,
    fetch: global.fetch,
  };
  process.env.CODEX_BOT_STATE_ROOT = stateRoot;
  delete process.env.GROK_BOT_CLIPROXY_URL;
  delete process.env.GROK_BOT_GATEWAY_URL;
  delete process.env.SAND_HOST_GATEWAY_URL;
  delete require.cache[require.resolve(connectionPath)];
  globalThis[stateKey] = null;
  t.after(() => {
    delete require.cache[require.resolve(connectionPath)];
    globalThis[stateKey] = null;
    global.fetch = previous.fetch;
    for (const [name, value] of [
      ["CODEX_BOT_STATE_ROOT", previous.stateRoot],
      ["GROK_BOT_CLIPROXY_URL", previous.proxyUrl],
      ["GROK_BOT_GATEWAY_URL", previous.gatewayUrl],
      ["SAND_HOST_GATEWAY_URL", previous.sandGatewayUrl],
    ]) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  return { stateRoot, connection: require(connectionPath) };
}

test("local model discovery is loopback-only and becomes a provider catalog", async (t) => {
  const { connection } = environment(t);
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "qwen3:8b", object: "model" },
          { id: "llama3.2:latest", object: "model" },
          { id: "qwen3:8b", object: "model" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const status = await connection.configureLocalProvider({
    baseUrl: "http://127.0.0.1:11434/",
    apiKey: "",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/models");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(status.connection.mode, "local");
  assert.equal(status.connection.route, "local-openai-compatible");
  assert.equal(status.connection.provider, "local");
  assert.equal(status.connection.model, "qwen3:8b");
  assert.deepEqual(
    status.preferences.catalog.models.map((model) => model.id),
    ["qwen3:8b", "llama3.2:latest"],
  );
  assert.deepEqual(status.preferences.catalog.reasoningEfforts, ["none"]);
  assert.equal(status.preferences.catalog.fastMode.supported, false);
  assert.equal(
    status.providers.find((item) => item.id === "local").signedIn,
    true,
  );

  const selected = connection.setDefaultPreferences({
    model: "llama3.2:latest",
  });
  assert.equal(selected.defaults.model, "llama3.2:latest");
  const runtime = connection.getConnection();
  assert.equal(runtime.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(runtime.apiKey, null);
  assert.equal(runtime.reasoningSupported, false);
});

test("local endpoint validation rejects non-loopback and ambiguous URLs", (t) => {
  const { connection } = environment(t);
  const credentialUrl = new URL("http://127.0.0.1:11434/v1");
  credentialUrl.username = "user";
  credentialUrl.password = "pass";
  for (const value of [
    "https://127.0.0.1:11434/v1",
    "http://localhost:11434/v1",
    "http://0.0.0.0:11434/v1",
    "http://127.0.0.2:11434/v1",
    "http://127.0.0.1/v1",
    credentialUrl.toString(),
    "http://127.0.0.1:11434/custom",
    "http://127.0.0.1:11434/v1?token=secret",
  ]) {
    assert.throws(
      () => connection.normalizeLocalBaseUrl(value),
      /literal http/,
    );
  }
  assert.equal(
    connection.normalizeLocalBaseUrl("http://127.0.0.1:1234"),
    "http://127.0.0.1:1234/v1",
  );
});

test("local discovery rejects malformed, empty, oversized, and failed catalogs", async (t) => {
  const { connection } = environment(t);
  const cases = [
    [new Response("not json", { status: 200 }), /invalid JSON/],
    [
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
      /no usable model IDs/,
    ],
    [
      new Response("denied", { status: 401 }),
      /rejected model discovery \(401\)/,
    ],
    [new Response("x".repeat(1024 * 1024 + 1), { status: 200 }), /too large/],
  ];
  for (const [response, expected] of cases) {
    global.fetch = async () => response;
    await assert.rejects(
      connection.configureLocalProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
      expected,
    );
  }
});

test("local provider cannot be selected before a successful discovery", (t) => {
  const { connection } = environment(t);
  assert.throws(
    () => connection.useProvider("local"),
    /Connect and discover a local model server/,
  );
});
