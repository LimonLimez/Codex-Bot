"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const macRoot = path.resolve(__dirname, "..");
const patchPath = path.join(macRoot, "src", "patch", "host-inference.cjs");

const STOCK_INFERENCE =
  'function E4i(t){let e,n=qdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),r=()=>(e??=A4i({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),e);return{resolvePrivacyMode:()=>Jdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),getGeminiVideoAttachedMediaUrlProvider:()=>t.isGeminiVideoDeveloperApiEnabled?.()===!0?n:void 0,createSession(o,s){let a=process.env.SAND_AGENT_MOCK_RESPONSE;if(a!=null){let p=s?.modelId??"sand-mock",h=y2a(a);return h!=null?w2a(h,p):{getExecutor:()=>PQt(()=>({response:a,chunkSize:8})),getModelId:()=>p}}let l=t.getModelExperimentState?.(),c=v4i({state:l,requestSource:s?.requestSource,readConfiguredDefaultModel:()=>t.getConfiguredDefaultModel?.(),readConfiguredAutomationsModel:()=>t.getConfiguredAutomationsModel?.()}),u=A2a({sessionOptions:s,envModelOverride:process.env.SAND_AGENT_MODEL,storedDefaultModel:t.getDefaultModel?.(),storedComputerUseModel:t.getComputerUseModel?.(),storedBrowserUseModel:t.getBrowserUseModel?.(),experimentModelOverride:c}),d=Qdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId,requestedModel:u,inferenceReason:t.isGeminiVideoDeveloperApiEnabled?.()===!0?s?.inferenceReason:void 0,onRequestId:o,...s?.lineage!=null?{lineage:s.lineage}:{}});return s?.skipLabeling===!0||s?.isSummarizationSession===!0||s?.isComputerUseSubagent===!0?d:y4i(d,r(),u.modelId)},recordPostTurnLabeling(o){w4i(r(),{conversationId:o.conversationId,requestId:o.requestId,modelName:o.modelName,messages:o.messages})}}}';
const READINESS =
  "isReady:async()=>process.env.SAND_AGENT_MOCK_RESPONSE!=null||n.peekAccessToken()!==null";
const PRIMARY_SESSION =
  "ye={modelId:t.subagentModelId,inferenceReason:t.subagentType}";
const SUMMARY_SESSION =
  't.inference.createSession(pn=>{t.emitUpdate({type:"request-id",requestId:pn})},{modelId:dXt,isSummarizationSession:!0';

function syntheticHost({ duplicateInference = false, readiness = READINESS } = {}) {
  return [
    '"use strict";',
    STOCK_INFERENCE,
    duplicateInference ? STOCK_INFERENCE : "",
    "function T4i(t){return E4i(t)}",
    `function __primary(t){let ${PRIMARY_SESSION};return ye}`,
    `function __summary(t){return ${SUMMARY_SESSION}})}`,
    `var b4i={start:t=>({${readiness},port:T4i(t)})};`,
    "globalThis.__host={primary:__primary,summary:__summary};",
  ].join("");
}

