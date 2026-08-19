"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const serverPath = path.join(__dirname, "..", "src", "desktop", "inference-bridge-server.cjs");
const clientPath = path.join(__dirname, "..", "src", "bridge", "inference-socket-client.cjs");

const BOT_UUID = "11111111-1111-4111-8111-111111111111";
const BOT_ID = `bot-${BOT_UUID}`;
const CAPABILITY = "a".repeat(64);
const TARGET_ID = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function computerTarget(taskId, overrides = {}) {
  return Object.freeze({
    mode: "local",
    botId: BOT_ID,
    targetId: TARGET_ID,
    targetGeneration: 4,
    workspaceId: `workspace-${(taskId === "parent" ? "a" : "b").repeat(64)}`,
    tools: Object.freeze(["shell.execute", "browser.navigate", "browser.capture"]),
    ...overrides,
  });
}

function capturedFrame() {
  return Object.freeze({
    frameId: `frame-${"d".repeat(64)}`,
    width: 1024,
    height: 680,
    mimeType: "image/png",
  });
}

function stableComputerTargetRouter() {
  return Object.freeze({
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() { return Object.freeze({ state: "ready" }); },
    async disposeTask() {},
  });
}

function config(overrides = {}) {
  const endpoint = overrides.endpoint;
  const credential = overrides.credential ?? CAPABILITY;
  const publicOverrides = { ...overrides };
  delete publicOverrides.endpoint;
  delete publicOverrides.credential;
  const value = {
    botId: BOT_UUID,
    generation: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: "priority",
    ...publicOverrides,
  };
  Object.defineProperties(value, {
    endpoint: { value: endpoint, enumerable: false },
    credential: { value: credential, enumerable: false },
  });
  return Object.freeze(value);
}

function prompt(overrides = {}) {
  return {
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    invocationId: "invocation-1",
    ...overrides,
  };
}

test("private socket config accepts canonical dynamic API and local model identities", () => {
  const { InferenceSocketClient } = require(clientPath);
  const fakeNet = { createConnection() { throw new Error("not reached"); } };
  for (const provider of ["openai-api-key", "local-openai-compatible"]) {
    assert.doesNotThrow(() => new InferenceSocketClient({
      config: config({ endpoint: "tcp://127.0.0.1:43123", provider, model: provider === "openai-api-key" ? "gpt-live" : "llama-local", reasoningEffort: provider === "openai-api-key" ? "high" : "none", serviceTier: null }),
      conversationId: "conversation-1",
      taskId: "task-1",
      netImpl: fakeNet,
    }));
  }
});

async function withBridge(t, router, computerTargetRouter = stableComputerTargetRouter()) {
  const { InferenceBridgeServer } = require(serverPath);
  const server = new InferenceBridgeServer({ router, computerTargetRouter, capability: CAPABILITY });
  const session = await server.start();
  t.after(() => server.dispose());
  return { server, session };
}

async function collect(stream) {
  const values = [];
  for await (const value of stream) values.push(value);
  return values;
}

function providerResult(events, overrides = {}) {
  const invocationId = overrides.invocationId ?? "invocation-1";
  const usage = overrides.usage ?? Object.freeze({
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
  });
  return Object.freeze({
    fullStream: (async function* () {
      for (const event of events) yield Object.freeze(event);
    })(),
    usage: Promise.resolve(usage),
    extendedUsage: Promise.resolve(overrides.extendedUsage ?? Object.freeze({
      inputTokens: usage.promptTokens ?? 0,
      outputTokens: usage.completionTokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    })),
    providerMetadata: Promise.resolve(overrides.providerMetadata ?? Object.freeze({
      provider: "fixture",
    })),
    invocationId: Promise.resolve(invocationId),
    response: Promise.resolve(overrides.response ?? Object.freeze({
      id: invocationId,
      timestamp: new Date("2026-08-14T12:00:00.000Z"),
      modelId: overrides.modelId ?? "gpt-5.6-sol",
      messages: Object.freeze([]),
    })),
  });
}

test("the private loopback bridge streams official inference without exposing provider credentials", async (t) => {
  const received = [];
  const router = {
    async stream(request) {
      received.push(request);
      return {
        fullStream: (async function* () {
          yield Object.freeze({ type: "text-delta", textDelta: "hello" });
          yield Object.freeze({
            type: "finish",
            finishReason: "stop",
            usage: Object.freeze({ promptTokens: 3, completionTokens: 2, totalTokens: 5 }),
          });
        })(),
        usage: Promise.resolve(Object.freeze({ promptTokens: 3, completionTokens: 2, totalTokens: 5 })),
        extendedUsage: Promise.resolve(Object.freeze({
          inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 100,
        })),
        providerMetadata: Promise.resolve(Object.freeze({ codex: Object.freeze({ model: "gpt-5.6-sol" }) })),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve(Object.freeze({
          id: "invocation-1",
          timestamp: new Date("2026-08-14T12:00:00.000Z"),
          modelId: "gpt-5.6-sol",
          messages: Object.freeze([Object.freeze({
            id: "invocation-1", role: "assistant", content: Object.freeze([Object.freeze({ type: "text", text: "hello" })]),
          })]),
        })),
      };
    },
  };
  const { session } = await withBridge(t, router);
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "parent",
  });
  t.after(() => client.dispose());
  const result = client.stream(prompt());
  assert.deepEqual(await collect(result.fullStream), [
    { type: "text-delta", textDelta: "hello" },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
  ]);
  assert.deepEqual(await result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal((await result.response).timestamp.toISOString(), "2026-08-14T12:00:00.000Z");
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].selection, {
    botId: `bot-${BOT_UUID}`,
    generation: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: "priority",
  });
  assert.equal(received[0].conversationId, "conversation-1");
  assert.equal(typeof received[0].taskId, "undefined");
  assert.equal(typeof received[0].computer, "undefined");
  assert.equal(typeof received[0].workspaceId, "undefined");
  assert.equal(typeof received[0].assertCurrent, "undefined");
  assert.equal(received[0].signal instanceof AbortSignal, true);
  assert.doesNotMatch(JSON.stringify(received), /aaaa|credential|endpoint|Authorization|CLIProxy/);
});

