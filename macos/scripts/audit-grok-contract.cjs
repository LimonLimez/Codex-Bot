"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const babelParser = require("prettier/plugins/babel").parsers.babel;
const { sha256File } = require("./verify-vendor-app.cjs");

const APP_ASAR_SHA256 =
  "1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997";
const PRELOAD_PATH = "dist/electron-preload/preload.cjs";
const DIRECT_IPC_METHODS = new Set([
  "invoke",
  "on",
  "once",
  "postMessage",
  "removeListener",
  "send",
  "sendSync",
]);

const FEATURES = Object.freeze([
  {
    id: "attachments",
    description: "Stage, commit, resolve, read, and download conversation attachments.",
    evidence: ["rpc:commitStagedAttachments", "rpc:resolveAttachmentMedia"],
  },
  {
    id: "audio-transcription",
    description: "Transcribe user audio through the stock desktop method.",
    evidence: ["rpc:transcribeAudio"],
  },
  {
    id: "authentication",
    description: "Expose the account login, cancellation, logout, and status contract.",
    evidence: ["rpc:getCursorAuthStatus", "rpc:loginCursor", "smoke:no-vendor-inference"],
  },
  {
    id: "background-tasks",
    description: "Keep stock background and delegated task lifecycle surfaces.",
    evidence: ["smoke:background-tasks"],
  },
  {
    id: "bot-profile",
    description: "Keep bot profile, avatar source, avatar file, and avatar generation flows.",
    evidence: ["rpc:generateAgentAvatarImage", "rpc:pickAvatarFile", "rpc:pickAvatarSource"],
  },
  {
    id: "computer",
    description: "Keep remote computer update, recovery, connection, presence, and dispatch flows.",
    evidence: ["rpc:updateComputer", "event:update-computer-dispatched", "event:vnc-user-presence"],
  },
  {
    id: "connectors-mcp",
    description: "Keep MCP catalog, accounts, authentication, tools, and connector settings.",
    evidence: ["rpc:getMcpCatalog", "rpc:authenticateMcpServer", "event:mcp-auth-completed"],
  },
  {
    id: "feedback",
    description: "Keep the stock feedback action and feedback window event.",
    evidence: ["rpc:submitFeedback", "event:open-feedback"],
  },
  {
    id: "group-chat",
    description: "Keep one-to-one, bot-to-bot, and multi-bot group conversation flows.",
    evidence: ["smoke:group-chat"],
  },
  {
    id: "models",
    description: "Keep available, default, and computer-use model preference contracts.",
    evidence: ["rpc:getAvailableModels", "rpc:getAgentDefaultModel", "rpc:setAgentDefaultModel"],
  },
  {
    id: "onboarding",
    description: "Keep onboarding state, forced onboarding, skipping, and reporting.",
    evidence: ["rpc:getOnboardingSeen", "event:force-onboarding", "event:skip-onboarding"],
  },
  {
    id: "plugins",
    description: "Keep plugin discovery, install, update, uninstall, and logo flows.",
    evidence: ["rpc:getEffectivePlugins", "rpc:installEntry", "rpc:uninstallPlugin"],
  },
  {
    id: "routines",
    description: "Keep recurring routine creation, schedule, pause, resume, and execution flows.",
    evidence: ["smoke:routines"],
  },
  {
    id: "secrets",
    description: "Keep bounded secret listing, reveal, update, and removal flows.",
    evidence: ["rpc:listSecrets", "rpc:revealSecret", "rpc:upsertSecrets", "rpc:removeSecrets"],
  },
  {
    id: "settings-theme",
    description: "Keep theme, hardware acceleration, time zone, privacy, and settings state.",
    evidence: ["rpc:getThemeState", "rpc:getHardwareAcceleration", "event:theme-changed"],
  },
  {
    id: "skills",
    description: "Keep stock skill discovery, installation, removal, and execution surfaces.",
    evidence: ["smoke:skills"],
  },
  {
    id: "team-coordination",
    description: "Keep team popularity, teammate, subagent, and delegated coordination flows.",
    evidence: ["rpc:getMcpTeamPopularity", "smoke:team-coordination"],
  },
  {
    id: "updates",
    description: "Keep independent update status, track, check, idle, and install controls.",
    evidence: ["rpc:getUpdateStatus", "rpc:checkForUpdates", "event:update-status"],
  },
  {
    id: "usage",
    description: "Keep weekly and summary usage reporting surfaces without leaking credentials.",
    evidence: ["rpc:getCursorWeeklyUsage", "rpc:getCursorUsageSummary"],
  },
  {
    id: "window-controls",
    description: "Keep minimize, maximize, close, resize, state, zoom, and title controls.",
    evidence: ["rpc:minimizeWindow", "rpc:toggleMaximizeWindow", "event:window-state"],
  },
  {
    id: "workspace-repository",
    description: "Keep stock workspace, branch, repository, and code-task flows.",
    evidence: ["smoke:workspace-repository"],
  },
]);

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function propertyName(property) {
  if (property == null || property.type === "SpreadElement") return null;
  if (property.computed) {
    return property.key?.type === "StringLiteral" ? property.key.value : null;
  }
  return property.key?.name ?? property.key?.value ?? null;
}

