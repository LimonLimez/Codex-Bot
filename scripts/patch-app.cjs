"use strict";

// Electron patches Node's fs APIs to mount .asar paths. The installer needs
// to read and write the archive itself, so disable that virtual-filesystem
// interception when the script is hosted by the user's Electron executable.
if (process.versions?.electron) process.noAsar = true;

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const babelParser = require("prettier/plugins/babel").parsers.babel;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SUPPORTED = Object.freeze({
  version: "0.18.0",
  appAsarSha256:
    "38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0",
});

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    args[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function pngDataUri(file) {
  const bytes = fs.readFileSync(file);
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw new Error(`Provider icon is not a PNG: ${file}`);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, "utf8");
}

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0)
    throw new Error(`Patch anchor is ambiguous: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function replaceInRegion(text, regionStart, before, after, label) {
  const region = text.indexOf(regionStart);
  if (region < 0) throw new Error(`Patch region not found: ${label}`);
  const first = text.indexOf(before, region);
  if (first < 0) throw new Error(`Patch anchor not found: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function replaceAllExact(text, before, after, expected, label) {
  const count = text.split(before).length - 1;
  if (count !== expected)
    throw new Error(`Expected ${expected} ${label} anchor(s), found ${count}`);
  return text.split(before).join(after);
}

function replaceAllExactInRegion(
  text,
  regionStart,
  regionEnd,
  before,
  after,
  expected,
  label,
) {
  const startIndex = text.indexOf(regionStart);
  const endIndex = text.indexOf(regionEnd, startIndex + regionStart.length);
  if (startIndex < 0 || endIndex < 0)
    throw new Error(`Patch region not found: ${label}`);
  const region = text.slice(startIndex, endIndex);
  const count = region.split(before).length - 1;
  if (count !== expected)
    throw new Error(`Expected ${expected} ${label} anchor(s), found ${count}`);
  return (
    text.slice(0, startIndex) +
    region.split(before).join(after) +
    text.slice(endIndex)
  );
}

function sourceRegion(text, start, end, label) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0)
    throw new Error(`Local auth verifier could not find ${label}`);
  return text.slice(startIndex, endIndex);
}

function assertPatchInvariant(condition, label) {
  if (!condition)
    throw new Error(`Local auth isolation verification failed: ${label}`);
}