test("main replaces native Grok child tools with the exact reviewed Local Computer catalog", async (t) => {
  const resolved = [];
  const received = [];
  const currentChecks = [];
  const disposals = [];
  const computerTargetRouter = {
    async resolve(value) {
      resolved.push(value);
      return computerTarget(value.taskId);
    },
    async assertTaskCurrent(value) { currentChecks.push(value); },
    async run() { throw new Error("must not run without a tool call"); },
    async disposeTask(value) { disposals.push(value); },
  };
  const router = {
    stream(request) {
      received.push(request);
      return {
        fullStream: (async function* () {
          yield { type: "finish", finishReason: "stop", usage: {} };
        })(),
        usage: Promise.resolve({}),
        extendedUsage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({
          id: "invocation-1",
          timestamp: new Date("2026-08-14T12:00:00.000Z"),
          modelId: "gpt-5.6-sol",
          messages: [],
        }),
      };
    },
  };
  const { session } = await withBridge(t, router, computerTargetRouter);
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await collect(client.stream(prompt({
    tools: [{ type: "function", name: "browser_navigate", inputSchema: { type: "object" } }],
    toolChoice: "auto",
  })).fullStream);
  assert.equal(resolved.length, 1);
  assert.equal(resolved.every((value) => value.botId === BOT_ID
    && value.conversationId === "conversation-1"
    && value.taskId === "native-child-transcript"), true);
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]).sort(), [
    "conversationId", "invocationId", "messages", "selection", "signal", "toolChoice", "tools", "workspaceId",
  ]);
  assert.equal(received[0].workspaceId, `workspace-${"b".repeat(64)}`);
  assert.deepEqual(received[0].tools, [
    {
      type: "function",
      name: "browser_navigate",
      description: "Open a public HTTPS page in this bot's Local Desktop browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", format: "uri" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "browser_capture",
      description: "Inspect metadata for this bot's current Local Desktop browser frame.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "shell_execute",
      description: "Run one bounded full-host command after explicit permission. Output is returned only as metadata.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", maxLength: 8192 } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ]);
  assert.equal(received[0].toolChoice, "auto");
  assert.equal(currentChecks.length >= 1, true);
  assert.equal(currentChecks.every((value) => value.botId === BOT_ID
    && value.taskId === "native-child-transcript"
    && value.targetId === TARGET_ID
    && value.targetGeneration === 4
    && value.workspaceId === `workspace-${"b".repeat(64)}`), true);
  assert.deepEqual(disposals, [{ botId: BOT_ID, taskId: "native-child-transcript" }]);
  assert.doesNotMatch(JSON.stringify(received), /native-child-transcript|taskProof|local-/);
});

test("native Grok child executes one reviewed browser call on its exact target and privately continues inference", async (t) => {
  const requests = [];
  const runs = [];
  const currentChecks = [];
  const disposals = [];
  const router = {
    stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        return providerResult([
          { type: "tool-call-streaming-start", toolCallId: "call-browser-1", toolName: "browser_navigate" },
          {
            type: "tool-call",
            toolCallId: "call-browser-1",
            toolName: "browser_navigate",
            args: { url: "https://www.youtube.com/" },
          },
          { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
        ]);
      }
      return providerResult([
        { type: "text-delta", textDelta: "YouTube is open." },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 } },
      ], {
        usage: Object.freeze({ promptTokens: 5, completionTokens: 4, totalTokens: 9 }),
        providerMetadata: Object.freeze({ provider: "direct-final" }),
      });
    },
  };
  const computerTargetRouter = {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent(value) { currentChecks.push(value); },
    async run(value) {
      runs.push(value);
      return Object.freeze({ state: "ready" });
    },
    async disposeTask(value) { disposals.push(value); },
  };
  const { session } = await withBridge(t, router, computerTargetRouter);
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  const result = client.stream(prompt({
    tools: [{
      type: "function",
      name: "spawn_subagent",
      description: "Unreviewed recursive host tool /Users/person token",
      parameters: { type: "object" },
    }],
    toolChoice: { toolName: "spawn_subagent" },
  }));
  const events = await collect(result.fullStream);

  assert.deepEqual(events, [
    { type: "text-delta", textDelta: "YouTube is open." },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 } },
  ]);
  assert.deepEqual(await result.usage, { promptTokens: 5, completionTokens: 4, totalTokens: 9 });
  assert.deepEqual(await result.providerMetadata, { provider: "direct-final" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ tools }) => tools.map(({ name }) => name)), [
    ["browser_navigate", "browser_capture", "shell_execute"],
    ["browser_navigate", "browser_capture", "shell_execute"],
  ]);
  assert.equal(requests.every((request) => request.toolChoice === "auto"
    && request.workspaceId === `workspace-${"b".repeat(64)}`), true);
  assert.deepEqual(requests[1].messages.slice(-2), [
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "call-browser-1",
        toolName: "browser_navigate",
        args: { url: "https://www.youtube.com/" },
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-browser-1",
        toolName: "browser_navigate",
        result: { content: [{ type: "text", text: '{"state":"ready"}' }] },
        isError: false,
      }],
    },
  ]);
  assert.deepEqual(runs, [{
    mode: "local",
    botId: BOT_ID,
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
    targetId: TARGET_ID,
    targetGeneration: 4,
    workspaceId: `workspace-${"b".repeat(64)}`,
    capability: "browser.navigate",
    operation: "browser.navigate",
    arguments: { url: "https://www.youtube.com/" },
    resourceId: "browser",
    resourceLabel: "OpenBot Browser",
    reason: "Open a page in this bot's browser",
  }]);
  assert.equal(currentChecks.length >= 4, true);
  assert.deepEqual(disposals, [{ botId: BOT_ID, taskId: "native-child-transcript" }]);
  assert.doesNotMatch(JSON.stringify(requests), /spawn_subagent|Unreviewed recursive|taskProof/);
  assert.doesNotMatch(JSON.stringify(events), /tool-call|tool-result|Users|token|local-|workspace-/);
});

