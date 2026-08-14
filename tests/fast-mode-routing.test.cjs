"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.CODEX_BOT_STATE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-bot-fast-mode-test-"),
);

const root = path.resolve(__dirname, "..");
const connectionManager = require(
  path.join(root, "src", "codex-connection.cjs"),
);
const bridge = require(path.join(root, "src", "bridge.cjs"));

function chatStream(events) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function exercise(
  connection,
  events,
  { agentId = "bot-fast-test", toolChoice } = {},
) {
  const originalGetConnection = connectionManager.getConnection;
  const originalFetch = globalThis.fetch;
  const calls = [];
  const requestedAgentIds = [];
  connectionManager.getConnection = (requestedAgentId) => {
    requestedAgentIds.push(requestedAgentId);
    return connection;
  };
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      options,
      payload: JSON.parse(options.body),
    });
    return chatStream(events);
  };

  try {
    const session = bridge.createPromptSession({ agentId });
    const executor = session.getExecutor([
      { role: "user", content: "Handle this." },
    ]);
    const result = executor.stream(
      {},
      "invocation-fast-test",
      [
        {
          name: "Computer",
          description: "Control the browser.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ],
      { toolChoice },
    );
    const streamEvents = [];
    for await (const event of result.fullStream) streamEvents.push(event);
    return {
      calls,
      requestedAgentIds,
      streamEvents,
      usage: await result.usage,
      response: await result.response,
      providerMetadata: await result.providerMetadata,
      modelId: session.getModelId(),
    };
  } finally {
    connectionManager.getConnection = originalGetConnection;
    globalThis.fetch = originalFetch;
  }
}

test(
  "Codex OAuth Fast mode uses the verified CLIProxy model alias and preserves streamed output",
  { concurrency: false },
  async () => {
    const result = await exercise(
      {
        mode: "codex-oauth",
        route: "cliproxyapi-codex-oauth",
        baseUrl: "http://127.0.0.1:8317/v1/",
        apiKey: "local-test-key",
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        fastMode: true,
      },
      [
        { id: "chat-fast-1", choices: [{ delta: { content: "Working" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-browser-1",
                    function: { name: "Computer", arguments: '{"url":"' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'https://example.com"}' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 },
        },
      ],
      { toolChoice: { toolName: "Computer" } },
    );

    assert.equal(result.calls.length, 1);
    assert.equal(
      result.calls[0].url,
      "http://127.0.0.1:8317/v1/chat/completions",
    );
    assert.equal(result.calls[0].payload.model, "gpt-5.6-terra-fast");
    assert.equal(Object.hasOwn(result.calls[0].payload, "service_tier"), false);
    assert.equal(result.calls[0].payload.reasoning_effort, "high");
    assert.deepEqual(result.calls[0].payload.tool_choice, {
      type: "function",
      function: { name: "Computer" },
    });
    assert.ok(result.requestedAgentIds.length >= 2);
    assert.ok(
      result.requestedAgentIds.every((value) => value === "bot-fast-test"),
    );
    assert.equal(result.modelId, "gpt-5.6-terra");

    assert.deepEqual(result.usage, {
      promptTokens: 21,
      completionTokens: 8,
      totalTokens: 29,
    });
    assert.ok(
      result.streamEvents.some(
        (event) => event.type === "text-delta" && event.textDelta === "Working",
      ),
    );
    assert.ok(
      result.streamEvents.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolCallId === "call-browser-1" &&
          event.toolName === "Computer" &&
          event.args.url === "https://example.com",
      ),
    );
    assert.equal(result.streamEvents.at(-1).finishReason, "tool-calls");
    assert.equal(result.response.modelId, "gpt-5.6-terra");
    assert.equal(
      result.providerMetadata.cliproxy.requestModel,
      "gpt-5.6-terra-fast",
    );
    assert.equal(
      result.providerMetadata.cliproxy.fastTransport,
      "cliproxy-model-alias",
    );
  },
);

test(
  "direct OpenAI API-key Fast mode keeps the model and requests the fast service tier",
  { concurrency: false },
  async () => {
    const result = await exercise(
      {
        mode: "api-key",
        route: "openai-api-key",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-not-real",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        fastMode: true,
      },
      [
        { id: "chat-direct-fast-1", choices: [{ delta: { content: "Done" } }] },
        {
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
      ],
    );

    assert.equal(
      result.calls[0].url,
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(result.calls[0].payload.model, "gpt-5.6-sol");
    assert.equal(result.calls[0].payload.service_tier, "fast");
    assert.equal(
      result.providerMetadata.cliproxy.fastTransport,
      "openai-service-tier",
    );
  },
);

test(
  "standard mode leaves the existing Chat Completions request unchanged",
  { concurrency: false },
  async () => {
    const result = await exercise(
      {
        mode: "codex-oauth",
        route: "cliproxyapi-codex-oauth",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKey: "local-test-key",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        fastMode: false,
      },
      [
        { id: "chat-standard-1", choices: [{ delta: { content: "Ready" } }] },
        {
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ],
    );

    assert.equal(
      result.calls[0].url,
      "http://127.0.0.1:8317/v1/chat/completions",
    );
    assert.equal(result.calls[0].payload.model, "gpt-5.6-luna");
    assert.equal(Object.hasOwn(result.calls[0].payload, "service_tier"), false);
    assert.equal(result.providerMetadata.cliproxy.fastTransport, "standard");
    assert.ok(
      result.streamEvents.some(
        (event) => event.type === "text-delta" && event.textDelta === "Ready",
      ),
    );
    assert.equal(result.streamEvents.at(-1).finishReason, "stop");
  },
);

test(
  "direct OpenAI API-key Standard mode pins the default service tier",
  { concurrency: false },
  async () => {
    const result = await exercise(
      {
        mode: "api-key",
        route: "openai-api-key",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-not-real",
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        fastMode: false,
      },
      [
        {
          id: "chat-direct-standard-1",
          choices: [{ delta: { content: "Standard" } }],
        },
        {
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        },
      ],
    );

    assert.equal(
      result.calls[0].url,
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(result.calls[0].payload.model, "gpt-5.6-terra");
    assert.equal(result.calls[0].payload.service_tier, "default");
    assert.equal(
      result.providerMetadata.cliproxy.fastTransport,
      "openai-default-tier",
    );
  },
);
