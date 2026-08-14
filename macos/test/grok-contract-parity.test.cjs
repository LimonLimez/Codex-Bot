"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const macRoot = path.resolve(__dirname, "..");
const contractPath = path.join(
  macRoot,
  "assets",
  "grok-bot-0.20.0-contract.json",
);
const auditorPath = path.join(macRoot, "scripts", "audit-grok-contract.cjs");

const additions = [
  "attachProdBoxStatus",
  "devRestart",
  "getHardwareAcceleration",
  "listClientPersistenceKeys",
  "migrateClientPersistence",
  "noteSentryConversation",
  "readClientPersistence",
  "relaunchDesktop",
  "removeClientPersistence",
  "reportHeapMetrics",
  "setAttachProdBoxEnabled",
  "setHardwareAccelerationEnabled",
  "writeClientPersistence",
];

const requiredFeatures = [
  "attachments",
  "audio-transcription",
  "authentication",
  "background-tasks",
  "bot-profile",
  "computer",
  "connectors-mcp",
  "feedback",
  "group-chat",
  "models",
  "onboarding",
  "plugins",
  "routines",
  "secrets",
  "settings-theme",
  "skills",
  "team-coordination",
  "updates",
  "usage",
  "window-controls",
  "workspace-repository",
];

function loadContract() {
  return JSON.parse(fs.readFileSync(contractPath, "utf8"));
}

function loadAuditor() {
  delete require.cache[require.resolve(auditorPath)];
  return require(auditorPath);
}

function syntheticPreload(contract) {
  const methods = contract.rpcMethods
    .map((name, index) => `${JSON.stringify(name)}:{args:${index % 2 === 0 ? '"none"' : '"object"'}}`)
    .join(",");
  const subscriptions = contract.eventSubscriptions
    .map((name) => `edge.subscribe({${JSON.stringify(name)}:listener});`)
    .join("\n");
  const ipc = contract.directIpcChannels
    .map((name) => `ipcRenderer.invoke(${JSON.stringify(name)},{});`)
    .join("\n");
  return `const table={${methods}};\n${subscriptions}\n${ipc}\n`;
}

