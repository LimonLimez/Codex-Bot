"use strict";

const path = require("node:path");

const CHROMIUM_HARDENING_ARGS = Object.freeze([
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-quic",
  "--disable-sync",
  "--deny-permission-prompts",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--no-pings",
]);

/**
 * This function is deliberately self-contained so Playwright can serialize it
 * when it is passed directly to BrowserContext.addInitScript(). Register it on
 * the context before creating pages; Playwright will then run it in pages,
 * child frames, and popups belonging to that context.
 */
function browserPageHardeningInitScript() {
  const root = globalThis;
  const navigatorObject = root.navigator;

  function defineLocked(target, property, value, enumerable = false) {
    if (target === null || target === undefined) {
      return false;
    }

    try {
      Object.defineProperty(target, property, {
        configurable: false,
        enumerable,
        value,
        writable: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  function makeNotAllowedError(message) {
    let error;

    try {
      error = new root.DOMException(message, "NotAllowedError");
    } catch {
      error = new Error(message);
      error.name = "NotAllowedError";
    }

    return error;
  }

  function makeGeolocationError() {
    const error = makeNotAllowedError(
      "Geolocation is disabled in this browser seat.",
    );

    try {
      Object.defineProperty(error, "code", {
        configurable: false,
        enumerable: true,
        value: 1,
        writable: false,
      });
    } catch {
      // The name still communicates a standards-compatible denial if a browser
      // does not allow an own `code` property on DOMException.
    }

    return error;
  }

  function enqueue(callback) {
    if (typeof root.queueMicrotask === "function") {
      root.queueMicrotask(callback);
      return;
    }

    Promise.resolve().then(callback);
  }

  function denyPromise() {
    return Promise.reject(
      makeNotAllowedError(
        "This browser capability is disabled in this browser seat.",
      ),
    );
  }

  function denyLegacyMedia(_constraints, _successCallback, errorCallback) {
    const error = makeNotAllowedError(
      "Media capture is disabled in this browser seat.",
    );

    if (typeof errorCallback === "function") {
      enqueue(() => errorCallback(error));
      return undefined;
    }

    return Promise.reject(error);
  }

  function denyCurrentPosition(_successCallback, errorCallback) {
    if (typeof errorCallback === "function") {
      enqueue(() => errorCallback(makeGeolocationError()));
    }
  }

  function denyWatchPosition(_successCallback, errorCallback) {
    if (typeof errorCallback === "function") {
      enqueue(() => errorCallback(makeGeolocationError()));
    }

    return 0;
  }

  function clearDeniedWatch() {}

  for (const property of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    defineLocked(root, property, undefined);
  }

  const mediaDevices = navigatorObject?.mediaDevices;
  const mediaDevicesPrototype = root.MediaDevices?.prototype;
  for (const target of [mediaDevicesPrototype, mediaDevices]) {
    defineLocked(target, "getUserMedia", denyPromise);
    defineLocked(target, "getDisplayMedia", denyPromise);
  }

  const navigatorPrototype = root.Navigator?.prototype;
  for (const target of [navigatorPrototype, navigatorObject]) {
    defineLocked(target, "getUserMedia", denyLegacyMedia);
    defineLocked(target, "webkitGetUserMedia", denyLegacyMedia);
    defineLocked(target, "mozGetUserMedia", denyLegacyMedia);
  }

  const geolocationFacade = {};
  defineLocked(geolocationFacade, "getCurrentPosition", denyCurrentPosition);
  defineLocked(geolocationFacade, "watchPosition", denyWatchPosition);
  defineLocked(geolocationFacade, "clearWatch", clearDeniedWatch);
  Object.freeze(geolocationFacade);

  const geolocationPrototype = root.Geolocation?.prototype;
  defineLocked(geolocationPrototype, "getCurrentPosition", denyCurrentPosition);
  defineLocked(geolocationPrototype, "watchPosition", denyWatchPosition);
  defineLocked(geolocationPrototype, "clearWatch", clearDeniedWatch);
  defineLocked(navigatorPrototype, "geolocation", geolocationFacade, true);
  defineLocked(navigatorObject, "geolocation", geolocationFacade, true);

  const permissions = navigatorObject?.permissions;
  const permissionsPrototype = root.Permissions?.prototype;
  const originalPermissionQuery =
    typeof permissions?.query === "function"
      ? permissions.query.bind(permissions)
      : typeof permissionsPrototype?.query === "function"
        ? permissionsPrototype.query.bind(permissions)
        : null;
  const deniedPermissionNames = new Set([
    "camera",
    "clipboard-read",
    "clipboard-write",
    "geolocation",
    "microphone",
    "notifications",
  ]);
  const deniedPermissionStatus = {};
  defineLocked(deniedPermissionStatus, "state", "denied", true);
  defineLocked(deniedPermissionStatus, "onchange", null, true);
  defineLocked(
    deniedPermissionStatus,
    "addEventListener",
    function addEventListener() {},
  );
  defineLocked(
    deniedPermissionStatus,
    "removeEventListener",
    function removeEventListener() {},
  );
  defineLocked(
    deniedPermissionStatus,
    "dispatchEvent",
    function dispatchEvent() {
      return false;
    },
  );
  Object.freeze(deniedPermissionStatus);

  function hardenedPermissionQuery(descriptor) {
    const permissionName =
      typeof descriptor?.name === "string" ? descriptor.name.toLowerCase() : "";

    if (deniedPermissionNames.has(permissionName)) {
      return Promise.resolve(deniedPermissionStatus);
    }

    if (originalPermissionQuery) {
      return originalPermissionQuery(descriptor);
    }

    return Promise.reject(new TypeError("The Permissions API is unavailable."));
  }

  defineLocked(permissionsPrototype, "query", hardenedPermissionQuery);
  defineLocked(permissions, "query", hardenedPermissionQuery);

  function Notification() {
    throw makeNotAllowedError(
      "Notifications are disabled in this browser seat.",
    );
  }

  function requestNotificationPermission(callback) {
    if (typeof callback === "function") {
      enqueue(() => callback("denied"));
    }

    return Promise.resolve("denied");
  }

  defineLocked(Notification, "permission", "denied", true);
  defineLocked(
    Notification,
    "requestPermission",
    requestNotificationPermission,
  );
  try {
    Object.freeze(Notification.prototype);
  } catch {
    // The constructor itself still throws if a host prevents prototype freezing.
  }
  defineLocked(root, "Notification", Notification);

  const serviceWorkerRegistrationPrototype =
    root.ServiceWorkerRegistration?.prototype;
  defineLocked(
    serviceWorkerRegistrationPrototype,
    "showNotification",
    denyPromise,
  );

  const clipboard = navigatorObject?.clipboard;
  const clipboardPrototype = root.Clipboard?.prototype;
  for (const target of [clipboardPrototype, clipboard]) {
    defineLocked(target, "read", denyPromise);
    defineLocked(target, "readText", denyPromise);
    defineLocked(target, "write", denyPromise);
    defineLocked(target, "writeText", denyPromise);
  }
  defineLocked(navigatorPrototype, "clipboard", undefined, true);
  defineLocked(navigatorObject, "clipboard", undefined, true);

  const documentObject = root.document;
  const documentPrototype = root.Document?.prototype;
  const originalExecCommand =
    typeof documentObject?.execCommand === "function"
      ? documentObject.execCommand.bind(documentObject)
      : null;
  const originalQueryCommandSupported =
    typeof documentObject?.queryCommandSupported === "function"
      ? documentObject.queryCommandSupported.bind(documentObject)
      : null;
  const originalQueryCommandEnabled =
    typeof documentObject?.queryCommandEnabled === "function"
      ? documentObject.queryCommandEnabled.bind(documentObject)
      : null;
  const clipboardCommands = new Set(["copy", "cut", "paste"]);

  function isClipboardCommand(command) {
    return clipboardCommands.has(String(command).trim().toLowerCase());
  }

  function hardenedExecCommand(command, ...args) {
    if (isClipboardCommand(command)) {
      return false;
    }

    return originalExecCommand ? originalExecCommand(command, ...args) : false;
  }

  function hardenedQueryCommandSupported(command) {
    if (isClipboardCommand(command)) {
      return false;
    }

    return originalQueryCommandSupported
      ? originalQueryCommandSupported(command)
      : false;
  }

  function hardenedQueryCommandEnabled(command) {
    if (isClipboardCommand(command)) {
      return false;
    }

    return originalQueryCommandEnabled
      ? originalQueryCommandEnabled(command)
      : false;
  }

  for (const target of [documentPrototype, documentObject]) {
    defineLocked(target, "execCommand", hardenedExecCommand);
    defineLocked(
      target,
      "queryCommandSupported",
      hardenedQueryCommandSupported,
    );
    defineLocked(target, "queryCommandEnabled", hardenedQueryCommandEnabled);
  }
}

async function installBrowserPageHardening(context) {
  if (!context || typeof context.addInitScript !== "function") {
    throw new TypeError(
      "A Playwright browser context with addInitScript() is required.",
    );
  }

  await context.addInitScript(browserPageHardeningInitScript);
}

const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/gu;
const DIRECTIONAL_FORMATTING_CHARACTERS =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const WINDOWS_RESERVED_FILENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/iu;
const MAX_DOWNLOAD_FILENAME_LENGTH = 200;

function trimToFilenameLength(filename) {
  if (filename.length <= MAX_DOWNLOAD_FILENAME_LENGTH) {
    return filename;
  }

  const finalDot = filename.lastIndexOf(".");
  const extension =
    finalDot > 0 && filename.length - finalDot <= 32
      ? filename.slice(finalDot)
      : "";
  const stemLength = MAX_DOWNLOAD_FILENAME_LENGTH - extension.length;
  let stem = filename.slice(0, stemLength);

  if (/^[\ud800-\udbff]$/u.test(stem.slice(-1))) {
    stem = stem.slice(0, -1);
  }

  return `${stem}${extension}`;
}

function cleanFilenameCandidate(value) {
  let candidate;

  try {
    candidate = String(value ?? "").normalize("NFKC");
  } catch {
    candidate = "";
  }

  candidate = candidate.replace(DIRECTIONAL_FORMATTING_CHARACTERS, "");
  const components = candidate.split(/[\\/]+/u).filter(Boolean);
  candidate = components.at(-1) ?? "";
  candidate = candidate.replace(INVALID_FILENAME_CHARACTERS, "_");
  candidate = candidate.trim().replace(/[. ]+$/u, "");

  if (!candidate || candidate === "." || candidate === "..") {
    return "";
  }

  if (WINDOWS_RESERVED_FILENAME.test(candidate)) {
    candidate = `_${candidate}`;
  }

  candidate = trimToFilenameLength(candidate).replace(/[. ]+$/u, "");
  return candidate;
}

function sanitizeDownloadFilename(suggestedFilename, fallback = "download") {
  return (
    cleanFilenameCandidate(suggestedFilename) ||
    cleanFilenameCandidate(fallback) ||
    "download"
  );
}

function resolveSafeDownloadPath(downloadsRoot, suggestedFilename, fallback) {
  if (typeof downloadsRoot !== "string" || downloadsRoot.trim() === "") {
    throw new TypeError("A non-empty downloads root path is required.");
  }

  const resolvedRoot = path.resolve(downloadsRoot);
  const filename = sanitizeDownloadFilename(suggestedFilename, fallback);
  const destination = path.resolve(resolvedRoot, filename);
  const relativeDestination = path.relative(resolvedRoot, destination);

  if (
    !relativeDestination ||
    path.isAbsolute(relativeDestination) ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${path.sep}`) ||
    path.dirname(destination) !== resolvedRoot
  ) {
    throw new Error(
      "The download destination must remain inside the downloads root.",
    );
  }

  return destination;
}

module.exports = Object.freeze({
  CHROMIUM_HARDENING_ARGS,
  browserPageHardeningInitScript,
  installBrowserPageHardening,
  resolveSafeDownloadPath,
  sanitizeDownloadFilename,
});