test("the Grok 0.20 host inference path is exclusively routed through the Codex bridge", () => {
  const { patchHostInferenceSource } = require(patchPath);
  const patched = patchHostInferenceSource(syntheticHost());
  const start = patched.indexOf("function E4i(t){");
  const end = patched.indexOf("function T4i(t){", start);
  const inference = patched.slice(start, end);

  assert.match(inference, /process\.env\.CODEX_BOT_BRIDGE/);
  assert.match(inference, /require\(bridgePath\)/);
  assert.match(
    inference,
    /createPromptSession\(\{\.\.\.s,onRequestId:o,botId:void 0,modelId:void 0\},ETn\)/,
  );
  assert.match(inference, /qt\.NO_TRAINING/);
  assert.doesNotMatch(
    inference,
    /getAccessToken|SAND_AGENT_MOCK_RESPONSE|Qdi\(|A4i\(|y4i\(/,
  );
  assert.match(patched, /isReady:async\(\)=>!0/);
  assert.match(patched, /ye=\{conversationId:t\.getConversationId\(\),taskId:openBotTaskId\(t\),modelId:t\.subagentModelId/);
  assert.match(patched, /\{conversationId:t\.getConversationId\(\),taskId:openBotTaskId\(t\),modelId:dXt,isSummarizationSession:!0/);
  assert.doesNotMatch(patched, new RegExp(READINESS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the reviewed host patch derives parent and native subagent identities from runner state", () => {
  const { patchHostInferenceSource } = require(patchPath);
  const context = vm.createContext({ dXt: "summary-model" });
  vm.runInContext(patchHostInferenceSource(syntheticHost()), context);
  let parentTranscriptReads = 0;
  const parent = {
    isSubagentRunner: false,
    getConversationId: () => "conversation-parent",
    get subagentTranscriptId() { parentTranscriptReads += 1; return "must-not-be-read"; },
    subagentModelId: "gpt-5.6-sol",
    subagentType: "parent",
  };
  let childTranscriptReads = 0;
  const child = {
    isSubagentRunner: true,
    getConversationId: () => "conversation-parent",
    get subagentTranscriptId() { childTranscriptReads += 1; return "native-child-transcript"; },
    subagentModelId: "gpt-5.6-sol",
    subagentType: "generalPurpose",
  };

  assert.deepEqual(JSON.parse(JSON.stringify(context.__host.primary(parent))), {
    conversationId: "conversation-parent",
    taskId: "parent",
    modelId: "gpt-5.6-sol",
    inferenceReason: "parent",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__host.primary(child))), {
    conversationId: "conversation-parent",
    taskId: "native-child-transcript",
    modelId: "gpt-5.6-sol",
    inferenceReason: "generalPurpose",
  });
  assert.equal(parentTranscriptReads, 0);
  assert.equal(childTranscriptReads, 1);

  let summaryOptions;
  context.__host.summary({
    ...child,
    inference: { createSession(_callback, options) { summaryOptions = options; } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(summaryOptions)), {
    conversationId: "conversation-parent",
    taskId: "native-child-transcript",
    modelId: "summary-model",
    isSummarizationSession: true,
  });
  assert.equal(childTranscriptReads, 2);

  assert.throws(() => context.__host.primary({
    ...child,
    subagentTranscriptId: undefined,
  }), /subagent identity is unavailable/i);
  assert.throws(() => context.__host.primary({
    ...child,
    subagentTranscriptId: "../forged",
  }), /subagent identity is unavailable/i);
});

test("host inference patching fails closed on missing or ambiguous reviewed anchors", () => {
  const { patchHostInferenceSource } = require(patchPath);
  assert.throws(
    () => patchHostInferenceSource('"use strict";function T4i(t){}'),
    /inference|anchor|not found/i,
  );
  assert.throws(
    () => patchHostInferenceSource(syntheticHost({ duplicateInference: true })),
    /inference|anchor|ambiguous/i,
  );
  assert.throws(
    () => patchHostInferenceSource(syntheticHost({ readiness: "isReady:async()=>!1" })),
    /readiness|anchor|not found/i,
  );
});

test(
  "the exact verified Grok Bot 0.20 host source satisfies the reviewed patch anchors",
  {
    skip: !fs.existsSync(process.env.GROK_BOT_020_APP
      || "/Applications/Grok Bot original 20260811.app"),
  },
  () => {
    const { patchHostInferenceSource } = require(patchPath);
    const app = path.resolve(process.env.GROK_BOT_020_APP
      || "/Applications/Grok Bot original 20260811.app");
    const host = path.join(app, "Contents", "Resources", "app.asar");
    const asar = require("@electron/asar");
    const source = asar.extractFile(host, "dist/host/host-main.cjs").toString("utf8");
    const patched = patchHostInferenceSource(source);
    assert.notEqual(patched, source);
    assert.equal((patched.match(/process\.env\.CODEX_BOT_BRIDGE/g) ?? []).length, 1);
    assert.equal((patched.match(/isReady:async\(\)=>!0/g) ?? []).length, 1);
    assert.equal((patched.match(/taskId:openBotTaskId\(t\)/g) ?? []).length, 2);
    assert.equal((patched.match(/function openBotTaskId\(t\)/g) ?? []).length, 1);
    assert.doesNotMatch(
      patched.slice(
        patched.indexOf("function E4i(t){"),
        patched.indexOf("function T4i(t){"),
      ),
      /getAccessToken|SAND_AGENT_MOCK_RESPONSE|Qdi\(|A4i\(|y4i\(/,
    );
  },
);
