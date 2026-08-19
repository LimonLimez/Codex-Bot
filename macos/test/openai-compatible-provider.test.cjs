"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const providerPath = path.join(__dirname, "..", "src", "desktop", "openai-compatible-provider.cjs");

function model(id = "local-model") {
  return { id, object: "model", owned_by: "fixture" };
}

async function server(t, body, status = 200, headers = {}) {
  const instance = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => instance.close());
  return `http://127.0.0.1:${instance.address().port}/v1`;
}

test("local discovery accepts only literal loopback and one bounded non-redirecting model response", async (t) => {
  const { OpenAICompatibleProvider } = require(providerPath);
  const provider = new OpenAICompatibleProvider();
  const baseUrl = await server(t, { object: "list", data: [model()] });
  const catalog = await provider.discover({
    providerId: "local-openai-compatible", baseUrl, apiKey: null,
  });
  assert.deepEqual(catalog.models.map(({ model: id }) => id), ["local-model"]);
  const credentialedUrl = new URL("http://127.0.0.1:11434/v1");
  credentialedUrl.username = "fixture-user";
  credentialedUrl.password = "fixture-password";
  for (const invalid of [
    "http://localhost:11434/v1", "http://192.168.1.2/v1", "https://127.0.0.1/v1",
    credentialedUrl.href, "http://[::1]:11434/v1",
  ]) await assert.rejects(provider.discover({
    providerId: "local-openai-compatible", baseUrl: invalid, apiKey: null,
  }), /invalid|loopback/i);
});

test("OpenAI API-key discovery uses only the fixed endpoint and keeps secret non-enumerable", async () => {
  const { OpenAICompatibleProvider } = require(providerPath);
  const calls = [];
  const provider = new OpenAICompatibleProvider({
    request: async (options) => {
      calls.push(options);
      return { statusCode: 200, headers: {}, body: JSON.stringify({ data: [model("gpt-live")] }) };
    },
  });
  const catalog = await provider.discover({
    providerId: "openai-api-key", baseUrl: "https://attacker.invalid/v1", apiKey: "sk-private",
  });
  assert.equal(calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(catalog.models[0].model, "gpt-live");
  assert.doesNotMatch(JSON.stringify(catalog), /sk-private/);
  assert.deepEqual(Object.keys(provider.streamConfiguration("openai-api-key")), ["providerId", "baseUrl"]);
  assert.equal(provider.streamConfiguration("openai-api-key").apiKey, "sk-private");
  assert.doesNotMatch(JSON.stringify(provider.streamConfiguration("openai-api-key")), /sk-private/);
});

test("discovery rejects redirects, duplicate or malformed ids, and oversized catalogs", async (t) => {
  const { OpenAICompatibleProvider } = require(providerPath);
  const redirect = new OpenAICompatibleProvider({
    request: async () => ({ statusCode: 302, headers: { location: "http://127.0.0.1:9/v1/models" }, body: "" }),
  });
  await assert.rejects(redirect.discover({
    providerId: "local-openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null,
  }), /redirect/i);
  const malformed = new OpenAICompatibleProvider({
    request: async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ data: [model("bad/id"), model("bad/id")] }) }),
  });
  await assert.rejects(malformed.discover({
    providerId: "openai-api-key", apiKey: "sk-private",
  }), /invalid|model/i);
  const many = new OpenAICompatibleProvider({
    request: async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ data: Array.from({ length: 201 }, (_, i) => model(`model-${i}`)) }) }),
  });
  await assert.rejects(many.discover({ providerId: "openai-api-key", apiKey: "sk-private" }), /invalid|models/i);
});
