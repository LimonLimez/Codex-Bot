const CHATGPT_RELAY_CONTRACT_VERSION = 1;
const {
  REPLACEMENT_RANGE_UNIT: CHATGPT_REPLACEMENT_RANGE_UNIT,
  applyReplacementRange: applyChatGPTReplacementRange,
} = require("../renderer/chat-content.js");
const RELAY_METHODS = Object.freeze([
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

function identifier(value, label) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${label} is invalid.`);
  return value;
}

function optionalIdentifier(value, label) {
  return value == null ? undefined : identifier(value, label);
}

function exactAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported ChatGPT attachment.");
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["attachmentID", "byteCount", "fileName", "mimeType"].join("\0")) throw new Error("Unsupported ChatGPT attachment.");
  if (typeof value.attachmentID !== "string" || !value.attachmentID
    || typeof value.fileName !== "string" || !value.fileName
    || typeof value.mimeType !== "string" || !value.mimeType
    || !Number.isInteger(value.byteCount) || value.byteCount < 0) {
    throw new Error("Unsupported ChatGPT attachment.");
  }
  return { attachmentID: value.attachmentID, fileName: value.fileName, mimeType: value.mimeType, byteCount: value.byteCount };
}

function command(method, params) {
  return { method, ...(params === undefined ? {} : { params }) };
}

function createCommand({ companionChatID, modelID } = {}) {
  const params = { companionChatID: identifier(companionChatID, "Companion Chat ID") };
  const model = optionalIdentifier(modelID, "ChatGPT model ID");
  if (model !== undefined) params.modelID = model;
  return command("conversation/create", params);
}

function snapshotCommand({ conversationID, afterSequence } = {}) {
  const params = { conversationID: identifier(conversationID, "ChatGPT conversation ID") };
  if (afterSequence !== undefined) {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("ChatGPT snapshot sequence is invalid.");
    params.afterSequence = afterSequence;
  }
  return command("conversation/snapshot", params);
}

function sendCommand({ requestID, conversationID, text, attachments = [] } = {}) {
  if (typeof text !== "string" || !text || text.length > 1_000_000) throw new Error("ChatGPT message text is invalid.");
  if (!Array.isArray(attachments) || attachments.length > 8) throw new Error("Unsupported ChatGPT attachment.");
  return command("message/send", {
    requestID: identifier(requestID, "ChatGPT request ID"),
    conversationID: identifier(conversationID, "ChatGPT conversation ID"),
    content: [{ type: "text", text }],
    attachments: attachments.map(exactAttachment),
  });
}

function cancelCommand({ requestID, conversationID, turnID } = {}) {
  return command("turn/cancel", {
    requestID: identifier(requestID, "ChatGPT request ID"),
    conversationID: identifier(conversationID, "ChatGPT conversation ID"),
    turnID: identifier(turnID, "ChatGPT turn ID"),
  });
}

function acknowledgeCommand({ watermarks } = {}) {
  if (!Array.isArray(watermarks) || !watermarks.length || watermarks.length > 64) throw new Error("ChatGPT watermarks are invalid.");
  return command("watermarks/acknowledge", {
    watermarks: watermarks.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join("\0") !== ["sequence", "streamID"].join("\0")
        || typeof value.streamID !== "string" || !value.streamID
        || !Number.isInteger(value.sequence) || value.sequence < 0) throw new Error("ChatGPT watermarks are invalid.");
      return { streamID: value.streamID, sequence: value.sequence };
    }),
  });
}

function reconcileCommand({ requestIDs } = {}) {
  if (!Array.isArray(requestIDs) || requestIDs.length > 128) throw new Error("ChatGPT request reconciliation is invalid.");
  return command("requests/reconcile", { requestIDs: requestIDs.map((value) => identifier(value, "ChatGPT request ID")) });
}

function selectModelCommand({ conversationID, modelID } = {}) {
  return command("conversation/select-model", {
    conversationID: identifier(conversationID, "ChatGPT conversation ID"),
    modelID: identifier(modelID, "ChatGPT model ID"),
  });
}

function adaptSnapshotResult(result) {
  const snapshot = result?.snapshot;
  const conversationID = identifier(result?.conversationID, "ChatGPT conversation ID");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || identifier(snapshot.conversationID, "ChatGPT snapshot conversation ID") !== conversationID) {
    throw new Error("ChatGPT changed its native conversation ID.");
  }
  if (typeof snapshot.title !== "string" || !Array.isArray(snapshot.content)
    || !snapshot.watermark || typeof snapshot.watermark.streamID !== "string"
    || !Number.isInteger(snapshot.watermark.sequence)
    || (snapshot.activeTurnID != null && typeof snapshot.activeTurnID !== "string")
    || (snapshot.modelID != null && typeof snapshot.modelID !== "string")) {
    throw new Error("ChatGPT returned an invalid conversation snapshot.");
  }
  return {
    conversationID,
    snapshot: {
      conversationID,
      title: snapshot.title,
      content: snapshot.content,
      watermark: { streamID: snapshot.watermark.streamID, sequence: snapshot.watermark.sequence },
      activeTurnID: snapshot.activeTurnID ?? null,
      modelID: snapshot.modelID ?? null,
    },
  };
}

module.exports = {
  CHATGPT_REPLACEMENT_RANGE_UNIT,
  CHATGPT_RELAY_CONTRACT_VERSION,
  RELAY_METHODS,
  acknowledgeCommand,
  adaptSnapshotResult,
  applyChatGPTReplacementRange,
  cancelCommand,
  createCommand,
  reconcileCommand,
  selectModelCommand,
  sendCommand,
  snapshotCommand,
};