function topLevelFunctionRegions(text) {
  const starts = [
    ...text.matchAll(/^(?:async\s+)?function\s+[$A-Za-z_][$\w]*\s*\(/gm),
  ].map((match) => match.index);
  return starts.map((start, index) => ({
    start,
    source: text.slice(start, starts[index + 1] ?? text.length),
  }));
}

function exactFunctionRegion(text, candidate, label) {
  let parsed;
  try {
    parsed = babelParser.parse(candidate.source);
  } catch (error) {
    throw new Error(
      `Could not parse ${label} function boundary: ${error.message || error}`,
    );
  }
  const declaration = parsed?.program?.body?.[0];
  if (
    declaration?.type !== "FunctionDeclaration" ||
    declaration.start !== 0 ||
    !Number.isSafeInteger(declaration.end) ||
    declaration.end <= 0
  ) {
    throw new Error(`Could not resolve exact ${label} function boundary`);
  }
  const end = candidate.start + declaration.end;
  return {
    start: candidate.start,
    end,
    source: text.slice(candidate.start, end),
  };
}

function uniqueFunctionRegion(text, needles, label) {
  const matches = topLevelFunctionRegions(text)
    .filter(({ source }) => needles.every((needle) => source.includes(needle)))
    .map((candidate) => exactFunctionRegion(text, candidate, label))
    .filter(({ source }) => needles.every((needle) => source.includes(needle)));
  if (matches.length !== 1)
    throw new Error(`Expected one ${label} function, found ${matches.length}`);
  return matches[0];
}

function replaceOnceInFunction(text, needles, before, after, label) {
  const region = uniqueFunctionRegion(text, needles, label);
  const patched = replaceOnce(region.source, before, after, label);
  return text.slice(0, region.start) + patched + text.slice(region.end);
}

function replaceAllExactInFunction(
  text,
  needles,
  before,
  after,
  expected,
  label,
) {
  const region = uniqueFunctionRegion(text, needles, label);
  const patched = replaceAllExact(
    region.source,
    before,
    after,
    expected,
    label,
  );
  return text.slice(0, region.start) + patched + text.slice(region.end);
}

function replaceFunction(text, needles, replacement, label) {
  const region = uniqueFunctionRegion(text, needles, label);
  return (
    text.slice(0, region.start) + replacement + "\n" + text.slice(region.end)
  );
}

function functionName(region, label) {
  const match = /^(?:async\s+)?function\s+([$A-Za-z_][$\w]*)\s*\(/.exec(
    region.source,
  );
  if (match == null)
    throw new Error(`Could not resolve ${label} function name`);
  return match[1];
}

const STOCK_COWORKER_ACK_CHAIN =
  "        const executor = host.isSubagentRunner || isSilenceAllowed ? diskPressureExecutor : applyStartOfTurnAckReminder(applySendMessageReminder(diskPressureExecutor));";

function verifyCoworkerHostBehaviorSource(hostSource) {
  assertPatchInvariant(
    hostSource.includes("var SAND_ONBOARDING_KICKSTART_PROMPT = [") &&
      hostSource.includes("[first run] This is your very first turn."),
    "host retains the stock first-run coworker onboarding cue",
  );
  assertPatchInvariant(
    hostSource.includes(STOCK_COWORKER_ACK_CHAIN),
    "host retains the stock start-of-turn acknowledgement middleware chain",
  );
}

function patchHostAgentIdentitySource(hostSource) {
  let text = replaceOnce(
    hostSource,
    "        const mainSessionOptions = {\n          modelId: host.subagentModelId,",
    "        const mainSessionOptions = {\n          agentId: host.resolveBoxId(),\n          modelId: host.subagentModelId,",
    "agent-scoped inference preferences",
  );
  text = replaceOnce(
    text,
    "        getMachineId: options2.getMachineId,\n        requestedModel,",
    "        getMachineId: options2.getMachineId,\n        agentId: sessionOptions?.agentId,\n        requestedModel,",
    "agent identity inference handoff",
  );
  return text;
}

function verifyHostAgentIdentitySource(hostSource) {
  const sessionOptions = sourceRegion(
    hostSource,
    "        const mainSessionOptions = {",
    "        };",
    "main inference session options",
  );
  const agentId = sessionOptions.indexOf("agentId: host.resolveBoxId(),");
  const modelId = sessionOptions.indexOf("modelId: host.subagentModelId,");
  assertPatchInvariant(
    agentId >= 0 && agentId < modelId,
    "main inference session carries the current bot id before model selection",
  );
  const inferenceHandoff = sourceRegion(
    hostSource,
    "      const session = createCursorInferencePromptSession({",
    "      });",
    "local inference bridge handoff",
  );
  const handoffAgentId = inferenceHandoff.indexOf(
    "agentId: sessionOptions?.agentId,",
  );
  const requestedModel = inferenceHandoff.indexOf("requestedModel,");
  assertPatchInvariant(
    handoffAgentId >= 0 && handoffAgentId < requestedModel,
    "local inference bridge receives the bot id before model resolution",
  );
}

function verifyBrowserSeatLifecycleSource(hostSource) {
  const gateway = uniqueFunctionRegion(
    hostSource,
    [
      "function createHostGatewayApi",
      "const mintAgent = async (args) =>",
      "deleteAgent: async (args) =>",
      "deleteAgents: async (args) =>",
    ],
    "host gateway API",
  ).source;
  const mintAgent = sourceRegion(
    gateway,
    "  const mintAgent = async (args) => {",
    "\n  };\n  return {",
    "agent mint lifecycle",
  );
  const mintResult = mintAgent.indexOf(
    "const result = await manager.createAgent(",
  );
  const ensureSeat = mintAgent.indexOf("manager.ensureSeat(result.agent.id)");
  const mintReturn = mintAgent.lastIndexOf("return result;");
  assertPatchInvariant(
    mintResult >= 0 && ensureSeat > mintResult && mintReturn > ensureSeat,
    "a successfully minted bot provisions its browser seat before returning",
  );
  assertPatchInvariant(
    mintAgent.split("manager.ensureSeat(result.agent.id)").length - 1 === 1 &&
      hostSource.split("manager.ensureSeat(result.agent.id)").length - 1 === 1,
    "browser-seat provisioning occurs exactly once and only in mintAgent",
  );

  const deleteAgent = sourceRegion(
    gateway,
    "    deleteAgent: async (args) => {",
    "\n    deleteAgents: async (args) => {",
    "single-agent delete lifecycle",
  );
  const deleteResult = deleteAgent.indexOf(
    "const result = await manager.deleteAgent(args.id);",
  );
  const closeSeat = deleteAgent.indexOf("manager.closeSeatForKey(args.id)");
  const deleteReturn = deleteAgent.lastIndexOf("return result;");
  assertPatchInvariant(
    deleteResult >= 0 && closeSeat > deleteResult && deleteReturn > closeSeat,
    "a deleted bot closes its browser seat before returning",
  );
  assertPatchInvariant(
    deleteAgent.split("manager.closeSeatForKey(args.id)").length - 1 === 1 &&
      hostSource.split("manager.closeSeatForKey(args.id)").length - 1 === 1,
    "single-agent browser-seat cleanup occurs exactly once in deleteAgent",
  );
  assertPatchInvariant(
    !deleteAgent.includes("manager.ensureSeat("),
    "agent deletion cannot provision a browser seat",
  );

  const deleteAgents = sourceRegion(
    gateway,
    "    deleteAgents: async (args) => {",
    "\n    duplicateAgent: (args) =>",
    "batch agent delete lifecycle",
  );
  const batchDeleteResult = deleteAgents.indexOf(
    "const result = await manager.deleteAgents(args.ids);",
  );
  const batchRelease = deleteAgents.indexOf("await deps.releaseAgentBox(id);");
  const batchClose = deleteAgents.indexOf("manager.closeSeatForKey(id)");
  const batchReturn = deleteAgents.lastIndexOf("return result;");
  assertPatchInvariant(
    batchDeleteResult >= 0 &&
      batchRelease > batchDeleteResult &&
      batchClose > batchRelease &&
      batchReturn > batchClose,
    "each successfully batch-deleted bot closes its browser seat before returning",
  );
  assertPatchInvariant(
    deleteAgents.split("manager.closeSeatForKey(id)").length - 1 === 1 &&
      hostSource.split("manager.closeSeatForKey(id)").length - 1 === 1,
    "batch browser-seat cleanup occurs exactly once inside the per-id delete loop",
  );
  assertPatchInvariant(
    !deleteAgents.includes("manager.ensureSeat("),
    "batch agent deletion cannot provision a browser seat",
  );
}

function verifyHostComputerSeatRoutingSource(hostSource) {
  const execute = sourceRegion(
    hostSource,
    "async function executeAndPersistComputerUse",
    "\nfunction createScreenshotArgs",
    "employee-scoped computer executor",
  );
  const localMode = execute.indexOf(
    'const useLocalComputer = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1";',
  );
  const seatIdentity = execute.indexOf(
    'const seatKey = typeof deps.seatKey === "string" ? deps.seatKey.trim() : "";',
  );
  const failClosed = execute.indexOf(
    "if (useLocalComputer && (!bridgePath || !seatKey))",
  );
  const localExecutor = execute.indexOf(
    "require(bridgePath).createExecutor({ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate, seatKey })",
  );
  const vendorExecutor = execute.indexOf(
    "resourceAccessor.get(computerUseExecutorResource)",
  );
  assertPatchInvariant(
    localMode >= 0 &&
      seatIdentity > localMode &&
      failClosed > seatIdentity &&
      localExecutor > failClosed &&
      vendorExecutor > localExecutor,
    "local Computer and Screenshot execution fails closed before creating an employee-scoped executor",
  );
  assertPatchInvariant(
    execute.includes(
      'throw new Error("A stable employee browser-seat key is required in local computer mode.")',
    ) && !execute.includes("default-seat"),
    "the host executor cannot fall back to a shared browser seat",
  );

  const tools = uniqueFunctionRegion(
    hostSource,
    [
      "function buildTurnTools",
      "createComputerTool(remoteBoxResourceAccessor",
      "createScreenshotTool(remoteBoxResourceAccessor",
    ],
    "turn tool assembly",
  ).source;
  const localMainRegistration = tools.indexOf(
    'if ((host.isComputerUseSubagent || (!host.isSubagentRunner && !host.isSharedRoomRunner && process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1")) && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {',
  );
  const computerRegistration = tools.indexOf(
    "createComputerTool(remoteBoxResourceAccessor, {",
  );
  assertPatchInvariant(
    localMainRegistration >= 0 && computerRegistration > localMainRegistration,
    "local private and same-user group turns receive the direct employee-scoped Computer tool",
  );
  const computer = sourceRegion(
    tools,
    "createComputerTool(remoteBoxResourceAccessor, {",
    "\n  if (host.isBrowserUseSubagent",
    "Computer tool registration",
  );
  const screenshot = sourceRegion(
    tools,
    "createScreenshotTool(remoteBoxResourceAccessor, {",
    "\n  if (!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable() && host.boxHandoff",
    "Screenshot tool registration",
  );
  for (const [label, registration] of [
    ["Computer", computer],
    ["Screenshot", screenshot],
  ]) {
    const persistImage = registration.indexOf(
      "getPersistImage: () => host.persistImage",
    );
    const seatKey = registration.indexOf("seatKey: host.resolveBoxId(),");
    assertPatchInvariant(
      persistImage >= 0 && seatKey > persistImage,
      `${label} receives the stable current bot id at its tool boundary`,
    );
    assertPatchInvariant(
      registration.split("seatKey: host.resolveBoxId(),").length - 1 === 1,
      `${label} receives exactly one employee browser-seat key`,
    );
  }
  assertPatchInvariant(
    tools.split("seatKey: host.resolveBoxId(),").length - 1 === 2,
    "only the Computer and Screenshot registrations receive employee browser-seat keys",
  );
  for (const marker of [
    'const directLocalComputerOffered = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable();',
    "Use Computer directly for browser and desktop work",
    "A denied Shell call does not mean browser access is blocked",
    "real Computer approval card",
  ]) {
    assertPatchInvariant(
      hostSource.includes(marker),
      `local direct-computer guidance retains ${marker}`,
    );
  }
}

function verifyLocalExecComputerIsolationSource(localExecSource) {
  const manager = uniqueFunctionRegion(
    localExecSource,
    [
      "function buildLocalExecManager",
      "new RegistryResourceAccessor()",
      "SimpleControlledExecManager.fromResources(registry3)",
    ],
    "local-exec manager",
  ).source;
  assertPatchInvariant(
    !manager.includes("computerUseExecutorResource") &&
      !manager.includes("GROK_BOT_WINDOWS_COMPUTER_BRIDGE") &&
      !manager.includes(".createExecutor("),
    "the shared local-exec daemon cannot expose an unscoped computer executor",
  );
}

function verifyHostLocalOnlySource(hostSource) {
  const bootstrap = hostSource.slice(0, 5_000);
  for (const setting of [
    'process.env.GROK_BOT_LOCAL_ONLY = "1";',
    'process.env.SAND_DISABLE_TELEMETRY = "1";',
    'process.env.SAND_DISABLE_ANALYTICS = "1";',
    'process.env.SAND_DISABLE_UPDATES = "1";',
    'process.env.SAND_BACKEND_URL = "http://127.0.0.1:1";',
  ]) {
    assertPatchInvariant(
      bootstrap.includes(setting),
      `host startup pins ${setting}`,
    );
  }
  assertPatchInvariant(
    bootstrap.includes("startViewServer?.()") &&
      bootstrap.includes("GROK_BOT_WINDOWS_COMPUTER_BRIDGE"),
    "host startup retains the local live-view bridge",
  );

  const inference = sourceRegion(
    hostSource,
    "function createCursorInferencePromptSession(options2) {",
    "\nvar PRIVACY_MODE_CACHE_MAX_AGE_MS",
    "local inference prompt session",
  );
  assertPatchInvariant(
    inference.includes("GROK_BOT_CLIPROXY_BRIDGE") &&
      inference.includes(
        "require(bridgePath).createPromptSession(options2, imageResizingMiddleware)",
      ) &&
      !inference.includes("getAccessToken"),
    "host inference is exclusively routed through the user-owned local bridge",
  );

  for (const marker of [
    'if (process.env.GROK_BOT_LOCAL_ONLY === "1") return PrivacyMode.NO_TRAINING;',
    "recordFollowupClassification: async () => {}",
    'if (process.env.GROK_BOT_LOCAL_ONLY === "1" || skipLabeling)',
    'if (process.env.GROK_BOT_LOCAL_ONLY === "1") return { flushPendingUploads: async () => {} };',
    "skillsCatalog: async () => []",
    "Vendor backend RPCs are disabled in Open Bot local-only mode.",
  ]) {
    assertPatchInvariant(
      hostSource.includes(marker),
      `host vendor-service isolation retains ${marker}`,
    );
  }

  for (const marker of [
    "listAllAutomationDefinitions()",
    "runServerScheduledAutomation({ agentId, automation, runUuid, scheduledForMs })",
    "clearInterval(localRoutineTimer)",
    "manager.ensureSeat(result.agent.id)",
    "manager.closeSeatForKey(args.id)",
    "seatKey: host.resolveBoxId()",
    'const remoteBox = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" ? localExec.box',
    'isBrowserUseSubagentEnabled: () => process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" ? false',
  ]) {
    assertPatchInvariant(
      hostSource.includes(marker),
      `host local feature retains ${marker}`,
    );
  }
  verifyBrowserSeatLifecycleSource(hostSource);
  verifyHostComputerSeatRoutingSource(hostSource);
  verifyCoworkerHostBehaviorSource(hostSource);
}

function patchRendererComposerIdentitySource(rendererSource) {
  let text = replaceAllExactInFunction(
    rendererSource,
    [
      "newChatComposer:",
      "heroComposer:",
      "attachmentNotice: t.attachmentNoticeMessage,",
    ],
    "        attachmentNotice: t.attachmentNoticeMessage,",
    "        codexAgentId: n.currentAgentId,\n        attachmentNotice: t.attachmentNoticeMessage,",
    3,
    "composer bot identity",
  );
  text = replaceAllExactInFunction(
    text,
    ['p.jsx("form"', "isSendingPaused: t,"],
    "  const e = he.c(215),",
    "  const e = he.c(216),",
    1,
    "composer memo-cache size",
  );
  text = replaceAllExactInFunction(
    text,
    ['p.jsx("form"', "isSendingPaused: t,"],
    "      isSendingPaused: t,",
    "      isSendingPaused: t,\n      codexAgentId: codexAgentId2,",
    1,
    "composer bot identity prop",
  );
  text = replaceAllExactInFunction(
    text,
    ['p.jsx("form"', "codexAgentId: codexAgentId2,"],
    `    e[211] !== ts || e[212] !== ks || e[213] !== za
      ? (($a = p.jsx("form", { className: ts, onSubmit: ks, children: za })),
        (e[211] = ts),
        (e[212] = ks),
        (e[213] = za),
        (e[214] = $a))
      : ($a = e[214]),`,
    `    e[211] !== ts ||
    e[212] !== ks ||
    e[213] !== za ||
    e[214] !== codexAgentId2
      ? (($a = p.jsx("form", {
          className: ts,
          "data-codex-agent-id": codexAgentId2,
          onSubmit: ks,
          children: za,
        })),
        (e[211] = ts),
        (e[212] = ks),
        (e[213] = za),
        (e[214] = codexAgentId2),
        (e[215] = $a))
      : ($a = e[215]),`,
    1,
    "composer form bot identity",
  );
  return text;
}

function verifyRendererComposerIdentitySource(rendererSource) {
  const composerOwner = uniqueFunctionRegion(
    rendererSource,
    ["newChatComposer:", "heroComposer:", "codexAgentId: n.currentAgentId,"],
    "composer owner",
  ).source;
  assertPatchInvariant(
    composerOwner.split("codexAgentId: n.currentAgentId,").length - 1 === 3,
    "all three composer surfaces receive the current bot id",
  );
  const composerForm = uniqueFunctionRegion(
    rendererSource,
    ['p.jsx("form"', "codexAgentId: codexAgentId2,"],
    "composer form",
  ).source;
  assertPatchInvariant(
    composerForm.includes("const e = he.c(216),"),
    "composer memo cache reserves the added bot-id slot",
  );
  assertPatchInvariant(
    composerForm.includes("codexAgentId: codexAgentId2,") &&
      composerForm.includes('"data-codex-agent-id": codexAgentId2,') &&
      composerForm.includes("e[214] !== codexAgentId2") &&
      composerForm.includes("(e[214] = codexAgentId2)") &&
      composerForm.includes("(e[215] = $a)") &&
      composerForm.includes("($a = e[215])"),
    "composer form memoization and DOM identity stay in sync",
  );
  assertPatchInvariant(
    !/\be\[216\]/.test(composerForm),
    "composer memo cache indices remain within the declared size",
  );
}

function patchSettingsViewSource(settingsSource) {
  const localGeneral = `function Sa(s) {
  const { auth: t } = s;
  return a.jsxs("div", {
    className: k(
      "sand-settings-general",
      "sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x",
    ),
    children: [
      a.jsx(re, { title: "Account", children: a.jsx(Vs, { auth: t }) }),
      a.jsx(pa, {}),
    ],
  });
}`;
  return replaceFunction(
    settingsSource,
    [
      '"sand-settings-general"',
      'title: "Account"',
      "children: [d, l, r, i, o]",
    ],
    localGeneral,
    "general settings cards",
  );
}

function verifySettingsViewSource(settingsSource) {
  const general = uniqueFunctionRegion(
    settingsSource,
    ['"sand-settings-general"', 'title: "Account"'],
    "general settings cards",
  ).source;
  assertPatchInvariant(
    general.includes('title: "Account"') &&
      general.includes("a.jsx(pa, {})") &&
      !general.includes("a.jsx(oa, {})") &&
      !general.includes("a.jsx(va, {})"),
    "general settings retain only account and appearance before local controls are injected",
  );
}

function verifyRendererLocalOnlySource(rendererSource) {
  const onboarding = uniqueFunctionRegion(
    rendererSource,
    ["The vendor sign-in gates xAI services", 'gate: "shell"', "countAgents()"],
    "local onboarding gate",
  ).source;
  assertPatchInvariant(
    onboarding.includes("markOnboardingSeen()") &&
      !onboarding.includes("isSignedIn()"),
    "onboarding enters the genuine workspace without a vendor session",
  );
  assertPatchInvariant(
    rendererSource.includes("noteSignedOut: () => {}") &&
      rendererSource.includes("forceOnboarding: () => {}"),
    "vendor auth transitions cannot force onboarding",
  );
  assertPatchInvariant(
    rendererSource.includes("children: p.jsx(Gzn, {})") &&
      rendererSource.includes(
        "Renderer Sentry is disabled in the Open Bot local-only build",
      ) &&
      !rendererSource.includes("tBn();"),
    "workspace shell is direct and renderer Sentry stays disabled",
  );
  const pauseGate = uniqueFunctionRegion(
    rendererSource,
    ["sand_client_pause belongs to vendor computer setup", "return false;"],
    "local computer setup bypass",
  ).source;
  assertPatchInvariant(
    !pauseGate.includes("featureGates"),
    "vendor computer setup gate is bypassed",
  );
  const pluginSidebar = uniqueFunctionRegion(
    rendererSource,
    [
      "Vendor plugin discovery is unavailable in the local-only build",
      "return null;",
    ],
    "plugin sidebar isolation",
  ).source;
  assertPatchInvariant(
    !pluginSidebar.includes("onOpenPlugins"),
    "vendor plugin sidebar entry is disabled",
  );
  const pluginCommands = uniqueFunctionRegion(
    rendererSource,
    ['label: "Jump to"', "composerActions:"],
    "command palette",
  ).source;
  assertPatchInvariant(
    !pluginCommands.includes('id: "overlay:plugins"'),
    "vendor plugin command is disabled",
  );
  assertPatchInvariant(
    !rendererSource.includes("Rme.open(Uf.plugins(") &&
      !rendererSource.includes('id: "sand.openTools"') &&
      !rendererSource.includes('id: "sand.openWorkflows"') &&
      !rendererSource.includes('hotkey: "mod+shift+m"') &&
      !rendererSource.includes('hotkey: "mod+shift+w"') &&
      !rendererSource.includes("run: uSe"),
    "vendor plugin overlays have no reachable global action, shortcut, or opener",
  );
  const preview = uniqueFunctionRegion(
    rendererSource,
    ["sand-computer-preview__frame", "GBLiveSeat", 'aspectRatio: "1280 / 800"'],
    "local computer preview",
  ).source;
  assertPatchInvariant(
    !preview.includes("p.jsx(dbn"),
    "computer preview renders only the local browser seat",
  );
  assertPatchInvariant(
    rendererSource.includes(
      'const wDn = [{ id: "general", label: "General", icon: "settings-gear" }];',
    ),
    "stock settings navigation exposes only the local-safe General section",
  );
  const pane = uniqueFunctionRegion(
    rendererSource,
    [
      "S.useSyncExternalStore(EDn",
      "windowWidth: window.innerWidth",
      "paneWidth: u",
    ],
    "local live pane",
  ).source;
  assertPatchInvariant(
    pane.includes(") || !0,"),
    "local live pane remains available at narrow widths",
  );
}

function verifyRendererRuntimeBindingsSource(rendererSource) {
  const orgDeclarations =
    rendererSource.match(
      /^const FRn = Dme\(\)\.actions,\r?\n  RWe = na\.orgChart;$/gm,
    ) ?? [];
  const orgActionUses = rendererSource.match(/\bRWe\b/g) ?? [];
  const paletteUses = rendererSource.match(/\bFRn\b/g) ?? [];
  assertPatchInvariant(
    orgDeclarations.length === 1 &&
      orgActionUses.length === 3 &&
      paletteUses.length === 2,
    "renderer command palette retains the FRn/RWe declarations used by its org-chart action",
  );

  const onboardingDeclarations =
    rendererSource.match(/^async function hUn\s*\(/gm) ?? [];
  const onboardingCalls = rendererSource.match(/\bhUn\s*\(\{/g) ?? [];
  assertPatchInvariant(
    onboardingDeclarations.length === 1 && onboardingCalls.length === 1,
    "renderer onboarding gate retains the hUn declaration used by the workspace shell",
  );
}

function collectBindingNames(node, names) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectBindingNames(child, names);
    return;
  }

  if (node.type === "VariableDeclarator") collectPatternNames(node.id, names);
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    collectPatternNames(node.id, names);
    for (const parameter of node.params ?? [])
      collectPatternNames(parameter, names);
  }
  if (node.type === "CatchClause") collectPatternNames(node.param, names);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression")
    collectPatternNames(node.id, names);

  for (const [key, child] of Object.entries(node)) {
    if (["type", "start", "end", "loc", "extra"].includes(key)) continue;
    collectBindingNames(child, names);
  }
}

function collectPatternNames(pattern, names) {
  if (pattern == null || typeof pattern !== "object") return;
  if (pattern.type === "Identifier") {
    names.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    collectPatternNames(pattern.argument, names);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternNames(pattern.left, names);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? [])
      collectPatternNames(element, names);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      if (property.type === "RestElement")
        collectPatternNames(property.argument, names);
      else collectPatternNames(property.value, names);
    }
  }
}

