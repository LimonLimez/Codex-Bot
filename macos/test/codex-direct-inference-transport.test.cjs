"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const transportPath = path.join(
  __dirname,
  "..",
  "src",
  "desktop",
  "codex-direct-inference-transport.cjs",
);

const BOT_ID = "bot-11111111-1111-4111-8111-111111111111";

function selection(overrides = {}) {
  return Object.freeze({
    botId: BOT_ID,
    generation: 4,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: "priority",
    ...overrides,
  });
}

function request(overrides = {}) {
  return Object.freeze({
    selection: selection(),
    conversationId: "conversation-1",
    messages: Object.freeze([
      Object.freeze({ role: "system", content: "Be precise." }),
      Object.freeze({ role: "user", content: "Hello" }),
    ]),
    tools: Object.freeze([]),
    toolChoice: "none",
    invocationId: "invocation-1",
    signal: undefined,
    assertCurrent: async () => {},
    ...overrides,
  });
}

class FakeManager extends EventEmitter {
  constructor({ hold = false, toolCall = false } = {}) {
    super();
    this.calls = [];
    this.generation = 9;
    this.hold = hold;
    this.toolCall = toolCall;
    this.startCalls = 0;
    this.declined = [];
  }

  async start() {
    this.startCalls += 1;
  }

  async request(method, params, options) {
    this.calls.push({ method, params, options });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      if (this.toolCall) {
        setImmediate(() => this.emit("dynamic-tool-call", {
          id: 44,
          method: "item/tool/call",
          params: {
            arguments: { text: "hello" },
            callId: "call-1",
            namespace: null,
            threadId: "thread-1",
            tool: "send_message",
            turnId: "turn-1",
          },
        }));
      } else if (!this.hold) {
        setImmediate(() => {
          this.emit("notification", {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              tokenUsage: {
                last: {
                  inputTokens: 12,
                  cachedInputTokens: 3,
                  cacheWriteInputTokens: 2,
                  outputTokens: 5,
                  reasoningOutputTokens: 1,
                  totalTokens: 17,
                },
                total: {
                  inputTokens: 12,
                  cachedInputTokens: 3,
                  cacheWriteInputTokens: 2,
                  outputTokens: 5,
                  reasoningOutputTokens: 1,
                  totalTokens: 17,
                },
                modelContextWindow: 200_000,
              },
            },
          });
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello " },
          });
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "world" },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed", items: [] },
            },
          });
        });
      }
      return { turn: { id: "turn-1" } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error("private unsupported manager request /Users/person token");
  }

  declineDynamicToolCall(id) { this.declined.push(id); }
}

async function collect(stream) {
  const values = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("official Codex streams through one ephemeral read-only app-server turn with exact native capabilities", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager();
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });

  const result = transport.stream(request());
  assert.deepEqual(await collect(result.fullStream), [
    { type: "text-delta", textDelta: "Hello " },
    { type: "text-delta", textDelta: "world" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    },
  ]);
  assert.deepEqual(await result.usage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  assert.deepEqual(await result.extendedUsage, {
    inputTokens: 12,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    maxTokens: 200_000,
  });
  assert.deepEqual(await result.providerMetadata, {
    codex: {
      botId: BOT_ID,
      generation: 4,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: "priority",
    },
  });
  assert.equal((await result.invocationId), "invocation-1");
  assert.equal((await result.response).messages[0].content[0].text, "Hello world");

  assert.equal(manager.startCalls, 1);
  assert.deepEqual(manager.calls.map(({ method }) => method), ["thread/start", "turn/start"]);
  assert.deepEqual(manager.calls[0], {
    method: "thread/start",
    params: {
      approvalPolicy: "never",
      cwd: "/private/codex-bot-empty-workspace",
      developerInstructions: "Be precise.",
      ephemeral: true,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      sandbox: "read-only",
      serviceName: "codex-bot",
      serviceTier: "priority",
    },
    options: { timeoutMs: 30_000 },
  });
  assert.equal(manager.calls[1].params.threadId, "thread-1");
  assert.equal(manager.calls[1].params.model, "gpt-5.6-sol");
  assert.equal(manager.calls[1].params.effort, "ultra");
  assert.equal(manager.calls[1].params.serviceTier, "priority");
  assert.equal(manager.calls[1].params.approvalPolicy, "never");
  assert.deepEqual(manager.calls[1].params.input.map(({ type }) => type), ["text", "text", "text"]);
  assert.match(manager.calls[1].params.input.map(({ text }) => text).join("\n"), /Conversation transcript/);
  assert.match(manager.calls[1].params.input.map(({ text }) => text).join("\n"), /Hello/);
  assert.doesNotMatch(JSON.stringify(manager.calls), /authToken|credential|CLIProxy|chat\/completions/);
});

