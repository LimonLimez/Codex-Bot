"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createRuntimeConfig } = require(path.resolve(
  __dirname,
  "..",
  "src",
  "bridge",
  "runtime-config.cjs",
));
const clientPath = path.resolve(
  __dirname,
  "..",
  "src",
  "bridge",
  "codex-client.cjs",
);

const BOT_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "client-secret-".padEnd(52, "t");

function runtime(overrides = {}) {
  return createRuntimeConfig({
    botId: BOT_ID,
    generation: 5,
    endpoint: "http://127.0.0.1:43123/v1",
    credential: TOKEN,
    model: "gpt-5.6-terra",
    reasoningEffort: "ultra",
    ...overrides,
  });
}

function bodyFromEvents(events) {
  return (async function* () {
    for (const event of events) {
      yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`, "utf8");
    }
    yield Buffer.from("data: [DONE]\n\n", "utf8");
  })();
}

async function collect(fullStream) {
  const events = [];
  for await (const event of fullStream) events.push(event);
  return events;
}

test("sends one exact authenticated loopback request and returns scoped secret-free stream metadata", async () => {
  const { CodexClient } = require(clientPath);
  const calls = [];
  const client = new CodexClient({
    config: runtime(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        body: bodyFromEvents([
          {
            id: "response-1",
            choices: [{ delta: { content: "Working" } }],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "approval-1",
                      function: {
                        name: "RequestApproval",
                        arguments: '{"summary":"Publish release"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 7,
              total_tokens: 21,
            },
          },
        ]),
      };
    },
  });
  const result = client.stream({
    invocationId: "invocation-1",
    messages: [{ role: "user", content: "Do the work." }],
    tools: [
      {
        name: "RequestApproval",
        description: "Ask before publishing.",
        parameters: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    ],
    toolChoice: { toolName: "RequestApproval" },
  });
  const events = await collect(result.fullStream);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:43123/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers["X-Codex-Bot-Id"], BOT_ID);
  assert.equal(calls[0].options.headers["X-Codex-Runtime-Generation"], "5");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, "gpt-5.6-terra");
  assert.equal(payload.reasoning_effort, "ultra");
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.tool_choice, {
    type: "function",
    function: { name: "RequestApproval" },
  });
  assert.doesNotMatch(calls[0].options.body, /client-secret|43123/);
  assert.deepEqual(events, [
    { type: "text-delta", textDelta: "Working" },
    {
      type: "tool-call-streaming-start",
      toolCallId: "approval-1",
      toolName: "RequestApproval",
    },
    {
      type: "tool-call-delta",
      toolCallId: "approval-1",
      toolName: "RequestApproval",
      argsTextDelta: '{"summary":"Publish release"}',
    },
    {
      type: "tool-call",
      toolCallId: "approval-1",
      toolName: "RequestApproval",
      args: { summary: "Publish release" },
    },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { promptTokens: 14, completionTokens: 7, totalTokens: 21 },
    },
  ]);
  assert.deepEqual(await result.usage, {
    promptTokens: 14,
    completionTokens: 7,
    totalTokens: 21,
  });
  assert.deepEqual(await result.providerMetadata, {
    codex: {
      botId: BOT_ID,
      generation: 5,
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
    },
  });
  assert.doesNotMatch(JSON.stringify(await result.providerMetadata), /43123|client-secret/);
  const response = await result.response;
  assert.equal(response.id, "response-1");
  assert.equal(response.modelId, "gpt-5.6-terra");
  assert.equal(response.messages[0].content[1].toolCallId, "approval-1");
});

test("rejects stale generation before a later frame can escape", async () => {
  const { CodexClient } = require(clientPath);
  let current = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = new CodexClient({
    config: runtime(),
    isCurrent: () => current,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
        await gate;
        yield Buffer.from('data: {"choices":[{"delta":{"content":"stale"}}]}\n\n');
      })(),
    }),
  });
  const result = client.stream({
    messages: [{ role: "user", content: "Go." }],
    tools: [],
  });
  const iterator = result.fullStream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text-delta", textDelta: "first" },
  });
  current = false;
  release();
  await assert.rejects(iterator.next(), { code: "CODEX_BRIDGE_STALE" });
  await assert.rejects(result.usage, { code: "CODEX_BRIDGE_STALE" });
});

test("duplicate tool or approval IDs are rejected instead of being delivered twice", async () => {
  const { CodexClient } = require(clientPath);
  const client = new CodexClient({
    config: runtime(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: bodyFromEvents([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "approval-1", function: { name: "RequestApproval", arguments: "{}" } },
                  { index: 1, id: "approval-1", function: { name: "RequestApproval", arguments: "{}" } },
                ],
              },
            },
          ],
        },
      ]),
    }),
  });
  const result = client.stream({
    messages: [{ role: "user", content: "Go." }],
    tools: [{ name: "RequestApproval", parameters: { type: "object", properties: {} } }],
  });
  await assert.rejects(collect(result.fullStream), {
    code: "CODEX_BRIDGE_PROTOCOL_INVALID",
  });
  await assert.rejects(result.response, {
    code: "CODEX_BRIDGE_PROTOCOL_INVALID",
  });
});

test("rejects unsafe tool arguments and multiple provider choices before public delivery", async (t) => {
  const { CodexClient } = require(clientPath);
  await t.test("unsafe tool arguments", async () => {
    const client = new CodexClient({
      config: runtime(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: bodyFromEvents([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "unsafe-1",
                      function: {
                        name: "Computer",
                        arguments:
                          '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]),
      }),
    });
    const result = client.stream({
      messages: [{ role: "user", content: "Go." }],
      tools: [{ name: "Computer", parameters: { type: "object" } }],
    });
    await assert.rejects(collect(result.fullStream), {
      code: "CODEX_BRIDGE_PROTOCOL_INVALID",
    });
    assert.equal(Object.prototype.polluted, undefined);
  });

  await t.test("multiple provider choices", async () => {
    const client = new CodexClient({
      config: runtime(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: bodyFromEvents([
          {
            choices: [
              { delta: { content: "first" } },
              { delta: { content: "unowned second" } },
            ],
          },
        ]),
      }),
    });
    const result = client.stream({
      messages: [{ role: "user", content: "Go." }],
      tools: [],
    });
    await assert.rejects(collect(result.fullStream), {
      code: "CODEX_BRIDGE_PROTOCOL_INVALID",
    });
  });
});

test("abandoning a stream aborts transport and settles every public promise", async () => {
  const { CodexClient } = require(clientPath);
  let observedSignal;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = new CodexClient({
    config: runtime(),
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
          await gate;
        })(),
      };
    },
  });
  const result = client.stream({
    messages: [{ role: "user", content: "Go." }],
    tools: [],
  });
  const iterator = result.fullStream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text-delta", textDelta: "first" },
  });
  await iterator.return();
  release();
  assert.equal(observedSignal.aborted, true);
  for (const promise of [
    result.usage,
    result.extendedUsage,
    result.providerMetadata,
    result.response,
  ]) {
    const outcome = await Promise.race([
      promise.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: "timeout" }), 50),
      ),
    ]);
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error.code, "CODEX_BRIDGE_CANCELLED");
  }
});

test("oversized SSE, HTTP errors, and disposal fail closed without exposing transport details", async (t) => {
  const { CodexClient, MAX_SSE_LINE_BYTES } = require(clientPath);
  await t.test("oversized line", async () => {
    const client = new CodexClient({
      config: runtime(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: (async function* () {
          yield Buffer.from(`data: ${"x".repeat(MAX_SSE_LINE_BYTES + 1)}`);
        })(),
      }),
    });
    const result = client.stream({ messages: [{ role: "user", content: "Go." }], tools: [] });
    await assert.rejects(collect(result.fullStream), {
      code: "CODEX_BRIDGE_PROTOCOL_INVALID",
    });
  });

  await t.test("HTTP error is sanitized", async () => {
    const client = new CodexClient({
      config: runtime(),
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        text: async () => `provider at http://127.0.0.1:43123/v1 used ${TOKEN}`,
        body: null,
      }),
    });
    const result = client.stream({ messages: [{ role: "user", content: "Go." }], tools: [] });
    await assert.rejects(collect(result.fullStream), (error) => {
      assert.equal(error.code, "CODEX_BRIDGE_FAILED");
      assert.doesNotMatch(String(error.stack), /43123|client-secret|provider at/);
      return true;
    });
  });

  await t.test("dispose aborts active work and rejects later work", async () => {
    let observedSignal;
    const client = new CodexClient({
      config: runtime(),
      fetchImpl: async (_url, options) => {
        observedSignal = options.signal;
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    const result = client.stream({ messages: [{ role: "user", content: "Go." }], tools: [] });
    const operation = collect(result.fullStream);
    await new Promise((resolve) => setImmediate(resolve));
    client.dispose();
    assert.equal(observedSignal.aborted, true);
    await assert.rejects(operation, { code: "CODEX_BRIDGE_DISPOSED" });
    assert.throws(
      () => client.stream({ messages: [{ role: "user", content: "Again." }], tools: [] }),
      { code: "CODEX_BRIDGE_DISPOSED" },
    );
  });
});