function verifyLiveSeatAliasIsolationSource(rendererSource) {
  const component = uniqueFunctionRegion(
    rendererSource,
    ["function GBLiveSeat", 'role: "application"', "onPointerMove:"],
    "transformed live-seat component",
  ).source;
  const parsed = babelParser.parse(component);
  const bindings = new Set();
  collectBindingNames(parsed.program.body[0], bindings);
  assertPatchInvariant(
    !bindings.has("S") && !bindings.has("p"),
    "transformed live-seat component cannot shadow renderer aliases S or p",
  );
}

function verifyLocalAuthIsolationSources(mainSource, rendererSource) {
  const bootstrap = mainSource.slice(0, 12_000);
  const handoffCall = bootstrap.indexOf("handOffDirectCodexBotLaunch();");
  const localOnlyAssignment = bootstrap.indexOf(
    'process.env.GROK_BOT_LOCAL_ONLY = "1";',
  );
  assertPatchInvariant(
    bootstrap.includes("function handOffDirectCodexBotLaunch()"),
    "desktop startup defines the direct-launch handoff",
  );
  assertPatchInvariant(
    handoffCall >= 0 && handoffCall < localOnlyAssignment,
    "direct-launch handoff runs before local-only desktop startup",
  );
  const wrappedLaunchSource = sourceRegion(
    bootstrap,
    "function isCodexBotWrappedLaunchEnvironment() {",
    "\nfunction handOffDirectCodexBotLaunch() {",
    "verified wrapped-launch environment",
  );
  for (const marker of [
    "CODEX_BOT_STATE_ROOT",
    "SAND_HOST_GATEWAY_URL",
    'require("node:path").isAbsolute(stateRoot)',
    'const prefix = "http://127.0.0.1:";',
    "descriptor.startsWith(prefix)",
    "/^[1-9][0-9]{0,4}$/.test(portText)",
    "port > 65535",
    "const url = new URL(descriptor);",
    'url.protocol === "http:"',
    'url.hostname === "127.0.0.1"',
    'url.username === ""',
    'url.password === ""',
    'url.pathname === "/"',
    'url.search === ""',
    'url.hash === ""',
    "url.port === String(port)",
  ]) {
    assertPatchInvariant(
      wrappedLaunchSource.includes(marker),
      `wrapped-launch environment strictly validates ${marker}`,
    );
  }
  const handoffSource = sourceRegion(
    bootstrap,
    "function handOffDirectCodexBotLaunch() {",
    "\nhandOffDirectCodexBotLaunch();",
    "direct-launch handoff",
  );
  assertPatchInvariant(
    handoffSource.includes(
      'path.join(installRoot, "tools", "runtime", "Launch-Codex-Bot.ps1")',
    ),
    "direct launch resolves the installed local runtime launcher",
  );
  assertPatchInvariant(
    handoffSource.includes(
      'path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")',
    ),
    "direct launch resolves PowerShell beneath the absolute SystemRoot",
  );
  assertPatchInvariant(
    handoffSource.includes('require("node:child_process").spawnSync(') &&
      handoffSource.includes("windowsHide: true") &&
      handoffSource.includes('stdio: "ignore"'),
    "direct-launch handoff synchronously waits for a hidden launcher",
  );
  assertPatchInvariant(
    !handoffSource.includes("detached: true") &&
      !handoffSource.includes(".unref()"),
    "direct-launch handoff cannot abandon a child that Windows may tear down",
  );
  assertPatchInvariant(
    handoffSource.includes(
      "if (launcherResult.error) throw launcherResult.error;",
    ) &&
      handoffSource.includes("if (launcherResult.signal)") &&
      handoffSource.includes("if (!Number.isInteger(launcherResult.status))") &&
      handoffSource.includes("if (launcherResult.status !== 0)"),
    "direct-launch handoff validates synchronous launcher completion",
  );
  assertPatchInvariant(
    handoffSource.includes("if (isCodexBotWrappedLaunchEnvironment()) return;"),
    "only a strictly verified local wrapper environment bypasses direct-launch handoff",
  );
  const gatewayMode = uniqueFunctionRegion(
    mainSource,
    ["function isCodexLocalGatewayMode", "isCodexBotWrappedLaunchEnvironment"],
    "local gateway mode predicate",
  ).source;
  assertPatchInvariant(
    gatewayMode.includes("return isCodexBotWrappedLaunchEnvironment();") &&
      !gatewayMode.includes("new URL("),
    "desktop account wiring shares the strict wrapped-launch predicate",
  );
  assertPatchInvariant(
    bootstrap.includes("showCodexBotLocalOnlyLaunchError") &&
      bootstrap.includes("process.exit(1)"),
    "a missing or failed launcher stops with a local-only error",
  );

  const mainAuthRegion = uniqueFunctionRegion(
    mainSource,
    [
      "function createCursorAccountEdgePort",
      "Vendor account services are disabled in Open Bot local-only mode.",
    ],
    "desktop account edge",
  ).source;
  const localGuard = mainAuthRegion.indexOf(
    'if (process.env.GROK_BOT_LOCAL_ONLY === "1") {',
  );
  const serviceIndex = mainAuthRegion.indexOf(
    "const { ensureCursorAuthService: ensureCursorAuthService2 } = deps;",
  );
  assertPatchInvariant(
    localGuard >= 0 && serviceIndex > localGuard,
    "local account edge short-circuits before vendor auth service access",
  );
  const localAccountPort = mainAuthRegion.slice(localGuard, serviceIndex);
  for (const method of [
    "getAuthStatus",
    "login",
    "cancelLogin",
    "logout",
    "getSandAccess",
    "getSandAccessFresh",
  ]) {
    assertPatchInvariant(
      localAccountPort.includes(`${method}: async`),
      `local account edge implements ${method}`,
    );
  }
  assertPatchInvariant(
    localAccountPort.includes('return { state: "granted", reason: "none" };') &&
      !localAccountPort.includes("ensureCursorAuthService2"),
    "local account edge grants local inference without reaching vendor auth",
  );

  const authOpenExternal = sourceRegion(
    mainSource,
    "var cursorAuthWiring = createCursorAuthWiring({",
    "var { ensureCursorAuthService } = cursorAuthWiring;",
    "desktop auth wiring",
  );
  const openExternalGuard = authOpenExternal.indexOf(
    'if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;',
  );
  const shellOpenExternal = authOpenExternal.indexOf(
    "shell.openExternal(url3)",
  );
  assertPatchInvariant(
    openExternalGuard >= 0,
    "auth browser launch is guarded in local-only mode",
  );
  assertPatchInvariant(
    shellOpenExternal >= 0 && openExternalGuard < shellOpenExternal,
    "auth browser guard runs before shell.openExternal",
  );

  const rendererAuthRegion = uniqueFunctionRegion(
    rendererSource,
    [
      "async getCursorAuthStatus(t)",
      "async loginCursor(t)",
      "async cancelCursorLogin(t)",
      "async logoutCursor(t)",
    ],
    "renderer auth adapter",
  ).source;
  const rendererMethods = [
    "getCursorAuthStatus",
    "loginCursor",
    "cancelCursorLogin",
    "logoutCursor",
  ];
  for (const method of rendererMethods) {
    const methodStart = rendererAuthRegion.indexOf(`async ${method}(`);
    const nextMethod = rendererAuthRegion.indexOf(
      "\n    async ",
      methodStart + 1,
    );
    assertPatchInvariant(
      methodStart >= 0,
      `renderer ${method} method is present`,
    );
    const methodSource = rendererAuthRegion.slice(
      methodStart,
      nextMethod < 0 ? rendererAuthRegion.length : nextMethod,
    );
    assertPatchInvariant(
      methodSource.includes("return codexLocalAuthIdentity();"),
      `renderer ${method} returns the synthetic local identity`,
    );
  }
  assertPatchInvariant(
    !/\be\.(?:login|logout|cancelLogin)\s*\(/.test(rendererAuthRegion),
    "renderer auth adapter cannot invoke vendor login, logout, or cancellation",
  );
  assertPatchInvariant(
    mainSource.includes("function codexLocalAuthIdentity()") &&
      rendererSource.includes("function codexLocalAuthIdentity()"),
    "both processes define the synthetic local identity",
  );
  assertPatchInvariant(
    !rendererAuthRegion.includes("n.cursorAccount") &&
      rendererAuthRegion.includes("async getCursorAvatar(t)") &&
      rendererAuthRegion.includes("async getCursorWeeklyUsage(t)") &&
      rendererAuthRegion.includes("async getCursorPrivacyModeEnabled(t)") &&
      rendererAuthRegion.includes("async getSandAccessFresh(t)") &&
      rendererAuthRegion.includes(
        'return { state: "granted", reason: "none" };',
      ),
    "renderer account edge cannot reach vendor auth, access, profile, or usage services",
  );
  verifyRendererLocalOnlySource(rendererSource);
}

function resolveRendererAssetPaths(root) {
  const rendererRoot = path.join(root, "dist", "renderer");
  const htmlFile = path.join(rendererRoot, "index.html");
  const html = fs.readFileSync(htmlFile, "utf8");
  const entryMatches = [...html.matchAll(/src="\.\/assets\/([^"?]+\.js)"/g)];
  if (entryMatches.length !== 1)
    throw new Error(
      `Expected one renderer entry script, found ${entryMatches.length}`,
    );
  const assetsRoot = path.join(rendererRoot, "assets");
  const entryFile = path.join(assetsRoot, entryMatches[0][1]);
  if (!fs.existsSync(entryFile))
    throw new Error(`Renderer entry asset is missing: ${entryMatches[0][1]}`);
  const settingsCandidates = fs
    .readdirSync(assetsRoot)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsRoot, name))
    .filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return (
        source.includes("sand-settings-general") &&
        source.includes("SettingsModal")
      );
    });
  if (settingsCandidates.length !== 1) {
    throw new Error(
      `Expected one renderer settings module, found ${settingsCandidates.length}`,
    );
  }
  return { htmlFile, entryFile, settingsFile: settingsCandidates[0] };
}

