"use strict";

const path = require("node:path");
const { LocalComputerBoundary } = require("./local-computer-boundary.cjs");
const { LocalDesktopManager } = require("./local-desktop-manager.cjs");
const { createLocalHelperTransport } = require("./local-helper-transport.cjs");
const { LocalPermissionBroker } = require("./local-permission-broker.cjs");
const { LocalPermissionStore } = require("./local-permission-store.cjs");

const WORKSPACE_BOOKMARK = Buffer.from("openbot-workspace-v1", "utf8");
const FILE_CAPABILITIES = new Set(["filesystem.read", "filesystem.write"]);
const PASSIVE_CAPABILITIES = new Set(["shell.execute", "application.open"]);
const TCC_CAPABILITIES = new Set(["application.automate", "screen.capture"]);
const MAX_BOOKMARK_BYTES = 64 * 1024;

function unavailable(message = "Selected resource is unavailable.") {
  const error = new Error(message);
  error.code = "OPENBOT_PERMISSION_RESOURCE_UNAVAILABLE";
  return error;
}

function decodeBookmark(value) {
  if (typeof value !== "string" || value.length === 0
    || value.length > Math.ceil(MAX_BOOKMARK_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw unavailable();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_BOOKMARK_BYTES || bytes.toString("base64") !== value) {
    throw unavailable();
  }
  return bytes;
}

function createResourceChooser(electron) {
  if (!electron?.dialog || typeof electron.dialog.showOpenDialog !== "function") {
    throw new TypeError("Local Computer requires the macOS resource picker.");
  }
  return async function chooseResource(request) {
    const capability = request?.capability;
    if (PASSIVE_CAPABILITIES.has(capability) || TCC_CAPABILITIES.has(capability)) {
      return Buffer.from(WORKSPACE_BOOKMARK);
    }
    if (!FILE_CAPABILITIES.has(capability)) throw unavailable();
    let result;
    try {
      result = await electron.dialog.showOpenDialog({
        title: capability === "filesystem.write" ? "Allow OpenBot to use a folder" : "Allow OpenBot to use a file or folder",
        buttonLabel: "Allow",
        securityScopedBookmarks: true,
        properties: capability === "filesystem.write"
          ? ["openDirectory", "createDirectory"]
          : ["openFile", "openDirectory"],
      });
    } catch {
      throw unavailable();
    }
    if (result?.canceled || !Array.isArray(result?.bookmarks) || result.bookmarks.length !== 1
      || !Array.isArray(result.filePaths) || result.filePaths.length !== 1) {
      throw unavailable("Resource selection was cancelled or unavailable.");
    }
    return decodeBookmark(result.bookmarks[0]);
  };
}

function createTccAdapter(electron) {
  if (!electron?.systemPreferences || typeof electron.systemPreferences !== "object") {
    throw new TypeError("Local Computer requires macOS permission APIs.");
  }
  return Object.freeze({
    async ensure(request) {
      try {
        if (PASSIVE_CAPABILITIES.has(request?.capability) || FILE_CAPABILITIES.has(request?.capability)) return true;
        if (request?.capability === "screen.capture") {
          return typeof electron.systemPreferences.getMediaAccessStatus === "function"
            && electron.systemPreferences.getMediaAccessStatus("screen") === "granted";
        }
        if (request?.capability === "application.automate") {
          return typeof electron.systemPreferences.isTrustedAccessibilityClient === "function"
            && electron.systemPreferences.isTrustedAccessibilityClient(true) === true;
        }
      } catch {}
      return false;
    },
  });
}

function createLocalComputerRuntimeComponents({
  electron,
  stateRoot,
  store,
  PermissionStoreClass = LocalPermissionStore,
  BrokerClass = LocalPermissionBroker,
  ManagerClass = LocalDesktopManager,
  BoundaryClass = LocalComputerBoundary,
} = {}) {
  if (!electron?.BrowserWindow || !electron?.session || !electron?.utilityProcess
    || typeof electron.utilityProcess.fork !== "function"
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || !store || typeof store.read !== "function" || typeof store.updateComputer !== "function"
    || [PermissionStoreClass, BrokerClass, ManagerClass, BoundaryClass].some((value) => typeof value !== "function")) {
    throw new TypeError("Local Computer runtime dependencies are invalid.");
  }
  const permissionStore = new PermissionStoreClass({
    filePath: path.join(stateRoot, "local-permissions.v1.json"),
  });
  const broker = new BrokerClass({
    store: permissionStore,
    readCurrentComputer: (botId) => store.read(botId),
    chooseResource: createResourceChooser(electron),
    tcc: createTccAdapter(electron),
  });
  const childPath = path.join(__dirname, "local-helper-child.cjs");
  const manager = new ManagerClass({
    electron,
    userDataPath: stateRoot,
    permissionBroker: broker,
    helperFactory: async (identity) => createLocalHelperTransport({
      spawnHelper: electron.utilityProcess.fork.bind(electron.utilityProcess),
      childPath,
      ...identity,
    }),
  });
  const boundary = new BoundaryClass({ store, manager, broker });
  return Object.freeze({ boundary, manager });
}

function createLocalComputerRuntime(options = {}) {
  return createLocalComputerRuntimeComponents(options).boundary;
}

module.exports = {
  createLocalComputerRuntime,
  createLocalComputerRuntimeComponents,
  createResourceChooser,
  createTccAdapter,
};