test("the Grok 0.20 contract records every stock preload and feature boundary", () => {
  const contract = loadContract();
  assert.deepEqual(
    {
      schemaVersion: contract.schemaVersion,
      product: contract.product,
      version: contract.version,
      platform: contract.platform,
      appAsarSha256: contract.appAsarSha256,
    },
    {
      schemaVersion: 1,
      product: "Grok Bot",
      version: "0.20.0",
      platform: "darwin-arm64",
      appAsarSha256:
        "1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997",
    },
  );
  assert.match(contract.preloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(contract.rpcMethods.length, 130);
  assert.equal(contract.eventSubscriptions.length, 22);
  assert.equal(contract.directIpcChannels.length, 7);
  for (const list of [
    contract.rpcMethods,
    contract.eventSubscriptions,
    contract.directIpcChannels,
  ]) {
    assert.deepEqual(list, [...list].sort());
    assert.equal(new Set(list).size, list.length);
  }
  for (const method of additions) assert.ok(contract.rpcMethods.includes(method), method);
  for (const inherited of [
    "authenticateMcpServer",
    "checkForUpdates",
    "commitStagedAttachments",
    "generateAgentAvatarImage",
    "getAvailableModels",
    "getCursorUsageSummary",
    "getMcpCatalog",
    "listSecrets",
    "openExternal",
    "pickAvatarFile",
    "recordLocalToolApproval",
    "setThemePreference",
    "transcribeAudio",
    "updateComputer",
  ]) {
    assert.ok(contract.rpcMethods.includes(inherited), inherited);
  }
  assert.deepEqual(
    contract.features.map(({ id }) => id),
    requiredFeatures,
  );
  for (const feature of contract.features) {
    assert.match(feature.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(typeof feature.description, "string");
    assert.ok(feature.description.length >= 12);
    assert.ok(Array.isArray(feature.evidence) && feature.evidence.length > 0);
    for (const evidence of feature.evidence) {
      assert.match(evidence, /^(?:rpc|event|ipc|smoke):[A-Za-z0-9:_-]+$/);
    }
  }
  assert.doesNotMatch(JSON.stringify(contract), /\/Users\/|\\Users\\|\/private\/tmp\//);
});

test("the auditor rejects missing, added, and renamed stock contract members", () => {
  const contract = loadContract();
  const { auditPreloadContract } = loadAuditor();
  const exact = syntheticPreload(contract);
  const result = auditPreloadContract(exact, contract, { checkSourceHash: false });
  assert.deepEqual(result, {
    ok: true,
    rpcMethods: 130,
    eventSubscriptions: 22,
    directIpcChannels: 7,
  });

  const missingMethod = exact.replace(
    `${JSON.stringify(contract.rpcMethods[0])}:{args:"none"},`,
    "",
  );
  assert.throws(
    () => auditPreloadContract(missingMethod, contract, { checkSourceHash: false }),
    /RPC method.*missing/i,
  );
  const addedMethod = exact.replace("const table={", 'const table={"unreviewedMethod":{args:"none"},');
  assert.throws(
    () => auditPreloadContract(addedMethod, contract, { checkSourceHash: false }),
    /RPC method.*unexpected/i,
  );
  const missingEvent = exact.replace(
    `edge.subscribe({${JSON.stringify(contract.eventSubscriptions[0])}:listener});`,
    "",
  );
  assert.throws(
    () => auditPreloadContract(missingEvent, contract, { checkSourceHash: false }),
    /event.*missing/i,
  );
  const addedEvent = `${exact}\nedge.subscribe({"unreviewed-event":listener});\n`;
  assert.throws(
    () => auditPreloadContract(addedEvent, contract, { checkSourceHash: false }),
    /event.*unexpected/i,
  );
  const missingIpc = exact.replace(
    `ipcRenderer.invoke(${JSON.stringify(contract.directIpcChannels[0])},{});`,
    "",
  );
  assert.throws(
    () => auditPreloadContract(missingIpc, contract, { checkSourceHash: false }),
    /IPC.*missing/i,
  );
});

test("the auditor checks a staged ASAR by its preserved stock preload contract", async (t) => {
  const contract = loadContract();
  const source = syntheticPreload(contract);
  const stagedContract = {
    ...contract,
    preloadSha256: crypto.createHash("sha256").update(source).digest("hex"),
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-contract-asar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tree = path.join(root, "tree");
  const preload = path.join(tree, "dist", "electron-preload", "preload.cjs");
  fs.mkdirSync(path.dirname(preload), { recursive: true });
  fs.writeFileSync(preload, `${source}\nipcRenderer.invoke("codex-bot:list");\n`);
  fs.writeFileSync(
    path.join(tree, "package.json"),
    '{"name":"sand","version":"0.1.4-macos.1"}\n',
  );
  const archive = path.join(root, "staged.asar");
  await asar.createPackage(tree, archive);
  const { auditAsarContract } = loadAuditor();
  assert.deepEqual(auditAsarContract(archive, stagedContract), {
    ok: true,
    rpcMethods: 130,
    eventSubscriptions: 22,
    directIpcChannels: 7,
  });
});

test(
  "the exact Grok 0.20 preload matches the checked-in contract",
  { skip: process.env.GROK_BOT_020_APP == null },
  () => {
    const contract = loadContract();
    const { auditAppContract } = loadAuditor();
    const result = auditAppContract(process.env.GROK_BOT_020_APP, contract);
    assert.equal(result.ok, true);
    assert.equal(result.rpcMethods, 130);
    assert.equal(result.eventSubscriptions, 22);
    assert.equal(result.directIpcChannels, 7);
  },
);
