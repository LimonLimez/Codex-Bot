"use strict";

const { types } = require("node:util");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAME_ID = /^frame-[A-Za-z0-9._:-]{1,128}$/;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_PREVIEW_WIDTH = 640;
const MAX_PREVIEW_HEIGHT = 400;
const MAX_INTERACTIVE_WIDTH = 960;
const MAX_INTERACTIVE_HEIGHT = 600;
const SURFACE_WIDTH = 1280;
const SURFACE_HEIGHT = 800;
const FRAME_INTERVAL_MS = 1000;
const SELECT_FIELDS = new Set(["botId", "viewGeneration"]);
const CLEAR_FIELDS = new Set(["viewGeneration"]);
const IDENTITY_FIELDS = new Set(["botId", "targetId", "targetGeneration"]);
const SESSION_FIELDS = new Set([...IDENTITY_FIELDS, "sessionGeneration"]);
const VIEW_FIELDS = new Set([...SESSION_FIELDS, "pageGeneration", "viewGeneration"]);
const PRESENTATION_FIELDS = new Set([...VIEW_FIELDS, "presentation"]);
const NAVIGATE_FIELDS = new Set([...VIEW_FIELDS, "url"]);
const HISTORY_FIELDS = new Set(VIEW_FIELDS);
const CONTROL_FIELDS = new Set(VIEW_FIELDS);
const RELEASE_CONTROL_FIELDS = new Set([...CONTROL_FIELDS, "controlGeneration"]);
const INPUT_CURRENTNESS_FIELDS = new Set([
  ...VIEW_FIELDS, "frameId", "frameSequence", "inputSequence", "controlGeneration",
]);
const INPUT_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS, "type",
  "x", "y", "button", "buttons", "clickCount", "deltaX", "deltaY", "modifiers",
  "coordinate", "coordinateSpace", "deviceScaleFactor", "text", "unmodifiedText", "key", "code",
  "windowsVirtualKeyCode", "nativeVirtualKeyCode", "autoRepeat", "isKeypad", "isSystemKey", "location",
  "selectionStart", "selectionEnd", "replacementStart", "replacementEnd",
]);
const MOUSE_INPUT_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS, "type", "x", "y", "button", "buttons", "clickCount", "deltaX", "deltaY",
  "modifiers", "coordinate", "coordinateSpace", "deviceScaleFactor",
]);
const KEY_INPUT_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS, "type", "modifiers", "text", "unmodifiedText", "key", "code",
  "windowsVirtualKeyCode", "nativeVirtualKeyCode", "autoRepeat", "isKeypad", "isSystemKey", "location",
]);
const INSERT_TEXT_INPUT_FIELDS = new Set([...INPUT_CURRENTNESS_FIELDS, "type", "text"]);
const IME_INPUT_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS, "type", "text", "selectionStart", "selectionEnd", "replacementStart", "replacementEnd",
]);
const COMPUTER_ENVELOPE_FIELDS = new Set(["botId", "computer"]);
const COMPUTER_STATE_FIELDS = new Set([
  "mode", "generation", "localProfileId", "nativeAgentId", "state", "lastConfirmedAt", "lastErrorCode",
]);
const SESSION_OUTPUT_FIELDS = new Set([
  "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration", "surface", "presentations",
  "state", "partition", "workspaceId",
]);
const FRAME_FIELDS = new Set([
  "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration", "frameId", "frameSequence",
  "presentation", "width", "height", "mimeType", "bytes",
]);
const STATUS_STATES = new Set(["connecting", "live", "unavailable", "retrying"]);
const STATUS_CODES = new Set([null, "OPENBOT_LOCAL_CAPTURE_FAILED", "OPENBOT_LOCAL_DESKTOP_STALE"]);
const MOUSE_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const KEY_TYPES = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
const MOUSE_BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);
const COORDINATE_SPACES = new Set(["css-dip", "dip"]);
const EVENT_NAMES = Object.freeze([
  "did-start-loading", "did-start-navigation", "did-navigate", "did-frame-navigate", "will-navigate",
  "destroyed", "render-process-gone",
]);

const LOCAL_DESKTOP_FRAME_CHANNELS = Object.freeze({
  presentation: "openbot-local-frame:presentation",
  select: "openbot-local-frame:select",
  retry: "openbot-local-frame:retry",
  clear: "openbot-local-frame:clear",
  navigate: "openbot-local-frame:navigate",
  goBack: "openbot-local-frame:go-back",
  goForward: "openbot-local-frame:go-forward",
  reload: "openbot-local-frame:reload",
  acquireControl: "openbot-local-frame:acquire-control",
  releaseControl: "openbot-local-frame:release-control",
  sendInput: "openbot-local-frame:send-input",
});
const LOCAL_DESKTOP_FRAME_EVENT_CHANNEL = "openbot-local-frame:frame";
const LOCAL_DESKTOP_STATUS_EVENT_CHANNEL = "openbot-local-frame:status";
const LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL = "openbot-local-frame:navigation";
const LOCAL_DESKTOP_FRAME_STATUS_EVENT_CHANNEL = LOCAL_DESKTOP_STATUS_EVENT_CHANNEL;

function failure(code = "OPENBOT_LOCAL_FRAME_OPERATION_FAILED") {
  const error = new Error("OpenBot Local Desktop frame operation failed.");
  error.code = code;
  Object.defineProperty(error, "stack", { value: "Error: OpenBot Local Desktop frame operation failed." });
  return error;
}

function staleFailure() {
  return failure("OPENBOT_LOCAL_DESKTOP_STALE");
}

function proxy(value) {
  try { return types.isProxy(value); } catch { return true; }
}

function ownData(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || proxy(value)) throw failure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw failure(); }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key) || !("value" in descriptors[key]))
    || [...required].some((key) => !descriptors[key])) throw failure();
  try { return Object.fromEntries(keys.map((key) => [key, descriptors[key].value])); } catch { throw failure(); }
}

function knownData(value, fields, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || proxy(value)) throw failure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw failure(); }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !fields.has(key) || !("value" in descriptors[key]))
    || [...required].some((key) => !descriptors[key])) throw failure();
  try { return Object.fromEntries(keys.map((key) => [key, descriptors[key].value])); } catch { throw failure(); }
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure();
  return value;
}

function nonNegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure();
  return value;
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw failure();
  return value;
}

function targetId(value) {
  if (typeof value !== "string" || !TARGET_ID.test(value)) throw failure();
  return value;
}

function frameId(value) {
  if (typeof value !== "string" || !FRAME_ID.test(value)) throw failure();
  return value;
}

