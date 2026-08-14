"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const patchPath = path.join(macRoot, "src", "patch", "host-inference.cjs");

const STOCK_INFERENCE =
  'function E4i(t){let e,n=qdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),r=()=>(e??=A4i({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),e);return{resolvePrivacyMode:()=>Jdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),getGeminiVideoAttachedMediaUrlProvider:()=>t.isGeminiVideoDeveloperApiEnabled?.()===!0?n:void 0,createSession(o,s){let a=process.env.SAND_AGENT_MOCK_RESPONSE;if(a!=null){let p=s?.modelId??"sand-mock",h=y2a(a);return h!=null?w2a(h,p):{getExecutor:()=>PQt(()=>({response:a,chunkSize:8})),getModelId:()=>p}}let l=t.getModelExperimentState?.(),c=v4i({state:l,requestSource:s?.requestSource,readConfiguredDefaultModel:()=>t.getConfiguredDefaultModel?.(),readConfiguredAutomationsModel:()=>t.getConfiguredAutomationsModel?.()}),u=A2a({sessionOptions:s,envModelOverride:process.env.SAND_AGENT_MODEL,storedDefaultModel:t.getDefaultModel?.(),storedComputerUseModel:t.getComputerUseModel?.(),storedBrowserUseModel:t.getBrowserUseModel?.(),experimentModelOverride:c}),d=Qdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId,requestedModel:u,inferenceReason:t.isGeminiVideoDeveloperApiEnabled?.()===!0?s?.inferenceReason:void 0,onRequestId:o,...s?.lineage!=null?{lineage:s.lineage}:{}});return s?.skipLabeling===!0||s?.isSummarizationSession===!0||s?.isComputerUseSubagent===!0?d:y4i(d,r(),u.modelId)},recordPostTurnLabeling(o){w4i(r(),{conversationId:o.conversationId,requestId:o.requestId,modelName:o.modelName,messages:o.messages})}}}';
const READINESS =
  "isReady:async()=>process.env.SAND_AGENT_MOCK_RESPONSE!=null||n.peekAccessToken()!==null";

function syntheticHost({ duplicateInference = false, readiness = READINESS } = {}) {
  return [
    '"use strict";',
    STOCK_INFERENCE,
    duplicateInference ? STOCK_INFERENCE : "",
    "function T4i(t){return E4i(t)}",
    `var b4i={start:t=>({${readiness},port:T4i(t)})};`,
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
  assert.doesNotMatch(patched, new RegExp(READINESS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
  { skip: !process.env.GROK_BOT_020_APP },
  () => {
    const { patchHostInferenceSource } = require(patchPath);
    const app = path.resolve(process.env.GROK_BOT_020_APP);
    const host = path.join(app, "Contents", "Resources", "app.asar");
    const asar = require("@electron/asar");
    const source = asar.extractFile(host, "dist/host/host-main.cjs").toString("utf8");
    const patched = patchHostInferenceSource(source);
    assert.notEqual(patched, source);
    assert.equal((patched.match(/process\.env\.CODEX_BOT_BRIDGE/g) ?? []).length, 1);
    assert.equal((patched.match(/isReady:async\(\)=>!0/g) ?? []).length, 1);
    assert.doesNotMatch(
      patched.slice(
        patched.indexOf("function E4i(t){"),
        patched.indexOf("function T4i(t){"),
      ),
      /getAccessToken|SAND_AGENT_MOCK_RESPONSE|Qdi\(|A4i\(|y4i\(/,
    );
  },
);