function walkAst(root, visitor) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node == null || typeof node !== "object") continue;
    visitor(node);
    for (const [key, value] of Object.entries(node)) {
      if (["comments", "errors", "loc", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          pending.push(value[index]);
        }
      } else if (value != null && typeof value === "object") {
        pending.push(value);
      }
    }
  }
}

function parsePreload(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 2_000_000) {
    throw new Error("Preload source is missing or outside the audit bound");
  }
  try {
    return babelParser.parse(source);
  } catch (error) {
    throw new Error(`Could not parse preload source: ${error.message || error}`);
  }
}

function extractPreloadContract(source) {
  const ast = parsePreload(source);
  const methodTables = [];
  const eventSubscriptions = new Set();
  const directIpcChannels = new Set();
  walkAst(ast, (node) => {
    if (node.type === "ObjectExpression") {
      const methods = [];
      for (const property of node.properties ?? []) {
        if (property.type !== "ObjectProperty" || property.value?.type !== "ObjectExpression") {
          continue;
        }
        const args = property.value.properties?.find(
          (candidate) => propertyName(candidate) === "args",
        );
        if (
          args?.type === "ObjectProperty" &&
          args.value?.type === "StringLiteral" &&
          (args.value.value === "none" || args.value.value === "object")
        ) {
          const name = propertyName(property);
          if (name != null) methods.push(name);
        }
      }
      if (methods.length >= 50) methodTables.push(methods.sort());
    }
    if (
      node.type !== "CallExpression" ||
      (node.callee?.type !== "MemberExpression" &&
        node.callee?.type !== "OptionalMemberExpression")
    ) {
      return;
    }
    const method = node.callee.property?.name ?? node.callee.property?.value;
    const first = node.arguments?.[0];
    if (method === "subscribe" && first?.type === "ObjectExpression") {
      for (const property of first.properties ?? []) {
        const name = propertyName(property);
        if (name != null) eventSubscriptions.add(name);
      }
    }
    if (
      DIRECT_IPC_METHODS.has(method) &&
      first?.type === "StringLiteral" &&
      first.value.startsWith("sand:")
    ) {
      directIpcChannels.add(first.value);
    }
  });
  if (methodTables.length !== 1) {
    throw new Error(`Expected one preload RPC method table, found ${methodTables.length}`);
  }
  return {
    preloadSha256: sha256Text(source),
    rpcMethods: methodTables[0],
    eventSubscriptions: [...eventSubscriptions].sort(),
    directIpcChannels: [...directIpcChannels].sort(),
  };
}