function sameFrame(left, right) {
  if (left === right) return true;
  try {
    const leftProcessId = left?.processId;
    const leftRoutingId = left?.routingId;
    const rightProcessId = right?.processId;
    const rightRoutingId = right?.routingId;
    return Number.isSafeInteger(leftProcessId) && leftProcessId >= 0
      && Number.isSafeInteger(leftRoutingId) && leftRoutingId >= 0
      && Number.isSafeInteger(rightProcessId) && rightProcessId >= 0
      && Number.isSafeInteger(rightRoutingId) && rightRoutingId >= 0
      && leftProcessId === rightProcessId && leftRoutingId === rightRoutingId;
  } catch { return false; }
}

function identity(value) {
  const input = ownData(value, IDENTITY_FIELDS, IDENTITY_FIELDS);
  return Object.freeze({ botId: botId(input.botId), targetId: targetId(input.targetId), targetGeneration: nonNegative(input.targetGeneration) });
}

function selectRequest(value) {
  const input = ownData(value, SELECT_FIELDS, SELECT_FIELDS);
  return Object.freeze({ botId: botId(input.botId), viewGeneration: positive(input.viewGeneration) });
}

function clearRequest(value) {
  const input = ownData(value, CLEAR_FIELDS, CLEAR_FIELDS);
  return Object.freeze({ viewGeneration: positive(input.viewGeneration) });
}

function sessionRequest(value, fields) {
  const input = ownData(value, fields, fields);
  const result = {
    botId: botId(input.botId),
    targetId: targetId(input.targetId),
    targetGeneration: nonNegative(input.targetGeneration),
    sessionGeneration: positive(input.sessionGeneration),
  };
  if (fields.has("pageGeneration")) result.pageGeneration = positive(input.pageGeneration);
  if (fields.has("viewGeneration")) result.viewGeneration = positive(input.viewGeneration);
  return result;
}

function presentationRequest(value) {
  const input = sessionRequest(value, PRESENTATION_FIELDS);
  if (value.presentation !== "preview" && value.presentation !== "interactive") throw failure();
  input.presentation = value.presentation;
  return Object.freeze(input);
}

function navigateRequest(value) {
  const input = sessionRequest(value, NAVIGATE_FIELDS);
  if (typeof value.url !== "string" || value.url.length === 0 || value.url.length > 4096 || value.url.includes("\0")) throw failure();
  let parsed;
  try { parsed = new URL(value.url); } catch { throw failure(); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw failure();
  input.url = value.url;
  return Object.freeze(input);
}

function computerIdentity(value, expectedBotId) {
  const envelope = ownData(value, COMPUTER_ENVELOPE_FIELDS, COMPUTER_ENVELOPE_FIELDS);
  const computer = ownData(envelope.computer, COMPUTER_STATE_FIELDS, COMPUTER_STATE_FIELDS);
  if (envelope.botId !== expectedBotId || computer.mode !== "local" || computer.state !== "ready"
    || typeof computer.localProfileId !== "string" || !TARGET_ID.test(computer.localProfileId)
    || !Number.isSafeInteger(computer.generation) || computer.generation < 0
    || (computer.nativeAgentId !== null && typeof computer.nativeAgentId !== "string")
    || typeof computer.lastConfirmedAt !== "string" || computer.lastErrorCode !== null) throw failure();
  return Object.freeze({ botId: expectedBotId, targetId: computer.localProfileId, targetGeneration: computer.generation });
}

function sameIdentity(left, right) {
  return Boolean(left && right) && left.botId === right.botId && left.targetId === right.targetId
    && left.targetGeneration === right.targetGeneration;
}

function boundedMetric(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure();
  return value;
}

function finiteNumber(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw failure();
  return value;
}

function optionalFinite(value, maximum) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum) throw failure();
  return value;
}

function optionalInteger(value, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure();
  return value;
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw failure();
  return value;
}

function optionalText(value, maximumBytes) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) throw failure();
  return value;
}

function assertRouteFields(input, fields) {
  if (Object.keys(input).some((key) => !fields.has(key))) throw failure();
}

function metrics(value) {
  const input = knownData(value, new Set(["cssWidth", "cssHeight"]), ["cssWidth", "cssHeight"]);
  return Object.freeze({ cssWidth: boundedMetric(input.cssWidth, SURFACE_WIDTH), cssHeight: boundedMetric(input.cssHeight, SURFACE_HEIGHT) });
}

function presentationMetrics(value) {
  const input = ownData(value, new Set(["preview", "interactive"]), ["preview", "interactive"]);
  const preview = knownData(input.preview, new Set(["width", "height", "fps"]), ["width", "height", "fps"]);
  const interactive = knownData(input.interactive, new Set(["width", "height"]), ["width", "height"]);
  if (typeof preview.fps !== "number" || !Number.isFinite(preview.fps) || preview.fps <= 0 || preview.fps > 60) throw failure();
  return Object.freeze({
    preview: Object.freeze({ width: boundedMetric(preview.width, MAX_PREVIEW_WIDTH), height: boundedMetric(preview.height, MAX_PREVIEW_HEIGHT), fps: preview.fps }),
    interactive: Object.freeze({ width: boundedMetric(interactive.width, MAX_INTERACTIVE_WIDTH), height: boundedMetric(interactive.height, MAX_INTERACTIVE_HEIGHT) }),
  });
}

function session(value, fallbackIdentity, previous = null) {
  if (!value || typeof value !== "object") {
    return Object.freeze({
      sessionGeneration: previous?.sessionGeneration || 1,
      pageGeneration: previous?.pageGeneration || 1,
      surface: previous?.surface || Object.freeze({ cssWidth: SURFACE_WIDTH, cssHeight: SURFACE_HEIGHT }),
      presentations: previous?.presentations || Object.freeze({
        preview: Object.freeze({ width: MAX_PREVIEW_WIDTH, height: MAX_PREVIEW_HEIGHT, fps: 1 }),
        interactive: Object.freeze({ width: MAX_INTERACTIVE_WIDTH, height: MAX_INTERACTIVE_HEIGHT }),
      }),
      rich: false,
    });
  }
  const input = knownData(value, SESSION_OUTPUT_FIELDS, []);
  if (input.botId !== undefined && input.botId !== fallbackIdentity.botId
    || input.targetId !== undefined && input.targetId !== fallbackIdentity.targetId
    || input.targetGeneration !== undefined && input.targetGeneration !== fallbackIdentity.targetGeneration) throw staleFailure();
  const result = {
    sessionGeneration: input.sessionGeneration === undefined ? (previous?.sessionGeneration || 1) : positive(input.sessionGeneration),
    pageGeneration: input.pageGeneration === undefined ? (previous?.pageGeneration || 1) : positive(input.pageGeneration),
    surface: input.surface === undefined ? (previous?.surface || Object.freeze({ cssWidth: SURFACE_WIDTH, cssHeight: SURFACE_HEIGHT })) : metrics(input.surface),
    presentations: input.presentations === undefined ? (previous?.presentations || Object.freeze({
      preview: Object.freeze({ width: MAX_PREVIEW_WIDTH, height: MAX_PREVIEW_HEIGHT, fps: 1 }),
      interactive: Object.freeze({ width: MAX_INTERACTIVE_WIDTH, height: MAX_INTERACTIVE_HEIGHT }),
    })) : presentationMetrics(input.presentations),
    rich: input.sessionGeneration !== undefined || input.pageGeneration !== undefined || input.presentations !== undefined,
  };
  return Object.freeze(result);
}

