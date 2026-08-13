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

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SUPPORTED = Object.freeze({
  version: "0.16.0",
  appAsarSha256: "955fb24e72ec85729cac2f921758a93a85089a0fc659e712125d6650b364d20e",
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
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`Patch anchor is ambiguous: ${label}`);
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
  if (count !== expected) throw new Error(`Expected ${expected} ${label} anchor(s), found ${count}`);
  return text.split(before).join(after);
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
    ["Grok Bot", "Codex Bot"],
    ["grok bot", "codex bot"],
    ["X-Grok-Seat-Token", "X-Codex-Seat-Token"],
    ["Sign In with Cursor", "Sign in with Codex"],
    ["Sign in to Cursor", "Sign in with Codex"],
    ["Signed in to Cursor", "Signed in to Codex"],
    ["Cursor account", "Codex account"],
    ["Cursor Account", "Codex Account"],
  ];
  walk(root, (file) => {
    if (!extensions.has(path.extname(file).toLowerCase()) || file.endsWith("codex-ui.js")) return;
    let text = fs.readFileSync(file, "utf8");
    const before = text;
    for (const [search, replacement] of replacements) text = text.split(search).join(replacement);
    if (text !== before) fs.writeFileSync(file, text, "utf8");
  });
}

function patchPackage(root) {
  const file = path.join(root, "package.json");
  const packageJson = readJson(file);
  if (packageJson.version !== SUPPORTED.version) throw new Error(`Unsupported Grok Bot version ${packageJson.version}`);
  packageJson.productName = "Codex Bot";
  packageJson.description = "Codex-powered digital coworker";
  packageJson.author = "Codex Bot community build";
  packageJson.homepage = "https://github.com/LimonLimez/Codex-Bot";
  writeText(file, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function patchElectronMain(root) {
  const file = path.join(root, "dist", "electron-main", "main.cjs");
  let text = fs.readFileSync(file, "utf8");
  const strictIndex = text.indexOf('"use strict";\n');
  if (strictIndex < 0) throw new Error("Electron local-only startup anchor not found");
  const localOnlyBootstrap = `"use strict";
process.env.GROK_BOT_LOCAL_ONLY = "1";
process.env.SAND_DISABLE_TELEMETRY = "1";
process.env.SAND_DISABLE_ANALYTICS = "1";
process.env.SAND_DISABLE_UPDATES = "1";
process.env.SAND_BACKEND_URL = "http://127.0.0.1:1";
`;
  text = text.slice(0, strictIndex) + localOnlyBootstrap + text.slice(strictIndex + '"use strict";\n'.length);
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
    '  return (next) => async (req) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      throw new Error("Vendor backend RPCs are disabled in Codex Bot local-only mode.");\n    }\n    const [auth2, machineId] = await Promise.all([',
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
  const stateRoot = process.env.CODEX_BOT_STATE_ROOT?.trim();
  const descriptor = process.env.SAND_HOST_GATEWAY_URL?.trim();
  if (!stateRoot || !descriptor) return false;
  try {
    const url = new URL(descriptor);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
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
    'ipcMain9.handle("sand:sand-access", async () => {\n    return await (await ensureSandAccessReader()).read();\n  });',
    'ipcMain9.handle("sand:sand-access", async () => {\n    // Inference is provided by the user-owned local Codex route.\n    return { state: "granted", reason: "none" };\n  });',
    "local inference entitlement",
  );
  text = replaceOnce(
    text,
    "    return posixPathFromFileUrl(source);",
    "    const filePath = posixPathFromFileUrl(source);\n    if (filePath == null) return null;\n    return process.platform === \"win32\" && /^\\/[A-Za-z]:\\//.test(filePath) ? filePath.slice(1) : filePath;",
    "Windows file attachment normalization",
  );
  text = replaceOnce(
    text,
    "import_electron50.app.whenReady().then(async () => {",
    'if (process.platform === "win32") {\n  import_electron50.app.setAppUserModelId("io.github.limonlimez.codexbot");\n}\nimport_electron50.app.whenReady().then(async () => {',
    "Windows application id",
  );
  fs.writeFileSync(file, text, "utf8");
}

function patchLocalExec(root) {
  const file = path.join(root, "dist", "local-exec-daemon", "main.cjs");
  let text = fs.readFileSync(file, "utf8");
  text = replaceInRegion(
    text,
    "function buildLocalExecManager(root, maxFileBytes)",
    "  return SimpleControlledExecManager.fromResources(registry3);",
    `  const windowsComputerBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE?.trim();
  if (process.platform === "win32" && windowsComputerBridgePath) {
    const windowsComputerBridge = require(windowsComputerBridgePath);
    registry3.register(
      computerUseExecutorResource,
      windowsComputerBridge.createExecutor({ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate })
    );
  }
  return SimpleControlledExecManager.fromResources(registry3);`,
    "local computer executor",
  );
  fs.writeFileSync(file, text, "utf8");
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
  text = text.slice(0, strictIndex) + startupBridge + text.slice(strictIndex + '"use strict";\n'.length);

  const inferenceStart = text.indexOf("function createCursorInferencePromptSession(options2) {");
  const inferenceEnd = text.indexOf("\nvar PRIVACY_MODE_CACHE_MAX_AGE_MS", inferenceStart);
  if (inferenceStart < 0 || inferenceEnd < 0) throw new Error("Inference function patch anchors not found");
  const inferenceReplacement = `function createCursorInferencePromptSession(options2) {
  const bridgePath = process.env.GROK_BOT_CLIPROXY_BRIDGE;
  if (bridgePath == null || bridgePath.trim() === "") {
    throw new Error("GROK_BOT_CLIPROXY_BRIDGE is required in the Codex Bot build.");
  }
  return require(bridgePath).createPromptSession(options2, imageResizingMiddleware);
}`;
  text = text.slice(0, inferenceStart) + inferenceReplacement + text.slice(inferenceEnd);

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
    'var codebaseTelemetryExtension = defineHostExtension({',
    "  start: (context2) => {\n    const logger96 = createSandCodebaseTelemetryLogger(context2.host.log);",
    '  start: (context2) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") return { flushPendingUploads: async () => {} };\n    const logger96 = createSandCodebaseTelemetryLogger(context2.host.log);',
    "codebase telemetry isolation",
  );
  text = replaceInRegion(
    text,
    'var managedSetupExtension = defineHostExtension({',
    "  start: (context2) => {\n    const auth2 = context2.deps.auth;",
    '  start: (context2) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      return {\n        dispose: () => {},\n        skillsCatalog: async () => [],\n        ensureManagedSkill: async () => false,\n        resolveTeamRules: async () => []\n      };\n    }\n    const auth2 = context2.deps.auth;',
    "managed vendor setup isolation",
  );
  text = replaceOnce(
    text,
    "  return (next) => async (req) => {\n    const [auth2, machineId] = await Promise.all([",
    '  return (next) => async (req) => {\n    if (process.env.GROK_BOT_LOCAL_ONLY === "1") {\n      throw new Error("Vendor backend RPCs are disabled in Codex Bot local-only mode.");\n    }\n    const [auth2, machineId] = await Promise.all([',
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
  text = replaceInRegion(text, automationRegion, "    hub.start();\n", `    hub.start();\n${scheduler}`, "local routine scheduler");
  text = replaceInRegion(text, automationRegion, "    context2.onStop(async () => {", "    context2.onStop(async () => {\n      if (localRoutineTimer != null) clearInterval(localRoutineTimer);", "routine timer shutdown");
  text = replaceInRegion(text, automationRegion, "      suspendWakes: async () => {\n        watcher.suspend();", "      suspendWakes: async () => {\n        localRoutineWakesSuspended = true;\n        watcher.suspend();", "routine suspend");
  text = replaceInRegion(text, automationRegion, "      resumeWakes: () => {\n        watcher.resume();", "      resumeWakes: () => {\n        localRoutineWakesSuspended = false;\n        watcher.resume();", "routine resume");
  text = replaceInRegion(text, automationRegion, "        fireConsumer.start();\n      },", "        fireConsumer.start();\n        requestLocalRoutineTick();\n      },", "routine resume tick");

  const createAgentRegion = "    createAgent: async (args) => {";
  const seatProvision = `      try {
        const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
        if (process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && seatBridgePath) {
          await require(seatBridgePath).manager.ensureSeat(result.agent.id);
        }
      } catch (error) {
        console.error("[codex-browser-seat] Unable to provision the new bot's browser seat", error);
      }
`;
  text = replaceInRegion(text, createAgentRegion, "      return result;", `${seatProvision}      return result;`, "automatic browser seat");
  const deleteAgentRegion = "    deleteAgent: async (args) => {";
  const seatClose = `      try {
        const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
        if (seatBridgePath) await require(seatBridgePath).manager.closeSeatForKey(args.id);
      } catch (error) {
        console.error("[codex-browser-seat] Unable to close the deleted bot's browser seat", error);
      }
`;
  text = replaceInRegion(text, deleteAgentRegion, "      deps.hostEvents.emit({", `${seatClose}      deps.hostEvents.emit({`, "browser seat cleanup");
  text = replaceOnce(text, "    skillsCatalog: () => managedSetup.skillsCatalog(),", '    skillsCatalog: () => process.env.GROK_BOT_LOCAL_ROUTINES === "1" ? Promise.resolve([]) : managedSetup.skillsCatalog(),', "remote plugin catalog");

  text = replaceOnce(text, '    return createImageResult(output.result.value.screenshot, "image/webp", summary);', '    return createImageResult(output.result.value.screenshot, process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE ? "image/png" : "image/webp", summary);', "computer image result");
  text = replaceOnce(
    text,
    "  const computerUse = resourceAccessor.get(computerUseExecutorResource);",
    `  const bridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE?.trim();
  const computerUse = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && bridgePath
    ? require(bridgePath).createExecutor({ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate, seatKey: deps.seatKey })
    : resourceAccessor.get(computerUseExecutorResource);`,
    "browser-seat executor",
  );
  text = replaceInRegion(text, "async function executeAndPersistComputerUse", '      "image/webp"', '      process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE ? "image/png" : "image/webp"', "persisted computer image MIME");
  text = replaceInRegion(text, "createComputerTool(remoteBoxResourceAccessor", "        getPersistImage: () => host.persistImage,", "        getPersistImage: () => host.persistImage,\n        seatKey: host.resolveBoxId(),", "stable employee seat key");
  text = replaceOnce(text, '    const remoteBox = extensions.api("forever-box").box;', '    const remoteBox = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" ? localExec.box : extensions.api("forever-box").box;', "local employee computer");
  text = replaceOnce(text, "      isBrowserUseSubagentEnabled: () => experiments.isBrowserUseSubagentEnabled(),", '      isBrowserUseSubagentEnabled: () => process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" ? false : experiments.isBrowserUseSubagentEnabled(),', "browser subagent isolation");
  text = replaceOnce(text, "        const executor = host.isSubagentRunner || isSilenceAllowed ? diskPressureExecutor : applyStartOfTurnAckReminder(applySendMessageReminder(diskPressureExecutor));", "        const executor = host.isSubagentRunner || isSilenceAllowed ? diskPressureExecutor : applySendMessageReminder(diskPressureExecutor);", "coworker acknowledgement behavior");

  fs.writeFileSync(file, text, "utf8");
}

function formatRenderer(file) {
  const cli = require.resolve("prettier/bin/prettier.cjs");
  const result = childProcess.spawnSync(process.execPath, [cli, "--write", file], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.status !== 0) throw new Error(`Renderer formatting failed: ${result.stderr || result.stdout}`);
}

function patchRenderer(root, viewToken, viewPort) {
  const renderer = path.join(root, "dist", "renderer", "assets", "index-DVUCYGay.js");
  formatRenderer(renderer);
  let text = fs.readFileSync(renderer, "utf8");

  const onboardingGateStart = text.indexOf("async function gus(n) {");
  const onboardingGateEnd = text.indexOf("function yus()", onboardingGateStart);
  if (onboardingGateStart < 0 || onboardingGateEnd < 0) throw new Error("Onboarding gate patch anchors not found");
  text = text.slice(0, onboardingGateStart) + `async function gus(n) {
  // The vendor sign-in gates xAI services. This derived app uses only the
  // user-owned local Codex route, so open the genuine workspace shell without
  // fabricating a vendor session or touching the original installation.
  try {
    if (await n.countAgents() > 0) n.markOnboardingSeen();
  } catch {}
  return { kind: "landed", gate: "shell", sessionFact: true, provisional: false };
}
` + text.slice(onboardingGateEnd);
  text = replaceOnce(
    text,
    '    noteSignedOut: (u) => c({ kind: "signed-out", accountSlot: u }),',
    "    noteSignedOut: () => {},",
    "vendor logout onboarding transition",
  );
  text = replaceOnce(
    text,
    '    forceOnboarding: () => c({ kind: "force-onboarding" }),',
    "    forceOnboarding: () => {},",
    "vendor forced onboarding transition",
  );
  text = replaceOnce(
    text,
    `          children:
            e === "onboarding"
              ? h.jsx(tis, { onComplete: s, presentation: sls }, t)
              : h.jsx($ls, {}),`,
    `          children: h.jsx($ls, {}),`,
    "original workspace shell selection",
  );
  text = replaceOnce(
    text,
    `    async getCursorAuthStatus(t) {
      return NQ("getCursorAuthStatus", t, () => e.getStatus());
    },`,
    `    async getCursorAuthStatus(t) {
      Cn(t);
      // This is a renderer-only local identity slot. It unlocks the stock
      // roster and composer without creating or claiming an xAI session.
      return {
        kind: "logged-in",
        authId: "codex-bot-local",
        name: "Codex Bot User",
        isAnysphereUser: false,
      };
    },`,
    "local frontend identity adapter",
  );
  text = replaceOnce(text, "hns();", "/* Renderer Sentry is disabled in the Codex Bot local-only build. */", "renderer telemetry isolation");
  text = replaceOnce(
    text,
    `function Vqt() {
  return cs(ct().experiments.snapshots)?.featureGates?.sand_client_pause ?? !1;
}`,
    `function Vqt() {
  return false;
}`,
    "local computer setup bypass",
  );

  const sidebarStart = text.indexOf("  let Ps;", text.indexOf("function hCn(n)"));
  const sidebarEnd = text.indexOf("  let rr;", sidebarStart);
  if (sidebarStart < 0 || sidebarEnd < 0) throw new Error("Plugin sidebar patch anchors not found");
  text = text.slice(0, sidebarStart) + "  let Ps;\n  e[177] !== xs || e[178] !== oe\n    ? ((Ps = null), (e[177] = xs), (e[178] = oe), (e[179] = Ps))\n    : (Ps = e[179]);\n" + text.slice(sidebarEnd);

  const component = fs.readFileSync(path.join(PROJECT_ROOT, "src", "renderer", "live-seat-component.jsfrag"), "utf8")
    .replace(/^\uFEFF/, "")
    .replaceAll("__CODEX_VIEW_PORT__", String(viewPort));
  text = replaceOnce(text, "function VFn({", `${component}function VFn({`, "live browser-seat component");
  const previewFunction = text.indexOf("function VFn({");
  const previewStart = text.indexOf("              style: { aspectRatio:", previewFunction);
  const previewEnd = text.indexOf("            }),\n            P", previewStart);
  if (previewStart < 0 || previewEnd < 0) throw new Error("Computer preview patch anchors not found");
  text = text.slice(0, previewStart) + '              style: { aspectRatio: "1280 / 800" },\n              children: [h.jsx(GBLiveSeat, { agentId: n, subjectLabel: r })],\n' + text.slice(previewEnd);

  const settingsStart = text.indexOf("const vis = [", text.indexOf("function wis(n)"));
  const settingsEnd = text.indexOf("];", settingsStart) + 2;
  if (settingsStart < 0 || settingsEnd < 2) throw new Error("Settings navigation patch anchors not found");
  text = text.slice(0, settingsStart) + 'const vis = [{ id: "general", label: "General", icon: "settings-gear" }];' + text.slice(settingsEnd);
  text = replaceOnce(
    text,
    "    p = T.useSyncExternalStore(Cis, () =>\n      fwn({ windowWidth: window.innerWidth, sidebar: m, paneWidth: u }),\n    ),",
    "    p =\n      T.useSyncExternalStore(Cis, () =>\n        fwn({ windowWidth: window.innerWidth, sidebar: m, paneWidth: u }),\n      ) || !0,",
    "narrow live pane",
  );
  text = replaceInRegion(text, "function Ais(n)", "      if (!c) {", "      if (!c && !p) {", "narrow pane resize");

  const pluginCommandStart = text.indexOf('        {\n          id: "overlay:plugins",', text.indexOf("function Fis(n)"));
  const pluginCommandEnd = text.indexOf("        ...Nis", pluginCommandStart);
  if (pluginCommandStart < 0 || pluginCommandEnd < 0) throw new Error("Plugin command patch anchors not found");
  text = text.slice(0, pluginCommandStart) + "        ...[],\n" + text.slice(pluginCommandEnd);
  fs.writeFileSync(renderer, text, "utf8");

  const htmlFile = path.join(root, "dist", "renderer", "index.html");
  let html = fs.readFileSync(htmlFile, "utf8");
  html = replaceOnce(html, "connect-src 'self' ws: sand-media:;", `connect-src 'self' http://127.0.0.1:${viewPort} ws: sand-media:;`, "loopback CSP");
  html = replaceOnce(html, '<script type="module" crossorigin src="./assets/index-DVUCYGay.js"></script>', '<script type="module" src="./codex-ui.js"></script>\n    <script type="module" crossorigin src="./assets/index-DVUCYGay.js"></script>', "Codex UI module");
  fs.writeFileSync(htmlFile, html, "utf8");

  const codexUi = fs.readFileSync(path.join(PROJECT_ROOT, "src", "renderer", "codex-ui.js"), "utf8");
  if (!codexUi.includes("__CODEX_VIEW_TOKEN__") || !codexUi.includes("__CODEX_VIEW_PORT__")) {
    throw new Error("Renderer connection placeholder is missing");
  }
  writeText(
    path.join(root, "dist", "renderer", "codex-ui.js"),
    codexUi.replaceAll("__CODEX_VIEW_TOKEN__", viewToken).replaceAll("__CODEX_VIEW_PORT__", String(viewPort)),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceAsar = path.resolve(args["source-asar"] || "");
  const targetAsar = path.resolve(args["target-asar"] || "");
  const runtimeConfig = path.resolve(args["runtime-config"] || "");
  if (!fs.existsSync(sourceAsar) || !targetAsar || !fs.existsSync(runtimeConfig)) {
    throw new Error("Usage: patch-app.cjs --source-asar <original app.asar> --target-asar <patched app.asar> --runtime-config <runtime.json>");
  }
  const sourceHash = sha256(sourceAsar);
  if (sourceHash !== SUPPORTED.appAsarSha256) {
    throw new Error(`Unsupported app.asar (${sourceHash}). This release supports Grok Bot ${SUPPORTED.version} only.`);
  }
  const runtime = readJson(runtimeConfig);
  if (!/^[A-Za-z0-9_-]{24,}$/.test(runtime.viewToken || "")) throw new Error("runtime.json contains an invalid viewToken");
  if (!Number.isInteger(runtime.viewPort) || runtime.viewPort < 1024 || runtime.viewPort > 65535) {
    throw new Error("runtime.json contains an invalid viewPort");
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-patch-"));
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
    fs.mkdirSync(path.dirname(targetAsar), { recursive: true });
    await asar.createPackageWithOptions(extracted, targetAsar, { unpackDir: "{dist/deps,dist/native}" });
    process.stdout.write(`${JSON.stringify({ ok: true, sourceHash, targetHash: sha256(targetAsar), version: SUPPORTED.version })}\n`);
  } finally {
    if (temporaryRoot.startsWith(os.tmpdir() + path.sep)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
