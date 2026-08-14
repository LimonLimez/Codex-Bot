const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CHATGPT_RELAY_CONTRACT_VERSION,
  RELAY_METHODS,
  createCommand,
  snapshotCommand,
  sendCommand,
  cancelCommand,
  acknowledgeCommand,
  reconcileCommand,
  adaptSnapshotResult,
  CHATGPT_REPLACEMENT_RANGE_UNIT,
  applyChatGPTReplacementRange,
} = require("../src/bots/chatgpt-relay-codec.cjs");

test("contract v1 commands match the Swift relay golden JSON", () => {
  assert.equal(CHATGPT_RELAY_CONTRACT_VERSION, 1);
  assert.equal(CHATGPT_REPLACEMENT_RANGE_UNIT, "utf16-code-units");
  assert.deepEqual([...RELAY_METHODS], [
    "status/read",
    "model/list",
    "conversation/create",
    "conversation/snapshot",
    "conversation/select-model",
    "message/send",
    "turn/cancel",
    "watermarks/acknowledge",
    "requests/reconcile",
  ]);
  assert.deepEqual(createCommand({ companionChatID: "companion-chat-1", modelID: "chatgpt-medium" }), {
    method: "conversation/create",
    params: { companionChatID: "companion-chat-1", modelID: "chatgpt-medium" },
  });
  assert.deepEqual(snapshotCommand({ conversationID: "chat-1", afterSequence: 8 }), {
    method: "conversation/snapshot",
    params: { conversationID: "chat-1", afterSequence: 8 },
  });
  assert.deepEqual(sendCommand({ requestID: "request-1", conversationID: "chat-1", text: "hello", attachments: [] }), {
    method: "message/send",
    params: {
      requestID: "request-1",
      conversationID: "chat-1",
      content: [{ type: "text", text: "hello" }],
      attachments: [],
    },
  });
  assert.deepEqual(cancelCommand({ requestID: "cancel-1", conversationID: "chat-1", turnID: "turn-1" }), {
    method: "turn/cancel",
    params: { requestID: "cancel-1", conversationID: "chat-1", turnID: "turn-1" },
  });
  assert.deepEqual(acknowledgeCommand({ watermarks: [{ streamID: "chat-1", sequence: 9 }] }), {
    method: "watermarks/acknowledge",
    params: { watermarks: [{ streamID: "chat-1", sequence: 9 }] },
  });
  assert.deepEqual(reconcileCommand({ requestIDs: ["request-1", "cancel-1"] }), {
    method: "requests/reconcile",
    params: { requestIDs: ["request-1", "cancel-1"] },
  });
});

test("contract v1 replacement ranges match JavaScript UTF-16 offsets", () => {
  assert.equal(applyChatGPTReplacementRange("A🐈e\u0301Z", "ok", { start: 1, length: 4 }), "AokZ");
});
test("send codec rejects local paths and accepts only exact sanitized attachment DTOs", () => {
  assert.throws(() => sendCommand({
    requestID: "request-1",
    conversationID: "chat-1",
    text: "hello",
    attachments: ["/tmp/private.png"],
  }), /unsupported ChatGPT attachment/i);
  assert.deepEqual(sendCommand({
    requestID: "request-1",
    conversationID: "chat-1",
    text: "hello",
    attachments: [{ attachmentID: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteCount: 4 }],
  }).params.attachments, [{ attachmentID: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteCount: 4 }]);
  assert.throws(() => sendCommand({
    requestID: "request-1",
    conversationID: "chat-1",
    text: "hello",
    attachments: [{ attachmentID: "attachment-1", fileName: "note.txt", mimeType: "text/plain", byteCount: 4, path: "/tmp/note.txt" }],
  }), /unsupported ChatGPT attachment/i);
});

test("snapshot adapter preserves only native content, watermark, active turn, and model", () => {
  const result = adaptSnapshotResult({
    conversationID: "chat-1",
    snapshot: {
      conversationID: "chat-1",
      title: "Native Chat",
      content: [
        { type: "markdown", text: "**hello**" },
        { type: "link", label: "OpenAI", url: "https://openai.com/" },
      ],
      watermark: { streamID: "chat-1", sequence: 12 },
      activeTurnID: "turn-1",
      modelID: "chatgpt-medium",
    },
  });
  assert.deepEqual(result, {
    conversationID: "chat-1",
    snapshot: {
      conversationID: "chat-1",
      title: "Native Chat",
      content: [
        { type: "markdown", text: "**hello**" },
        { type: "link", label: "OpenAI", url: "https://openai.com/" },
      ],
      watermark: { streamID: "chat-1", sequence: 12 },
      activeTurnID: "turn-1",
      modelID: "chatgpt-medium",
    },
  });
  assert.throws(() => adaptSnapshotResult({
    conversationID: "chat-evil",
    snapshot: { conversationID: "chat-1", title: "", content: [], watermark: { streamID: "chat-1", sequence: 0 }, activeTurnID: null, modelID: null },
  }), /changed its native conversation ID/i);
});
