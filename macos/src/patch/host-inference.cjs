"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { replaceUnique } = require("./anchors.cjs");

const INFERENCE_START = "function E4i(t){";
const INFERENCE_END = "function T4i(t){";
const STOCK_READINESS =
  "isReady:async()=>process.env.SAND_AGENT_MOCK_RESPONSE!=null||n.peekAccessToken()!==null";
const CODEX_READINESS = "isReady:async()=>!0";
const PRIMARY_SESSION_OPTIONS = "ye={modelId:t.subagentModelId,inferenceReason:";
const CODEX_PRIMARY_SESSION_OPTIONS =
  'ye={conversationId:t.getConversationId(),taskId:openBotTaskId(t),modelId:t.subagentModelId,inferenceReason:';
const SUMMARY_SESSION_OPTIONS =
  't.inference.createSession(pn=>{t.emitUpdate({type:"request-id",requestId:pn})},{modelId:dXt,isSummarizationSession:!0';
const CODEX_SUMMARY_SESSION_OPTIONS =
  't.inference.createSession(pn=>{t.emitUpdate({type:"request-id",requestId:pn})},{conversationId:t.getConversationId(),taskId:openBotTaskId(t),modelId:dXt,isSummarizationSession:!0';
const MAX_HOST_BYTES = 32 * 1024 * 1024;

const CODEX_INFERENCE =
  'function openBotTaskId(t){if(!t.isSubagentRunner)return"parent";let e=t.subagentTranscriptId;if(typeof e!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(e)||e.includes(".."))throw new Error("OpenBot subagent identity is unavailable.");return e}function E4i(t){let bridgePath=process.env.CODEX_BOT_BRIDGE;if(typeof bridgePath!=="string"||bridgePath.trim()==="")throw new Error("OpenBot bridge is unavailable.");let bridge=require(bridgePath);if(bridge==null||typeof bridge.createPromptSession!=="function")throw new Error("OpenBot bridge is unavailable.");return{resolvePrivacyMode:()=>Promise.resolve(qt.NO_TRAINING),getGeminiVideoAttachedMediaUrlProvider:()=>void 0,createSession(o,s){return bridge.createPromptSession({...s,onRequestId:o,botId:void 0,modelId:void 0},ETn)},recordPostTurnLabeling(){}}}';

function uniqueIndex(source, anchor, label) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Patch anchor is ambiguous: ${label}`);
  }
  return first;
}

function patchHostInferenceSource(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("Grok host source must be a non-empty string");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_HOST_BYTES) {
    throw new Error("Grok host source is too large");
  }
  const start = uniqueIndex(source, INFERENCE_START, "Grok 0.20 inference start");
  const end = uniqueIndex(source, INFERENCE_END, "Grok 0.20 inference end");
  if (end <= start) throw new Error("Grok 0.20 inference anchors are out of order");
  let patched = source.slice(0, start) + CODEX_INFERENCE + source.slice(end);
  patched = replaceUnique(
    patched,
    STOCK_READINESS,
    CODEX_READINESS,
    "Grok 0.20 inference readiness",
  );
  patched = replaceUnique(
    patched,
    PRIMARY_SESSION_OPTIONS,
    CODEX_PRIMARY_SESSION_OPTIONS,
    "Grok 0.20 primary conversation session",
  );
  patched = replaceUnique(
    patched,
    SUMMARY_SESSION_OPTIONS,
    CODEX_SUMMARY_SESSION_OPTIONS,
    "Grok 0.20 summary conversation session",
  );
  return patched;
}

function patchHostInference(extractedRoot) {
  const root = path.resolve(extractedRoot);
  const file = path.join(root, "dist", "host", "host-main.cjs");
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Grok host patch path escaped the extracted app");
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Grok host source must be a real file");
  }
  const source = fs.readFileSync(file, "utf8");
  const patched = patchHostInferenceSource(source);
  fs.writeFileSync(file, patched, { encoding: "utf8", mode: stat.mode & 0o777 });
}

module.exports = {
  CODEX_INFERENCE,
  CODEX_PRIMARY_SESSION_OPTIONS,
  CODEX_READINESS,
  CODEX_SUMMARY_SESSION_OPTIONS,
  INFERENCE_END,
  INFERENCE_START,
  STOCK_READINESS,
  patchHostInference,
  patchHostInferenceSource,
};
