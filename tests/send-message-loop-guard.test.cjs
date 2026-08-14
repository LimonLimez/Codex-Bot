"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const bridge = require(path.resolve(__dirname, "..", "src", "bridge.cjs"));

const tools = ["SendMessage", "Shell", "Computer"].map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
}));

function names(messages) {
  return bridge
    .convertToolsForStep(tools, messages)
    .map((tool) => tool.function.name);
}

function completedBatch(calls) {
  return [
    {
      role: "assistant",
      content: calls.map(({ id, name }) => ({
        type: "tool-call",
        toolCallId: id,
        toolName: name,
        args: {},
      })),
    },
    {
      role: "tool",
      content: calls.map(({ id, name }) => ({
        type: "tool-result",
        toolCallId: id,
        toolName: name,
        result: { content: [{ type: "text", text: "ok" }] },
      })),
    },
  ];
}

test("SendMessage is available on the first inference step", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(
    bridge.trailingCompletedToolBatchHasSendMessage(messages),
    false,
  );
  assert.deepEqual(names(messages), ["SendMessage", "Shell", "Computer"]);
});

test("SendMessage is hidden for one step after a completed message-only batch", () => {
  const messages = [
    { role: "user", content: "do the work" },
    ...completedBatch([{ id: "send-1", name: "SendMessage" }]),
  ];

  assert.equal(
    bridge.trailingCompletedToolBatchMessageMode(messages),
    "message-only",
  );
  assert.equal(bridge.trailingCompletedToolBatchHasSendMessage(messages), true);
  assert.deepEqual(names(messages), ["Shell", "Computer"]);
});

test("SendMessage remains available after a completed mixed message and work batch", () => {
  const messages = [
    { role: "user", content: "do the work" },
    ...completedBatch([
      { id: "send-1", name: "SendMessage" },
      { id: "shell-1", name: "Shell" },
    ]),
  ];

  assert.equal(
    bridge.trailingCompletedToolBatchMessageMode(messages),
    "message-with-work",
  );
  assert.equal(bridge.trailingCompletedToolBatchHasSendMessage(messages), true);
  assert.deepEqual(names(messages), ["SendMessage", "Shell", "Computer"]);
});

test("an incomplete SendMessage batch does not suppress the delivery tool", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "send-1",
          toolName: "SendMessage",
          args: {},
        },
      ],
    },
  ];

  assert.equal(bridge.trailingCompletedToolBatchMessageMode(messages), "none");
  assert.equal(
    bridge.trailingCompletedToolBatchHasSendMessage(messages),
    false,
  );
  assert.deepEqual(names(messages), ["SendMessage", "Shell", "Computer"]);
});

test("SendMessage returns after a subsequent completed non-message batch", () => {
  const messages = [
    { role: "user", content: "do two steps" },
    ...completedBatch([{ id: "send-1", name: "SendMessage" }]),
    ...completedBatch([{ id: "shell-1", name: "Shell" }]),
  ];

  assert.equal(bridge.trailingCompletedToolBatchMessageMode(messages), "none");
  assert.equal(
    bridge.trailingCompletedToolBatchHasSendMessage(messages),
    false,
  );
  assert.deepEqual(names(messages), ["SendMessage", "Shell", "Computer"]);
});