function cloneBytes(value) {
  try {
    if (!(value instanceof Uint8Array) || proxy(value) || value.byteLength < 1 || value.byteLength > MAX_FRAME_BYTES) throw failure();
    return Uint8Array.from(value);
  } catch (error) {
    if (error?.code === "OPENBOT_LOCAL_FRAME_OPERATION_FAILED") throw error;
    throw failure();
  }
}

function managerFrame(value, expected, presentation, previous) {
  const input = knownData(value, FRAME_FIELDS, ["botId", "targetId", "targetGeneration", "frameId", "width", "height", "mimeType", "bytes"]);
  if (input.botId !== expected.botId || input.targetId !== expected.targetId || input.targetGeneration !== expected.targetGeneration
    || input.mimeType !== "image/png") throw staleFailure();
  const actualPresentation = input.presentation === undefined ? presentation : input.presentation;
  if (actualPresentation !== "preview" && actualPresentation !== "interactive") throw failure();
  const width = boundedMetric(input.width, actualPresentation === "interactive" ? MAX_INTERACTIVE_WIDTH : MAX_PREVIEW_WIDTH);
  const height = boundedMetric(input.height, actualPresentation === "interactive" ? MAX_INTERACTIVE_HEIGHT : MAX_PREVIEW_HEIGHT);
  const result = {
    sessionGeneration: input.sessionGeneration === undefined ? previous.sessionGeneration : positive(input.sessionGeneration),
    pageGeneration: input.pageGeneration === undefined ? previous.pageGeneration : positive(input.pageGeneration),
    frameId: frameId(input.frameId),
    frameSequence: input.frameSequence === undefined ? previous.frameSequence + 1 : positive(input.frameSequence),
    presentation: actualPresentation,
    width,
    height,
    mimeType: "image/png",
    bytes: cloneBytes(input.bytes),
    rich: input.presentation !== undefined || input.frameSequence !== undefined || input.sessionGeneration !== undefined,
  };
  if (result.sessionGeneration !== previous.sessionGeneration || result.pageGeneration < previous.pageGeneration) throw staleFailure();
  return Object.freeze(result);
}

function inputRequest(value) {
  const input = knownData(value, INPUT_FIELDS, [...INPUT_CURRENTNESS_FIELDS, "type"]);
  const result = sessionRequest(Object.fromEntries([...VIEW_FIELDS].map((key) => [key, input[key]])), VIEW_FIELDS);
  result.frameId = frameId(input.frameId);
  result.frameSequence = positive(input.frameSequence);
  result.inputSequence = positive(input.inputSequence);
  result.controlGeneration = positive(input.controlGeneration);
  if (typeof input.type !== "string") throw failure();
  result.type = input.type;
  if (MOUSE_TYPES.has(input.type)) {
    assertRouteFields(input, MOUSE_INPUT_FIELDS);
    const hasX = input.x !== undefined;
    const hasY = input.y !== undefined;
    if (hasX !== hasY || (!hasX && input.coordinate === undefined)) throw failure();
    if (hasX) {
      result.x = finiteNumber(input.x, 0, SURFACE_WIDTH);
      result.y = finiteNumber(input.y, 0, SURFACE_HEIGHT);
    }
    if (input.coordinate !== undefined) {
      const point = ownData(input.coordinate, new Set(["x", "y"]), ["x", "y"]);
      result.coordinate = Object.freeze({
        x: finiteNumber(point.x, 0, SURFACE_WIDTH),
        y: finiteNumber(point.y, 0, SURFACE_HEIGHT),
      });
      delete result.x;
      delete result.y;
    }
    if (input.coordinateSpace !== undefined) {
      if (typeof input.coordinateSpace !== "string" || !COORDINATE_SPACES.has(input.coordinateSpace)) throw failure();
      result.coordinateSpace = input.coordinateSpace;
    }
    if (input.deviceScaleFactor !== undefined) {
      if (input.deviceScaleFactor !== 1) throw failure();
      result.deviceScaleFactor = input.deviceScaleFactor;
    }
    if (input.button !== undefined) {
      if (typeof input.button !== "string" || !MOUSE_BUTTONS.has(input.button)) throw failure();
      result.button = input.button;
    } else if (input.type === "mousePressed" || input.type === "mouseReleased") throw failure();
    const optionals = {
      buttons: optionalInteger(input.buttons, 0, 31),
      clickCount: optionalInteger(input.clickCount, 0, 32),
      deltaX: optionalFinite(input.deltaX, 1_000_000),
      deltaY: optionalFinite(input.deltaY, 1_000_000),
      modifiers: optionalInteger(input.modifiers, 0, 15),
    };
    for (const [key, fieldValue] of Object.entries(optionals)) {
      if (fieldValue !== undefined) result[key] = fieldValue;
    }
  } else if (KEY_TYPES.has(input.type)) {
    assertRouteFields(input, KEY_INPUT_FIELDS);
    const optionals = {
      key: optionalText(input.key, 128),
      code: optionalText(input.code, 128),
      text: optionalText(input.text, 4096),
      unmodifiedText: optionalText(input.unmodifiedText, 4096),
      modifiers: optionalInteger(input.modifiers, 0, 15),
      windowsVirtualKeyCode: optionalInteger(input.windowsVirtualKeyCode, 0, 0xffff),
      nativeVirtualKeyCode: optionalInteger(input.nativeVirtualKeyCode, 0, 0xffff),
      autoRepeat: optionalBoolean(input.autoRepeat),
      isKeypad: optionalBoolean(input.isKeypad),
      isSystemKey: optionalBoolean(input.isSystemKey),
      location: optionalInteger(input.location, 0, 3),
    };
    if (optionals.key === undefined && optionals.code === undefined) throw failure();
    for (const [key, fieldValue] of Object.entries(optionals)) {
      if (fieldValue !== undefined) result[key] = fieldValue;
    }
  } else if (input.type === "insertText") {
    assertRouteFields(input, INSERT_TEXT_INPUT_FIELDS);
    result.text = optionalText(input.text, 64 * 1024);
    if (result.text === undefined) throw failure();
  } else if (input.type === "imeSetComposition") {
    assertRouteFields(input, IME_INPUT_FIELDS);
    result.text = optionalText(input.text, 64 * 1024);
    if (result.text === undefined) throw failure();
    result.selectionStart = optionalInteger(input.selectionStart, 0, result.text.length);
    result.selectionEnd = optionalInteger(input.selectionEnd, 0, result.text.length);
    if (result.selectionStart === undefined || result.selectionEnd === undefined
      || result.selectionEnd < result.selectionStart) throw failure();
    const replacementStart = optionalInteger(input.replacementStart, -1, 1_000_000);
    const replacementEnd = optionalInteger(input.replacementEnd, -1, 1_000_000);
    if ((replacementStart === undefined) !== (replacementEnd === undefined)
      || replacementStart !== undefined && replacementEnd < replacementStart) throw failure();
    if (replacementStart !== undefined) {
      result.replacementStart = replacementStart;
      result.replacementEnd = replacementEnd;
    }
  } else throw failure();
  return Object.freeze(result);
}