test("native child workspace IDs select distinct private app-server working directories", async (t) => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-task-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "empty-workspace");
  fs.mkdirSync(base, { mode: 0o700 });
  const manager = new FakeManager();
  const transport = new CodexDirectInferenceTransport({ manager, workspacePath: base });
  const workspaceId = `workspace-${"c".repeat(64)}`;

  await collect(transport.stream(request({ workspaceId })).fullStream);
  const cwd = manager.calls.find(({ method }) => method === "thread/start").params.cwd;
  assert.equal(cwd, path.join(root, "task-workspaces", workspaceId));
  const stat = fs.lstatSync(cwd);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(manager.calls), /native-child|taskId|taskProof/);
});

test("foreign notifications are ignored and manager or selection generation changes fail closed", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager({ hold: true });
  let current = true;
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const result = transport.stream(request({
    assertCurrent: async () => {
      if (!current) {
        const error = new Error("changed");
        error.code = "CODEX_INFERENCE_STALE";
        throw error;
      }
    },
  }));
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  await waitFor(() => manager.calls.some(({ method }) => method === "turn/start"));
  manager.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "foreign", turnId: "turn-1", itemId: "item", delta: "private" },
  });
  manager.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "foreign", itemId: "item", delta: "private" },
  });
  current = false;
  manager.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item", delta: "stale" },
  });
  await assert.rejects(pending, { code: "CODEX_INFERENCE_STALE" });
  assert.doesNotMatch(String((await pending.catch((error) => error))?.stack), /private|Users|token/);
});

test("caller cancellation interrupts the exact turn and disposal rejects active work", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager({ hold: true });
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const controller = new AbortController();
  const result = transport.stream(request({ signal: controller.signal }));
  const pending = result.fullStream[Symbol.asyncIterator]().next();
  await waitFor(() => manager.calls.some(({ method }) => method === "turn/start"));
  controller.abort(new Error("private /Users/person token"));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CODEX_INFERENCE_CANCELLED");
    assert.doesNotMatch(String(error.stack), /private|Users|token/);
    return true;
  });
  await waitFor(() => manager.calls.some(({ method }) => method === "turn/interrupt"));
  assert.deepEqual(manager.calls.at(-1).params, { threadId: "thread-1", turnId: "turn-1" });

  const next = transport.stream(request({ invocationId: "invocation-2" }));
  const nextPending = next.fullStream[Symbol.asyncIterator]().next();
  await waitFor(() => manager.calls.filter(({ method }) => method === "turn/start").length === 2);
  transport.dispose();
  transport.dispose();
  await assert.rejects(nextPending, { code: "CODEX_INFERENCE_DISPOSED" });
  assert.throws(() => transport.stream(request()), { code: "CODEX_INFERENCE_DISPOSED" });
});

test("selection changes while turn/start is in flight interrupt the returned exact turn", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  let releaseTurn;
  let current = true;
  const manager = new FakeManager({ hold: true });
  const originalRequest = manager.request.bind(manager);
  manager.request = async (method, params, options) => {
    if (method !== "turn/start") return originalRequest(method, params, options);
    manager.calls.push({ method, params, options });
    return new Promise((resolve) => {
      releaseTurn = () => resolve({ turn: { id: "turn-held" } });
    });
  };
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const result = transport.stream(request({
    assertCurrent: async () => {
      if (!current) throw new Error("selection changed");
    },
  }));
  const pending = result.fullStream[Symbol.asyncIterator]().next();
  await waitFor(() => typeof releaseTurn === "function");
  current = false;
  releaseTurn();
  await assert.rejects(pending, { code: "CODEX_INFERENCE_STALE" });
  await waitFor(() => manager.calls.some(({ method }) => method === "turn/interrupt"));
  assert.deepEqual(manager.calls.at(-1).params, {
    threadId: "thread-1",
    turnId: "turn-held",
  });
});

test("cancellation and disposal while turn/start is held interrupt the returned exact turn", async (t) => {
  for (const mode of ["cancel", "dispose"]) {
    await t.test(mode, async () => {
      const { CodexDirectInferenceTransport } = require(transportPath);
      let releaseTurn;
      const manager = new FakeManager({ hold: true });
      const originalRequest = manager.request.bind(manager);
      manager.request = async (method, params, options) => {
        if (method !== "turn/start") return originalRequest(method, params, options);
        manager.calls.push({ method, params, options });
        return new Promise((resolve) => {
          releaseTurn = () => resolve({ turn: { id: `turn-${mode}` } });
        });
      };
      const transport = new CodexDirectInferenceTransport({
        manager,
        workspacePath: "/private/codex-bot-empty-workspace",
      });
      const abort = new AbortController();
      const result = transport.stream(request({ signal: abort.signal }));
      const pending = result.fullStream[Symbol.asyncIterator]().next();
      await waitFor(() => typeof releaseTurn === "function");
      if (mode === "cancel") abort.abort();
      else transport.dispose();
      releaseTurn();
      await assert.rejects(pending, {
        code: mode === "cancel" ? "CODEX_INFERENCE_CANCELLED" : "CODEX_INFERENCE_DISPOSED",
      });
      await waitFor(() => manager.calls.some(({ method }) => method === "turn/interrupt"));
      assert.deepEqual(manager.calls.at(-1).params, {
        threadId: "thread-1",
        turnId: `turn-${mode}`,
      });
      transport.dispose();
    });
  }
});