function verifyLocalAuthIsolation(root) {
  const rendererAssets = resolveRendererAssetPaths(root);
  verifyLocalAuthIsolationSources(
    fs.readFileSync(
      path.join(root, "dist", "electron-main", "main.cjs"),
      "utf8",
    ),
    fs.readFileSync(rendererAssets.entryFile, "utf8"),
  );
  const hostSource = fs.readFileSync(
    path.join(root, "dist", "host", "host-main.cjs"),
    "utf8",
  );
  verifyLocalExecComputerIsolationSource(
    fs.readFileSync(
      path.join(root, "dist", "local-exec-daemon", "main.cjs"),
      "utf8",
    ),
  );
  verifyHostAgentIdentitySource(hostSource);
  verifyHostLocalOnlySource(hostSource);
  verifyRendererComposerIdentitySource(
    fs.readFileSync(rendererAssets.entryFile, "utf8"),
  );
  verifySettingsViewSource(
    fs.readFileSync(rendererAssets.settingsFile, "utf8"),
  );
}

function walk(directory, visitor) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, visitor);
    else if (entry.isFile()) visitor(file);
  }
}

function applyBranding(root) {
  const extensions = new Set([".js", ".cjs", ".mjs", ".json", ".html", ".css"]);
  const replacements = [
    ["Grok Bot", "Open Bot"],
    ["grok bot", "codex bot"],
    ["X-Grok-Seat-Token", "X-Codex-Seat-Token"],
    ["Sign In with Cursor", "Sign in with Codex"],
    ["Sign in to Cursor", "Sign in with Codex"],
    ["Signed in to Cursor", "Signed in to Codex"],
    ["Cursor account", "Codex account"],
    ["Cursor Account", "Codex Account"],
  ];
  walk(root, (file) => {
    if (
      !extensions.has(path.extname(file).toLowerCase()) ||
      file.endsWith("codex-ui.js")
    )
      return;
    let text = fs.readFileSync(file, "utf8");
    const before = text;
    for (const [search, replacement] of replacements)
      text = text.split(search).join(replacement);
    if (text !== before) fs.writeFileSync(file, text, "utf8");
  });
}

