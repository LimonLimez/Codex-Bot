"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LocalHelperProtocol } = require("./local-helper-protocol.cjs");

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_DISPLAY_FRAME_BYTES = 1_048_576;
const MAX_DISPLAY_FRAME_WIDTH = 640;
const MAX_DISPLAY_FRAME_HEIGHT = 400;
const SURFACE_CSS_WIDTH = 1280;
const SURFACE_CSS_HEIGHT = 800;
const PREVIEW_FRAME_WIDTH = 640;
const PREVIEW_FRAME_HEIGHT = 400;
const PREVIEW_FRAME_INTERVAL_MS = 1_000;
const INTERACTIVE_FRAME_WIDTH = 960;
const INTERACTIVE_FRAME_HEIGHT = 600;
const DISPLAY_FRAME_BOUNDS = Object.freeze([
  Object.freeze({ width: PREVIEW_FRAME_WIDTH, height: PREVIEW_FRAME_HEIGHT }),
  Object.freeze({ width: 512, height: 320 }),
  Object.freeze({ width: 400, height: 250 }),
  Object.freeze({ width: 320, height: 200 }),
]);
const INTERACTIVE_FRAME_BOUNDS = Object.freeze([
  Object.freeze({ width: INTERACTIVE_FRAME_WIDTH, height: INTERACTIVE_FRAME_HEIGHT }),
  Object.freeze({ width: 768, height: 480 }),
  Object.freeze({ width: 640, height: 400 }),
]);
const MAX_URL_BYTES = 4096;
const LOCAL_DESKTOP_START_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"><title>OpenBot Free Local Desktop</title></head><body><main><h1>Free Local Desktop</h1><p>Ready for this bot.</p></main></body></html>";
const LOCAL_DESKTOP_START_URL = `data:text/html;base64,${Buffer.from(LOCAL_DESKTOP_START_HTML, "utf8").toString("base64")}`;
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTION_FIELDS = new Set([
  "botId",
  "targetId",
  "targetGeneration",
  "taskId",
  "capability",
  "operation",
  "arguments",
  "resourceId",
  "resourceLabel",
  "reason",
]);
const IDENTITY_FIELDS = new Set(["botId", "targetId", "targetGeneration"]);
const NAVIGATION_FIELDS = new Set([...IDENTITY_FIELDS, "sessionGeneration", "url"]);
const DISPOSE_TASK_FIELDS = new Set(["botId", "taskId"]);
const DELETE_BOT_FIELDS = new Set(["botId", "localProfileId"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INPUT_CURRENTNESS_FIELDS = new Set([
  "botId",
  "targetId",
  "targetGeneration",
  "sessionGeneration",
  "pageGeneration",
  "frameId",
  "frameSequence",
  "inputSequence",
]);
const MOUSE_INPUT_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS,
  "type",
  "x",
  "y",
  "button",
  "buttons",
  "clickCount",
  "deltaX",
  "deltaY",
  "modifiers",
  "coordinate",
  "coordinateSpace",
  "deviceScaleFactor",
]);
const KEY_INPUT_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS,
  "type",
  "modifiers",
  "text",
  "unmodifiedText",
  "key",
  "code",
  "windowsVirtualKeyCode",
  "nativeVirtualKeyCode",
  "autoRepeat",
  "isKeypad",
  "isSystemKey",
  "location",
]);
const INSERT_TEXT_FIELDS = new Set([...INPUT_CURRENTNESS_FIELDS, "text"]);
const IME_COMPOSITION_FIELDS = new Set([
  ...INPUT_CURRENTNESS_FIELDS,
  "text",
  "selectionStart",
  "selectionEnd",
  "replacementStart",
  "replacementEnd",
]);
const NAVIGATION_HISTORY_FIELDS = new Set([...IDENTITY_FIELDS, "sessionGeneration", "pageGeneration"]);
const PRESENTATION_REQUEST_FIELDS = new Set([...IDENTITY_FIELDS, "presentation"]);
const CDP_INPUT_METHODS = new Set([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.imeSetComposition",
]);
const CDP_PARAMETER_FIELDS = Object.freeze({
  "Input.dispatchMouseEvent": Object.freeze([
    "type", "x", "y", "button", "buttons", "clickCount", "deltaX", "deltaY", "modifiers",
  ]),
  "Input.dispatchKeyEvent": Object.freeze([
    "type", "modifiers", "text", "unmodifiedText", "key", "code",
    "windowsVirtualKeyCode", "nativeVirtualKeyCode", "autoRepeat", "isKeypad", "isSystemKey", "location",
  ]),
  "Input.insertText": Object.freeze(["text"]),
  "Input.imeSetComposition": Object.freeze([
    "text", "selectionStart", "selectionEnd", "replacementStart", "replacementEnd",
  ]),
});
const MOUSE_EVENT_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const MOUSE_BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);
const KEY_EVENT_TYPES = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
const CDP_DEBUGGER_VERSION = "1.3";
const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const MAX_IME_REPLACEMENT_OFFSET = 1_000_000;
const EXTERNAL_RESOURCE_CAPABILITIES = new Set([
  "filesystem.read",
  "filesystem.write",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const SECURED_BROWSER_SESSIONS = new WeakSet();
const PROFILE_REMOVE_SCRIPT = String.raw`set -efu
expected_root=$1
expected_profile=$2
profile_name=$3
case "$profile_name" in
  ????????-????-????-????-????????????) ;;
  *) exit 64 ;;
esac
case "$profile_name" in *[!0123456789abcdef-]*) exit 64 ;; esac
actual_root=$(/usr/bin/stat -f '%d:%i:%FB' .) || exit 65
[ "$actual_root" = "$expected_root" ] || exit 66
[ ! -L "./$profile_name" ] || exit 67
[ -d "./$profile_name" ] || exit 67
actual_profile=$(/usr/bin/stat -f '%d:%i:%FB' "./$profile_name") || exit 67
[ "$actual_profile" = "$expected_profile" ] || exit 68
exec /bin/rm -Rfx "./$profile_name"`;
const PROFILE_REMOVE_REFUSAL_CODES = new Set([64, 66, 67, 68]);

class LocalDesktopError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalDesktopError";
    this.code = code;
  }
}

function desktopError(message, code) {
  return new LocalDesktopError(message, code);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clonePlain(value, seen = new Set(), depth = 0) {
  if (depth > 16) throw new TypeError("Local Desktop data is oversized.");
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Local Desktop data contains an invalid number.");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Local Desktop data must contain plain data values only.");
  if (seen.has(value)) throw new TypeError("Local Desktop data cannot contain cycles.");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Local Desktop data must use plain objects and arrays.");
  }
  let descriptors;
  let keys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw new TypeError("Local Desktop data must contain plain data values only.");
  }
  if (keys.some((key) => typeof key !== "string")) throw new TypeError("Local Desktop data cannot contain symbols.");
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError("Local Desktop data contains a forbidden field.");
    if (!("value" in descriptors[key])) throw new TypeError("Local Desktop data must not contain accessors.");
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw new TypeError("Local Desktop arrays must be dense.");
    }
  }
  seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = clonePlain(descriptors[key].value, seen, depth + 1);
  }
  seen.delete(value);
  return copy;
}

