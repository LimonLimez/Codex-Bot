"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const STATE_ROOT =
  process.env.CODEX_BOT_STATE_ROOT ||
  path.join(process.env.LOCALAPPDATA || __dirname, "Open Bot");
const HELPER_PATH = path.join(__dirname, "official-computer-helper.cjs");
const REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_INPUT_REQUEST_TIMEOUT_MS = 105000;
const ACTION_EXECUTION_DEADLINE_MS = 90000;
const requestedInputTimeout = Number(
  process.env.CODEX_OFFICIAL_INPUT_TIMEOUT_MS,
);
const INPUT_REQUEST_TIMEOUT_MS =
  Number.isInteger(requestedInputTimeout) &&
  requestedInputTimeout >= 25 &&
  requestedInputTimeout <= DEFAULT_INPUT_REQUEST_TIMEOUT_MS
    ? requestedInputTimeout
    : DEFAULT_INPUT_REQUEST_TIMEOUT_MS;
const MUTATING_INPUT_KINDS = new Set(["click", "drag", "type", "key"]);
const CHILD_KEY = Symbol.for("codexbot.officialComputer.child");

function helperEnvironment() {
  const keep = [
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.NODE_ENV = "production";
  env.CODEX_OFFICIAL_COMPUTER_STATE = path.join(
    STATE_ROOT,
    "official-computer",
  );
  if (process.env.GROK_BOT_BROWSER_EXECUTABLE) {
    env.CODEX_OFFICIAL_CHROME = process.env.GROK_BOT_BROWSER_EXECUTABLE;
  }
  return env;
}

function publicHelperError(value) {
  const error = new Error(
    String(value?.message || "The official-computer helper failed."),
  );
  error.name = "OfficialComputerError";
  error.code = String(value?.code || "OFFICIAL_COMPUTER_ERROR");
  const requested = Number(value?.statusCode);
  error.statusCode =
    Number.isInteger(requested) && requested >= 400 && requested < 600
      ? requested
      : 502;
  return error;
}

function childState() {
  if (!globalThis[CHILD_KEY]) {
    globalThis[CHILD_KEY] = {
      child: null,
      pending: new Map(),
      startPromise: null,
    };
  }
  return globalThis[CHILD_KEY];
}

function rejectPending(state, error) {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
}

function refChild(child) {
  child?.ref?.();
  child?.channel?.ref?.();
}

function unrefChildWhenIdle(state, child) {
  if (state.child !== child || state.startPromise || state.pending.size !== 0)
    return;
  child?.channel?.unref?.();
  child?.unref?.();
}

function terminateHelper(state, child) {
  if (state.child !== child) return;
  state.child = null;
  state.startPromise = null;
  try {
    child.kill?.();
  } catch {}
  try {
    if (child.connected) child.disconnect?.();
  } catch {}
  rejectPending(
    state,
    publicHelperError({
      code: "HELPER_EXITED",
      message:
        "The official-computer helper was restarted after an input timeout.",
      statusCode: 503,
    }),
  );
}

async function ensureChild() {
  const state = childState();
  if (state.child?.connected) return state.child;
  if (state.startPromise) return state.startPromise;
  state.startPromise = new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.fork(HELPER_PATH, [], {
        execPath: process.execPath,
        execArgv: [],
        cwd: path.dirname(HELPER_PATH),
        env: helperEnvironment(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        serialization: "advanced",
      });
    } catch (error) {
      state.startPromise = null;
      reject(error);
      return;
    }
    state.child = child;
    const failed = (cause) => {
      if (state.child !== child) return;
      state.child = null;
      state.startPromise = null;
      rejectPending(
        state,
        publicHelperError({
          code: "HELPER_EXITED",
          message: "The official-computer helper stopped.",
          statusCode: 503,
        }),
      );
      if (cause instanceof Error) reject(cause);
    };
    child.on("message", (message) => {
      const id = String(message?.id || "");
      const pending = state.pending.get(id);
      if (!pending) return;
      state.pending.delete(id);
      clearTimeout(pending.timer);
      if (message?.ok === true) pending.resolve(message.result);
      else {
        const error = publicHelperError(message?.error);
        if (
          pending.method === "input.send" &&
          ["ACTION_DEADLINE_EXCEEDED", "ACTION_OUTCOME_UNCERTAIN"].includes(
            error.code,
          )
        )
          terminateHelper(state, child);
        pending.reject(error);
      }
      unrefChildWhenIdle(state, child);
    });
    child.once("error", failed);
    child.once("exit", () => failed());
    child.once("spawn", () => {
      state.startPromise = null;
      resolve(child);
      unrefChildWhenIdle(state, child);
    });
  });
  return state.startPromise;
}