function compareList(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
    if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(", ")}`);
    throw new Error(`${label} contract mismatch: ${parts.join("; ")}`);
  }
}

function validateContract(contract) {
  if (
    contract?.schemaVersion !== 1 ||
    contract.product !== "Grok Bot" ||
    contract.version !== "0.20.0" ||
    contract.platform !== "darwin-arm64" ||
    contract.appAsarSha256 !== APP_ASAR_SHA256 ||
    !/^[a-f0-9]{64}$/.test(contract.preloadSha256 ?? "")
  ) {
    throw new Error("Unsupported Grok preload contract metadata");
  }
  for (const [name, expectedCount] of [
    ["rpcMethods", 130],
    ["eventSubscriptions", 22],
    ["directIpcChannels", 7],
  ]) {
    const list = contract[name];
    if (!Array.isArray(list) || list.length !== expectedCount) {
      throw new Error(`Invalid Grok preload contract ${name}`);
    }
    if (new Set(list).size !== list.length || list.some((value, index) => value !== [...list].sort()[index])) {
      throw new Error(`Grok preload contract ${name} must be unique and sorted`);
    }
  }
  if (JSON.stringify(contract.features) !== JSON.stringify(FEATURES)) {
    throw new Error("Grok feature inventory mismatch");
  }
  return contract;
}

function auditPreloadContract(source, contract, { checkSourceHash = true } = {}) {
  validateContract(contract);
  const actual = extractPreloadContract(source);
  if (checkSourceHash && actual.preloadSha256 !== contract.preloadSha256) {
    throw new Error("Preload source hash mismatch");
  }
  compareList(actual.rpcMethods, contract.rpcMethods, "RPC method");
  compareList(actual.eventSubscriptions, contract.eventSubscriptions, "Event subscription");
  compareList(actual.directIpcChannels, contract.directIpcChannels, "Direct IPC");
  return {
    ok: true,
    rpcMethods: actual.rpcMethods.length,
    eventSubscriptions: actual.eventSubscriptions.length,
    directIpcChannels: actual.directIpcChannels.length,
  };
}

function appAsarPath(appPath) {
  return path.join(path.resolve(appPath), "Contents", "Resources", "app.asar");
}

function readPreloadFromAsar(asarPath) {
  return asar.extractFile(path.resolve(asarPath), PRELOAD_PATH).toString("utf8");
}

function auditAppContract(appPath, contract) {
  const archive = appAsarPath(appPath);
  if (sha256File(archive) !== contract.appAsarSha256) {
    throw new Error("Grok app.asar hash mismatch before contract audit");
  }
  return auditPreloadContract(readPreloadFromAsar(archive), contract);
}

function generateContract(appPath) {
  const archive = appAsarPath(appPath);
  if (sha256File(archive) !== APP_ASAR_SHA256) {
    throw new Error("Cannot generate a contract from an unsupported app.asar");
  }
  const extracted = extractPreloadContract(readPreloadFromAsar(archive));
  return {
    schemaVersion: 1,
    product: "Grok Bot",
    version: "0.20.0",
    platform: "darwin-arm64",
    appAsarSha256: APP_ASAR_SHA256,
    preloadSha256: extracted.preloadSha256,
    rpcMethods: extracted.rpcMethods,
    eventSubscriptions: extracted.eventSubscriptions,
    directIpcChannels: extracted.directIpcChannels,
    features: FEATURES.map((feature) => ({
      id: feature.id,
      description: feature.description,
      evidence: [...feature.evidence],
    })),
  };
}

function parseArgs(argv) {
  const result = { generate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--generate") {
      result.generate = true;
      continue;
    }
    if (!value.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${value}`);
    }
    result[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const defaultContract = path.join(
    __dirname,
    "..",
    "assets",
    "grok-bot-0.20.0-contract.json",
  );
  if (!args.app) {
    throw new Error("Usage: audit-grok-contract.cjs --app <Grok Bot.app> [--contract <contract.json>] [--generate --output <contract.json>]");
  }
  if (args.generate) {
    if (!args.output) throw new Error("--generate requires --output");
    const contract = generateContract(args.app);
    validateContract(contract);
    const output = path.resolve(args.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, generated: true, rpcMethods: 130 })}\n`);
    return;
  }
  const contract = JSON.parse(
    fs.readFileSync(path.resolve(args.contract ?? defaultContract), "utf8"),
  );
  process.stdout.write(`${JSON.stringify(auditAppContract(args.app, contract))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FEATURES,
  APP_ASAR_SHA256,
  auditAppContract,
  auditPreloadContract,
  extractPreloadContract,
  generateContract,
  readPreloadFromAsar,
  validateContract,
};