function cloneInput(value, label) {
  try {
    return clonePlain(value);
  } catch {
    throw new TypeError(`${label} must contain plain data values only.`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new Error(`${label} contains an unsupported field.`);
  }
  for (const key of fields) {
    if (!hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) throw new Error("Local Desktop bot ID is invalid.");
  return value.toLowerCase();
}

function normalizeTargetId(value) {
  if (typeof value !== "string") throw new Error("Local Desktop target ID is invalid.");
  const match = TARGET_ID_PATTERN.exec(value);
  if (!match) throw new Error("Local Desktop target ID is invalid.");
  return { targetId: value.toLowerCase(), uuid: match[1].toLowerCase() };
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Local Desktop generation is invalid.");
  return value;
}

function normalizePositiveSequence(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Local Desktop ${label} is invalid.`);
  return value;
}

function normalizeFrameId(value) {
  if (typeof value !== "string" || !/^frame-[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("Local Desktop frame ID is invalid.");
  }
  return value;
}

function inputError(message, code = "OPENBOT_LOCAL_INPUT_INVALID") {
  return desktopError(message, code);
}

function debuggerIsAttached(client) {
  try {
    const member = client?.isAttached;
    const value = typeof member === "function" ? member.call(client) : member;
    return value === true;
  } catch {
    return false;
  }
}

function normalizeInputCurrentness(value, fields, label = "Local Desktop input") {
  let input;
  try {
    input = assertPlainObject(cloneInput(value, label), label);
    for (const key of Object.keys(input)) {
      if (!fields.has(key)) throw new Error(`${label} contains an unsupported field.`);
    }
    for (const key of INPUT_CURRENTNESS_FIELDS) {
      if (!hasOwn(input, key)) throw new Error(`${label} is missing ${key}.`);
    }
    const identity = normalizeIdentity({
      botId: input.botId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
    });
    return {
      ...identity,
      sessionGeneration: normalizePositiveSequence(input.sessionGeneration, "session generation"),
      pageGeneration: normalizePositiveSequence(input.pageGeneration, "page generation"),
      frameId: normalizeFrameId(input.frameId),
      frameSequence: normalizePositiveSequence(input.frameSequence, "frame sequence"),
      inputSequence: normalizePositiveSequence(input.inputSequence, "input sequence"),
    };
  } catch (error) {
    if (error?.code === "OPENBOT_LOCAL_INPUT_INVALID") throw error;
    throw inputError(error?.message || `${label} is invalid.`);
  }
}

function finiteCoordinate(value, label, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw inputError(`Local Desktop ${label} is invalid.`);
  }
  return value;
}

function optionalFinite(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximum) {
    throw inputError(`Local Desktop ${label} is invalid.`);
  }
  return value;
}

function optionalSafeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw inputError(`Local Desktop ${label} is invalid.`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw inputError(`Local Desktop ${label} is invalid.`);
  return value;
}

function optionalString(value, label, maxBytes = 512) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw inputError(`Local Desktop ${label} is invalid.`);
  }
  return value;
}

function normalizeNavigationHistory(value) {
  try {
    const input = assertPlainObject(cloneInput(value, "Local navigation"), "Local navigation");
    assertExactKeys(input, NAVIGATION_HISTORY_FIELDS, "Local navigation");
    return {
      ...normalizeIdentity({
        botId: input.botId,
        targetId: input.targetId,
        targetGeneration: input.targetGeneration,
      }),
      sessionGeneration: normalizePositiveSequence(input.sessionGeneration, "session generation"),
      pageGeneration: normalizePositiveSequence(input.pageGeneration, "page generation"),
    };
  } catch (error) {
    if (error?.code === "OPENBOT_LOCAL_NAVIGATION_INVALID") throw error;
    throw desktopError(error?.message || "Local navigation is invalid.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
}

function normalizePresentationRequest(value) {
  try {
    const input = assertPlainObject(cloneInput(value, "Local Desktop presentation"), "Local Desktop presentation");
    assertExactKeys(input, PRESENTATION_REQUEST_FIELDS, "Local Desktop presentation");
    if (input.presentation !== "preview" && input.presentation !== "interactive") {
      throw new Error("Local Desktop presentation is invalid.");
    }
    const identity = normalizeIdentity({
      botId: input.botId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
    });
    return {
      botId: identity.botId,
      targetId: identity.targetId,
      targetGeneration: identity.targetGeneration,
      presentation: input.presentation,
    };
  } catch (error) {
    throw inputError(error?.message || "Local Desktop presentation is invalid.");
  }
}

function normalizeMouseInput(value) {
  const currentness = normalizeInputCurrentness(value, MOUSE_INPUT_FIELDS);
  let input;
  try { input = cloneInput(value, "Local Desktop mouse input"); } catch { throw inputError("Local Desktop mouse input is invalid."); }
  if (!MOUSE_EVENT_TYPES.has(input.type)) throw inputError("Local Desktop mouse event type is invalid.");
  const normalized = {
    ...currentness,
    type: input.type,
  };
  let point = input;
  if (input.coordinate !== undefined) {
    if (!input.coordinate || typeof input.coordinate !== "object" || Array.isArray(input.coordinate)) {
      throw inputError("Local Desktop mouse coordinate is invalid.");
    }
    const coordinateKeys = Object.keys(input.coordinate);
    if (coordinateKeys.some((key) => key !== "x" && key !== "y")
      || !hasOwn(input.coordinate, "x") || !hasOwn(input.coordinate, "y")) {
      throw inputError("Local Desktop mouse coordinate is invalid.");
    }
    point = input.coordinate;
  }
  if (input.coordinateSpace !== undefined
    && (typeof input.coordinateSpace !== "string" || !["css-dip", "dip"].includes(input.coordinateSpace))) {
    throw inputError("Local Desktop coordinate space is invalid.");
  }
  if (input.deviceScaleFactor !== undefined
    && (typeof input.deviceScaleFactor !== "number" || !Number.isFinite(input.deviceScaleFactor)
      || input.deviceScaleFactor !== 1)) {
    throw inputError("Local Desktop device scale factor is invalid.");
  }
  normalized.x = finiteCoordinate(point.x, "mouse X coordinate", SURFACE_CSS_WIDTH);
  normalized.y = finiteCoordinate(point.y, "mouse Y coordinate", SURFACE_CSS_HEIGHT);
  if (input.button !== undefined) {
    if (typeof input.button !== "string" || !MOUSE_BUTTONS.has(input.button)) {
      throw inputError("Local Desktop mouse button is invalid.");
    }
    normalized.button = input.button;
  } else if (input.type === "mousePressed" || input.type === "mouseReleased") {
    throw inputError("Local Desktop mouse button is required.");
  }
  const buttons = optionalSafeInteger(input.buttons, "mouse buttons", 0, 31);
  const clickCount = optionalSafeInteger(input.clickCount, "mouse click count", 0, 32);
  const modifiers = optionalSafeInteger(input.modifiers, "mouse modifiers", 0, 15);
  const deltaX = optionalFinite(input.deltaX, "mouse delta X", 1_000_000);
  const deltaY = optionalFinite(input.deltaY, "mouse delta Y", 1_000_000);
  for (const [key, fieldValue] of Object.entries({ buttons, clickCount, modifiers, deltaX, deltaY })) {
    if (fieldValue !== undefined) normalized[key] = fieldValue;
  }
  return normalized;
}

function normalizeKeyInput(value) {
  const currentness = normalizeInputCurrentness(value, KEY_INPUT_FIELDS);
  let input;
  try { input = cloneInput(value, "Local Desktop key input"); } catch { throw inputError("Local Desktop key input is invalid."); }
  if (!KEY_EVENT_TYPES.has(input.type)) throw inputError("Local Desktop key event type is invalid.");
  const key = optionalString(input.key, "key", 128);
  const code = optionalString(input.code, "code", 128);
  if (key === undefined && code === undefined) throw inputError("Local Desktop key or code is required.");
  const normalized = { ...currentness, type: input.type };
  for (const [name, fieldValue] of Object.entries({
    key,
    code,
    text: optionalString(input.text, "key text", 4096),
    unmodifiedText: optionalString(input.unmodifiedText, "unmodified key text", 4096),
    modifiers: optionalSafeInteger(input.modifiers, "key modifiers", 0, 15),
    windowsVirtualKeyCode: optionalSafeInteger(input.windowsVirtualKeyCode, "Windows virtual key code", 0, 0xffff),
    nativeVirtualKeyCode: optionalSafeInteger(input.nativeVirtualKeyCode, "native virtual key code", 0, 0xffff),
    autoRepeat: optionalBoolean(input.autoRepeat, "key auto-repeat"),
    isKeypad: optionalBoolean(input.isKeypad, "keypad flag"),
    isSystemKey: optionalBoolean(input.isSystemKey, "system-key flag"),
    location: optionalSafeInteger(input.location, "key location", 0, 3),
  })) {
    if (fieldValue !== undefined) normalized[name] = fieldValue;
  }
  return normalized;
}

function normalizeInsertText(value) {
  const currentness = normalizeInputCurrentness(value, INSERT_TEXT_FIELDS);
  let input;
  try { input = cloneInput(value, "Local Desktop text input"); } catch { throw inputError("Local Desktop text input is invalid."); }
  const text = optionalString(input.text, "text", 64 * 1024);
  if (text === undefined) throw inputError("Local Desktop text is required.");
  return { ...currentness, text };
}

function normalizeImeComposition(value) {
  const currentness = normalizeInputCurrentness(value, IME_COMPOSITION_FIELDS);
  let input;
  try { input = cloneInput(value, "Local Desktop IME input"); } catch { throw inputError("Local Desktop IME input is invalid."); }
  const text = optionalString(input.text, "composition text", 64 * 1024);
  if (text === undefined) throw inputError("Local Desktop composition text is required.");
  const selectionStart = optionalSafeInteger(input.selectionStart, "composition selection start", 0, text.length);
  const selectionEnd = optionalSafeInteger(input.selectionEnd, "composition selection end", 0, text.length);
  if (selectionStart === undefined || selectionEnd === undefined || selectionEnd < selectionStart) {
    throw inputError("Local Desktop composition selection is invalid.");
  }
  const replacementStart = optionalSafeInteger(
    input.replacementStart,
    "composition replacement start",
    -1,
    MAX_IME_REPLACEMENT_OFFSET,
  );
  const replacementEnd = optionalSafeInteger(
    input.replacementEnd,
    "composition replacement end",
    -1,
    MAX_IME_REPLACEMENT_OFFSET,
  );
  if ((replacementStart === undefined) !== (replacementEnd === undefined)) {
    throw inputError("Local Desktop composition replacement is invalid.");
  }
  if (replacementStart !== undefined && replacementEnd !== undefined && replacementEnd < replacementStart) {
    throw inputError("Local Desktop composition replacement is invalid.");
  }
  return {
    ...currentness,
    text,
    selectionStart,
    selectionEnd,
    ...(replacementStart === undefined ? {} : { replacementStart }),
    ...(replacementEnd === undefined ? {} : { replacementEnd }),
  };
}

function normalizeComputer(value, { allowStarting = false } = {}) {
  const input = assertPlainObject(cloneInput(value, "Local Computer"), "Local Computer");
  const botId = normalizeBotId(input.botId);
  const computer = assertPlainObject(input.computer, "Local Computer state");
  const target = normalizeTargetId(computer.localProfileId);
  if (computer.mode !== "local"
    || (computer.state !== "ready" && (!allowStarting || computer.state !== "starting"))) {
    throw desktopError("Local Computer is unavailable.", "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE");
  }
  return {
    botId,
    targetId: target.targetId,
    profileUuid: target.uuid,
    targetGeneration: normalizeGeneration(computer.generation),
  };
}

function normalizeIdentity(value, fields = IDENTITY_FIELDS, label = "Local Desktop identity") {
  const input = assertPlainObject(cloneInput(value, label), label);
  assertExactKeys(input, fields, label);
  const target = normalizeTargetId(input.targetId);
  return {
    botId: normalizeBotId(input.botId),
    targetId: target.targetId,
    profileUuid: target.uuid,
    targetGeneration: normalizeGeneration(input.targetGeneration),
  };
}

function normalizeAction(value) {
  const input = assertPlainObject(cloneInput(value, "Local Desktop action"), "Local Desktop action");
  assertExactKeys(input, ACTION_FIELDS, "Local Desktop action");
  const identity = normalizeIdentity({
    botId: input.botId,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
  });
  for (const [field, label] of [
    ["taskId", "task ID"],
    ["resourceId", "resource ID"],
  ]) {
    if (typeof input[field] !== "string" || !SAFE_ID_PATTERN.test(input[field]) || input[field].includes("..")) {
      throw new Error(`Local Desktop ${label} is invalid.`);
    }
  }
  if (typeof input.capability !== "string" || input.operation !== input.capability) {
    throw new Error("Local Desktop operation is invalid.");
  }
  for (const [field, label] of [["resourceLabel", "resource label"], ["reason", "reason"]]) {
    if (typeof input[field] !== "string" || input[field].length === 0 || input[field].trim() !== input[field]
      || Buffer.byteLength(input[field], "utf8") > 512 || /[\0-\x1f\x7f\\/]/.test(input[field])) {
      throw new Error(`Local Desktop ${label} is invalid.`);
    }
  }
  assertPlainObject(input.arguments, "Local Desktop arguments");
  return { ...input, ...identity };
}

function normalizeNavigation(value) {
  try {
    const input = assertPlainObject(cloneInput(value, "Local navigation"), "Local navigation");
    assertExactKeys(input, NAVIGATION_FIELDS, "Local navigation");
    const identity = normalizeIdentity({
      botId: input.botId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
    });
    return {
      ...identity,
      sessionGeneration: normalizePositiveSequence(input.sessionGeneration, "session generation"),
      url: safeHttpsUrl(input.url),
    };
  } catch (error) {
    if (error?.code === "OPENBOT_LOCAL_NAVIGATION_INVALID") throw error;
    throw desktopError("Local navigation is invalid.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
}

function normalizeDisposeTask(value) {
  const input = assertPlainObject(cloneInput(value, "Local Desktop task"), "Local Desktop task");
  assertExactKeys(input, DISPOSE_TASK_FIELDS, "Local Desktop task");
  if (typeof input.taskId !== "string" || !SAFE_ID_PATTERN.test(input.taskId)) {
    throw new Error("Local Desktop task ID is invalid.");
  }
  return { botId: normalizeBotId(input.botId), taskId: input.taskId };
}

function normalizeDeleteBot(value) {
  if (typeof value === "string") {
    return { botId: normalizeBotId(value), localProfileId: null, profileUuid: null, legacy: true };
  }
  let array;
  let prototype;
  let descriptors;
  try {
    array = Array.isArray(value);
    if (value && typeof value === "object" && !array) {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    }
  } catch {
    throw new TypeError("Local Desktop deletion must contain plain data values only.");
  }
  if (!value || typeof value !== "object" || array
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Local Desktop deletion must be a plain object.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Local Desktop deletion cannot contain symbols.");
  }
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key) || !DELETE_BOT_FIELDS.has(key)) {
      throw new Error("Local Desktop deletion contains an unsupported field.");
    }
  }
  for (const key of DELETE_BOT_FIELDS) {
    if (!hasOwn(descriptors, key)) throw new Error(`Local Desktop deletion is missing ${key}.`);
    if (!("value" in descriptors[key])) {
      throw new TypeError("Local Desktop deletion must contain plain data values only.");
    }
  }
  const target = normalizeTargetId(descriptors.localProfileId.value);
  return {
    botId: normalizeBotId(descriptors.botId.value),
    localProfileId: target.targetId,
    profileUuid: target.uuid,
    legacy: false,
  };
}

function botDeletingError() {
  return desktopError("Local Desktop data for this bot is being deleted.", "OPENBOT_LOCAL_BOT_DELETING");
}

function cleanupRefusedError() {
  return desktopError("Local profile cleanup was refused.", "OPENBOT_LOCAL_CLEANUP_REFUSED");
}

function cleanupFailedError() {
  return desktopError("Local profile cleanup failed.", "OPENBOT_LOCAL_CLEANUP_FAILED");
}

function directoryIdentity(stat) {
  const seconds = stat.birthtimeNs / 1_000_000_000n;
  const nanoseconds = String(stat.birthtimeNs % 1_000_000_000n).padStart(9, "0");
  return `${stat.dev}:${stat.ino}:${seconds}.${nanoseconds}`;
}

function removeBoundProfile({ root, rootIdentity, profileIdentity, profileUuid }) {
  return new Promise((resolve, reject) => {
    try {
      childProcess.execFile(
        "/bin/sh",
        ["-c", PROFILE_REMOVE_SCRIPT, "openbot-profile-cleanup", rootIdentity, profileIdentity, profileUuid],
        {
          cwd: root,
          env: { LC_ALL: "C" },
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_024,
        },
        (error) => {
          if (!error) {
            resolve();
            return;
          }
          if (PROFILE_REMOVE_REFUSAL_CODES.has(error.code)) reject(cleanupRefusedError());
          else reject(cleanupFailedError());
        },
      );
    } catch {
      reject(cleanupFailedError());
    }
  });
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_URL_BYTES || value.includes("\0")) {
    throw desktopError("Local navigation URL is invalid.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
  let url;
  try { url = new URL(value); } catch {
    throw desktopError("Local navigation URL is invalid.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
  const hostname = url.hostname.toLowerCase();
  const comparableHostname = hostname.replace(/\.+$/, "");
  if (url.protocol !== "https:" || url.username || url.password || !hostname
    || comparableHostname === "localhost" || comparableHostname.endsWith(".localhost")
    || privateIp(comparableHostname)) {
    throw desktopError("Local navigation requires a public HTTPS URL.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
  return url.href;
}

function safeDisplayUrl(value) {
  if (value === LOCAL_DESKTOP_START_URL) return LOCAL_DESKTOP_START_URL;
  return safeHttpsUrl(value);
}

function privateIp(hostname) {
  const address = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const mapped = /^::ffff:(?:([0-9]{1,3}(?:\.[0-9]{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
    if (mapped) {
      const ipv4 = mapped[1] || (() => {
        const high = Number.parseInt(mapped[2], 16);
        const low = Number.parseInt(mapped[3], 16);
        return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
      })();
      return privateIp(ipv4);
    }
    return address === "::1" || address === "::" || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address);
  }
  return false;
}

function safeUUID(makeUUID) {
  const value = makeUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Generated Local Desktop UUID is invalid.");
  return value.toLowerCase();
}

function publicSession(entry) {
  return Object.freeze({
    botId: entry.botId,
    targetId: entry.targetId,
    targetGeneration: entry.targetGeneration,
    sessionGeneration: entry.sessionGeneration,
    pageGeneration: entry.pageGeneration,
    partition: entry.partition,
    workspaceId: entry.workspaceId,
    surface: Object.freeze({
      cssWidth: SURFACE_CSS_WIDTH,
      cssHeight: SURFACE_CSS_HEIGHT,
    }),
    presentations: Object.freeze({
      preview: Object.freeze({
        width: PREVIEW_FRAME_WIDTH,
        height: PREVIEW_FRAME_HEIGHT,
        fps: PREVIEW_FRAME_INTERVAL_MS / 1_000,
      }),
      interactive: Object.freeze({
        width: INTERACTIVE_FRAME_WIDTH,
        height: INTERACTIVE_FRAME_HEIGHT,
      }),
    }),
    state: "ready",
  });
}

function currentBot(entry) {
  return Object.freeze({
    botId: entry.botId,
    computer: Object.freeze({
      mode: "local",
      generation: entry.targetGeneration,
      localProfileId: entry.targetId,
      state: "ready",
    }),
  });
}

class LocalDesktopManager extends EventEmitter {
  #electron;
  #userDataPath;
  #permissionBroker;
  #readCurrentComputer;
  #helperFactory;
  #debuggerFactory;
  #randomUUID;
  #helperTimeoutMs;
  #navigationTimeoutMs;
  #sessionGenerations = new Map();
  #entries = new Map();
  #profiles = new Map();
  #profileOwners = new Map();
  #queues = new Map();
  #cleanupByBot = new Map();
  #deletions = new Map();
  #windows = new WeakSet();
  #disposePromise = null;
  #disposed = false;

  constructor({
    electron,
    userDataPath,
    permissionBroker,
    readCurrentComputer,
    helperFactory,
    debuggerFactory = null,
    randomUUID = crypto.randomUUID,
    helperTimeoutMs = 30_000,
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
  } = {}) {
    super();
    if (!electron?.BrowserWindow || typeof electron?.session?.fromPartition !== "function") {
      throw new TypeError("Local Desktop manager requires Electron browser APIs.");
    }
    if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath) || userDataPath.includes("\0")) {
      throw new TypeError("Local Desktop manager requires an absolute userData path.");
    }
    if (!permissionBroker || typeof permissionBroker.request !== "function"
      || typeof permissionBroker.cancelTask !== "function"
      || typeof permissionBroker.cancelBot !== "function"
      || typeof permissionBroker.deleteBot !== "function") {
      throw new TypeError("Local Desktop manager requires a permission broker.");
    }
    if (typeof readCurrentComputer !== "function") {
      throw new TypeError("Local Desktop manager requires an authoritative current Computer reader.");
    }
    if (typeof helperFactory !== "function" || (debuggerFactory !== null && typeof debuggerFactory !== "function")
      || typeof randomUUID !== "function"
      || !Number.isSafeInteger(helperTimeoutMs) || helperTimeoutMs < 1 || helperTimeoutMs > 120_000
      || !Number.isSafeInteger(navigationTimeoutMs) || navigationTimeoutMs < 1 || navigationTimeoutMs > 30_000) {
      throw new TypeError("Local Desktop helper configuration is invalid.");
    }
    this.#electron = electron;
    this.#userDataPath = path.resolve(userDataPath);
    this.#permissionBroker = permissionBroker;
    this.#readCurrentComputer = readCurrentComputer;
    this.#helperFactory = helperFactory;
    this.#debuggerFactory = debuggerFactory;
    this.#randomUUID = randomUUID;
    this.#helperTimeoutMs = helperTimeoutMs;
    this.#navigationTimeoutMs = navigationTimeoutMs;
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {}
    }
    return true;
  }

  ownsWindow(window) {
    try { return Boolean(window && typeof window === "object" && this.#windows.has(window)); } catch { return false; }
  }

  async open(value) {
    this.#assertActive();
    const computer = normalizeComputer(value);
    this.#assertBotAvailable(computer.botId);
    this.#claimProfile(computer.botId, computer.targetId);
    return this.#enqueue(computer.botId, async () => {
      const pendingCleanup = this.#cleanupByBot.get(computer.botId);
      if (pendingCleanup) await Promise.allSettled([pendingCleanup]);
      this.#assertBotAvailable(computer.botId);
      const existing = this.#entries.get(computer.botId);
      if (existing && this.#sameIdentity(existing, computer)) {
        existing.fenced = true;
        try {
          await this.#assertCurrentComputer(computer);
          this.#assertReusableEntry(existing, computer);
          existing.fenced = false;
          return publicSession(existing);
        } catch (error) {
          if (this.#entries.get(computer.botId) === existing) {
            try { await this.#closeEntry(existing, true); } catch {}
          } else if (existing.closePromise) {
            try { await existing.closePromise; } catch {}
          }
          throw error;
        }
      }
      if (existing) {
        await this.#closeEntry(existing, true);
        await this.#assertCurrentComputer(computer);
      }

      const profilePath = await this.#ensureProfile(computer.profileUuid);
      await this.#assertCurrentComputer(computer);
      this.#assertBotAvailable(computer.botId);
      const partition = `persist:openbot-local-${computer.profileUuid}`;
      const browserSession = this.#electron.session.fromPartition(partition);
      this.#secureSession(browserSession);
      const window = new this.#electron.BrowserWindow({
        show: false,
        width: SURFACE_CSS_WIDTH,
        height: SURFACE_CSS_HEIGHT,
        useContentSize: true,
        webPreferences: {
          session: browserSession,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      this.#windows.add(window);
      let helperTransport;
      let protocol;
      let unsubscribeHelperExit;
      let helperExited = false;
      let publishedEntry = null;
      let entry = null;
      let helperIsUnavailable = () => true;
      try {
        this.#secureWindow(window);
        await window.webContents.loadURL(LOCAL_DESKTOP_START_URL);
        await this.#assertCurrentComputer(computer);
        if (window.webContents.getURL() !== LOCAL_DESKTOP_START_URL) {
          throw desktopError("Local Desktop start document is invalid.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        helperTransport = await this.#helperFactory(Object.freeze({
          botId: computer.botId,
          targetId: computer.targetId,
          targetGeneration: computer.targetGeneration,
          workspacePath: profilePath.workspacePath,
        }));
        if (!helperTransport || typeof helperTransport.onExit !== "function"
          || typeof helperTransport.isClosed !== "function") {
          throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        const onHelperExit = () => {
          helperExited = true;
          const entry = publishedEntry;
          if (!entry) return;
          entry.fenced = true;
          entry.closeRequested = true;
          try {
            void Promise.resolve(this.#closeEntry(entry, true)).catch(() => {});
          } catch {}
        };
        unsubscribeHelperExit = helperTransport.onExit(onHelperExit);
        if (typeof unsubscribeHelperExit !== "function") {
          throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        helperIsUnavailable = () => {
          if (helperExited) return true;
          try { return helperTransport.isClosed() !== false; } catch { return true; }
        };
        if (helperIsUnavailable()) {
          throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        await this.#assertCurrentComputer(computer);
        if (helperIsUnavailable()) {
          throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        if (window.webContents.getURL() !== LOCAL_DESKTOP_START_URL) {
          throw desktopError("Local Desktop start document is invalid.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        const previousSessionGeneration = this.#sessionGenerations.get(computer.targetId) || 0;
        const sessionGeneration = previousSessionGeneration + 1;
        if (!Number.isSafeInteger(sessionGeneration)) {
          throw desktopError("Local Desktop session generation is exhausted.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        this.#sessionGenerations.set(computer.targetId, sessionGeneration);
        entry = {
          ...computer,
          sessionGeneration,
          pageGeneration: 1,
          frameSequence: 0,
          lastFrameId: null,
          inputSequence: 0,
          heldButtons: new Set(),
          heldKeys: new Map(),
          releasePromise: null,
          releaseFailed: false,
          lastPointer: { x: 0, y: 0 },
          debuggerClient: null,
          debuggerDetachListener: null,
          debuggerAttachPromise: null,
          debuggerDetached: false,
          navigationListeners: [],
          navigationPending: false,
          partition,
          workspaceId: `workspace-${computer.profileUuid}`,
          profilePath: profilePath.profilePath,
          workspacePath: profilePath.workspacePath,
          browserSession,
          window,
          helperTransport,
          protocol: null,
          unsubscribeHelperExit,
          operations: new Map(),
          closePromise: null,
          fenced: false,
          closeRequested: false,
        };
        protocol = new LocalHelperProtocol({
          transport: helperTransport,
          readCurrentComputer: async () => {
            const current = this.#entries.get(computer.botId);
            return current ? currentBot(current) : null;
          },
          timeoutMs: this.#helperTimeoutMs,
        });
        entry.protocol = protocol;
        publishedEntry = entry;
        if (helperIsUnavailable()) {
          throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        this.#entries.set(computer.botId, entry);
        this.#profiles.set(computer.botId, {
          ...computer,
          partition,
          browserSession,
          profilePath: profilePath.profilePath,
          workspacePath: profilePath.workspacePath,
        });
        window.once?.("closed", () => {
          if (this.#entries.get(computer.botId) !== entry) return;
          void this.#closeEntry(entry, true);
        });
        this.#bindNavigation(entry);
        await this.#attachDebugger(entry);
        this.#requiredEntry(computer, entry);
        if (helperIsUnavailable()) {
          throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        return publicSession(entry);
      } catch (error) {
        publishedEntry = null;
        if (entry && this.#entries.get(entry.botId) === entry) {
          try { await this.#closeEntry(entry, true); } catch {}
        } else if (entry?.closePromise) {
          try { await entry.closePromise; } catch {}
        }
        try { unsubscribeHelperExit?.(); } catch {}
        unsubscribeHelperExit = null;
        try { await protocol?.dispose(); } catch {}
        if (!protocol) {
          try { await helperTransport?.dispose?.(); } catch {}
        }
        try { if (!window.isDestroyed?.()) window.destroy(); } catch {}
        this.#assertBotAvailable(computer.botId);
        if (error instanceof LocalDesktopError) throw error;
        throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
      }
    });
  }

  async navigate(value) {
    this.#assertActive();
    const input = normalizeNavigation(value);
    const admittedEntry = this.#requiredEntry(input);
    if (admittedEntry.sessionGeneration !== input.sessionGeneration) {
      throw desktopError("Local navigation is stale.", "OPENBOT_LOCAL_NAVIGATION_STALE");
    }
    return this.#enqueue(input.botId, async () => {
      const entry = this.#requiredEntry(input, admittedEntry);
      if (entry.sessionGeneration !== input.sessionGeneration) {
        throw desktopError("Local navigation is stale.", "OPENBOT_LOCAL_NAVIGATION_STALE");
      }
      return this.#runNavigationWithDeadline(entry, async (deadline) => {
        await this.#beginNavigation(entry, deadline);
        try {
          await deadline.race(entry.window.webContents.loadURL(input.url));
        } catch {
          throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
        } finally {
          entry.navigationPending = false;
        }
        this.#requiredEntry(input, entry);
        try { safeHttpsUrl(entry.window.webContents.getURL()); } catch {
          throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
        }
        return publicSession(entry);
      });
    });
  }

  async goBack(value) {
    return this.#historyNavigation(value, "goBack");
  }

  async goForward(value) {
    return this.#historyNavigation(value, "goForward");
  }

  async reload(value) {
    return this.#historyNavigation(value, "reload");
  }

  async retry(value) {
    this.#assertActive();
    const computer = normalizeComputer(value);
    this.#assertBotAvailable(computer.botId);
    const previous = this.#entries.get(computer.botId);
    const previousPageGeneration = previous?.pageGeneration || 0;
    if (previous) await this.close(computer.botId);
    const session = await this.open(value);
    const reopened = this.#entries.get(computer.botId);
    if (reopened && previousPageGeneration > 0) {
      reopened.pageGeneration = previousPageGeneration + 1;
      reopened.lastFrameId = null;
    }
    return reopened ? publicSession(reopened) : session;
  }

  async #historyNavigation(value, method) {
    this.#assertActive();
    const input = normalizeNavigationHistory(value);
    const admittedEntry = this.#requiredEntry(input);
    if (admittedEntry.sessionGeneration !== input.sessionGeneration
      || admittedEntry.pageGeneration !== input.pageGeneration) {
      throw desktopError("Local navigation is stale.", "OPENBOT_LOCAL_NAVIGATION_STALE");
    }
    return this.#enqueue(input.botId, async () => {
      const entry = this.#requiredEntry(input, admittedEntry);
      if (entry.sessionGeneration !== input.sessionGeneration
        || entry.pageGeneration !== input.pageGeneration) {
        throw desktopError("Local navigation is stale.", "OPENBOT_LOCAL_NAVIGATION_STALE");
      }
      const navigation = entry.window.webContents?.[method];
      if (typeof navigation !== "function") {
        throw desktopError("Local navigation is unavailable.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
      }
      if (typeof entry.window.webContents.canGoBack === "function" && method === "goBack"
        && !entry.window.webContents.canGoBack()) {
        throw desktopError("Local navigation is unavailable.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
      }
      if (typeof entry.window.webContents.canGoForward === "function" && method === "goForward"
        && !entry.window.webContents.canGoForward()) {
        throw desktopError("Local navigation is unavailable.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
      }
      return this.#runNavigationWithDeadline(entry, async (deadline) => {
        await this.#beginNavigation(entry, deadline);
        const expectedPageGeneration = entry.pageGeneration;
        try {
          await this.#awaitHistoryNavigation(entry, navigation, expectedPageGeneration, deadline);
          this.#requiredEntry(input, entry);
          if (entry.pageGeneration !== expectedPageGeneration) {
            throw desktopError("Local navigation is stale.", "OPENBOT_LOCAL_NAVIGATION_STALE");
          }
          safeDisplayUrl(entry.window.webContents.getURL());
        } catch (error) {
          if (error instanceof LocalDesktopError
            && [
              "OPENBOT_LOCAL_DESKTOP_STALE",
              "OPENBOT_LOCAL_NAVIGATION_STALE",
              "OPENBOT_LOCAL_BOT_DELETING",
              "OPENBOT_LOCAL_DESKTOP_DISPOSED",
            ].includes(error.code)) throw error;
          if (error?.code === "OPENBOT_LOCAL_NAVIGATION_INVALID") {
            throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
          }
          throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
        } finally {
          entry.navigationPending = false;
        }
        return publicSession(entry);
      });
    });
  }

  async capture(value) {
    this.#assertActive();
    const input = normalizeIdentity(value);
    const entry = this.#requiredEntry(input);
      const image = await this.#captureCurrentImage(input, entry);
    let size;
    let bytes;
    try {
      size = image.getSize();
      bytes = image.toPNG();
    } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
      || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192
      || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    this.#recordFrame(entry, bytes);
    const frame = Object.freeze({
      botId: entry.botId,
      targetId: entry.targetId,
      targetGeneration: entry.targetGeneration,
      frameId: `frame-${crypto.createHash("sha256").update(bytes).digest("hex")}`,
      width: size.width,
      height: size.height,
      mimeType: "image/png",
    });
    this.emit("frame", frame);
    return frame;
  }

  async captureDisplayFrame(value) {
    let hasPresentation = false;
    try {
      hasPresentation = Boolean(value && typeof value === "object" && hasOwn(value, "presentation"));
    } catch {
      throw inputError("Local Desktop presentation is invalid.");
    }
    if (hasPresentation) {
      const request = normalizePresentationRequest(value);
      return this.#capturePresentationFrame({
        botId: request.botId,
        targetId: request.targetId,
        targetGeneration: request.targetGeneration,
      }, request.presentation, true);
    }
    return this.#capturePresentationFrame(value, "preview", false);
  }

  async capturePreviewFrame(value) {
    return this.#capturePresentationFrame(value, "preview", true);
  }

  async captureInteractiveFrame(value) {
    return this.#capturePresentationFrame(value, "interactive", true);
  }

  async #capturePresentationFrame(value, presentation, rich) {
    this.#assertActive();
    const input = normalizeIdentity(value);
    const entry = this.#requiredEntry(input);
    const image = await this.#captureCurrentImage(input, entry);
    let sourceSize;
    try { sourceSize = image.getSize(); } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    if (!this.#validFrameSize(sourceSize, 8192, 8192) || typeof image.resize !== "function") {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    const boundsList = presentation === "interactive" ? INTERACTIVE_FRAME_BOUNDS : DISPLAY_FRAME_BOUNDS;
    const maximumWidth = presentation === "interactive" ? INTERACTIVE_FRAME_WIDTH : MAX_DISPLAY_FRAME_WIDTH;
    const maximumHeight = presentation === "interactive" ? INTERACTIVE_FRAME_HEIGHT : MAX_DISPLAY_FRAME_HEIGHT;
    const maximumBytes = MAX_DISPLAY_FRAME_BYTES;
    for (const bounds of boundsList) {
      const scale = Math.min(1, bounds.width / sourceSize.width, bounds.height / sourceSize.height);
      const width = Math.max(1, Math.floor(sourceSize.width * scale));
      const height = Math.max(1, Math.floor(sourceSize.height * scale));
      let rendered;
      let size;
      let bytes;
      try {
        rendered = width === sourceSize.width && height === sourceSize.height
          ? image
          : image.resize({ width, height, quality: "good" });
        size = rendered.getSize();
        bytes = rendered.toPNG();
      } catch { continue; }
      if (!this.#validFrameSize(size, maximumWidth, maximumHeight)
        || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes) continue;
      const frameSequence = this.#recordFrame(entry, bytes);
      const frame = {
        botId: entry.botId,
        targetId: entry.targetId,
        targetGeneration: entry.targetGeneration,
        frameId: `frame-${crypto.createHash("sha256").update(bytes).digest("hex")}`,
        width: size.width,
        height: size.height,
        mimeType: "image/png",
        bytes: Uint8Array.from(bytes),
        ...(rich ? {
          presentation,
          sessionGeneration: entry.sessionGeneration,
          pageGeneration: entry.pageGeneration,
          frameSequence,
        } : {}),
      };
      try {
        await this.#assertCurrentComputer(input);
      } catch (error) {
        if (this.#entries.get(entry.botId) === entry) {
          try { await this.#closeEntry(entry, true); } catch {}
        }
        throw error;
      }
      this.#requiredEntry(input, entry);
      if (rich && entry.pageGeneration !== frame.pageGeneration) {
        throw desktopError("Local Desktop frame is stale.", "OPENBOT_LOCAL_DESKTOP_STALE");
      }
      return Object.freeze(frame);
    }
    throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
  }

  async dispatchMouseEvent(value) {
    return this.#dispatchInput(value, normalizeMouseInput, "Input.dispatchMouseEvent", {
      preclaim: (entry, input) => {
        entry.lastPointer = { x: input.x, y: input.y };
        if (input.type === "mousePressed" && input.button !== "none") entry.heldButtons.add(input.button);
      },
      commit: (entry, input) => {
        if (input.type === "mouseReleased" && input.button !== "none") entry.heldButtons.delete(input.button);
      },
    });
  }

  async dispatchKeyEvent(value) {
    return this.#dispatchInput(value, normalizeKeyInput, "Input.dispatchKeyEvent", {
      preclaim: (entry, input) => {
        if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
        const id = `${input.key || ""}\0${input.code || ""}`;
        entry.heldKeys.set(id, Object.freeze({
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(input.code === undefined ? {} : { code: input.code }),
        }));
      },
      commit: (entry, input) => {
        if (input.type !== "keyUp") return;
        entry.heldKeys.delete(`${input.key || ""}\0${input.code || ""}`);
      },
    });
  }

  async insertText(value) {
    return this.#dispatchInput(value, normalizeInsertText, "Input.insertText");
  }

  async imeSetComposition(value) {
    return this.#dispatchInput(value, normalizeImeComposition, "Input.imeSetComposition");
  }

  async #dispatchInput(value, normalize, method, lifecycle = null) {
    this.#assertActive();
    const input = normalize(value);
    const entry = this.#requiredInputEntry(input);
    return this.#enqueue(entry.botId, async () => {
      this.#requiredInputEntry(input, entry);
      await this.#ensureDebugger(entry);
      this.#requiredInputEntry(input, entry);
      const params = {};
      for (const key of CDP_PARAMETER_FIELDS[method]) {
        if (hasOwn(input, key)) params[key] = input[key];
      }
      lifecycle?.preclaim?.(entry, input);
      try {
        await this.#sendCdpCommand(entry, method, params);
        this.#requiredInputEntry(input, entry);
        entry.inputSequence = input.inputSequence;
        lifecycle?.commit?.(entry, input);
      } catch (error) {
        if (entry.closePromise) await Promise.allSettled([entry.closePromise]);
        else await this.#releaseHeldInputs(entry);
        throw error;
      }
      return Object.freeze({
        botId: entry.botId,
        targetId: entry.targetId,
        targetGeneration: entry.targetGeneration,
        sessionGeneration: entry.sessionGeneration,
        pageGeneration: entry.pageGeneration,
        frameId: entry.lastFrameId,
        frameSequence: entry.frameSequence,
        inputSequence: entry.inputSequence,
      });
    });
  }

  async run(value) {
    this.#assertActive();
    const input = normalizeAction(value);
    const entry = this.#requiredEntry(input);
    const requestId = `request-${safeUUID(this.#randomUUID)}`;
    let finishOperation;
    const operation = {
      requestId,
      taskId: input.taskId,
      cancelled: false,
      done: new Promise((resolve) => { finishOperation = resolve; }),
      finish: () => finishOperation(),
    };
    entry.operations.set(requestId, operation);
    try {
      const result = await this.#permissionBroker.request({
        botId: input.botId,
        targetId: input.targetId,
        targetGeneration: input.targetGeneration,
        capability: input.capability,
        resourceId: input.resourceId,
        resourceLabel: input.resourceLabel,
        reason: input.reason,
        ...(input.capability === "shell.execute" ? { command: input.arguments.command } : {}),
      }, async (bookmark) => {
        this.#assertOperationActive(entry, input, operation);
        if (EXTERNAL_RESOURCE_CAPABILITIES.has(input.capability)) {
          if (typeof entry.helperTransport.authorizeResource !== "function") {
            throw desktopError("Local resource handoff is unavailable.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
          }
          await entry.helperTransport.authorizeResource(requestId, Buffer.from(bookmark));
          this.#assertOperationActive(entry, input, operation);
        }
        return entry.protocol.run({
          requestId,
          botId: input.botId,
          targetId: input.targetId,
          targetGeneration: input.targetGeneration,
          taskId: input.taskId,
          capability: input.capability,
          operation: input.operation,
          arguments: input.arguments,
        });
      }, { taskId: input.taskId });
      this.#assertOperationActive(entry, input, operation);
      this.emit("result", Object.freeze({
        requestId,
        botId: entry.botId,
        targetId: entry.targetId,
        targetGeneration: entry.targetGeneration,
        taskId: input.taskId,
        ok: true,
      }));
      return result;
    } finally {
      if (entry.operations.get(requestId) === operation) entry.operations.delete(requestId);
      operation.finish();
    }
  }

  async disposeTask(value) {
    this.#assertActive();
    const input = normalizeDisposeTask(value);
    const entry = this.#entries.get(input.botId);
    if (!entry) return;
    const operations = [...entry.operations.values()]
      .filter((operation) => operation.taskId === input.taskId);
    for (const operation of operations) operation.cancelled = true;
    this.#permissionBroker.cancelTask(input);
    await entry.protocol.cancelTask(input.taskId);
    await Promise.all(operations.map((operation) => operation.done));
  }

  async close(botId) {
    const normalizedBotId = normalizeBotId(botId);
    this.#assertBotAvailable(normalizedBotId);
    const cleanupSnapshot = this.#cleanupByBot.get(normalizedBotId) || null;
    const current = this.#entries.get(normalizedBotId);
    if (current) current.closeRequested = true;
    return this.#enqueue(normalizedBotId, async () => {
      if (cleanupSnapshot) await cleanupSnapshot;
      const currentCleanup = this.#cleanupByBot.get(normalizedBotId);
      if (currentCleanup && currentCleanup !== cleanupSnapshot) await currentCleanup;
      this.#assertBotAvailable(normalizedBotId);
      const entry = this.#entries.get(normalizedBotId);
      if (entry) await this.#closeEntry(entry, true);
      else this.#permissionBroker.cancelBot(normalizedBotId);
    });
  }

  deleteBot(value) {
    let request;
    let state;
    try {
      this.#assertActive();
      request = normalizeDeleteBot(value);
      state = this.#deletions.get(request.botId);
      if (state) {
        if (!request.legacy && state.localProfileId !== request.localProfileId) {
          throw cleanupRefusedError();
        }
        if (state.completed) return state.completedPromise;
        if (state.inFlight) return state.inFlight;
      } else {
        let identity = request;
        if (request.legacy) {
          const profile = this.#profiles.get(request.botId);
          if (profile) {
            const target = normalizeTargetId(profile.targetId);
            identity = {
              ...request,
              localProfileId: target.targetId,
              profileUuid: target.uuid,
            };
          }
        }
        if (identity.localProfileId !== null) {
          this.#claimProfile(identity.botId, identity.localProfileId);
        }
        state = {
          botId: identity.botId,
          localProfileId: identity.localProfileId,
          profileUuid: identity.profileUuid,
          completed: false,
          completedPromise: null,
          inFlight: null,
        };
        this.#deletions.set(request.botId, state);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const olderQueue = this.#queues.get(request.botId) || null;
    const cleanupSnapshot = this.#cleanupByBot.get(request.botId) || null;
    const attempt = this.#deleteBotAttempt(state, olderQueue, cleanupSnapshot);
    let shared;
    shared = attempt.then((result) => {
      state.completed = true;
      state.completedPromise = shared;
      return result;
    }).finally(() => {
      if (state.inFlight === shared) state.inFlight = null;
    });
    state.inFlight = shared;
    return shared;
  }

  async #deleteBotAttempt(state, olderQueue, cleanupSnapshot) {
    try {
      if (olderQueue) await Promise.allSettled([olderQueue]);
      if (cleanupSnapshot) await Promise.allSettled([cleanupSnapshot]);
      const currentCleanup = this.#cleanupByBot.get(state.botId);
      if (currentCleanup && currentCleanup !== cleanupSnapshot) {
        await Promise.allSettled([currentCleanup]);
      }
      this.#assertDeletionActive(state);
      const cleanup = this.#deletionCleanupIdentity(state);
      if (cleanup) await this.#inspectDeletionPath(cleanup.profilePath);
      this.#assertDeletionActive(state);

      const entry = this.#entries.get(state.botId);
      if (entry) await this.#closeEntry(entry, true);
      this.#assertDeletionActive(state);
      await this.#permissionBroker.deleteBot(state.botId);
      this.#assertDeletionActive(state);

      if (cleanup) {
        const browserSession = this.#electron.session.fromPartition(cleanup.partition);
        if (!browserSession || typeof browserSession.clearStorageData !== "function") {
          throw cleanupFailedError();
        }
        await browserSession.clearStorageData();
        this.#assertDeletionActive(state);
        const inspected = await this.#inspectDeletionPath(cleanup.profilePath);
        this.#assertDeletionActive(state);
        if (inspected) {
          await removeBoundProfile(inspected);
          await this.#verifyDeletionResult(inspected);
        }
        this.#assertDeletionActive(state);
      }

      const profile = this.#profiles.get(state.botId);
      if (profile && (!cleanup || profile === cleanup.cachedProfile)) {
        this.#profiles.delete(state.botId);
      }
    } catch (error) {
      if (error instanceof LocalDesktopError) throw error;
      this.#assertDeletionActive(state);
      throw cleanupFailedError();
    }
  }

  #deletionCleanupIdentity(state) {
    const entry = this.#entries.get(state.botId) || null;
    const profile = this.#profiles.get(state.botId) || null;
    if (state.localProfileId === null) {
      if (entry || profile) throw cleanupRefusedError();
      return null;
    }
    const claimedOwner = this.#profileOwner(state.localProfileId);
    if (claimedOwner !== null && claimedOwner !== state.botId) throw cleanupRefusedError();
    const root = path.join(this.#userDataPath, "openbot-local");
    const profilePath = path.join(root, state.profileUuid);
    const workspacePath = path.join(profilePath, "workspace");
    const partition = `persist:openbot-local-${state.profileUuid}`;
    if (path.dirname(profilePath) !== root || path.basename(profilePath) !== state.profileUuid) {
      throw cleanupRefusedError();
    }
    for (const cached of [entry, profile]) {
      if (!cached) continue;
      if (cached.botId !== state.botId
        || cached.targetId !== state.localProfileId
        || cached.profileUuid !== state.profileUuid
        || cached.partition !== partition
        || cached.profilePath !== profilePath
        || cached.workspacePath !== workspacePath) {
        throw cleanupRefusedError();
      }
    }
    return { cachedProfile: profile, partition, profilePath };
  }

  async #inspectDeletionPath(profilePath) {
    const root = path.join(this.#userDataPath, "openbot-local");
    let rootStat;
    try {
      rootStat = await fs.lstat(root, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || rootStat.uid !== BigInt(process.getuid()) || (rootStat.mode & 0o777n) !== 0o700n) {
      throw cleanupRefusedError();
    }
    let profileStat;
    try {
      profileStat = await fs.lstat(profilePath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()
      || profileStat.uid !== BigInt(process.getuid()) || (profileStat.mode & 0o777n) !== 0o700n) {
      throw cleanupRefusedError();
    }
    return {
      root,
      rootIdentity: directoryIdentity(rootStat),
      profileIdentity: directoryIdentity(profileStat),
      profilePath,
      profileUuid: path.basename(profilePath),
    };
  }

  async #verifyDeletionResult(inspection) {
    let rootStat;
    try {
      rootStat = await fs.lstat(inspection.root, { bigint: true });
    } catch {
      throw cleanupRefusedError();
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || directoryIdentity(rootStat) !== inspection.rootIdentity) {
      throw cleanupRefusedError();
    }
    try {
      await fs.lstat(inspection.profilePath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw cleanupRefusedError();
    }
    throw cleanupRefusedError();
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    const deletions = [...this.#deletions.values()]
      .map((state) => state.inFlight)
      .filter((operation) => operation && typeof operation.then === "function");
    const queues = [...this.#queues.values()];
    const cleanups = [...this.#cleanupByBot.values()];
    this.#disposed = true;
    const entries = [...this.#entries.values()];
    this.#disposePromise = (async () => {
      await Promise.allSettled([
        ...entries.map((entry) => this.#closeEntry(entry, true)),
        ...deletions,
        ...queues,
        ...cleanups,
      ]);
      await Promise.allSettled(
        [...this.#entries.values()].map((entry) => this.#closeEntry(entry, true)),
      );
      await Promise.allSettled([...this.#cleanupByBot.values()]);
      this.#entries.clear();
      this.#queues.clear();
      this.#cleanupByBot.clear();
      this.#profileOwners.clear();
      this.removeAllListeners();
    })();
    return this.#disposePromise;
  }

  #sameIdentity(entry, identity) {
    return entry.botId === identity.botId
      && entry.targetId === identity.targetId
      && entry.targetGeneration === identity.targetGeneration;
  }

  #requiredEntry(identity, expected = null) {
    this.#assertBotAvailable(identity.botId);
    const entry = this.#entries.get(identity.botId);
    if (!entry || (expected && entry !== expected) || entry.fenced || entry.closeRequested
      || !this.#sameIdentity(entry, identity)
      || entry.window.isDestroyed?.()) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    return entry;
  }

  #requiredInputEntry(input, expected = null) {
    let entry;
    try {
      entry = this.#requiredEntry(input, expected);
    } catch (error) {
      if (error?.code === "OPENBOT_LOCAL_BOT_DELETING"
        || error?.code === "OPENBOT_LOCAL_DESKTOP_DISPOSED") throw error;
      throw inputError("Local Desktop input is stale.", "OPENBOT_LOCAL_INPUT_STALE");
    }
    if (entry.sessionGeneration !== input.sessionGeneration
      || entry.pageGeneration !== input.pageGeneration
      || entry.frameSequence !== input.frameSequence
      || entry.lastFrameId !== input.frameId
      || input.inputSequence <= entry.inputSequence) {
      throw inputError("Local Desktop input is stale.", "OPENBOT_LOCAL_INPUT_STALE");
    }
    return entry;
  }

  #recordFrame(entry, bytes) {
    const frameId = `frame-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const frameSequence = entry.frameSequence + 1;
    if (!Number.isSafeInteger(frameSequence)) {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    entry.frameSequence = frameSequence;
    entry.lastFrameId = frameId;
    return frameSequence;
  }

  async #runNavigationWithDeadline(entry, operation) {
    let timer = null;
    let timedOut = false;
    let rejectTimeout;
    const timeoutError = desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
    const timeoutPromise = new Promise((_resolve, reject) => { rejectTimeout = reject; });
    const deadline = Object.freeze({
      promise: timeoutPromise,
      race: (value) => Promise.race([Promise.resolve(value), timeoutPromise]),
    });
    timer = setTimeout(() => {
      timedOut = true;
      rejectTimeout(timeoutError);
    }, this.#navigationTimeoutMs);
    timer.unref?.();
    try {
      return await deadline.race(Promise.resolve().then(() => operation(deadline)));
    } catch (error) {
      if (timedOut) {
        entry.fenced = true;
        entry.closeRequested = true;
        await Promise.allSettled([this.#closeEntry(entry, true)]);
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async #beginNavigation(entry, deadline = null) {
    this.#requiredEntry({
      botId: entry.botId,
      targetId: entry.targetId,
      targetGeneration: entry.targetGeneration,
    }, entry);
    if (entry.navigationPending) return;
    entry.navigationPending = true;
    const nextPageGeneration = entry.pageGeneration + 1;
    if (!Number.isSafeInteger(nextPageGeneration)) {
      throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
    }
    entry.pageGeneration = nextPageGeneration;
    entry.lastFrameId = null;
    try {
      const release = this.#releaseHeldInputs(entry, deadline);
      await (deadline ? deadline.race(release) : release);
    } catch (error) {
      entry.fenced = true;
      entry.closeRequested = true;
      await Promise.allSettled([this.#closeEntry(entry, true)]);
      throw error;
    }
    this.#requiredEntry({
      botId: entry.botId,
      targetId: entry.targetId,
      targetGeneration: entry.targetGeneration,
    }, entry);
  }

  #bindNavigation(entry) {
    const webContents = entry.window.webContents;
    if (!webContents || typeof webContents.on !== "function") return;
    const onStart = (...args) => {
      let isMainFrame = true;
      if (typeof args[3] === "boolean") isMainFrame = args[3];
      else if (typeof args[0]?.isMainFrame === "boolean") isMainFrame = args[0].isMainFrame;
      if (!isMainFrame || entry.closePromise || entry.fenced) return;
      if (entry.navigationPending) {
        entry.navigationPending = false;
        return;
      }
      void this.#runNavigationWithDeadline(entry, (deadline) => this.#beginNavigation(entry, deadline))
        .catch(() => {})
        .finally(() => {
          if (!entry.closePromise) entry.navigationPending = false;
        });
    };
    webContents.on("did-start-navigation", onStart);
    entry.navigationListeners.push(["did-start-navigation", onStart]);
  }

  #awaitHistoryNavigation(entry, navigation, expectedPageGeneration, deadline) {
    const webContents = entry.window.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        try { webContents.off?.("did-start-navigation", onStart); } catch {}
        try { webContents.off?.("did-navigate", onNavigate); } catch {}
        try { webContents.off?.("did-navigate-in-page", onNavigateInPage); } catch {}
        try { webContents.off?.("did-fail-load", onFail); } catch {}
        try { webContents.off?.("destroyed", onDestroyed); } catch {}
        if (error) reject(error);
        else resolve();
      };
      const onStart = (...args) => {
        const isMainFrame = typeof args[3] === "boolean"
          ? args[3]
          : typeof args[0]?.isMainFrame === "boolean" ? args[0].isMainFrame : true;
        if (isMainFrame) started = true;
      };
      const completeNavigation = () => {
        if (!started) return;
        queueMicrotask(() => {
          try {
            this.#requiredEntry({
              botId: entry.botId,
              targetId: entry.targetId,
              targetGeneration: entry.targetGeneration,
            }, entry);
            if (entry.pageGeneration !== expectedPageGeneration) {
              finish(desktopError("Local navigation is stale.", "OPENBOT_LOCAL_NAVIGATION_STALE"));
              return;
            }
            finish();
          } catch (error) {
            finish(error instanceof LocalDesktopError
              ? error
              : desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED"));
          }
        });
      };
      const onNavigate = () => completeNavigation();
      const onNavigateInPage = (...args) => {
        const isMainFrame = typeof args[2] === "boolean" ? args[2] : false;
        if (isMainFrame) completeNavigation();
      };
      const onFail = (...args) => {
        const isMainFrame = typeof args[4] === "boolean" ? args[4] : true;
        if (isMainFrame) finish(desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED"));
      };
      const onDestroyed = () => finish(desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED"));
      webContents.on("did-start-navigation", onStart);
      webContents.on("did-navigate", onNavigate);
      webContents.on("did-navigate-in-page", onNavigateInPage);
      webContents.on("did-fail-load", onFail);
      webContents.on("destroyed", onDestroyed);
      void deadline.promise.catch((error) => finish(error));
      try {
        const result = navigation.call(webContents);
        if (result && typeof result.then === "function") {
          void Promise.resolve(result).catch(() => {
            finish(desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED"));
          });
        }
      } catch {
        finish(desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED"));
      }
    });
  }

  #unbindNavigation(entry) {
    const webContents = entry.window?.webContents;
    for (const [eventName, listener] of entry.navigationListeners || []) {
      try { webContents?.off?.(eventName, listener); } catch {}
    }
    entry.navigationListeners = [];
  }

  async #attachDebugger(entry) {
    if (entry.debuggerAttachPromise) return entry.debuggerAttachPromise;
    if (entry.debuggerClient) return entry.debuggerClient;
    let attachPromise;
    attachPromise = (async () => {
      let client;
      try {
        client = this.#debuggerFactory
          ? await this.#debuggerFactory(entry.window.webContents, Object.freeze({
            botId: entry.botId,
            targetId: entry.targetId,
            targetGeneration: entry.targetGeneration,
          }))
          : entry.window.webContents.debugger;
      } catch {
        throw desktopError("Local Desktop debugger is unavailable.", "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
      }
      if (client === undefined || client === null) {
        if (this.#debuggerFactory) {
          throw desktopError("Local Desktop debugger is unavailable.", "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
        }
        return null;
      }
      if (typeof client.attach !== "function" || typeof client.sendCommand !== "function"
        || typeof client.on !== "function" || typeof client.off !== "function") {
        throw desktopError("Local Desktop debugger is unavailable.", "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
      }
      const onDetach = () => {
        entry.debuggerDetached = true;
        entry.fenced = true;
        entry.closeRequested = true;
        try { void Promise.resolve(this.#closeEntry(entry, true)).catch(() => {}); } catch {}
      };
      entry.debuggerClient = client;
      entry.debuggerDetachListener = onDetach;
      try { client.on?.("detach", onDetach); } catch {
        entry.debuggerClient = null;
        entry.debuggerDetachListener = null;
        throw desktopError("Local Desktop debugger is unavailable.", "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
      }
      if (entry.closeRequested || entry.closePromise || this.#entries.get(entry.botId) !== entry) {
        throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
      }
      try {
        if (!debuggerIsAttached(client)) await client.attach(CDP_DEBUGGER_VERSION);
      } catch (error) {
        if (error instanceof LocalDesktopError) throw error;
        throw desktopError("Local Desktop debugger is unavailable.", "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
      }
      if (entry.debuggerDetached) {
        throw desktopError("Local Desktop debugger is detached.", "OPENBOT_LOCAL_DEBUGGER_DETACHED");
      }
      if (entry.closeRequested || entry.closePromise || this.#entries.get(entry.botId) !== entry) {
        throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
      }
      return client;
    })();
    entry.debuggerAttachPromise = attachPromise;
    try {
      return await attachPromise;
    } finally {
      if (entry.debuggerAttachPromise === attachPromise) entry.debuggerAttachPromise = null;
    }
  }

  async #ensureDebugger(entry) {
    const client = await this.#attachDebugger(entry);
    if (!client || typeof client.sendCommand !== "function") {
      throw desktopError("Local Desktop debugger is unavailable.", "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
    }
    if (!debuggerIsAttached(client)) {
      throw desktopError("Local Desktop debugger is detached.", "OPENBOT_LOCAL_DEBUGGER_DETACHED");
    }
    return client;
  }

  async #sendCdpCommand(entry, method, params) {
    if (!CDP_INPUT_METHODS.has(method)) {
      throw desktopError("Local Desktop input command is not allowed.", "OPENBOT_LOCAL_INPUT_INVALID");
    }
    const client = await this.#ensureDebugger(entry);
    if (entry.fenced || entry.closeRequested || entry.closePromise
      || this.#entries.get(entry.botId) !== entry || entry.window.isDestroyed?.()) {
      throw desktopError(
        "Local Desktop debugger is detached.",
        entry.debuggerDetached ? "OPENBOT_LOCAL_DEBUGGER_DETACHED" : "OPENBOT_LOCAL_DESKTOP_STALE",
      );
    }
    try {
      return await client.sendCommand(method, params);
    } catch {
      entry.fenced = true;
      entry.closeRequested = true;
      try { await this.#closeEntry(entry, true); } catch {}
      throw desktopError("Local Desktop debugger is detached.", "OPENBOT_LOCAL_DEBUGGER_DETACHED");
    }
  }

  async #releaseHeldInputs(entry, deadline = null) {
    if (entry.releasePromise) return entry.releasePromise;
    const releasePromise = Promise.resolve().then(async () => {
      const buttons = [...(entry.heldButtons || [])];
      const keys = [...(entry.heldKeys?.entries?.() || [])];
      if (buttons.length === 0 && keys.length === 0) return;
      const client = entry.debuggerClient;
      if (!client || !debuggerIsAttached(client) || typeof client.sendCommand !== "function") {
        entry.releaseFailed = true;
        throw desktopError("Local Desktop held input could not be released.", "OPENBOT_LOCAL_INPUT_RELEASE_FAILED");
      }
      let failed = false;
      const pointer = entry.lastPointer || { x: 0, y: 0 };
      for (const button of buttons) {
        try {
          const release = client.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: pointer.x,
            y: pointer.y,
            button,
            buttons: 0,
          });
          await (deadline ? deadline.race(release) : release);
          entry.heldButtons?.delete(button);
        } catch { failed = true; }
      }
      for (const [id, key] of keys) {
        try {
          const release = client.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            ...key,
          });
          await (deadline ? deadline.race(release) : release);
          entry.heldKeys?.delete(id);
        } catch { failed = true; }
      }
      if (failed) {
        entry.releaseFailed = true;
        throw desktopError("Local Desktop held input could not be released.", "OPENBOT_LOCAL_INPUT_RELEASE_FAILED");
      }
    });
    entry.releasePromise = releasePromise;
    try {
      return await releasePromise;
    } finally {
      if (entry.releasePromise === releasePromise) entry.releasePromise = null;
    }
  }

  async #detachDebugger(entry) {
    const client = entry.debuggerClient;
    const listener = entry.debuggerDetachListener;
    entry.debuggerDetachListener = null;
    entry.debuggerClient = null;
    try { client?.off?.("detach", listener); } catch {}
    if (!client || typeof client.detach !== "function" || !debuggerIsAttached(client)) return;
    try { await client.detach(); } catch {}
  }

  #assertOperationActive(entry, identity, operation) {
    this.#requiredEntry(identity, entry);
    if (operation.cancelled || entry.operations.get(operation.requestId) !== operation) {
      throw desktopError("Local Desktop task was cancelled.", "OPENBOT_LOCAL_TASK_CANCELLED");
    }
  }

  #assertBotAvailable(botId) {
    this.#assertActive();
    if (this.#deletions.has(botId)) throw botDeletingError();
  }

  async #assertCurrentComputer(expected) {
    this.#assertBotAvailable(expected.botId);
    let value;
    try {
      value = await this.#readCurrentComputer(expected.botId);
    } catch {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    this.#assertBotAvailable(expected.botId);
    let current;
    try {
      current = normalizeComputer(value, { allowStarting: true });
    } catch {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    if (!this.#sameIdentity(expected, current)) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    return current;
  }

  #assertReusableEntry(entry, expected) {
    this.#assertBotAvailable(expected.botId);
    let destroyed = false;
    try { destroyed = Boolean(entry.window.isDestroyed?.()); } catch { destroyed = true; }
    if (this.#entries.get(expected.botId) !== entry || entry.closePromise || entry.closeRequested || destroyed
      || !this.#sameIdentity(entry, expected)) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
  }

  #profileOwner(targetId) {
    const claimed = this.#profileOwners.get(targetId);
    if (claimed) return claimed;
    for (const collection of [this.#entries, this.#profiles]) {
      for (const [botId, value] of collection) {
        if (value?.targetId !== targetId) continue;
        this.#profileOwners.set(targetId, botId);
        return botId;
      }
    }
    return null;
  }

  #claimProfile(botId, targetId) {
    const owner = this.#profileOwner(targetId);
    if (owner !== null && owner !== botId) throw cleanupRefusedError();
    this.#profileOwners.set(targetId, botId);
  }

  #assertDeletionActive(state) {
    if (this.#deletions.get(state.botId) !== state) throw cleanupRefusedError();
  }

  #closeEntry(entry, cancelPermissions) {
    if (entry.closePromise) return entry.closePromise;
    entry.fenced = true;
    entry.closeRequested = true;
    if (this.#entries.get(entry.botId) === entry) this.#entries.delete(entry.botId);
    this.#unbindNavigation(entry);
    try { entry.unsubscribeHelperExit?.(); } catch {}
    entry.unsubscribeHelperExit = null;
    for (const operation of entry.operations.values()) operation.cancelled = true;
    let resolveClose;
    let rejectClose;
    const closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    entry.closePromise = closePromise;
    this.#cleanupByBot.set(entry.botId, closePromise);
    void closePromise.then(() => {
      if (this.#cleanupByBot.get(entry.botId) === closePromise) this.#cleanupByBot.delete(entry.botId);
    }, () => {
      if (this.#cleanupByBot.get(entry.botId) === closePromise) this.#cleanupByBot.delete(entry.botId);
    });
    if (cancelPermissions) {
      try { this.#permissionBroker.cancelBot(entry.botId); } catch {}
    }
    void (async () => {
      let releaseError = null;
      const attachPromise = entry.debuggerAttachPromise;
      if (attachPromise) await Promise.allSettled([attachPromise]);
      if (!entry.releaseFailed) {
        try { await this.#releaseHeldInputs(entry); } catch (error) { releaseError = error; }
      }
      await this.#detachDebugger(entry);
      try { await entry.protocol.dispose(); } catch {}
      await Promise.all([...entry.operations.values()].map((operation) => operation.done));
      try { if (!entry.window.isDestroyed?.()) entry.window.destroy(); } catch {}
      entry.heldButtons?.clear();
      entry.heldKeys?.clear();
      if (releaseError) throw releaseError;
    })().then(resolveClose, rejectClose);
    return closePromise;
  }

  async #ensureProfile(uuid) {
    const root = path.join(this.#userDataPath, "openbot-local");
    const profilePath = path.join(root, uuid);
    const workspacePath = path.join(profilePath, "workspace");
    for (const directory of [root, profilePath, workspacePath]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw desktopError("Local workspace must be a private real directory.", "OPENBOT_LOCAL_WORKSPACE_UNSAFE");
      }
      await fs.chmod(directory, 0o700);
    }
    return { profilePath, workspacePath };
  }

  #secureSession(browserSession) {
    if (!browserSession || typeof browserSession.setPermissionRequestHandler !== "function"
      || typeof browserSession.setPermissionCheckHandler !== "function") {
      throw desktopError("Local browser session is unavailable.", "OPENBOT_LOCAL_BROWSER_UNAVAILABLE");
    }
    if (SECURED_BROWSER_SESSIONS.has(browserSession)) return;
    SECURED_BROWSER_SESSIONS.add(browserSession);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setDevicePermissionHandler?.(() => false);
    browserSession.on?.("will-download", (event) => event.preventDefault?.());
  }

  #secureWindow(window) {
    if (!window?.webContents || typeof window.webContents.setWindowOpenHandler !== "function"
      || typeof window.webContents.loadURL !== "function" || typeof window.webContents.getURL !== "function"
      || typeof window.webContents.capturePage !== "function") {
      throw desktopError("Local browser window is unavailable.", "OPENBOT_LOCAL_BROWSER_UNAVAILABLE");
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on?.("will-navigate", (event, url) => {
      try { safeHttpsUrl(url); } catch { event.preventDefault?.(); }
    });
    window.webContents.on?.("will-redirect", (event, url) => {
      try { safeHttpsUrl(url); } catch { event.preventDefault?.(); }
    });
  }

  async #captureCurrentImage(identity, expected) {
    this.#requiredEntry(identity, expected);
    const pageGeneration = expected.pageGeneration;
    this.#assertCaptureUrl(expected);
    let image;
    try { image = await expected.window.webContents.capturePage(); } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    this.#requiredEntry(identity, expected);
    if (expected.pageGeneration !== pageGeneration) {
      throw desktopError("Local Desktop frame is stale.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    this.#assertCaptureUrl(expected);
    return image;
  }

  #assertCaptureUrl(entry) {
    try { safeDisplayUrl(entry.window.webContents.getURL()); } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
  }

  #validFrameSize(size, maximumWidth, maximumHeight) {
    return Boolean(size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
      && size.width >= 1 && size.height >= 1
      && size.width <= maximumWidth && size.height <= maximumHeight);
  }

  #enqueue(botId, operation) {
    const previous = this.#queues.get(botId) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#queues.set(botId, tail);
    void tail.then(() => {
      if (this.#queues.get(botId) === tail) this.#queues.delete(botId);
    });
    return result;
  }

  #assertActive() {
    if (this.#disposed) {
      throw desktopError("Local Desktop manager is disposed.", "OPENBOT_LOCAL_DESKTOP_DISPOSED");
    }
  }
}

module.exports = {
  LOCAL_DESKTOP_START_HTML,
  LOCAL_DESKTOP_START_URL,
  SURFACE_CSS_WIDTH,
  SURFACE_CSS_HEIGHT,
  PREVIEW_FRAME_WIDTH,
  PREVIEW_FRAME_HEIGHT,
  PREVIEW_FRAME_INTERVAL_MS,
  INTERACTIVE_FRAME_WIDTH,
  INTERACTIVE_FRAME_HEIGHT,
  CDP_DEBUGGER_VERSION,
  LocalDesktopError,
  LocalDesktopManager,
  safeDisplayUrl,
};
