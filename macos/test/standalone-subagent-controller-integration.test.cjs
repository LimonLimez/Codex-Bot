"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { StandaloneConversationController } = require("../src/desktop/standalone-conversation-controller.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const SELECTION = Object.freeze({
  botId: BOT_A,
  generation: 7,
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  serviceTier: null,
});

function ids() {
  const values = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ];
  return () => {
    const value = values.shift();
    if (!value) throw new Error("test exhausted deterministic IDs");
    return value;
  };
}

function result(events) {
  return Object.freeze({
    fullStream: (async function* () {
      for (const event of events) yield Object.freeze(event);
    })(),
  });
}

test("the standalone parent exposes real subwork beside Computer tools without persisting the child transcript", async () => {
  const requests = [];
  const childOpens = [];
  const childDispatches = [];
  let computerDisposals = 0;
  let childSessionDisposals = 0;
  let childRunnerDisposals = 0;
  const router = {
    async stream(request) {
      requests.push(request);
      if (requests.length === 1) return result([
        { type: "tool-call-streaming-start", toolCallId: "call-subwork", toolName: "spawn_subagent" },
        { type: "tool-call", toolCallId: "call-subwork", toolName: "spawn_subagent", args: { task: "Inspect the page." } },
        { type: "finish", finishReason: "tool-calls" },
      ]);
      return result([
        { type: "text-delta", textDelta: "Parent received the result." },
        { type: "finish", finishReason: "stop" },
      ]);
    },
  };
  const toolBridge = {
    async open(identity) {
      return Object.freeze({
        ...identity,
        definitions: Object.freeze([Object.freeze({
          type: "function",
          name: "browser_capture",
          description: "Inspect the current frame.",
          parameters: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
        })]),
        async dispatch() { throw new Error("parent Computer tool was not selected"); },
        async dispose() { computerDisposals += 1; },
      });
    },
  };
  const subagentRunner = {
    async open(identity) {
      childOpens.push(identity);
      return Object.freeze({
        botId: identity.botId,
        conversationId: identity.conversationId,
        taskId: identity.taskId,
        definitions: Object.freeze([Object.freeze({
          type: "function",
          name: "spawn_subagent",
          description: "Run one bounded subtask.",
          parameters: Object.freeze({
            type: "object",
            properties: Object.freeze({ task: Object.freeze({ type: "string" }) }),
            required: Object.freeze(["task"]),
            additionalProperties: false,
          }),
        })]),
        async dispatch(call) {
          childDispatches.push(call);
          return Object.freeze({ status: "completed", output: "private child answer" });
        },
        async dispose() { childSessionDisposals += 1; },
      });
    },
    dispose() { childRunnerDisposals += 1; },
  };
  const controller = new StandaloneConversationController({
    router,
    toolBridge,
    subagentRunner,
    async readSelection() { return SELECTION; },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  const terminal = new Promise((resolve) => controller.on("event", (event) => {
    if (["completed", "failed"].includes(event.type)) resolve(event);
  }));
  await controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Delegate this." });
  assert.equal((await terminal).type, "completed");

  assert.deepEqual(childOpens, [{
    botId: BOT_A,
    conversationId: created.conversationId,
    taskId: "standalone-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    selection: SELECTION,
  }]);
  assert.deepEqual(requests[0].tools.map(({ name }) => name), ["browser_capture", "spawn_subagent"]);
  assert.deepEqual(requests[1].tools.map(({ name }) => name), ["browser_capture", "spawn_subagent"]);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /private child answer/);
  assert.deepEqual(childDispatches, [{
    botId: BOT_A,
    conversationId: created.conversationId,
    taskId: "standalone-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    invocationId: "invocation-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    toolCallId: "call-subwork",
    toolName: "spawn_subagent",
    args: { task: "Inspect the page." },
  }]);
  const durable = controller.read({ botId: BOT_A, conversationId: created.conversationId });
  assert.deepEqual(durable.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Delegate this." },
    { role: "assistant", text: "Parent received the result." },
  ]);
  assert.doesNotMatch(JSON.stringify(durable), /private child answer/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(computerDisposals, 1);
  assert.equal(childSessionDisposals, 1);
  await controller.dispose();
  assert.equal(childRunnerDisposals, 1);
});