function sameToken(state, input, includeFrame = false) {
  if (!state || state.botId !== input.botId || state.targetId !== input.targetId
    || state.targetGeneration !== input.targetGeneration || state.sessionGeneration !== input.sessionGeneration
    || state.pageGeneration !== input.pageGeneration || state.viewGeneration !== input.viewGeneration) return false;
  if (includeFrame && (state.frameId !== input.frameId || state.frameSequence !== input.frameSequence)) return false;
  return true;
}

function statusDto(state, stateName, code = null) {
  if (!STATUS_STATES.has(stateName) || !STATUS_CODES.has(code)) throw failure();
  if (state.rich && state.presentation === "interactive") {
    return Object.freeze({
      botId: state.botId,
      targetId: state.targetId,
      targetGeneration: state.targetGeneration,
      sessionGeneration: state.sessionGeneration,
      pageGeneration: state.pageGeneration,
      viewGeneration: state.viewGeneration,
      frameId: state.frameId,
      frameSequence: state.frameSequence,
      inputSequence: state.inputSequence,
      presentation: state.presentation,
      state: stateName,
      code,
    });
  }
  return Object.freeze({
    botId: state.botId,
    targetId: state.targetId,
    targetGeneration: state.targetGeneration,
    viewGeneration: state.viewGeneration,
    state: stateName,
    code,
  });
}

function selectionResultDto(state) {
  if (!state || state.presentation !== "preview" || !BOT_ID.test(state.botId) || !TARGET_ID.test(state.targetId)
    || !Number.isSafeInteger(state.targetGeneration) || state.targetGeneration < 0
    || !Number.isSafeInteger(state.sessionGeneration) || state.sessionGeneration < 1
    || !Number.isSafeInteger(state.pageGeneration) || state.pageGeneration < 1
    || !Number.isSafeInteger(state.viewGeneration) || state.viewGeneration < 1
    || typeof state.frameId !== "string" || !FRAME_ID.test(state.frameId)
    || !Number.isSafeInteger(state.frameSequence) || state.frameSequence < 1
    || !Number.isSafeInteger(state.inputSequence) || state.inputSequence < 0) throw failure();
  return Object.freeze({
    botId: state.botId,
    targetId: state.targetId,
    targetGeneration: state.targetGeneration,
    sessionGeneration: state.sessionGeneration,
    pageGeneration: state.pageGeneration,
    viewGeneration: state.viewGeneration,
    frameId: state.frameId,
    frameSequence: state.frameSequence,
    inputSequence: state.inputSequence,
    presentation: "preview",
    state: "live",
    code: null,
  });
}

