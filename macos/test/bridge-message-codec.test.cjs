"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const codecPath = path.resolve(
  __dirname,
  "..",
  "src",
  "bridge",
  "message-codec.cjs",
);

test("encodes Grok host text, image, file, assistant tool calls, and tool results without mutation", () => {
  const { encodeMessages } = require(codecPath);
  const source = [
    { role: "system", content: "You are the selected bot." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this." },
        {
          type: "image",
          image: "aGVsbG8=",
          mimeType: "image/png",
        },
        { type: "file", filename: "brief.pdf", mimeType: "application/pdf" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect it." },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "Computer",
          args: { action: "screenshot" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "Computer",
          result: {
            content: [
              { type: "text", text: "Captured." },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
          },
        },
      ],
    },
  ];
  const before = JSON.stringify(source);
  const result = encodeMessages(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(result, [
    { role: "system", content: "You are the selected bot." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
        { type: "text", text: "[Attached file: brief.pdf]" },
      ],
    },
    {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "Computer",
            arguments: '{"action":"screenshot"}',
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "Captured." },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<tool_visual_result>Machine-observed tool output.</tool_visual_result>",
        },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
      ],
    },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[1].content), true);
});

test("preserves every ordinary stock function tool including approvals, plugins, routines, and Computer", () => {
  const { encodeTools } = require(codecPath);
  const tools = [
    {
      name: "Computer",
      description: "Use the active bot computer.",
      parameters: {
        type: "object",
        properties: { action: { type: "string" } },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "RequestApproval",
      description: "Ask for exact approval.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "RunRoutine",
      description: "Run a saved routine.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "CallMcpTool",
      description: "Call a connected MCP tool.",
      parameters: { type: "object", properties: {} },
    },
  ];
  const result = encodeTools(tools);
  assert.deepEqual(
    result.map((tool) => tool.function.name),
    ["Computer", "RequestApproval", "RunRoutine", "CallMcpTool"],
  );
  assert.deepEqual(result[0].function.parameters, tools[0].parameters);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0].function.parameters), true);
});

test("tool choice conversion is exact and rejects unowned or malformed selections", () => {
  const { encodeToolChoice } = require(codecPath);
  const names = new Set(["Computer", "RequestApproval"]);
  assert.equal(encodeToolChoice(undefined, names), "auto");
  assert.equal(encodeToolChoice("none", names), "none");
  assert.deepEqual(encodeToolChoice({ toolName: "Computer" }, names), {
    type: "function",
    function: { name: "Computer" },
  });
  for (const invalid of [
    "required",
    { toolName: "Unknown" },
    { toolName: "Computer", extra: true },
    { get toolName() { throw new Error("hostile"); } },
  ]) {
    assert.throws(() => encodeToolChoice(invalid, names), {
      code: "CODEX_BRIDGE_PAYLOAD_INVALID",
    });
  }
});

test("rejects malformed, hostile, cyclic, duplicate, and oversized message or tool payloads", () => {
  const { MAX_REQUEST_BYTES, encodeMessages, encodeTools } = require(codecPath);
  const cyclic = { role: "user", content: [] };
  cyclic.content.push(cyclic);
  const custom = Object.create({ inherited: true });
  custom.role = "user";
  custom.content = "unsafe";
  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("private proxy trap");
      },
    },
  );
  const cases = [
    () => encodeMessages(cyclic),
    () => encodeMessages([custom]),
    () => encodeMessages([{ role: "vendor", content: "unsafe" }]),
    () =>
      encodeMessages([
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "Computer", args: {} }, { type: "tool-call", toolCallId: "x", toolName: "Computer", args: {} }] },
      ]),
    () => encodeMessages([{ role: "user", content: "x".repeat(MAX_REQUEST_BYTES + 1) }]),
    () => encodeTools([{ type: "provider-defined", name: "vendor" }]),
    () => encodeTools([{ name: "Computer", parameters: hostileProxy }]),
    () => encodeTools([{ name: "Computer", description: "x", parameters: { get type() { throw new Error("hostile"); } } }]),
    () => encodeTools([{ name: "Computer", description: "x", parameters: {} }, { name: "Computer", description: "duplicate", parameters: {} }]),
  ];
  for (const operation of cases) {
    assert.throws(operation, (error) => {
      assert.equal(error.code, "CODEX_BRIDGE_PAYLOAD_INVALID");
      assert.doesNotMatch(String(error.stack), /private proxy trap/);
      return true;
    });
  }
});