test("Computer-unavailable native child fallback suppresses every non-text provider event", async (t) => {
  const requests = [];
  let runs = 0;
  const { session } = await withBridge(t, {
    stream(request) {
      requests.push(request);
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: "call-recursive", toolName: "spawn_subagent" },
        {
          type: "tool-call",
          toolCallId: "call-recursive",
          toolName: "spawn_subagent",
          args: { prompt: "read /Users/person/private-token" },
        },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve() {
      const error = new Error("Computer unavailable /Users/person/private-token");
      error.code = "OPENBOT_COMPUTER_NOT_CONFIGURED";
      throw error;
    },
    async run() { runs += 1; throw new Error("must not run"); },
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  const observed = [];
  let caught = null;
  try {
    for await (const event of client.stream(prompt({
      tools: [{ type: "function", name: "spawn_subagent", parameters: { type: "object" } }],
      toolChoice: "auto",
    })).fullStream) observed.push(event);
  } catch (error) {
    caught = error;
  }

  assert.deepEqual(observed, []);
  assert.equal(caught?.code, "CODEX_BRIDGE_UNAVAILABLE");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].toolChoice, "none");
  assert.equal(runs, 0);
  assert.doesNotMatch(JSON.stringify(observed), /spawn_subagent|tool-call|Users|private-token/);
});