function installLocalDesktopFrameIpc({
  electron,
  manager,
  computerBoundary,
  ready = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!electron?.ipcMain || !electron?.BrowserWindow
    || typeof electron.ipcMain.handle !== "function" || typeof electron.ipcMain.removeHandler !== "function"
    || typeof electron.BrowserWindow.fromWebContents !== "function"
    || !manager || typeof manager.open !== "function" || typeof manager.ownsWindow !== "function"
    || (!manager.captureDisplayFrame && !manager.capturePreviewFrame)
    || !computerBoundary || typeof computerBoundary.read !== "function"
    || (ready !== null && (!ready || typeof ready.then !== "function"))
    || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") throw failure();
  const readiness = ready === null ? Promise.resolve() : Promise.resolve(ready);
  let disposed = false;
  let disposePromise = null;
  let nextControlGeneration = 0;
  const states = new Map();
  const flights = new Map();
  const highWater = new Map();
  const senderListeners = new Map();
  const controlLeases = new Map();
  const managerClosures = new Map();
  const openOwnersByBot = new Map();
  const senderClosures = new Map();
  const botAdmissionEpochs = new Map();
  const registered = [];

  function currentSender(event) {
    try {
      const sender = event?.sender;
      const senderFrame = event?.senderFrame;
      if (!sender || !senderFrame || typeof sender.isDestroyed !== "function" || sender.isDestroyed()
        || typeof sender.send !== "function" || typeof sender.once !== "function" || typeof sender.off !== "function"
        || typeof sender.on !== "function" || !sameFrame(sender.mainFrame, senderFrame)
        || typeof senderFrame.isDestroyed !== "function" || senderFrame.isDestroyed()) return null;
      const window = electron.BrowserWindow.fromWebContents(sender);
      if (!window || typeof window.isDestroyed !== "function" || window.isDestroyed()
        || window.webContents !== sender || typeof window.webContents.isDestroyed !== "function"
        || window.webContents.isDestroyed() || manager.ownsWindow(window)) return null;
      return Object.freeze({ sender, senderFrame });
    } catch { return null; }
  }

  function currentState(state) {
    if (disposed || !state || state.invalidated || states.get(state.sender) !== state) return false;
    const live = Boolean(currentSender({ sender: state.sender, senderFrame: state.senderFrame }));
    if (!live) invalidate(state, true, true);
    return live;
  }

  function clearTimer(state) {
    if (state.timer !== null) {
      try { clearIntervalFn(state.timer); } catch {}
      state.timer = null;
    }
  }

  function controlKey(state) {
    if (!state?.botId || !state.targetId || !Number.isSafeInteger(state.targetGeneration)
      || !Number.isSafeInteger(state.sessionGeneration)) return null;
    return `${state.botId}\0${state.targetId}\0${state.targetGeneration}\0${state.sessionGeneration}`;
  }

  function releaseControl(state) {
    const lease = state?.lease;
    if (!lease) return;
    state.lease = null;
    if (controlLeases.get(lease.key) === lease) controlLeases.delete(lease.key);
  }

  function removeSenderListener(sender) {
    const listener = senderListeners.get(sender);
    if (!listener) return;
    senderListeners.delete(sender);
    for (const name of EVENT_NAMES) {
      try { sender.off(name, listener); } catch {}
    }
  }

  function registerOpenOwner(owner) {
    let owners = openOwnersByBot.get(owner.botId);
    if (!owners) {
      owners = new Set();
      openOwnersByBot.set(owner.botId, owners);
    }
    owners.add(owner);
  }

  function forgetOpenOwner(owner) {
    const owners = openOwnersByBot.get(owner?.botId);
    if (!owners) return;
    owners.delete(owner);
    if (owners.size === 0) openOwnersByBot.delete(owner.botId);
  }

  function admissionEpoch(botId) {
    return botAdmissionEpochs.get(botId) || 0;
  }

  function advanceAdmissionEpoch(botId) {
    const next = admissionEpoch(botId) + 1;
    if (!Number.isSafeInteger(next)) throw failure();
    botAdmissionEpochs.set(botId, next);
    return next;
  }

  function currentAdmission(state) {
    return Boolean(state) && state.admissionEpoch === admissionEpoch(state.botId);
  }

  function hasEstablishedSession(botId) {
    return [...states.values()].some((candidate) => candidate.botId === botId
      && Number.isSafeInteger(candidate.sessionGeneration) && candidate.sessionGeneration >= 1);
  }

  function closePendingOpens(state, forceClose = false) {
    const bot = state?.botId;
    const key = `pending\0${bot}`;
    const existing = managerClosures.get(key);
    if (existing) {
      if (forceClose || hasEstablishedSession(bot)) existing.forceClose = true;
      return existing.promise;
    }
    const owners = [...(openOwnersByBot.get(bot) || [])];
    if (owners.length === 0) return null;
    const cleanupEpoch = advanceAdmissionEpoch(bot);
    const record = { botId: bot, forceClose: forceClose || hasEstablishedSession(bot), cleanupEpoch, promise: null };
    const promise = Promise.all(owners.map((owner) => owner.outcome)).then(async (outcomes) => {
      if (!record.forceClose && !outcomes.includes(true)) return;
      if (typeof manager.close !== "function") return;
      try { await manager.close(bot); } catch {}
    }).finally(() => {
      for (const owner of owners) forgetOpenOwner(owner);
      if (managerClosures.get(key) === record) managerClosures.delete(key);
      for (const [sender, closing] of senderClosures) {
        if (closing === promise) senderClosures.delete(sender);
      }
    });
    record.promise = promise;
    managerClosures.set(key, record);
    const affected = new Set([
      ...owners.map((owner) => owner.state),
      ...[...states.values()].filter((candidate) => candidate.botId === bot),
    ]);
    for (const candidate of affected) {
      if (candidate && candidate !== state && !candidate.invalidated) invalidate(candidate, false, false);
      if (candidate) {
        candidate.closePromise = promise;
        senderClosures.set(candidate.sender, promise);
      }
    }
    for (const owner of owners) owner.cleanupPromise = promise;
    return promise;
  }

  function closeManagerSession(state) {
    const pending = openOwnersByBot.get(state?.botId);
    if (pending?.size) return closePendingOpens(state, Number.isSafeInteger(state.sessionGeneration));
    const bot = state?.botId;
    if (typeof bot !== "string") return null;
    const key = `pending\0${bot}`;
    const existing = managerClosures.get(key);
    if (existing) return existing.promise;
    const cleanupEpoch = advanceAdmissionEpoch(bot);
    const shouldClose = Number.isSafeInteger(state.sessionGeneration) || hasEstablishedSession(bot);
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const record = { botId: bot, cleanupEpoch, promise };
    managerClosures.set(key, record);
    for (const sibling of [...states.values()]) {
      if (sibling !== state && sibling.botId === bot) {
        invalidate(sibling, false, false);
        sibling.closePromise = promise;
        senderClosures.set(sibling.sender, promise);
      }
    }
    let effect;
    try {
      effect = shouldClose && typeof manager.close === "function" ? manager.close(bot) : null;
    } catch { effect = null; }
    void Promise.resolve(effect).catch(() => undefined).finally(() => {
      if (managerClosures.get(key) === record) managerClosures.delete(key);
      settle();
    });
    return promise;
  }

  function beginManagerOpen(state, record, retrying) {
    let admit;
    const owner = {
      botId: state.botId,
      targetId: state.targetId,
      targetGeneration: state.targetGeneration,
      state,
      admission: new Promise((resolve) => { admit = resolve; }),
      cleanupPromise: null,
      outcome: null,
    };
    state.openOwner = owner;
    owner.outcome = owner.admission.then(({ promise: admitted }) => admitted.then(() => true, () => false));
    registerOpenOwner(owner);
    let effect;
    try {
      effect = retrying && typeof manager.retry === "function"
        ? manager.retry(record)
        : manager.open(record);
    } catch (error) {
      effect = Promise.reject(error);
    }
    const promise = Promise.resolve(effect);
    admit({ promise });
    return promise;
  }

  function invalidate(state, resetHighWater = false, closeManager = false) {
    if (!state || state.invalidated) return state?.closePromise || null;
    state.invalidated = true;
    releaseControl(state);
    clearTimer(state);
    if (states.get(state.sender) === state) states.delete(state.sender);
    if (flights.get(state.sender)?.state === state) flights.delete(state.sender);
    if (resetHighWater) highWater.delete(state.sender);
    removeSenderListener(state.sender);
    state.closePromise = closeManager ? closeManagerSession(state) : null;
    return state.closePromise;
  }

  function onSenderNavigation(sender, navigation = null) {
    if (navigation && navigation.isMainFrame === false) return;
    const state = states.get(sender);
    if (state) invalidate(state, true, true);
    else {
      highWater.delete(sender);
      removeSenderListener(sender);
    }
  }

  function installSenderListeners(sender) {
    if (senderListeners.has(sender)) return;
    const listener = (navigation) => onSenderNavigation(sender, navigation);
    for (const name of EVENT_NAMES) {
      try { sender.on(name, listener); } catch {}
    }
    senderListeners.set(sender, listener);
  }

  function removeSenderListeners() {
    for (const sender of [...senderListeners.keys()]) removeSenderListener(sender);
  }

  function send(state, channel, value) {
    if (!currentState(state)) return false;
    try { state.sender.send(channel, value); return true; } catch { return false; }
  }

  function setRich(state, value) {
    if (value) state.rich = true;
  }

  function syncSession(state, value, fallback) {
    const next = session(value, fallback, state.sessionGeneration ? state : null);
    state.sessionGeneration = next.sessionGeneration;
    state.pageGeneration = next.pageGeneration;
    state.surface = next.surface;
    state.presentations = next.presentations;
    setRich(state, next.rich);
  }

  function publishStatus(state, stateName, code = null) {
    if (!currentState(state)) return false;
    return send(state, LOCAL_DESKTOP_STATUS_EVENT_CHANNEL, statusDto(state, stateName, code));
  }

  function publishFrame(state, frame) {
    if (!currentState(state)) return false;
    setRich(state, frame.rich);
    state.frameId = frame.frameId;
    state.frameSequence = frame.frameSequence;
    state.pageGeneration = frame.pageGeneration;
    state.sessionGeneration = frame.sessionGeneration;
    const richOutput = frame.presentation === "interactive" && state.rich;
    if (!richOutput) {
      if (state.lastPublishedFrameId === frame.frameId) return false;
      state.sequence += 1;
      state.lastPublishedFrameId = frame.frameId;
      return send(state, LOCAL_DESKTOP_FRAME_EVENT_CHANNEL, Object.freeze({
        botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration,
        viewGeneration: state.viewGeneration, sequence: state.sequence,
        width: frame.width, height: frame.height, mimeType: frame.mimeType,
        bytes: frame.bytes,
      }));
    }
    if (state.lastPublishedFrameId === frame.frameId && state.lastPublishedFrameSequence === frame.frameSequence
      && state.lastPublishedPresentation === frame.presentation) return false;
    state.lastPublishedFrameId = frame.frameId;
    state.lastPublishedFrameSequence = frame.frameSequence;
    state.lastPublishedPresentation = frame.presentation;
    return send(state, LOCAL_DESKTOP_FRAME_EVENT_CHANNEL, Object.freeze({
      botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration,
      sessionGeneration: state.sessionGeneration, pageGeneration: state.pageGeneration,
      viewGeneration: state.viewGeneration, frameId: frame.frameId, frameSequence: frame.frameSequence,
      inputSequence: state.inputSequence, presentation: frame.presentation, width: frame.width,
      height: frame.height, mimeType: frame.mimeType, bytes: frame.bytes,
      surface: state.surface, presentations: state.presentations,
    }));
  }

  function captureCode(error) {
    return error?.code === "OPENBOT_LOCAL_DESKTOP_STALE" ? "OPENBOT_LOCAL_DESKTOP_STALE" : "OPENBOT_LOCAL_CAPTURE_FAILED";
  }

  function lifecycle(error) {
    return typeof error?.code === "string" && /(?:DELET|DISPOSE|BOT_DELETING)/i.test(error.code);
  }

  function staleCode(error) {
    return typeof error?.code === "string" && /STALE/i.test(error.code);
  }

  function capture(state, presentation = state.presentation) {
    if (!currentState(state)) return Promise.resolve(null);
    if (state.captureFlight?.presentation === presentation) return state.captureFlight.promise;
    const generation = state.captureGeneration + 1;
    state.captureGeneration = generation;
    const flight = (async () => {
      try {
        if (!currentState(state) || state.captureGeneration !== generation) return null;
        const expected = { botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration };
        let raw;
        if (presentation === "interactive" && typeof manager.captureInteractiveFrame === "function") raw = await manager.captureInteractiveFrame(expected);
        else if (presentation === "preview" && typeof manager.capturePreviewFrame === "function") raw = await manager.capturePreviewFrame(expected);
        else if (typeof manager.captureDisplayFrame === "function") raw = await manager.captureDisplayFrame(expected);
        else throw failure("OPENBOT_LOCAL_CAPTURE_FAILED");
        if (!currentState(state) || state.captureGeneration !== generation) return null;
        const currentRecord = await computerBoundary.read(state.botId);
        if (!currentState(state) || state.captureGeneration !== generation) return null;
        let currentIdentity;
        try { currentIdentity = computerIdentity(currentRecord, state.botId); } catch { throw staleFailure(); }
        if (!sameIdentity(currentIdentity, { botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration })) throw staleFailure();
        const normalized = managerFrame(raw, expected, presentation, state);
        if (normalized.presentation !== presentation || normalized.sessionGeneration !== state.sessionGeneration
          || normalized.pageGeneration < state.pageGeneration || normalized.frameSequence <= state.frameSequence) throw staleFailure();
        if (normalized.pageGeneration > state.pageGeneration) releaseControl(state);
        publishFrame(state, normalized);
        publishStatus(state, "live", null);
        if (currentState(state) && state.timer === null) {
          state.timer = setIntervalFn(() => { void capture(state, state.presentation); }, FRAME_INTERVAL_MS);
          state.timer?.unref?.();
        }
        return statusDto(state, "live", null);
      } catch (error) {
        if (!currentState(state) || lifecycle(error) || staleCode(error)) {
          if (lifecycle(error) || staleCode(error)) invalidate(state, false, true);
          return null;
        }
        clearTimer(state);
        const unavailable = statusDto(state, "unavailable", captureCode(error));
        send(state, LOCAL_DESKTOP_STATUS_EVENT_CHANNEL, unavailable);
        return unavailable;
      }
    })();
    const record = { generation, presentation, promise: flight };
    state.captureFlight = record;
    void flight.then(() => {
      if (state.captureFlight === record) state.captureFlight = null;
    }, () => {
      if (state.captureFlight === record) state.captureFlight = null;
    });
    return flight;
  }

  function prepareView(checked, request, retrying) {
    const previous = states.get(checked.sender);
    const flight = flights.get(checked.sender);
    if (flight && flight.botId === request.botId && flight.viewGeneration === request.viewGeneration
      && sameFrame(flight.senderFrame, checked.senderFrame) && retrying === flight.retrying) return { view: flight.state, promise: flight.promise };
    const previousGeneration = highWater.get(checked.sender) || previous?.viewGeneration || 0;
    if (request.viewGeneration <= previousGeneration) throw failure();
    if (previous) invalidate(previous, false, true);
    const state = {
      sender: checked.sender, senderFrame: checked.senderFrame, botId: request.botId,
      admissionEpoch: admissionEpoch(request.botId),
      targetId: null, targetGeneration: null, sessionGeneration: null, pageGeneration: null,
      viewGeneration: request.viewGeneration, presentation: "preview",
      surface: Object.freeze({ cssWidth: SURFACE_WIDTH, cssHeight: SURFACE_HEIGHT }),
      presentations: Object.freeze({
        preview: Object.freeze({ width: MAX_PREVIEW_WIDTH, height: MAX_PREVIEW_HEIGHT, fps: 1 }),
        interactive: Object.freeze({ width: MAX_INTERACTIVE_WIDTH, height: MAX_INTERACTIVE_HEIGHT }),
      }),
      rich: typeof manager.capturePreviewFrame === "function" || typeof manager.captureInteractiveFrame === "function",
      invalidated: false, timer: null, captureFlight: null, captureGeneration: 0, closePromise: null,
      openOwner: null,
      frameId: null, frameSequence: 0, inputSequence: 0, sequence: 0,
      lastPublishedFrameId: null, lastPublishedFrameSequence: 0, lastPublishedPresentation: null, lease: null,
    };
    states.set(checked.sender, state);
    highWater.set(checked.sender, request.viewGeneration);
    installSenderListeners(checked.sender);
    return { view: state, promise: null };
  }

  async function startSelection(state, request, initialState) {
    let captureStarted = false;
    try {
      await readiness;
      if (!currentState(state) || !currentAdmission(state)) throw staleFailure();
      const closures = [...managerClosures.values()]
        .filter((entry) => entry.botId === request.botId)
        .map((entry) => entry.promise);
      if (closures.length > 0) await Promise.all(closures);
      if (!currentState(state) || !currentAdmission(state)) throw staleFailure();
      const record = await computerBoundary.read(request.botId);
      if (!currentState(state) || !currentAdmission(state)) throw staleFailure();
      const expected = computerIdentity(record, request.botId);
      state.targetId = expected.targetId;
      state.targetGeneration = expected.targetGeneration;
      publishStatus(state, initialState, null);
      if (!currentState(state) || !currentAdmission(state)) throw staleFailure();
      const opened = await beginManagerOpen(state, record, initialState === "retrying");
      if (!currentState(state) || !currentAdmission(state)) throw staleFailure();
      syncSession(state, opened, expected);
      forgetOpenOwner(state.openOwner);
      state.openOwner = null;
      const currentRecord = await computerBoundary.read(request.botId);
      if (!currentState(state) || !currentAdmission(state)) throw staleFailure();
      const current = computerIdentity(currentRecord, request.botId);
      if (!sameIdentity(expected, current)) throw staleFailure();
      captureStarted = true;
      const result = await capture(state, state.presentation);
      if (disposed) throw failure();
      if (!currentState(state) || !currentAdmission(state)) return null;
      if (result?.state === "live" && result.code === null && state.presentation === "preview") {
        return selectionResultDto(state);
      }
      return result;
    } catch (error) {
      if (disposed) throw failure();
      if (!currentState(state) || lifecycle(error) || error?.code === "OPENBOT_LOCAL_DESKTOP_STALE") return null;
      if (!captureStarted) throw failure();
      clearTimer(state);
      const unavailable = statusDto(state, "unavailable", captureCode(error));
      send(state, LOCAL_DESKTOP_STATUS_EVENT_CHANNEL, unavailable);
      return unavailable;
    }
  }

  function selectOrRetry(event, value, retrying = false) {
    try {
      if (disposed) throw failure();
      const checked = currentSender(event);
      if (!checked) throw failure();
      const request = selectRequest(value);
      const prepared = prepareView(checked, request, retrying);
      if (prepared.promise) return prepared.promise;
      const promise = startSelection(prepared.view, request, retrying ? "retrying" : "connecting").catch(() => { throw failure(); });
      flights.set(checked.sender, {
        botId: request.botId, viewGeneration: request.viewGeneration, senderFrame: checked.senderFrame,
        state: prepared.view, promise, retrying,
      });
      void promise.then(() => {
        if (flights.get(checked.sender)?.promise === promise) flights.delete(checked.sender);
      }, () => {
        if (flights.get(checked.sender)?.promise === promise) flights.delete(checked.sender);
      });
      return promise;
    } catch { return Promise.reject(failure()); }
  }

  async function clearSelection(event, value) {
    try {
      if (disposed) throw failure();
      const checked = currentSender(event);
      if (!checked) throw failure();
      const request = clearRequest(value);
      const previous = states.get(checked.sender);
      const previousGeneration = highWater.get(checked.sender) || previous?.viewGeneration || 0;
      if (request.viewGeneration < previousGeneration) return Object.freeze({ viewGeneration: request.viewGeneration });
      const closing = previous
        ? invalidate(previous, false, true)
        : (senderClosures.get(checked.sender) || null);
      highWater.set(checked.sender, request.viewGeneration);
      await readiness;
      if (closing) await closing;
      if (disposed || !currentSender(event)) throw failure();
      return Object.freeze({ viewGeneration: request.viewGeneration });
    } catch { throw failure(); }
  }

  function requireState(event, value, fields, includeFrame = false) {
    const checked = currentSender(event);
    if (!checked) throw failure();
    const state = states.get(checked.sender);
    if (!currentState(state) || !sameFrame(state.senderFrame, checked.senderFrame)) throw failure();
    const requestValue = Object.fromEntries([...fields].map((key) => [key, value[key]]));
    const request = sessionRequest(requestValue, fields);
    if (includeFrame) {
      request.frameId = value.frameId;
      request.frameSequence = value.frameSequence;
    }
    if (!sameToken(state, request, includeFrame)) throw failure();
    return { state, request, checked };
  }

  async function changePresentation(event, value) {
    const request = presentationRequest(value);
    const { state } = requireState(event, request, PRESENTATION_FIELDS);
    state.presentation = request.presentation;
    const result = await capture(state, state.presentation);
    if (disposed || !currentState(state)) throw failure();
    return result;
  }

  function navigationDto(state, action, url = null) {
    return Object.freeze({
      botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration,
      sessionGeneration: state.sessionGeneration, pageGeneration: state.pageGeneration,
      viewGeneration: state.viewGeneration, frameId: state.frameId, frameSequence: state.frameSequence,
      inputSequence: state.inputSequence, action, url,
    });
  }

  function controlDto(state, controlGeneration) {
    return Object.freeze({
      botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration,
      sessionGeneration: state.sessionGeneration, pageGeneration: state.pageGeneration,
      viewGeneration: state.viewGeneration, frameId: state.frameId, frameSequence: state.frameSequence,
      inputSequence: state.inputSequence, controlGeneration,
    });
  }

  async function navigate(event, value, action) {
    const request = action === "navigate" ? navigateRequest(value) : Object.freeze(sessionRequest(value, HISTORY_FIELDS));
    const { state } = requireState(event, request, action === "navigate" ? NAVIGATE_FIELDS : HISTORY_FIELDS);
    try {
      const managerValue = {
        botId: request.botId, targetId: request.targetId, targetGeneration: request.targetGeneration,
        sessionGeneration: request.sessionGeneration,
        ...(action === "navigate" ? { url: request.url } : { pageGeneration: request.pageGeneration }),
      };
      const method = action === "navigate" ? "navigate" : action;
      if (typeof manager[method] !== "function") throw failure();
      const result = await manager[method](managerValue);
      if (!currentState(state)) throw staleFailure();
      syncSession(state, result, {
        botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration,
        sessionGeneration: state.sessionGeneration, pageGeneration: state.pageGeneration,
      });
      if (result?.pageGeneration !== undefined) state.pageGeneration = positive(result.pageGeneration);
      state.frameId = null;
      state.frameSequence = 0;
      state.lastPublishedFrameId = null;
      releaseControl(state);
      const navigation = navigationDto(state, action, action === "navigate" ? request.url : null);
      send(state, LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL, navigation);
      await capture(state, state.presentation);
      if (disposed || !currentState(state)) throw failure();
      return navigation;
    } catch { throw failure(); }
  }

  function controlRequest(event, value, release = false) {
    const fields = release ? RELEASE_CONTROL_FIELDS : CONTROL_FIELDS;
    const request = sessionRequest(value, fields);
    if (release) request.controlGeneration = positive(value.controlGeneration);
    const { state } = requireState(event, request, fields);
    const key = controlKey(state);
    if (key === null) throw failure();
    if (release) {
      if (!state.lease || controlLeases.get(key) !== state.lease
        || state.lease.generation !== positive(value.controlGeneration)) throw failure();
      releaseControl(state);
      return controlDto(state, request.controlGeneration);
    }
    const existing = controlLeases.get(key);
    if (existing && existing.state !== state && currentState(existing.state)) throw failure();
    if (!currentState(state)) throw failure();
    if (!state.lease) {
      nextControlGeneration += 1;
      if (!Number.isSafeInteger(nextControlGeneration)) throw failure();
      state.lease = { generation: nextControlGeneration, key, state };
      controlLeases.set(key, state.lease);
    }
    return controlDto(state, state.lease.generation);
  }

  async function sendInput(event, value) {
    const input = inputRequest(value);
    const { state } = requireState(event, input, VIEW_FIELDS, true);
    const key = controlKey(state);
    if (!state.lease || key === null || controlLeases.get(key) !== state.lease
      || state.lease.generation !== input.controlGeneration || input.inputSequence <= state.inputSequence) throw failure();
    state.inputSequence = input.inputSequence;
    const managerInput = { ...input };
    delete managerInput.viewGeneration;
    delete managerInput.controlGeneration;
    if (input.type === "insertText" || input.type === "imeSetComposition") delete managerInput.type;
    const method = MOUSE_TYPES.has(input.type) ? "dispatchMouseEvent"
      : KEY_TYPES.has(input.type) ? "dispatchKeyEvent"
        : input.type === "insertText" ? "insertText" : "imeSetComposition";
    try {
      if (typeof manager[method] !== "function") throw failure();
      const result = await manager[method](managerInput);
      if (!currentState(state) || state.inputSequence !== input.inputSequence || !sameToken(state, input, true)) throw staleFailure();
      await capture(state, state.presentation);
      if (disposed || !currentState(state)) throw failure();
      return Object.freeze({
        botId: state.botId, targetId: state.targetId, targetGeneration: state.targetGeneration,
        sessionGeneration: state.sessionGeneration, pageGeneration: state.pageGeneration,
        viewGeneration: state.viewGeneration, frameId: state.frameId, frameSequence: state.frameSequence,
        inputSequence: state.inputSequence,
      });
    } catch { throw failure(); }
  }

  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.presentation, changePresentation);
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.select, (event, value) => selectOrRetry(event, value, false));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.retry, (event, value) => selectOrRetry(event, value, true));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.clear, clearSelection);
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.navigate, (event, value) => navigate(event, value, "navigate"));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.goBack, (event, value) => navigate(event, value, "goBack"));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.goForward, (event, value) => navigate(event, value, "goForward"));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.reload, (event, value) => navigate(event, value, "reload"));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl, (event, value) => Promise.resolve(controlRequest(event, value, false)));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.releaseControl, (event, value) => Promise.resolve(controlRequest(event, value, true)));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput, sendInput);
  registered.push(...Object.values(LOCAL_DESKTOP_FRAME_CHANNELS));

  const onChanged = (value) => {
    let changedBot;
    try { changedBot = typeof value?.botId === "string" && BOT_ID.test(value.botId) ? value.botId : null; } catch { return; }
    if (!changedBot) return;
    for (const state of [...states.values()]) if (state.botId === changedBot) invalidate(state, false, true);
  };
  const onManagerClosed = (value) => {
    let closedBot = null;
    try {
      closedBot = typeof value === "string" ? value : value?.botId;
      if (typeof closedBot !== "string" || !BOT_ID.test(closedBot)) closedBot = null;
    } catch { closedBot = null; }
    for (const state of [...states.values()]) {
      if (closedBot === null || state.botId === closedBot) invalidate(state);
    }
  };
  try { computerBoundary.on?.("changed", onChanged); } catch {}
  try { manager.on?.("closed", onManagerClosed); } catch {}
  try { manager.on?.("disposed", onManagerClosed); } catch {}

  return Object.freeze({
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      const closings = [];
      for (const state of [...states.values()]) {
        const closing = invalidate(state, false, true);
        if (closing) closings.push(closing);
      }
      removeSenderListeners();
      states.clear();
      flights.clear();
      highWater.clear();
      controlLeases.clear();
      senderClosures.clear();
      try { computerBoundary.off?.("changed", onChanged); } catch {}
      try { manager.off?.("closed", onManagerClosed); } catch {}
      try { manager.off?.("disposed", onManagerClosed); } catch {}
      for (const channel of registered) electron.ipcMain.removeHandler(channel);
      for (const entry of managerClosures.values()) closings.push(entry.promise);
      disposePromise = Promise.all(closings).then(() => undefined);
      return disposePromise;
    },
  });
}

module.exports = {
  LOCAL_DESKTOP_FRAME_CHANNELS,
  LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
  LOCAL_DESKTOP_FRAME_STATUS_EVENT_CHANNEL,
  LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
  LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  installLocalDesktopFrameIpc,
};