function patchPackage(root) {
  const file = path.join(root, "package.json");
  const packageJson = readJson(file);
  if (packageJson.version !== SUPPORTED.version)
    throw new Error(`Unsupported Grok Bot version ${packageJson.version}`);
  packageJson.productName = "Open Bot";
  packageJson.description = "Codex-powered digital coworker";
  packageJson.author = "Open Bot community build";
  packageJson.homepage = "https://github.com/LimonLimez/Open-Bot";
  writeText(file, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function patchElectronMain(root) {
  const file = path.join(root, "dist", "electron-main", "main.cjs");
  let text = fs.readFileSync(file, "utf8");
  const strictIndex = text.indexOf('"use strict";\n');
  if (strictIndex < 0)
    throw new Error("Electron local-only startup anchor not found");
  const localOnlyBootstrap = `"use strict";
function showCodexBotLocalOnlyLaunchError(detail) {
  const message = "Open Bot must start through its local runtime. " + detail;
  process.stderr.write("[codex-bot] " + message + "\\n");
  try {
    require("electron").dialog.showErrorBox("Open Bot could not start", message);
  } catch {}
}
function isCodexBotWrappedLaunchEnvironment() {
  const stateRoot = process.env.CODEX_BOT_STATE_ROOT?.trim();
  const descriptor = process.env.SAND_HOST_GATEWAY_URL?.trim();
  if (!stateRoot || !require("node:path").isAbsolute(stateRoot) || !descriptor) return false;
  const prefix = "http://127.0.0.1:";
  if (!descriptor.startsWith(prefix)) return false;
  const portText = descriptor.slice(prefix.length);
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) return false;
  const port = Number(portText);
  if (!Number.isInteger(port) || port > 65535) return false;
  try {
    const url = new URL(descriptor);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.port === String(port);
  } catch {
    return false;
  }
}
function handOffDirectCodexBotLaunch() {
  if (process.platform !== "win32") return;
  if (isCodexBotWrappedLaunchEnvironment()) return;
  const path = require("node:path");
  const fs = require("node:fs");
  const systemRoot = process.env.SystemRoot?.trim();
  const installRoot = path.resolve(process.resourcesPath, "..", "..");
  const launcher = path.join(installRoot, "tools", "runtime", "Launch-Codex-Bot.ps1");
  const powershell = systemRoot && path.isAbsolute(systemRoot)
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "";
  if (!powershell || !fs.existsSync(powershell) || !fs.existsSync(launcher)) {
    showCodexBotLocalOnlyLaunchError("The installed local launcher or Windows PowerShell is missing. Please repair the installation.");
    process.exit(1);
  }
  try {
    const launcherResult = require("node:child_process").spawnSync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher],
      { cwd: installRoot, stdio: "ignore", windowsHide: true }
    );
    if (launcherResult.error) throw launcherResult.error;
    if (launcherResult.signal) throw new Error("local launcher was terminated by signal " + launcherResult.signal);
    if (!Number.isInteger(launcherResult.status)) throw new Error("local launcher did not report an exit code");
    if (launcherResult.status !== 0) throw new Error("local launcher exited with code " + launcherResult.status);
    process.exit(0);
  } catch (error) {
    showCodexBotLocalOnlyLaunchError("The local launcher failed: " + (error?.message || String(error)));
    process.exit(1);
  }
}
handOffDirectCodexBotLaunch();
process.env.GROK_BOT_LOCAL_ONLY = "1";
process.env.SAND_DISABLE_TELEMETRY = "1";
process.env.SAND_DISABLE_ANALYTICS = "1";
process.env.SAND_DISABLE_UPDATES = "1";
process.env.SAND_BACKEND_URL = "http://127.0.0.1:1";
`;
  text =
    text.slice(0, strictIndex) +
    localOnlyBootstrap +
    text.slice(strictIndex + '"use strict";\n'.length);
  text = replaceOnce(
    text,
    "      start() {\n        const cached3 = loadCachedBootstrap(this.options.getCacheDir());",
    '      start() {\n        if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n          this.refreshSnapshot();\n          return;\n        }\n        const cached3 = loadCachedBootstrap(this.options.getCacheDir());',
    "desktop experiment startup isolation",
  );
  text = replaceOnce(
    text,
    "      refresh(trigger) {\n        if (this.isDisposed) {",
    '      refresh(trigger) {\n        if (process.env.GROK_BOT_LOCAL_ONLY === "1") return Promise.resolve();\n        if (this.isDisposed) {',
    "desktop experiment refresh isolation",
  );
  text = replaceOnce(
    text,
    "  return (next) => async (req) => {\n    const [auth2, machineId] = await Promise.all([",
    '  return (next) => async (req) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      throw new Error("Vendor backend RPCs are disabled in Open Bot local-only mode.");\n    }\n    const [auth2, machineId] = await Promise.all([',
    "desktop vendor backend isolation",
  );
  text = replaceOnce(
    text,
    "      async getValidAccessToken(options) {\n        const operationEpoch = this.authOperationEpoch;",
    '      async getValidAccessToken(options) {\n        if (process.env.GROK_BOT_LOCAL_ONLY === "1") throw new SandAuthSignInRequiredError();\n        const operationEpoch = this.authOperationEpoch;',
    "desktop vendor token isolation",
  );
  text = replaceOnce(
    text,
    "      async login() {\n        this.abortActiveLogin();",
    '      async login() {\n        if (process.env.GROK_BOT_LOCAL_ONLY === "1") throw new SandAuthSignInRequiredError();\n        this.abortActiveLogin();',
    "desktop vendor login isolation",
  );
  text = replaceOnce(
    text,
    "function createDesktopAccountAuthorizer(deps) {",
    `function isCodexLocalGatewayMode() {
  return isCodexBotWrappedLaunchEnvironment();
}
function createDesktopAccountAuthorizer(deps) {`,
    "verified local gateway mode",
  );
  text = replaceOnce(
    text,
    "      accountRuntime.observe(status);",
    '      accountRuntime.observe(isCodexLocalGatewayMode() ? { kind: "logged-in", authId: "codex-bot-local" } : status);',
    "local coordinator account observation",
  );
  text = replaceOnce(
    text,
    "  await accountRuntime.start(await authService.getStatus());",
    '  await accountRuntime.start(isCodexLocalGatewayMode() ? { kind: "logged-in", authId: "codex-bot-local" } : await authService.getStatus());',
    "local coordinator startup account",
  );
  text = replaceOnce(
    text,
    "  const envDescriptorBinding = envDescriptorUrl == null || envDescriptorUrl.length === 0 ? null : createEnvDescriptorAccountBinding(",
    "  const envDescriptorBinding = isCodexLocalGatewayMode() || envDescriptorUrl == null || envDescriptorUrl.length === 0 ? null : createEnvDescriptorAccountBinding(",
    "local descriptor binding bypass",
  );
  text = replaceOnce(
    text,
    "function createCursorAccountEdgePort(deps) {",
    `function codexLocalAuthIdentity() {
  return {
    kind: "logged-in",
    authId: "codex-bot-local",
    name: "Open Bot",
    displayName: "Open Bot",
    email: null,
    isAnysphereUser: false
  };
}
function createCursorAccountEdgePort(deps) {
  if (process.env.GROK_BOT_LOCAL_ONLY === "1") {
    const identity = () => codexLocalAuthIdentity();
    const access = async () => {
      // Inference is provided by the user-owned local Codex route.
      return { state: "granted", reason: "none" };
    };
    return {
      getSandAccess: async () => access(),
      getSandAccessFresh: async () => access(),
      getAuthStatus: async () => identity(),
      login: async () => identity(),
      cancelLogin: async () => identity(),
      logout: async () => identity(),
      updateAccountName: async (name) => ({ ...identity(), displayName: name }),
      getAvatar: async () => null,
      getWeeklyUsage: async () => null,
      getUsageSummary: async () => null,
      getPrReviewPreferences: async () => NO_SAND_PR_REVIEW_PREFERENCES,
      getPrivacyModeEnabled: async () => true,
      cancelTrial: async () => ({ ok: false, message: "Vendor account services are disabled in Open Bot local-only mode." }),
      invokeDashboardAction: async () => ({ ok: false, message: "Vendor account services are disabled in Open Bot local-only mode." })
    };
  }`,
    "desktop synthetic local identity",
  );
  text = replaceInRegion(
    text,
    "var cursorAuthWiring = createCursorAuthWiring({",
    "  openExternal: async (url3) => {\n    await import_electron51.shell.openExternal(url3);\n  },",
    '  openExternal: async (url3) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;\n    await import_electron51.shell.openExternal(url3);\n  },',
    "ultimate auth browser launch guard",
  );
  text = replaceOnce(
    text,
    "    return posixPathFromFileUrl(source);",
    '    const filePath = posixPathFromFileUrl(source);\n    if (filePath == null) return null;\n    return process.platform === "win32" && /^\\/[A-Za-z]:\\//.test(filePath) ? filePath.slice(1) : filePath;',
    "Windows file attachment normalization",
  );
  text = replaceOnce(
    text,
    "import_electron51.app.whenReady().then(async () => {",
    'if (process.platform === "win32") {\n  import_electron51.app.setAppUserModelId("io.github.limonlimez.openbot");\n}\nimport_electron51.app.whenReady().then(async () => {',
    "Windows application id",
  );
  fs.writeFileSync(file, text, "utf8");
}

function patchLocalExec(root) {
  const file = path.join(root, "dist", "local-exec-daemon", "main.cjs");
  verifyLocalExecComputerIsolationSource(fs.readFileSync(file, "utf8"));
}

function patchHost(root) {
  const file = path.join(root, "dist", "host", "host-main.cjs");
  let text = fs.readFileSync(file, "utf8");
  const strictIndex = text.indexOf('"use strict";\n');
  if (strictIndex < 0) throw new Error("Host startup bridge anchor not found");
  const startupBridge = `"use strict";
process.env.GROK_BOT_LOCAL_ONLY = "1";
process.env.SAND_DISABLE_TELEMETRY = "1";
process.env.SAND_DISABLE_ANALYTICS = "1";
process.env.SAND_DISABLE_UPDATES = "1";
process.env.SAND_BACKEND_URL = "http://127.0.0.1:1";
try {
  const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
  if (process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && seatBridgePath) require(seatBridgePath).startViewServer?.();
} catch (error) {
  console.error("[codex-bot] failed to start the live browser-seat bridge", error);
}
`;
  text =
    text.slice(0, strictIndex) +
    startupBridge +
    text.slice(strictIndex + '"use strict";\n'.length);

  const inferenceStart = text.indexOf(
    "function createCursorInferencePromptSession(options2) {",
  );
  const inferenceEnd = text.indexOf(
    "\nvar PRIVACY_MODE_CACHE_MAX_AGE_MS",
    inferenceStart,
  );
  if (inferenceStart < 0 || inferenceEnd < 0)
    throw new Error("Inference function patch anchors not found");
  const inferenceReplacement = `function createCursorInferencePromptSession(options2) {
  const bridgePath = process.env.GROK_BOT_CLIPROXY_BRIDGE;
  if (bridgePath == null || bridgePath.trim() === "") {
    throw new Error("GROK_BOT_CLIPROXY_BRIDGE is required in the Open Bot build.");
  }
  return require(bridgePath).createPromptSession(options2, imageResizingMiddleware);
}`;
  text =
    text.slice(0, inferenceStart) +
    inferenceReplacement +
    text.slice(inferenceEnd);
  text = patchHostAgentIdentitySource(text);

  text = replaceOnce(
    text,
    "  start() {\n    const cached3 = loadCachedBootstrap(this.options.getCacheDir());",
    '  start() {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      this.refreshSnapshot();\n      return;\n    }\n    const cached3 = loadCachedBootstrap(this.options.getCacheDir());',
    "host experiment startup isolation",
  );
  text = replaceOnce(
    text,
    "  refresh(trigger) {\n    if (this.isDisposed) {",
    '  refresh(trigger) {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") return Promise.resolve();\n    if (this.isDisposed) {',
    "host experiment refresh isolation",
  );
  text = replaceOnce(
    text,
    "async function resolveSandRunPrivacyMode(options2, fetchPrivacyMode = fetchSandPrivacyMode) {\n  try {",
    'async function resolveSandRunPrivacyMode(options2, fetchPrivacyMode = fetchSandPrivacyMode) {\n  if (process.env.GROK_BOT_LOCAL_ONLY === "1") return PrivacyMode.NO_TRAINING;\n  try {',
    "host privacy lookup isolation",
  );
  text = replaceOnce(
    text,
    "function createSandLabelingClient(options2) {\n  const client = createSandCursorBackendClient(InferenceService, options2);",
    'function createSandLabelingClient(options2) {\n  if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n    return {\n      recordFollowupClassification: async () => {},\n      recordPostTurnLabeling: async () => {}\n    };\n  }\n  const client = createSandCursorBackendClient(InferenceService, options2);',
    "host labeling client isolation",
  );
  text = replaceOnce(
    text,
    "      if (skipLabeling) {\n        return session;",
    '      if (process.env.GROK_BOT_LOCAL_ONLY === "1" || skipLabeling) {\n        return session;',
    "host followup labeling isolation",
  );
  text = replaceOnce(
    text,
    "    recordPostTurnLabeling(args) {\n      recordSandPostTurnLabeling(getLabelingClient(), {",
    '    recordPostTurnLabeling(args) {\n      if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;\n      recordSandPostTurnLabeling(getLabelingClient(), {',
    "host post-turn labeling isolation",
  );
  text = replaceOnce(
    text,
    "      isReady: async () => process.env.SAND_AGENT_MOCK_RESPONSE != null || auth2.peekAccessToken() !== null,",
    '      isReady: async () => process.env.GROK_BOT_LOCAL_ONLY === "1" || process.env.SAND_AGENT_MOCK_RESPONSE != null || auth2.peekAccessToken() !== null,',
    "local inference readiness",
  );
  text = replaceInRegion(
    text,
    "var codebaseTelemetryExtension = defineHostExtension({",
    "  start: (context2) => {\n    const logger97 = createSandCodebaseTelemetryLogger(context2.host.log);",
    '  start: (context2) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") return { flushPendingUploads: async () => {} };\n    const logger97 = createSandCodebaseTelemetryLogger(context2.host.log);',
    "codebase telemetry isolation",
  );
  text = replaceInRegion(
    text,
    "var managedSetupExtension = defineHostExtension({",
    "  start: (context2) => {\n    const auth2 = context2.deps.auth;",
    '  start: (context2) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      return {\n        dispose: () => {},\n        skillsCatalog: async () => [],\n        ensureManagedSkill: async () => false,\n        resolveTeamRules: async () => []\n      };\n    }\n    const auth2 = context2.deps.auth;',
    "managed vendor setup isolation",
  );
  text = replaceOnce(
    text,
    "  return (next) => async (req) => {\n    const [auth2, machineId] = await Promise.all([",
    '  return (next) => async (req) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      throw new Error("Vendor backend RPCs are disabled in Open Bot local-only mode.");\n    }\n    const [auth2, machineId] = await Promise.all([',
    "host vendor backend isolation",
  );

  text = replaceAllExact(
    text,
    "mimeType: DEFAULT_SCREENSHOT_MIME_TYPE",
    'mimeType: process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE ? "image/png" : DEFAULT_SCREENSHOT_MIME_TYPE',
    2,
    "computer screenshot MIME",
  );
  text = replaceOnce(
    text,
    "snapshotDataUrl: `data:image/webp;base64,${screenshot}`",
    'snapshotDataUrl: `data:${process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE ? "image/png" : "image/webp"};base64,${screenshot}`',
    "handoff screenshot MIME",
  );

  const automationRegion = "var automationsExtension = defineHostExtension";
  const scheduler = `    let localRoutineWakesSuspended = false;
    const localRoutineIntervalMs = 15e3;
    const localRoutineTick = async () => {
      if (process.env.GROK_BOT_LOCAL_ROUTINES !== "1" || localRoutineWakesSuspended) return;
      const nowMs = Date.now();
      const timeZone = context2.deps.settings.getUserTimeZone();
      const entries = await transcript.listAllAutomationDefinitions();
      for (const { agentId, automation } of entries) {
        if (!automation.isEnabled) continue;
        const anchor = automation.lastRunAt ?? automation.createdAt;
        let scheduledForMs = null;
        for (const schedule of triggerCronSchedules(automation.trigger)) {
          const nextRunAt = computeNextRunAt(schedule, anchor, timeZone);
          if (nextRunAt != null && (scheduledForMs == null || nextRunAt < scheduledForMs)) scheduledForMs = nextRunAt;
        }
        if (scheduledForMs == null || scheduledForMs > nowMs) continue;
        const runUuid = \`local-\${agentId}-\${automation.id}-\${scheduledForMs}\`;
        void transcript.runServerScheduledAutomation({ agentId, automation, runUuid, scheduledForMs }).catch((error4) => {
          console.error(\`[codex-bot:automation] local scheduled fire failed for \${agentId}/\${automation.id}: \${errorMessage(error4)}\`);
        });
      }
    };
    const requestLocalRoutineTick = () => void localRoutineTick().catch((error4) => {
      console.error(\`[codex-bot:automation] local scheduler tick failed: \${errorMessage(error4)}\`);
    });
    const localRoutineTimer = process.env.GROK_BOT_LOCAL_ROUTINES === "1" ? setInterval(requestLocalRoutineTick, localRoutineIntervalMs) : null;
    if (localRoutineTimer != null) requestLocalRoutineTick();
`;
  text = replaceInRegion(
    text,
    automationRegion,
    "    hub.start();\n",
    `    hub.start();\n${scheduler}`,
    "local routine scheduler",
  );
  text = replaceInRegion(
    text,
    automationRegion,
    "    context2.onStop(async () => {",
    "    context2.onStop(async () => {\n      if (localRoutineTimer != null) clearInterval(localRoutineTimer);",
    "routine timer shutdown",
  );
  text = replaceInRegion(
    text,
    automationRegion,
    "      suspendWakes: async () => {\n        watcher.suspend();",
    "      suspendWakes: async () => {\n        localRoutineWakesSuspended = true;\n        watcher.suspend();",
    "routine suspend",
  );
  text = replaceInRegion(
    text,
    automationRegion,
    "      resumeWakes: () => {\n        watcher.resume();",
    "      resumeWakes: () => {\n        localRoutineWakesSuspended = false;\n        watcher.resume();",
    "routine resume",
  );
  text = replaceInRegion(
    text,
    automationRegion,
    "        fireConsumer.start();\n      },",
    "        fireConsumer.start();\n        requestLocalRoutineTick();\n      },",
    "routine resume tick",
  );

  const seatProvision = `    try {
      const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
      if (process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && seatBridgePath) {
        await require(seatBridgePath).manager.ensureSeat(result.agent.id);
      }
    } catch (error) {
      console.error("[codex-browser-seat] Unable to provision the new bot's browser seat", error);
    }
`;
  text = replaceAllExactInRegion(
    text,
    "  const mintAgent = async (args) => {",
    "\n  };\n  return {",
    "    return result;",
    `${seatProvision}    return result;`,
    1,
    "automatic browser seat",
  );
  const seatClose = `      try {
        const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
        if (seatBridgePath) await require(seatBridgePath).manager.closeSeatForKey(args.id);
      } catch (error) {
        console.error("[codex-browser-seat] Unable to close the deleted bot's browser seat", error);
      }
`;
  text = replaceAllExactInRegion(
    text,
    "    deleteAgent: async (args) => {",
    "\n    deleteAgents: async (args) => {",
    "      deps.hostEvents.emit({",
    `${seatClose}      deps.hostEvents.emit({`,
    1,
    "browser seat cleanup",
  );
  const batchSeatClose = `        try {
          const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
          if (seatBridgePath) await require(seatBridgePath).manager.closeSeatForKey(id);
        } catch (error) {
          console.error("[codex-browser-seat] Unable to close a batch-deleted bot's browser seat", error);
        }
`;
  text = replaceAllExactInRegion(
    text,
    "    deleteAgents: async (args) => {",
    "\n    duplicateAgent: (args) =>",
    "        deps.hostEvents.emit({",
    `${batchSeatClose}        deps.hostEvents.emit({`,
    1,
    "batch browser seat cleanup",
  );
  text = replaceOnce(
    text,
    "    skillsCatalog: () => managedSetup.skillsCatalog(),",
    '    skillsCatalog: () => process.env.GROK_BOT_LOCAL_ROUTINES === "1" ? Promise.resolve([]) : managedSetup.skillsCatalog(),',
    "remote plugin catalog",
  );

  text = replaceOnce(
    text,
    '    return createImageResult(output.result.value.screenshot, "image/webp", summary);',
    '    return createImageResult(output.result.value.screenshot, process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE ? "image/png" : "image/webp", summary);',
    "computer image result",
  );
  text = replaceOnce(
    text,
    "  const computerUse = resourceAccessor.get(computerUseExecutorResource);",
    `  const bridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE?.trim();
  const useLocalComputer = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1";
  const seatKey = typeof deps.seatKey === "string" ? deps.seatKey.trim() : "";
  if (useLocalComputer && (!bridgePath || !seatKey)) {
    throw new Error("A stable employee browser-seat key is required in local computer mode.");
  }
  const computerUse = useLocalComputer
    ? require(bridgePath).createExecutor({ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate, seatKey })
    : resourceAccessor.get(computerUseExecutorResource);`,
    "browser-seat executor",
  );
  text = replaceInRegion(
    text,
    "async function executeAndPersistComputerUse",
    '      "image/webp"',
    '      process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE ? "image/png" : "image/webp"',
    "persisted computer image MIME",
  );
  text = replaceAllExactInRegion(
    text,
    "      createComputerTool(remoteBoxResourceAccessor, {",
    "\n  if (host.isBrowserUseSubagent",
    "        getPersistImage: () => host.persistImage,",
    "        getPersistImage: () => host.persistImage,\n        seatKey: host.resolveBoxId(),",
    1,
    "stable employee Computer seat key",
  );
  text = replaceAllExactInRegion(
    text,
    "      createScreenshotTool(remoteBoxResourceAccessor, {",
    "\n  if (!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable() && host.boxHandoff",
    "        getPersistImage: () => host.persistImage\n      })",
    "        getPersistImage: () => host.persistImage,\n        seatKey: host.resolveBoxId(),\n      })",
    1,
    "stable employee Screenshot seat key",
  );
  text = replaceOnce(
    text,
    "  if (host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {",
    '  if ((host.isComputerUseSubagent || (!host.isSubagentRunner && !host.isSharedRoomRunner && process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1")) && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {',
    "direct local Computer availability",
  );
  text = replaceOnce(
    text,
    '    const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true;\n    return [\n      "## The box desktop",\n      ...browserUseOffered ? [',
    `    const browserUseOffered = host.isBrowserUseSubagentEnabled?.() === true;
    const directLocalComputerOffered = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable();
    return [
      "## The box desktop",
      ...directLocalComputerOffered ? [
        "You have Computer and the read-only Screenshot on your own employee browser seat. Use Computer directly for browser and desktop work, including public web research; do not substitute Shell curl, Python networking, or a background computerUse task when Computer is listed.",
        "Computer follows the app's real per-action computer policy. If an action needs approval, the app presents the real Computer approval card. Do not invent an approval, ask only in prose, or tell the user to change Agent execution, Shell, vendor-computer, or another unrelated permission.",
        "A denied Shell call does not mean browser access is blocked. Continue through Computer, inspect the returned screenshot after each material action, and verify the destination or result before reporting success."
      ] : browserUseOffered ? [`,
    "direct local Computer guidance",
  );
  text = replaceOnce(
    text,
    '    const remoteBox = extensions.api("forever-box").box;',
    '    const remoteBox = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" ? localExec.box : extensions.api("forever-box").box;',
    "local employee computer",
  );
  text = replaceOnce(
    text,
    "      isBrowserUseSubagentEnabled: () => experiments.isBrowserUseSubagentEnabled(),",
    '      isBrowserUseSubagentEnabled: () => process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" ? false : experiments.isBrowserUseSubagentEnabled(),',
    "browser subagent isolation",
  );
  verifyCoworkerHostBehaviorSource(text);
  verifyBrowserSeatLifecycleSource(text);
  verifyHostComputerSeatRoutingSource(text);

  fs.writeFileSync(file, text, "utf8");
}

function formatRenderer(file) {
  const cli = require.resolve("prettier/bin/prettier.cjs");
  const result = childProcess.spawnSync(
    process.execPath,
    [cli, "--write", file],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Renderer formatting failed: ${result.stderr || result.stdout}`,
    );
}

function patchRenderer(root, viewToken, viewPort) {
  const rendererAssets = resolveRendererAssetPaths(root);
  const renderer = rendererAssets.entryFile;
  formatRenderer(renderer);
  formatRenderer(rendererAssets.settingsFile);
  let text = fs.readFileSync(renderer, "utf8");

  const onboardingGate = uniqueFunctionRegion(
    text,
    [
      "isOnboardingSeen()",
      "isSignedIn()",
      "countAgents()",
      'gate: "onboarding"',
    ],
    "onboarding gate",
  );
  const onboardingGateName = functionName(onboardingGate, "onboarding gate");
  text = replaceFunction(
    text,
    [
      "isOnboardingSeen()",
      "isSignedIn()",
      "countAgents()",
      'gate: "onboarding"',
    ],
    `async function ${onboardingGateName}(n) {
  // The vendor sign-in gates xAI services. This derived app uses only the
  // user-owned local Codex route, so open the genuine workspace shell without
  // fabricating a vendor session or touching the original installation.
  try {
    if (await n.countAgents() > 0) n.markOnboardingSeen();
  } catch {}
  return { kind: "landed", gate: "shell", sessionFact: true, provisional: false };
}`,
    "onboarding gate",
  );
  text = replaceOnce(
    text,
    '    noteSignedOut: (d) => u({ kind: "signed-out", accountSlot: d }),',
    "    noteSignedOut: () => {},",
    "vendor logout onboarding transition",
  );
  text = replaceOnce(
    text,
    '    forceOnboarding: () => u({ kind: "force-onboarding" }),',
    "    forceOnboarding: () => {},",
    "vendor forced onboarding transition",
  );
  text = replaceOnce(
    text,
    `          children:
            e === "onboarding"
              ? p.jsx(eDn, { onComplete: s, presentation: lzn }, t)
              : p.jsx(Gzn, {}),`,
    `          children: p.jsx(Gzn, {}),`,
    "original workspace shell selection",
  );
  const rendererAuthRegion = uniqueFunctionRegion(
    text,
    [
      "async getCursorAuthStatus(t)",
      "async loginCursor(t)",
      "async cancelCursorLogin(t)",
      "async logoutCursor(t)",
    ],
    "renderer auth adapter",
  );
  text =
    text.slice(0, rendererAuthRegion.start) +
    `function codexLocalAuthIdentity() {
  return {
    kind: "logged-in",
    authId: "codex-bot-local",
    name: "Open Bot",
    displayName: "Open Bot",
    email: null,
    isAnysphereUser: false,
  };
}
` +
    text.slice(rendererAuthRegion.start);
  const rendererAuthName = functionName(
    uniqueFunctionRegion(
      text,
      [
        "async getCursorAuthStatus(t)",
        "async loginCursor(t)",
        "async cancelCursorLogin(t)",
        "async logoutCursor(t)",
      ],
      "renderer auth adapter",
    ),
    "renderer auth adapter",
  );
  text = replaceFunction(
    text,
    [
      "async getCursorAuthStatus(t)",
      "async loginCursor(t)",
      "async cancelCursorLogin(t)",
      "async logoutCursor(t)",
    ],
    `function ${rendererAuthName}(n) {
  void n;
  const unavailable = async () => ({
    ok: false,
    message: "Vendor account services are disabled in Open Bot local-only mode.",
  });
  return {
    async getCursorAuthStatus(t) {
      fn(t);
      // This is a renderer-only local identity slot. It unlocks the stock
      // roster and composer without creating or claiming an xAI session.
      return codexLocalAuthIdentity();
    },
    async loginCursor(t) {
      fn(t);
      return codexLocalAuthIdentity();
    },
    async cancelCursorLogin(t) {
      fn(t);
      return codexLocalAuthIdentity();
    },
    async logoutCursor(t) {
      fn(t);
      return codexLocalAuthIdentity();
    },
    async updateCursorAccountName(t, s) {
      fn(s);
      return { ...codexLocalAuthIdentity(), name: t.name, displayName: t.name };
    },
    async getCursorAvatar(t) {
      fn(t);
      return null;
    },
    async getCursorWeeklyUsage(t) {
      fn(t);
      return null;
    },
    async getCursorUsageSummary(t) {
      fn(t);
      return null;
    },
    async getCursorPrReviewPreferences(t) {
      fn(t);
      return { user: void 0, team: void 0 };
    },
    async getCursorPrivacyModeEnabled(t) {
      fn(t);
      return true;
    },
    async getSandAccess(t) {
      fn(t);
      return { state: "granted", reason: "none" };
    },
    async getSandAccessFresh(t) {
      fn(t);
      return { state: "granted", reason: "none" };
    },
    async invokeCursorDashboardAction(t, s) {
      fn(s);
      return unavailable(t);
    },
    async cancelCursorSandTrial(t) {
      fn(t);
      return unavailable();
    },
  };
}`,
    "local frontend identity adapter",
  );
  text = replaceOnce(
    text,
    "tBn();",
    "/* Renderer Sentry is disabled in the Open Bot local-only build. */",
    "renderer telemetry isolation",
  );
  const pauseGate = uniqueFunctionRegion(
    text,
    ["sand_client_pause"],
    "local computer setup gate",
  );
  const pauseGateName = functionName(pauseGate, "local computer setup gate");
  text = replaceFunction(
    text,
    ["sand_client_pause"],
    `function ${pauseGateName}() {\n  // sand_client_pause belongs to vendor computer setup, which is disabled locally.\n  return false;\n}`,
    "local computer setup bypass",
  );

  const pluginSidebar = uniqueFunctionRegion(
    text,
    ["sand-agents-sidebar__plugins-entry", "onOpenPlugins"],
    "plugin sidebar entry",
  );
  const pluginSidebarName = functionName(pluginSidebar, "plugin sidebar entry");
  text = replaceFunction(
    text,
    ["sand-agents-sidebar__plugins-entry", "onOpenPlugins"],
    `function ${pluginSidebarName}() {\n  // Vendor plugin discovery is unavailable in the local-only build.\n  return null;\n}`,
    "plugin sidebar entry",
  );

  const pluginOverlayOpeners = [
    {
      needles: [
        "focusPlugin: { pluginId: n, arrival: e }",
        "Rme.open(Uf.plugins(",
      ],
      parameters: "n, e",
      body: "  void n;\n  void e;",
      label: "focused plugin overlay opener",
    },
    {
      needles: ["Rme.open(Uf.plugins());"],
      parameters: "",
      body: "",
      label: "plugin overlay opener",
    },
    {
      needles: ["focusWorkflowId: n", "Rme.open(Uf.plugins("],
      parameters: "n = null",
      body: "  void n;",
      label: "workflow overlay opener",
    },
    {
      needles: ["focusServerId: n", "Rme.open(Uf.plugins("],
      parameters: "n",
      body: "  void n;",
      label: "MCP server overlay opener",
    },
    {
      needles: ["focusBrowseQuery: n", "Rme.open(Uf.plugins("],
      parameters: "n",
      body: "  void n;",
      label: "plugin browse overlay opener",
    },
  ];
  for (const opener of pluginOverlayOpeners) {
    const region = uniqueFunctionRegion(text, opener.needles, opener.label);
    const name = functionName(region, opener.label);
    const body = opener.body.length === 0 ? "" : `\n${opener.body}`;
    text = replaceFunction(
      text,
      opener.needles,
      `function ${name}(${opener.parameters}) {\n  // Vendor plugin overlays are disabled in the local-only build.${body}\n}`,
      opener.label,
    );
  }
  const pluginReferenceRouter = uniqueFunctionRegion(
    text,
    ['n.startsWith("mcp-install:")', 'n.startsWith("mcp:")'],
    "plugin reference router",
  );
  const pluginReferenceRouterName = functionName(
    pluginReferenceRouter,
    "plugin reference router",
  );
  text = replaceFunction(
    text,
    ['n.startsWith("mcp-install:")', 'n.startsWith("mcp:")'],
    `function ${pluginReferenceRouterName}(n, e) {\n  // Transcript references cannot reopen the disabled vendor plugin overlay.\n  void n;\n  void e;\n}`,
    "plugin reference router",
  );
  text = replaceAllExactInFunction(
    text,
    ['id: "sand.openTools"', 'id: "sand.openWorkflows"'],
    `        {
          id: "sand.openTools",
          label: "Customize",
          hotkey: "mod+shift+m",
          isEnabledInContentEditable: !0,
          run: uSe,
        },
`,
    "",
    1,
    "global plugin action",
  );
  text = replaceAllExactInFunction(
    text,
    ['id: "sand.openWorkflows"', 'id: "sand.focusInput"'],
    `        {
          id: "sand.openWorkflows",
          label: "Skills",
          hotkey: "mod+shift+w",
          isEnabledInContentEditable: !0,
          run: () => A0t(),
        },
`,
    "",
    1,
    "global workflow action",
  );

  const component = fs
    .readFileSync(
      path.join(PROJECT_ROOT, "src", "renderer", "live-seat-component.jsfrag"),
      "utf8",
    )
    .replace(/^\uFEFF/, "")
    .replaceAll("__CODEX_VIEW_PORT__", String(viewPort))
    .replace(/\bT\./g, "S.")
    .replace(/\bh\./g, "p.");
  let previewRegion = uniqueFunctionRegion(
    text,
    ["sand-computer-preview__frame", "isStatusUnavailable", "subjectLabel"],
    "computer preview",
  );
  text =
    text.slice(0, previewRegion.start) +
    component +
    text.slice(previewRegion.start);
  previewRegion = uniqueFunctionRegion(
    text,
    ["sand-computer-preview__frame", "isStatusUnavailable", "subjectLabel"],
    "computer preview",
  );
  const previewStart = previewRegion.source.indexOf(
    "              style: { aspectRatio:",
  );
  const previewCloseMarker = "\n              ],\n            }),";
  const previewClose = previewRegion.source.indexOf(
    previewCloseMarker,
    previewStart,
  );
  if (previewStart < 0 || previewClose < 0)
    throw new Error("Computer preview patch anchors not found");
  const previewEnd = previewClose + "\n              ],".length;
  const patchedPreview =
    previewRegion.source.slice(0, previewStart) +
    '              style: { aspectRatio: "1280 / 800" },\n              children: [p.jsx(GBLiveSeat, { agentId: n, subjectLabel: r })],' +
    previewRegion.source.slice(previewEnd);
  text =
    text.slice(0, previewRegion.start) +
    patchedPreview +
    text.slice(previewRegion.end);

  text = replaceOnce(
    text,
    `const wDn = [
  { id: "general", label: "General", icon: "settings-gear" },
  { id: "usage", label: "Usage & Billing", icon: "chart-bars" },
  { id: "beta", label: "Updates", icon: "cloud-download" },
];`,
    'const wDn = [{ id: "general", label: "General", icon: "settings-gear" }];',
    "settings navigation",
  );
  text = replaceOnceInFunction(
    text,
    [
      "windowWidth: window.innerWidth",
      "sidebar: m",
      "paneWidth: u",
      "S.useSyncExternalStore(EDn",
    ],
    "    h = S.useSyncExternalStore(EDn, () =>\n      uan({ windowWidth: window.innerWidth, sidebar: m, paneWidth: u }),\n    ),",
    "    h =\n      S.useSyncExternalStore(EDn, () =>\n        uan({ windowWidth: window.innerWidth, sidebar: m, paneWidth: u }),\n      ) || !0,",
    "narrow live pane",
  );

  const pluginCommandRegion = uniqueFunctionRegion(
    text,
    ['id: "overlay:plugins"', 'label: "Jump to"', "composerActions:"],
    "plugin command",
  );
  const pluginCommandStart = pluginCommandRegion.source.indexOf(
    '        {\n          id: "overlay:plugins",',
  );
  const pluginCommandEnd = pluginCommandRegion.source.indexOf(
    "        ...NDn",
    pluginCommandStart,
  );
  if (pluginCommandStart < 0 || pluginCommandEnd < 0)
    throw new Error("Plugin command patch anchors not found");
  const patchedPluginCommands =
    pluginCommandRegion.source.slice(0, pluginCommandStart) +
    pluginCommandRegion.source.slice(pluginCommandEnd);
  text =
    text.slice(0, pluginCommandRegion.start) +
    patchedPluginCommands +
    text.slice(pluginCommandRegion.end);
  text = patchRendererComposerIdentitySource(text);
  verifyLiveSeatAliasIsolationSource(text);
  verifyRendererRuntimeBindingsSource(text);
  fs.writeFileSync(renderer, text, "utf8");

  const settingsView = rendererAssets.settingsFile;
  const settingsText = patchSettingsViewSource(
    fs.readFileSync(settingsView, "utf8"),
  );
  fs.writeFileSync(settingsView, settingsText, "utf8");

  const htmlFile = rendererAssets.htmlFile;
  let html = fs.readFileSync(htmlFile, "utf8");
  html = replaceOnce(
    html,
    "connect-src 'self' ws: sand-media:;",
    `connect-src 'self' http://127.0.0.1:${viewPort} ws: sand-media:;`,
    "loopback CSP",
  );
  const entryScript = `<script type="module" crossorigin src="./assets/${path.basename(renderer)}"></script>`;
  html = replaceOnce(
    html,
    entryScript,
    `<script type="module" src="./codex-ui.js"></script>\n    ${entryScript}`,
    "Codex UI module",
  );
  fs.writeFileSync(htmlFile, html, "utf8");

  let codexUi = fs.readFileSync(
    path.join(PROJECT_ROOT, "src", "renderer", "codex-ui.js"),
    "utf8",
  );
  if (
    !codexUi.includes("__CODEX_VIEW_TOKEN__") ||
    !codexUi.includes("__CODEX_VIEW_PORT__")
  ) {
    throw new Error("Renderer connection placeholder is missing");
  }
  const providerIcons = Object.freeze({
    __OPEN_BOT_ICON_CODEX__: "openai-codex.png",
    __OPEN_BOT_ICON_CLAUDE__: "anthropic-claude.png",
    __OPEN_BOT_ICON_KIMI__: "moonshot-kimi.png",
    __OPEN_BOT_ICON_XAI__: "xai.png",
    __OPEN_BOT_ICON_VERTEX__: "google-vertex.png",
  });
  for (const [placeholder, filename] of Object.entries(providerIcons)) {
    if (codexUi.split(placeholder).length !== 2)
      throw new Error(
        `Renderer provider icon placeholder is missing or ambiguous: ${placeholder}`,
      );
    codexUi = codexUi.replace(
      placeholder,
      pngDataUri(path.join(PROJECT_ROOT, "assets", "provider-icons", filename)),
    );
  }
  writeText(
    path.join(root, "dist", "renderer", "codex-ui.js"),
    codexUi
      .replaceAll("__CODEX_VIEW_TOKEN__", viewToken)
      .replaceAll("__CODEX_VIEW_PORT__", String(viewPort)),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceAsar = path.resolve(args["source-asar"] || "");
  const targetAsar = path.resolve(args["target-asar"] || "");
  const runtimeConfig = path.resolve(args["runtime-config"] || "");
  if (
    !fs.existsSync(sourceAsar) ||
    !targetAsar ||
    !fs.existsSync(runtimeConfig)
  ) {
    throw new Error(
      "Usage: patch-app.cjs --source-asar <original app.asar> --target-asar <patched app.asar> --runtime-config <runtime.json>",
    );
  }
  const sourceHash = sha256(sourceAsar);
  if (sourceHash !== SUPPORTED.appAsarSha256) {
    throw new Error(
      `Unsupported app.asar (${sourceHash}). This release supports Grok Bot ${SUPPORTED.version} only.`,
    );
  }
  const runtime = readJson(runtimeConfig);
  if (!/^[A-Za-z0-9_-]{24,}$/.test(runtime.viewToken || ""))
    throw new Error("runtime.json contains an invalid viewToken");
  if (
    !Number.isInteger(runtime.viewPort) ||
    runtime.viewPort < 1024 ||
    runtime.viewPort > 65535
  ) {
    throw new Error("runtime.json contains an invalid viewPort");
  }

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-patch-"),
  );
  const extracted = path.join(temporaryRoot, "app");
  fs.mkdirSync(extracted);
  try {
    asar.extractAll(sourceAsar, extracted);
    applyBranding(extracted);
    patchPackage(extracted);
    patchElectronMain(extracted);
    patchLocalExec(extracted);
    patchHost(extracted);
    patchRenderer(extracted, runtime.viewToken, runtime.viewPort);
    verifyLocalAuthIsolation(extracted);
    fs.mkdirSync(path.dirname(targetAsar), { recursive: true });
    await asar.createPackageWithOptions(extracted, targetAsar, {
      unpackDir: "{dist/deps,dist/native}",
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, sourceHash, targetHash: sha256(targetAsar), version: SUPPORTED.version })}\n`,
    );
  } finally {
    if (temporaryRoot.startsWith(os.tmpdir() + path.sep))
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  patchHostAgentIdentitySource,
  patchRendererComposerIdentitySource,
  patchSettingsViewSource,
  replaceFunction,
  verifyCoworkerHostBehaviorSource,
  verifyBrowserSeatLifecycleSource,
  verifyHostComputerSeatRoutingSource,
  verifyHostAgentIdentitySource,
  verifyHostLocalOnlySource,
  verifyLocalExecComputerIsolationSource,
  verifyLocalAuthIsolationSources,
  verifyLiveSeatAliasIsolationSource,
  verifyRendererComposerIdentitySource,
  verifyRendererRuntimeBindingsSource,
  verifySettingsViewSource,
};