test("official Codex preserves Grok host functions as app-server dynamic tool calls", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager({ toolCall: true });
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const tools = Object.freeze([Object.freeze({
    type: "function",
    name: "send_message",
    description: "Send a message",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({ text: Object.freeze({ type: "string" }) }),
      required: Object.freeze(["text"]),
    }),
  })]);
  const result = transport.stream(request({ tools, toolChoice: "auto" }));
  assert.deepEqual(await collect(result.fullStream), [
    { type: "tool-call-streaming-start", toolCallId: "call-1", toolName: "send_message" },
    { type: "tool-call", toolCallId: "call-1", toolName: "send_message", args: { text: "hello" } },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    },
  ]);
  assert.deepEqual(manager.calls[0].params.dynamicTools, [{
    type: "function",
    name: "send_message",
    description: "Send a message",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  }]);
  assert.deepEqual(manager.declined, [44]);
  assert.deepEqual((await result.response).messages[0].content, [{
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "send_message",
    args: { text: "hello" },
  }]);
});

test("named tool choice is enforced and cannot complete as ordinary text", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager();
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const tools = Object.freeze([
    Object.freeze({
      type: "function",
      name: "first",
      parameters: Object.freeze({ type: "object", properties: Object.freeze({}) }),
    }),
    Object.freeze({
      type: "function",
      name: "second",
      parameters: Object.freeze({ type: "object", properties: Object.freeze({}) }),
    }),
  ]);
  const result = transport.stream(request({ tools, toolChoice: Object.freeze({ toolName: "first" }) }));
  const observed = [];
  await assert.rejects(async () => {
    for await (const event of result.fullStream) observed.push(event);
  }, { code: "CODEX_INFERENCE_FAILED" });
  assert.deepEqual(observed, []);
  assert.deepEqual(manager.calls[0].params.dynamicTools.map(({ name }) => name), ["first"]);
});

test("official Codex sends image inputs through the native app-server image modality", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager();
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const result = transport.stream(request({
    messages: Object.freeze([
      Object.freeze({
        role: "user",
        content: Object.freeze([
          Object.freeze({ type: "text", text: "Inspect this image" }),
          Object.freeze({ type: "image", data: "aGVsbG8=", mimeType: "image/png" }),
        ]),
      }),
    ]),
  }));
  await collect(result.fullStream);
  const input = manager.calls.find(({ method }) => method === "turn/start").params.input;
  assert.equal(input.some(({ type }) => type === "image"), true);
  const image = input.find(({ type }) => type === "image");
  assert.deepEqual(image, {
    type: "image",
    url: "data:image/png;base64,aGVsbG8=",
    detail: null,
  });
  assert.doesNotMatch(input.filter(({ type }) => type === "text").map(({ text }) => text).join("\n"), /aGVsbG8=/);
});

test("hostile payloads, malformed tool requests, and failed turns expose only fixed errors", async () => {
  const { CodexDirectInferenceTransport } = require(transportPath);
  const manager = new FakeManager({ hold: true });
  const transport = new CodexDirectInferenceTransport({
    manager,
    workspacePath: "/private/codex-bot-empty-workspace",
  });
  const hostile = new Proxy([], { getOwnPropertyDescriptor() { throw new Error("private token"); } });
  assert.throws(() => transport.stream(request({ messages: hostile })), {
    code: "CODEX_INFERENCE_PAYLOAD_INVALID",
  });
  assert.throws(() => transport.stream(request({
    tools: Object.freeze([{ type: "function", name: "shell command", parameters: {} }]),
  })), { code: "CODEX_INFERENCE_PAYLOAD_INVALID" });
  assert.equal(manager.startCalls, 0);

  const result = transport.stream(request());
  const pending = result.fullStream[Symbol.asyncIterator]().next();
  await waitFor(() => manager.calls.some(({ method }) => method === "turn/start"));
  manager.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        items: [],
        error: { message: "private /Users/person token endpoint" },
      },
    },
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CODEX_INFERENCE_FAILED");
    assert.doesNotMatch(String(error.stack), /private|Users|token|endpoint/);
    return true;
  });
});
