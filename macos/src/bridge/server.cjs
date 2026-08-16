"use strict";

const { CodexClient, BridgeDisposedError } = require("./codex-client.cjs");
const { InferenceSocketClient } = require("./inference-socket-client.cjs");
const { loadRuntimeConfig } = require("./runtime-config.cjs");

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

class BridgeSessionError extends Error {
  constructor() {
    super("Codex bridge session is invalid.");
    this.name = "BridgeSessionError";
    this.code = "CODEX_BRIDGE_SESSION_INVALID";
  }
}

function sessionOptions(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeSessionError();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new BridgeSessionError();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BridgeSessionError();
  }
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !("value" in descriptor) ||
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function",
    )
  ) {
    throw new BridgeSessionError();
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function nativeSessionIdentity(options) {
  if (typeof options.conversationId !== "string" || !SESSION_ID.test(options.conversationId)
    || options.conversationId.includes("..")
    || typeof options.taskId !== "string" || !SESSION_ID.test(options.taskId)
    || options.taskId.includes("..")) {
    throw new BridgeSessionError();
  }
  return Object.freeze({
    conversationId: options.conversationId,
    taskId: options.taskId,
  });
}

function sameConfig(left, right) {
  return (
    right != null &&
    left.botId === right.botId &&
    left.generation === right.generation &&
    left.provider === right.provider &&
    left.endpoint === right.endpoint &&
    left.credential === right.credential &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier
  );
}

class PromptExecutor {
  #client;
  #messages;

  constructor(client, state) {
    this.#client = client;
    this.#messages = Array.isArray(state) ? [...state] : state == null ? [] : [state];
  }

  appendMessages(messages) {
    this.#messages.push(...(Array.isArray(messages) ? messages : [messages]));
    return this;
  }

  getState() {
    return [...this.#messages];
  }

  getMessages() {
    return [...this.#messages];
  }

  clearMessages() {
    this.#messages = [];
  }

  stream(context, invocationId, tools, options = {}) {
    return this.#client.stream({
      messages: this.#messages,
      tools,
      toolChoice: options?.toolChoice,
      invocationId,
      signal: context?.signal,
    });
  }
}

class PromptSession {
  #client;
  #config;
  #middleware;
  #release;
  #disposed = false;

  constructor(client, config, middleware, release) {
    this.#client = client;
    this.#config = config;
    this.#middleware = middleware;
    this.#release = release;
  }

  getExecutor(state) {
    const executor = new PromptExecutor(this.#client, state);
    return this.#middleware ? this.#middleware(executor) : executor;
  }

  getModelId() {
    return this.#config.model;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#client.dispose();
    this.#release();
  }
}

function createBridge({
  loadConfig = (options) => loadRuntimeConfig(process.env, options),
  fetchImpl = globalThis.fetch,
  isCurrent,
  SocketClientClass = InferenceSocketClient,
} = {}) {
  if (typeof loadConfig !== "function" || typeof fetchImpl !== "function"
    || typeof SocketClientClass !== "function") {
    throw new BridgeSessionError();
  }
  let disposed = false;
  const sessions = new Set();

  const bridge = {
    createPromptSession(options, middleware) {
      if (disposed) throw new BridgeDisposedError();
      const normalized = sessionOptions(options);
      const config = loadConfig(normalized);
      const requestedBotId = normalized.botId;
      if (requestedBotId != null && requestedBotId !== config.botId) {
        throw new BridgeSessionError();
      }
      if (
        normalized.modelId != null &&
        normalized.modelId !== config.model
      ) {
        throw new BridgeSessionError();
      }
      if (middleware != null && typeof middleware !== "function") {
        throw new BridgeSessionError();
      }
      const current =
        typeof isCurrent === "function"
          ? () => isCurrent(config)
          : () => {
              try {
                return sameConfig(config, loadConfig(normalized));
              } catch {
                return false;
              }
            };
      let client;
      if (config.provider == null) {
        client = new CodexClient({ config, fetchImpl, isCurrent: current });
      } else {
        const identity = nativeSessionIdentity(normalized);
        client = new SocketClientClass({
          config,
          conversationId: identity.conversationId,
          taskId: identity.taskId,
          isCurrent: current,
        });
      }
      let session;
      session = new PromptSession(client, config, middleware, () => sessions.delete(session));
      sessions.add(session);
      return session;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const session of sessions) session.dispose();
      sessions.clear();
    },
  };
  return Object.freeze(bridge);
}

const defaultBridge = createBridge();

module.exports = {
  BridgeSessionError,
  createBridge,
  createPromptSession: defaultBridge.createPromptSession,
  dispose: defaultBridge.dispose,
};