test("native child continuations expose only operation-specific public Computer results", async (t) => {
  const requests = [];
  const privateWorkspace = `workspace-${"c".repeat(64)}`;
  const publicFrameId = `frame-${"d".repeat(64)}`;
  const privateResult = {
    botId: BOT_ID,
    targetId: TARGET_ID,
    targetGeneration: 4,
    partition: "persist:/Users/person/private-token",
    workspaceId: privateWorkspace,
  };
  const { session } = await withBridge(t, {
    stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        return providerResult([
          { type: "tool-call-streaming-start", toolCallId: "call-public-nav", toolName: "browser_navigate" },
          {
            type: "tool-call",
            toolCallId: "call-public-nav",
            toolName: "browser_navigate",
            args: { url: "https://www.youtube.com/" },
          },
          { type: "tool-call-streaming-start", toolCallId: "call-public-frame", toolName: "browser_capture" },
          { type: "tool-call", toolCallId: "call-public-frame", toolName: "browser_capture", args: {} },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      }
      return providerResult([{ type: "finish", finishReason: "stop", usage: {} }]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run(action) {
      if (action.operation === "browser.navigate") {
        return Object.freeze({ ...privateResult, state: "ready" });
      }
      return Object.freeze({
        ...privateResult,
        frameId: publicFrameId,
        width: 1280,
        height: 720,
        mimeType: "image/png",
      });
    },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await collect(client.stream(prompt()).fullStream);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.at(-1), {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-public-nav",
        toolName: "browser_navigate",
        result: { content: [{ type: "text", text: '{"state":"ready"}' }] },
        isError: false,
      },
      {
        type: "tool-result",
        toolCallId: "call-public-frame",
        toolName: "browser_capture",
        result: { content: [{
          type: "text",
          text: JSON.stringify({
            frameId: publicFrameId,
            width: 1280,
            height: 720,
            mimeType: "image/png",
          }),
        }] },
        isError: false,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(requests[1].messages.slice(-2)), /botId|targetId|targetGeneration|partition|workspaceId|Users|private-token/);
});

test("cancellation remains target-bound while native child Computer resolution is held", async (t) => {
  await t.test("a target resolving after cancellation is disposed before inference", async (subtest) => {
    let entered = false;
    let releaseResolve;
    let receivedSignal;
    let providerCalls = 0;
    const disposals = [];
    const held = new Promise((resolve) => { releaseResolve = resolve; });
    const { session } = await withBridge(subtest, {
      stream() { providerCalls += 1; throw new Error("must not infer"); },
    }, {
      async resolve(_identity, signal) {
        receivedSignal = signal;
        entered = true;
        return held;
      },
      async assertTaskCurrent() {},
      async run() { throw new Error("must not run"); },
      async disposeTask(value) { disposals.push(value); },
    });
    const { InferenceSocketClient } = require(clientPath);
    const controller = new AbortController();
    const client = new InferenceSocketClient({
      config: config({ endpoint: session.endpoint }),
      conversationId: "conversation-1",
      taskId: "native-child-transcript",
    });
    subtest.after(() => client.dispose());

    const pending = collect(client.stream(prompt({ signal: controller.signal })).fullStream);
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("private caller cancellation /Users/person/token"));
    await assert.rejects(pending, { code: "CODEX_BRIDGE_CANCELLED" });
    for (let attempt = 0; attempt < 20 && !receivedSignal?.aborted; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseResolve(computerTarget("native-child-transcript"));
    for (let attempt = 0; attempt < 20 && disposals.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual({
      receivedAbortSignal: receivedSignal instanceof AbortSignal,
      receivedSignalAborted: receivedSignal?.aborted ?? false,
      providerCalls,
      disposals,
    }, {
      receivedAbortSignal: true,
      receivedSignalAborted: true,
      providerCalls: 0,
      disposals: [{ botId: BOT_ID, taskId: "native-child-transcript" }],
    });
  });

  await t.test("an unavailable result resolving after cancellation cannot start fallback inference", async (subtest) => {
    let entered = false;
    let rejectResolve;
    let receivedSignal;
    let providerCalls = 0;
    const held = new Promise((_resolve, reject) => { rejectResolve = reject; });
    const { session } = await withBridge(subtest, {
      stream() {
        providerCalls += 1;
        return providerResult([{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    }, {
      async resolve(_identity, signal) {
        receivedSignal = signal;
        entered = true;
        return held;
      },
    });
    const { InferenceSocketClient } = require(clientPath);
    const controller = new AbortController();
    const client = new InferenceSocketClient({
      config: config({ endpoint: session.endpoint }),
      conversationId: "conversation-1",
      taskId: "native-child-transcript",
    });
    subtest.after(() => client.dispose());

    const pending = collect(client.stream(prompt({ signal: controller.signal })).fullStream);
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("private caller cancellation /Users/person/token"));
    await assert.rejects(pending, { code: "CODEX_BRIDGE_CANCELLED" });
    for (let attempt = 0; attempt < 20 && !receivedSignal?.aborted; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const unavailable = new Error("private unavailable /Users/person/token");
    unavailable.code = "OPENBOT_COMPUTER_NOT_CONFIGURED";
    rejectResolve(unavailable);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual({
      receivedAbortSignal: receivedSignal instanceof AbortSignal,
      receivedSignalAborted: receivedSignal?.aborted ?? false,
      providerCalls,
    }, {
      receivedAbortSignal: true,
      receivedSignalAborted: true,
      providerCalls: 0,
    });
  });
});

test("native child rejects argument deltas after a reviewed tool call was finalized", async (t) => {
  let providerCalls = 0;
  let runs = 0;
  const { session } = await withBridge(t, {
    stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
        return providerResult([
          { type: "tool-call-streaming-start", toolCallId: "call-finalized", toolName: "browser_navigate" },
          {
            type: "tool-call",
            toolCallId: "call-finalized",
            toolName: "browser_navigate",
            args: { url: "https://www.youtube.com/" },
          },
          {
            type: "tool-call-delta",
            toolCallId: "call-finalized",
            toolName: "browser_navigate",
            argsTextDelta: '{"url":"https://private.invalid/"}',
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      }
      return providerResult([{ type: "finish", finishReason: "stop", usage: {} }]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() { runs += 1; return Object.freeze({ state: "ready" }); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  let caught = null;
  try { await collect(client.stream(prompt()).fullStream); } catch (error) { caught = error; }
  assert.deepEqual({ code: caught?.code ?? null, providerCalls, runs }, {
    code: "CODEX_BRIDGE_UNAVAILABLE",
    providerCalls: 1,
    runs: 0,
  });
});

test("native Grok child rejects a Computer capability the exact target did not advertise", async (t) => {
  let providerCalls = 0;
  let runs = 0;
  const advertised = [];
  const { session } = await withBridge(t, {
    stream(request) {
      providerCalls += 1;
      advertised.push(request.tools.map(({ name }) => name));
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: "call-denied", toolName: "shell_execute" },
        {
          type: "tool-call",
          toolCallId: "call-denied",
          toolName: "shell_execute",
          args: { command: "printf private" },
        },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve(value) {
      return computerTarget(value.taskId, {
        tools: Object.freeze(["browser.navigate", "browser.capture"]),
      });
    },
    async assertTaskCurrent() {},
    async run() { runs += 1; throw new Error("must not run"); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await assert.rejects(collect(client.stream(prompt()).fullStream), (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_UNAVAILABLE");
    assert.doesNotMatch(String(error.stack), /printf|private|shell_execute|Users|token/);
    return true;
  });
  assert.equal(providerCalls, 1);
  assert.equal(runs, 0);
  assert.deepEqual(advertised, [["browser_navigate", "browser_capture"]]);
});

test("native Grok child rejects malformed reviewed-tool arguments before Computer dispatch", async (t) => {
  let runs = 0;
  const { session } = await withBridge(t, {
    stream() {
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: "call-malformed", toolName: "browser_navigate" },
        {
          type: "tool-call",
          toolCallId: "call-malformed",
          toolName: "browser_navigate",
          args: { url: "https://www.youtube.com/", privatePath: "/Users/person/token" },
        },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() { runs += 1; throw new Error("must not run"); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await assert.rejects(collect(client.stream(prompt()).fullStream), (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_UNAVAILABLE");
    assert.doesNotMatch(String(error.stack), /Users|person|token|privatePath/);
    return true;
  });
  assert.equal(runs, 0);
});

test("native Grok child rejects a duplicate tool-call ID across continuation rounds", async (t) => {
  let providerCalls = 0;
  let runs = 0;
  const { session } = await withBridge(t, {
    stream() {
      providerCalls += 1;
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: "call-duplicate", toolName: "browser_capture" },
        { type: "tool-call", toolCallId: "call-duplicate", toolName: "browser_capture", args: {} },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() { runs += 1; return capturedFrame(); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await assert.rejects(collect(client.stream(prompt()).fullStream), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  assert.equal(providerCalls, 2);
  assert.equal(runs, 1);
});

test("cancelling a native Grok child during Computer dispatch disposes only its exact target task", async (t) => {
  let runEntered = false;
  let rejectRun;
  const disposals = [];
  let providerCalls = 0;
  const { session } = await withBridge(t, {
    stream() {
      providerCalls += 1;
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: "call-cancel", toolName: "browser_capture" },
        { type: "tool-call", toolCallId: "call-cancel", toolName: "browser_capture", args: {} },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() {
      runEntered = true;
      return new Promise((_resolve, reject) => { rejectRun = reject; });
    },
    async disposeTask(value) {
      disposals.push(value);
      rejectRun?.(new Error("private cancelled run /Users/person token"));
    },
  });
  const { InferenceSocketClient } = require(clientPath);
  const controller = new AbortController();
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  const pending = collect(client.stream(prompt({ signal: controller.signal })).fullStream);
  for (let attempt = 0; attempt < 20 && !runEntered; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runEntered, true);
  controller.abort(new Error("private caller cancellation /Users/person token"));
  await assert.rejects(pending, { code: "CODEX_BRIDGE_CANCELLED" });
  for (let attempt = 0; attempt < 20 && disposals.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(disposals, [{ botId: BOT_ID, taskId: "native-child-transcript" }]);
  assert.equal(providerCalls, 1);
});

test("native Grok child re-fences the exact Computer target after dispatch before provider continuation", async (t) => {
  let generation = 4;
  let providerCalls = 0;
  let runs = 0;
  const { session } = await withBridge(t, {
    stream() {
      providerCalls += 1;
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: "call-stale", toolName: "browser_capture" },
        { type: "tool-call", toolCallId: "call-stale", toolName: "browser_capture", args: {} },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve(value) {
      return computerTarget(value.taskId, {
        targetGeneration: generation,
        workspaceId: `workspace-${(generation === 4 ? "b" : "c").repeat(64)}`,
      });
    },
    async assertTaskCurrent(value) {
      if (generation !== value.targetGeneration) {
        const error = new Error("stale target /Users/person token");
        error.code = "OPENBOT_COMPUTER_TARGET_STALE";
        throw error;
      }
    },
    async run() {
      runs += 1;
      generation = 5;
      return Object.freeze({ state: "ready" });
    },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await assert.rejects(collect(client.stream(prompt()).fullStream), (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_UNAVAILABLE");
    assert.doesNotMatch(String(error.stack), /stale target|Users|person|token/);
    return true;
  });
  assert.equal(runs, 1);
  assert.equal(providerCalls, 1);
});

test("native Grok child supports bounded multi-round browser and reviewed-shell continuations", async (t) => {
  const requests = [];
  const runs = [];
  const { session } = await withBridge(t, {
    stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        return providerResult([
          { type: "tool-call-streaming-start", toolCallId: "call-nav", toolName: "browser_navigate" },
          {
            type: "tool-call", toolCallId: "call-nav", toolName: "browser_navigate",
            args: { url: "https://www.youtube.com/" },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      }
      if (requests.length === 2) {
        return providerResult([
          { type: "tool-call-streaming-start", toolCallId: "call-shell", toolName: "shell_execute" },
          { type: "tool-call", toolCallId: "call-shell", toolName: "shell_execute", args: { command: "printf openbot-ok" } },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      }
      return providerResult([
        { type: "text-delta", textDelta: "Both tasks finished." },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 } },
      ]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run(value) {
      runs.push(value);
      if (value.operation === "shell.execute") {
        return Object.freeze({ exitCode: 0, stdout: "openbot-ok /Users/person token", stderr: "" });
      }
      return Object.freeze({ state: "ready" });
    },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  assert.deepEqual(await collect(client.stream(prompt()).fullStream), [
    { type: "text-delta", textDelta: "Both tasks finished." },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 } },
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].messages.length, 3);
  assert.equal(requests[2].messages.length, 5);
  assert.deepEqual(runs.map(({ operation }) => operation), ["browser.navigate", "shell.execute"]);
  assert.deepEqual(requests[2].messages.at(-1), {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "call-shell",
      toolName: "shell_execute",
      result: { content: [{
        type: "text",
        text: JSON.stringify({
          exitCode: 0,
          stdout: {
            bytes: 30,
            sha256: "48841f20c835123f525b84a2638862967213acd972126e6e1288ceab8b422662",
          },
          stderr: {
            bytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        }),
      }] },
      isError: false,
    }],
  });
  assert.doesNotMatch(JSON.stringify(requests[2]), /Users|person|token|openbot-ok \/Users/);
});

test("native Grok child fails closed before a ninth reviewed tool round", async (t) => {
  let providerCalls = 0;
  let runs = 0;
  const { session } = await withBridge(t, {
    stream() {
      providerCalls += 1;
      const id = `call-round-${providerCalls}`;
      return providerResult([
        { type: "tool-call-streaming-start", toolCallId: id, toolName: "browser_capture" },
        { type: "tool-call", toolCallId: id, toolName: "browser_capture", args: {} },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() { runs += 1; return capturedFrame(); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await assert.rejects(collect(client.stream(prompt()).fullStream), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  assert.equal(providerCalls, 9);
  assert.equal(runs, 8);
});

test("reviewed native child Computer continuations preserve optional Fable provider selection", async (t) => {
  const requests = [];
  let runs = 0;
  const { session } = await withBridge(t, {
    stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        return providerResult([
          { type: "tool-call-streaming-start", toolCallId: "call-fable", toolName: "browser_capture" },
          { type: "tool-call", toolCallId: "call-fable", toolName: "browser_capture", args: {} },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ], { modelId: "claude-fable-5" });
      }
      return providerResult([
        { type: "text-delta", textDelta: "Fable inspected the frame." },
        { type: "finish", finishReason: "stop", usage: {} },
      ], { modelId: "claude-fable-5" });
    },
  }, {
    async resolve(value) { return computerTarget(value.taskId); },
    async assertTaskCurrent() {},
    async run() { runs += 1; return capturedFrame(); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({
      endpoint: session.endpoint,
      provider: "cliproxy-anthropic",
      model: "claude-fable-5",
      reasoningEffort: "ultra-code",
      serviceTier: null,
    }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  assert.deepEqual(await collect(client.stream(prompt()).fullStream), [
    { type: "text-delta", textDelta: "Fable inspected the frame." },
    { type: "finish", finishReason: "stop", usage: {} },
  ]);
  assert.equal(runs, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests.every(({ selection }) => selection.provider === "anthropic-claude"
    && selection.model === "claude-fable-5"
    && selection.reasoningEffort === "ultra-code"
    && selection.serviceTier === null), true);
  assert.deepEqual(requests.map(({ tools }) => tools.map(({ name }) => name)), [
    ["browser_navigate", "browser_capture", "shell_execute"],
    ["browser_navigate", "browser_capture", "shell_execute"],
  ]);
});

test("only the three reviewed Computer-unavailable codes keep native children in Chat-only mode", async (t) => {
  for (const code of [
    "OPENBOT_COMPUTER_NOT_CONFIGURED",
    "OPENBOT_CURSOR_COMPUTER_UNAVAILABLE",
    "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE",
  ]) {
    await t.test(code, async (subtest) => {
      const requests = [];
      const { session } = await withBridge(subtest, {
        stream(request) {
          requests.push(request);
          return providerResult([{ type: "finish", finishReason: "stop", usage: {} }]);
        },
      }, {
        async resolve() {
          const error = new Error(`private ${code} /Users/person token`);
          error.code = code;
          throw error;
        },
      });
      const { InferenceSocketClient } = require(clientPath);
      const client = new InferenceSocketClient({
        config: config({ endpoint: session.endpoint }),
        conversationId: "conversation-1",
        taskId: "native-child-transcript",
      });
      subtest.after(() => client.dispose());
      await collect(client.stream(prompt()).fullStream);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].tools, []);
      assert.equal(requests[0].toolChoice, "none");
      assert.match(requests[0].workspaceId, /^workspace-[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(requests), /Users|person|token|OPENBOT_|native-child/);
    });
  }
});

test("unknown, stale, and cross-bot Computer targets reject before child inference", async (t) => {
  const scenarios = [
    {
      name: "unknown unavailable code",
      resolve() {
        const error = new Error("private unknown /Users/person token");
        error.code = "OPENBOT_COMPUTER_TARGET_UNAVAILABLE";
        throw error;
      },
    },
    {
      name: "initial stale target",
      resolve() {
        const error = new Error("private stale /Users/person token");
        error.code = "OPENBOT_COMPUTER_TARGET_STALE";
        throw error;
      },
    },
    {
      name: "cross-bot target",
      resolve(value) {
        return computerTarget(value.taskId, {
          botId: "bot-22222222-2222-4222-8222-222222222222",
        });
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      let providerCalls = 0;
      const { session } = await withBridge(subtest, {
        stream() { providerCalls += 1; throw new Error("must not infer"); },
      }, { resolve: scenario.resolve });
      const { InferenceSocketClient } = require(clientPath);
      const client = new InferenceSocketClient({
        config: config({ endpoint: session.endpoint }),
        conversationId: "conversation-1",
        taskId: "native-child-transcript",
      });
      subtest.after(() => client.dispose());
      await assert.rejects(collect(client.stream(prompt()).fullStream), (error) => {
        assert.equal(error.code, "CODEX_BRIDGE_UNAVAILABLE");
        assert.doesNotMatch(String(error.stack), /private|Users|person|token|stale|unknown/);
        return true;
      });
      assert.equal(providerCalls, 0);
    });
  }
});

test("pure-text native child inference falls back only as Chat with no configured Computer", async (t) => {
  let computerCalls = 0;
  const received = [];
  const { session } = await withBridge(t, {
    stream(request) {
      received.push(request);
      return {
        fullStream: (async function* () {
          yield { type: "finish", finishReason: "stop", usage: {} };
        })(),
        usage: Promise.resolve({}),
        extendedUsage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({
          id: "invocation-1",
          timestamp: new Date("2026-08-14T12:00:00.000Z"),
          modelId: "gpt-5.6-sol",
          messages: [],
        }),
      };
    },
  }, {
    async resolve() {
      computerCalls += 1;
      const error = new Error("not configured /Users/person token");
      error.code = "OPENBOT_COMPUTER_NOT_CONFIGURED";
      throw error;
    },
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());

  await collect(client.stream(prompt({
    tools: [{ type: "function", name: "browser_navigate", inputSchema: { type: "object" } }],
    toolChoice: "auto",
  })).fullStream);
  assert.equal(computerCalls >= 1, true);
  assert.equal(received.length, 1);
  assert.match(received[0].workspaceId, /^workspace-[a-f0-9]{64}$/);
  assert.deepEqual(received[0].tools, []);
  assert.equal(received[0].toolChoice, "none");
  assert.equal(typeof received[0].taskId, "undefined");
  assert.equal(typeof received[0].taskProof, "undefined");
  assert.doesNotMatch(JSON.stringify(received), /native-child|Users|token|local-/);
});

test("a native child target change suppresses every later visible inference event", async (t) => {
  let generation = 4;
  let entered = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { session } = await withBridge(t, {
    stream() {
      entered += 1;
      return {
        fullStream: (async function* () {
          await gate;
          yield { type: "text-delta", textDelta: "must stay private" };
        })(),
        usage: Promise.resolve({}), extendedUsage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}), invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({
          id: "invocation-1",
          timestamp: new Date("2026-08-14T12:00:00.000Z"),
          modelId: "gpt-5.6-sol",
          messages: [],
        }),
      };
    },
  }, {
    async resolve(value) {
      return computerTarget(value.taskId, {
        targetGeneration: generation,
        workspaceId: `workspace-${(generation === 4 ? "b" : "c").repeat(64)}`,
      });
    },
    async assertTaskCurrent(value) {
      if (value.targetGeneration !== generation
        || value.workspaceId !== `workspace-${(generation === 4 ? "b" : "c").repeat(64)}`) {
        const error = new Error("target changed");
        error.code = "OPENBOT_COMPUTER_TARGET_STALE";
        throw error;
      }
    },
    async run() { throw new Error("must not run"); },
    async disposeTask() {},
  });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  t.after(() => client.dispose());
  const pending = collect(client.stream(prompt()).fullStream);
  while (entered === 0) await new Promise((resolve) => setImmediate(resolve));
  generation = 5;
  release();
  await assert.rejects(pending, { code: "CODEX_BRIDGE_UNAVAILABLE" });
});

test("missing or malformed task identity frames never bind a Computer or reach inference", async (t) => {
  let targetCalls = 0;
  let providerCalls = 0;
  const { session } = await withBridge(t, {
    stream() { providerCalls += 1; throw new Error("must not infer"); },
  }, {
    resolve() { targetCalls += 1; throw new Error("must not bind"); },
  });
  const port = Number(new URL(session.endpoint).port);
  async function send(request) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let received = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (chunk) => { received += chunk; });
      socket.on("end", () => resolve(received));
      socket.on("connect", () => socket.write(`${JSON.stringify({
        type: "start",
        capability: CAPABILITY,
        request,
      })}\n`));
    });
  }
  const base = {
    selection: {
      botId: BOT_ID,
      generation: 7,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "priority",
    },
    conversationId: "conversation-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    invocationId: "invocation-1",
  };
  for (const request of [
    base,
    { ...base, taskId: "../forged", taskProof: "b".repeat(64) },
    { ...base, taskId: "", taskProof: "b".repeat(64) },
    { ...base, taskId: "native-child-transcript", taskProof: "b".repeat(64) },
  ]) {
    const response = await send(request);
    assert.deepEqual(JSON.parse(response.trim()), {
      type: "error",
      code: "CODEX_BRIDGE_UNAVAILABLE",
    });
  }
  assert.equal(targetCalls, 0);
  assert.equal(providerCalls, 0);
});

test("cancellation while a native child provider start is held suppresses all late work", async (t) => {
  let entered = 0;
  let release;
  let providerCalls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const { session } = await withBridge(t, {
    async stream() {
      providerCalls += 1;
      entered += 1;
      await gate;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "late private" };
        })(),
        usage: Promise.resolve({}), extendedUsage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}), invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({}),
      };
    },
  });
  const { InferenceSocketClient } = require(clientPath);
  const controller = new AbortController();
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
  });
  const pending = collect(client.stream(prompt({ signal: controller.signal })).fullStream);
  while (entered === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("private /Users/person token"));
  await assert.rejects(pending, { code: "CODEX_BRIDGE_CANCELLED" });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, 1);
  assert.equal(providerCalls, 1);
  client.dispose();
});

test("an invalid capability and malformed frames fail closed before the router", async (t) => {
  let calls = 0;
  const { session } = await withBridge(t, { stream() { calls += 1; throw new Error("private"); } });
  const { InferenceSocketClient } = require(clientPath);
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint, credential: "b".repeat(64) }),
    conversationId: "conversation-1",
    taskId: "parent",
  });
  const result = client.stream(prompt());
  await assert.rejects(collect(result.fullStream), (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_UNAVAILABLE");
    assert.doesNotMatch(String(error.stack), /private|Users|aaaa|bbbb|token|endpoint/);
    return true;
  });
  assert.equal(calls, 0);
  client.dispose();
});

test("cancelling or disposing a client aborts the exact main-process operation", async (t) => {
  let aborted = 0;
  let entered = 0;
  const router = {
    stream(request) {
      entered += 1;
      return {
        fullStream: (async function* () {
          await new Promise((resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              aborted += 1;
              reject(request.signal.reason);
            }, { once: true });
          });
          yield null;
        })(),
        usage: new Promise(() => {}),
        extendedUsage: new Promise(() => {}),
        providerMetadata: new Promise(() => {}),
        invocationId: Promise.resolve("invocation-1"),
        response: new Promise(() => {}),
      };
    },
  };
  const { session } = await withBridge(t, router);
  const { InferenceSocketClient } = require(clientPath);
  const controller = new AbortController();
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "parent",
  });
  const result = client.stream(prompt({ signal: controller.signal }));
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  while (entered === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("private /Users/person token"));
  await assert.rejects(pending, { code: "CODEX_BRIDGE_CANCELLED" });
  while (aborted === 0) await new Promise((resolve) => setImmediate(resolve));

  const next = client.stream(prompt({ invocationId: "invocation-2" }));
  const nextPending = next.fullStream[Symbol.asyncIterator]().next();
  while (entered < 2) await new Promise((resolve) => setImmediate(resolve));
  client.dispose();
  await assert.rejects(nextPending, { code: "CODEX_BRIDGE_DISPOSED" });
  while (aborted < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, 2);
});

test("a pre-aborted request never connects or reaches the main-process router", async (t) => {
  let entered = 0;
  const { session } = await withBridge(t, {
    stream() { entered += 1; throw new Error("must not run"); },
  });
  const { InferenceSocketClient } = require(clientPath);
  const controller = new AbortController();
  controller.abort(new Error("private /Users/person token"));
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "parent",
  });
  const result = client.stream(prompt({ signal: controller.signal }));
  await assert.rejects(Promise.race([
    collect(result.fullStream),
    new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100)),
  ]), { code: "CODEX_BRIDGE_CANCELLED" });
  assert.equal(entered, 0);
  client.dispose();
});

test("cancelling or disposing while the private socket is connecting settles without sending", async (t) => {
  const { InferenceSocketClient } = require(clientPath);
  for (const scenario of [
    { name: "cancel", code: "CODEX_BRIDGE_CANCELLED" },
    { name: "dispose", code: "CODEX_BRIDGE_DISPOSED" },
  ]) {
    await t.test(scenario.name, async () => {
      class PendingSocket extends EventEmitter {
        destroyed = false;
        writes = [];
        write(value, callback) { this.writes.push(value); callback(); }
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          this.emit("close");
        }
      }
      const socket = new PendingSocket();
      const controller = new AbortController();
      const client = new InferenceSocketClient({
        config: config({ endpoint: "tcp://127.0.0.1:43123" }),
        conversationId: "conversation-1",
        taskId: "parent",
        netImpl: { createConnection() { return socket; } },
      });
      const result = client.stream(prompt({ signal: controller.signal }));
      const pending = result.fullStream[Symbol.asyncIterator]().next();
      await new Promise((resolve) => setImmediate(resolve));
      if (scenario.name === "cancel") controller.abort(new Error("private token /Users/person"));
      else client.dispose();
      await assert.rejects(Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100)),
      ]), { code: scenario.code });
      assert.equal(socket.destroyed, true);
      assert.deepEqual(socket.writes, []);
      client.dispose();
    });
  }
});

test("selection changes during a streamed reply suppress stale frames", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const router = {
    stream() {
      return {
        fullStream: (async function* () {
          await gate;
          yield { type: "text-delta", textDelta: "stale private" };
        })(),
        usage: Promise.resolve({}),
        extendedUsage: Promise.resolve({}),
        providerMetadata: Promise.resolve({}),
        invocationId: Promise.resolve("invocation-1"),
        response: Promise.resolve({}),
      };
    },
  };
  const { session } = await withBridge(t, router);
  const { InferenceSocketClient } = require(clientPath);
  let current = true;
  const client = new InferenceSocketClient({
    config: config({ endpoint: session.endpoint }),
    conversationId: "conversation-1",
    taskId: "parent",
    isCurrent: () => current,
  });
  const result = client.stream(prompt());
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  current = false;
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CODEX_BRIDGE_STALE");
    assert.doesNotMatch(String(error.stack), /stale private|Users|token/);
    return true;
  });
  client.dispose();
});

test("client frame queues are bounded and destroy the socket synchronously on overflow", async () => {
  const { InferenceSocketClient, MAX_QUEUED_FRAMES } = require(clientPath);
  class FakeSocket extends EventEmitter {
    destroyed = false;
    write(_value, callback) { callback(); }
    destroy() { this.destroyed = true; }
  }
  const socket = new FakeSocket();
  const client = new InferenceSocketClient({
    config: config({ endpoint: "tcp://127.0.0.1:43123" }),
    conversationId: "conversation-1",
    taskId: "parent",
    netImpl: {
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });
  const result = client.stream(prompt());
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const pending = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  const frame = `${JSON.stringify({ type: "event", value: { type: "text-delta", textDelta: "x" } })}\n`;
  socket.emit("data", Buffer.from(frame.repeat(MAX_QUEUED_FRAMES + 2)));
  assert.equal(socket.destroyed, true);
  assert.equal((await pending).value.type, "text-delta");
  await assert.rejects(iterator.next(), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  client.dispose();
});

test("the socket client sends one validated private native task identity", async () => {
  const { InferenceSocketClient } = require(clientPath);
  class FakeSocket extends EventEmitter {
    writes = [];
    write(value, callback) {
      this.writes.push(value);
      callback();
      queueMicrotask(() => this.emit("data", Buffer.from(`${JSON.stringify({
        type: "done",
        usage: {},
        extendedUsage: {},
        providerMetadata: {},
        invocationId: "invocation-1",
        response: {
          id: "invocation-1",
          timestamp: "2026-08-14T12:00:00.000Z",
          modelId: "gpt-5.6-sol",
          messages: [],
        },
      })}\n`)));
    }
    destroy() {}
  }
  const socket = new FakeSocket();
  const client = new InferenceSocketClient({
    config: config({ endpoint: "tcp://127.0.0.1:43123" }),
    conversationId: "conversation-1",
    taskId: "native-child-transcript",
    netImpl: {
      createConnection() {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  });
  await collect(client.stream(prompt()).fullStream);
  const message = JSON.parse(socket.writes[0]);
  assert.equal(message.request.conversationId, "conversation-1");
  assert.equal(message.request.taskId, "native-child-transcript");
  assert.match(message.request.taskProof, /^[a-f0-9]{64}$/);
  assert.equal((JSON.stringify(message).match(/native-child-transcript/g) ?? []).length, 1);
  client.dispose();

  for (const options of [
    { conversationId: "conversation-1" },
    { conversationId: "conversation-1", taskId: "../forged" },
    { conversationId: "conversation-1", taskId: "" },
  ]) {
    assert.throws(() => new InferenceSocketClient({
      config: config({ endpoint: "tcp://127.0.0.1:43123" }),
      ...options,
      netImpl: { createConnection() { throw new Error("must not connect"); } },
    }), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  }
});

test("unauthenticated sockets are capped and timeout destruction releases the exact slot", async (t) => {
  const accepted = [];
  class FakeServer extends EventEmitter {
    constructor(onConnection) { super(); this.onConnection = onConnection; this.listening = false; }
    listen() { this.listening = true; queueMicrotask(() => this.emit("listening")); }
    address() { return { address: "127.0.0.1", port: 43123 }; }
    close() { this.listening = false; }
  }
  class FakeSocket extends EventEmitter {
    destroyed = false;
    timeoutMs = null;
    setNoDelay() {}
    setTimeout(value) { this.timeoutMs = value; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  let fakeServer;
  const netImpl = {
    createServer(onConnection) {
      fakeServer = new FakeServer(onConnection);
      return fakeServer;
    },
  };
  const { InferenceBridgeServer, MAX_CONNECTIONS, AUTH_TIMEOUT_MS } = require(serverPath);
  const bridge = new InferenceBridgeServer({
    router: { stream() { throw new Error("must not run"); } },
    computerTargetRouter: stableComputerTargetRouter(),
    capability: CAPABILITY,
    netImpl,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  for (let index = 0; index < MAX_CONNECTIONS; index += 1) {
    const socket = new FakeSocket();
    accepted.push(socket);
    fakeServer.onConnection(socket);
    assert.equal(socket.destroyed, false);
    assert.equal(socket.timeoutMs, AUTH_TIMEOUT_MS);
  }
  const overCapacity = new FakeSocket();
  fakeServer.onConnection(overCapacity);
  assert.equal(overCapacity.destroyed, true);
  accepted[0].emit("timeout");
  assert.equal(accepted[0].destroyed, true);
  const replacement = new FakeSocket();
  fakeServer.onConnection(replacement);
  assert.equal(replacement.destroyed, false);
});

test("disposing while the private bridge is starting rejects the exact startup promise", async () => {
  class PendingServer extends EventEmitter {
    listening = false;
    listen() {}
    close() { this.emit("close"); }
  }
  let server;
  const { InferenceBridgeServer } = require(serverPath);
  const bridge = new InferenceBridgeServer({
    router: { stream() { throw new Error("must not run"); } },
    computerTargetRouter: stableComputerTargetRouter(),
    capability: CAPABILITY,
    netImpl: {
      createServer() {
        server = new PendingServer();
        return server;
      },
    },
  });
  const pending = bridge.start();
  bridge.dispose();
  await assert.rejects(Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 100)),
  ]), { code: "CODEX_BRIDGE_UNAVAILABLE" });
  assert.equal(server.listenerCount("listening"), 0);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("close"), 0);
});