async function request(method, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const child = await ensureChild();
  const state = childState();
  refChild(child);
  const id = crypto.randomBytes(18).toString("base64url");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      const actions = Array.isArray(args?.actions) ? args.actions : [];
      const mutatingInput =
        method === "input.send" &&
        actions.some((action) =>
          MUTATING_INPUT_KINDS.has(String(action?.kind || "")),
        );
      if (method === "input.send") terminateHelper(state, child);
      reject(
        publicHelperError(
          mutatingInput
            ? {
                code: "ACTION_OUTCOME_UNCERTAIN",
                message:
                  "The official-computer helper timed out during a mutating action. Its outcome is uncertain; inspect the fresh screen before retrying.",
                statusCode: 504,
              }
            : {
                code: "HELPER_TIMEOUT",
                message: "The official-computer helper did not answer in time.",
                statusCode: 504,
              },
        ),
      );
      if (method !== "input.send") unrefChildWhenIdle(state, child);
    }, timeoutMs);
    timer.unref?.();
    state.pending.set(id, { resolve, reject, timer, method });
    child.send({ id, method, args }, (error) => {
      if (!error) return;
      const pending = state.pending.get(id);
      if (!pending) return;
      state.pending.delete(id);
      clearTimeout(timer);
      reject(error);
      unrefChildWhenIdle(state, child);
    });
  });
}

async function shutdown() {
  const state = childState();
  const child = state.child;
  if (!child?.connected) return;
  try {
    await request("shutdown", {}, 10000);
  } catch {}
  child.disconnect?.();
  state.child = null;
}

process.once("exit", () => {
  const child = childState().child;
  if (child?.connected) child.disconnect();
});

module.exports = {
  status: () => request("status"),
  startLogin: () => request("login.start"),
  cancelLogin: () => request("login.cancel"),
  logout: () => request("logout"),
  setMode: (mode, acknowledged = false) =>
    request("mode.set", { mode, acknowledged }),
  setComputerPermissions: (
    alwaysAllowComputerActions,
    acknowledged = false,
    provider = "official-grok-cloud",
  ) =>
    request("permission.set", {
      alwaysAllowComputerActions,
      acknowledged,
      provider,
    }),
  computerPermissions: () => request("permission.get"),
  captureSeat: (seatKey) => request("frame.get", { seatKey }),
  executeSeatActions: (seatKey, actions, options = {}) =>
    request(
      "input.send",
      {
        seatKey,
        actions,
        actor: options.actor === "user" ? "user" : "agent",
        controlId: String(options.controlId || ""),
        deadlineMs:
          Date.now() +
          Math.min(
            ACTION_EXECUTION_DEADLINE_MS,
            Math.max(1, INPUT_REQUEST_TIMEOUT_MS - 10),
          ),
      },
      INPUT_REQUEST_TIMEOUT_MS,
    ),
  pendingApprovalForSeat: (seatKey) => request("approval.get", { seatKey }),
  decidePendingApproval: (seatKey, decision, binding) =>
    request("approval.decide", { seatKey, decision, binding }),
  acquireUserControl: (seatKey, controlId) =>
    request("control.acquire", { seatKey, controlId }),
  heartbeatUserControl: (seatKey, controlId) =>
    request("control.heartbeat", { seatKey, controlId }),
  releaseUserControl: (seatKey, controlId) =>
    request("control.release", { seatKey, controlId }),
  controlStatusForSeat: (seatKey) => request("control.get", { seatKey }),
  closeSeatForKey: (seatKey) => request("seat.close", { seatKey }),
  shutdown,
  helperEnvironment,
  HELPER_PATH,
  ACTION_EXECUTION_DEADLINE_MS,
  INPUT_REQUEST_TIMEOUT_MS,
};
