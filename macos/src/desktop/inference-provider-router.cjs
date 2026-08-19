"use strict";

const { types } = require("node:util");
const {
  PROVIDER_IDS,
  canonicalProviderId,
  providerDescriptor,
} = require("../provider-descriptors.cjs");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_TIER = /^[a-z][a-z0-9_-]{0,31}$/;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORKSPACE_ID = /^workspace-[a-f0-9]{64}$/;
const PROVIDERS = new Set(PROVIDER_IDS);
const DYNAMIC_CATALOG_PROVIDERS = new Set([
  "openai-codex", "openai-api-key", "local-openai-compatible",
]);
const REQUEST_KEYS = new Set([
  "selection",
  "conversationId",
  "messages",
  "tools",
  "toolChoice",
  "invocationId",
  "signal",
  "workspaceId",
]);
const SELECTION_KEYS = new Set([
  "botId",
  "generation",
  "provider",
  "model",
  "reasoningEffort",
  "serviceTier",
]);

class InferenceProviderError extends Error {
  constructor(code = "CODEX_INFERENCE_UNAVAILABLE", message = "Codex inference is unavailable.") {
    super(message);
    this.name = "InferenceProviderError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function inferenceError(code, message) {
  return new InferenceProviderError(code, message);
}

function ownData(value, allowed, code = "CODEX_INFERENCE_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw inferenceError(code, "Codex inference request is invalid.");
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw inferenceError(code, "Codex inference request is invalid.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw inferenceError(code, "Codex inference request is invalid.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !allowed.has(key) ||
        !("value" in descriptors[key]),
    )
  ) {
    throw inferenceError(code, "Codex inference request is invalid.");
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function normalizeSelection(value) {
  const raw = ownData(value, SELECTION_KEYS);
  let provider;
  if (
    Object.keys(raw).length !== SELECTION_KEYS.size ||
    typeof raw.botId !== "string" ||
    !BOT_ID.test(raw.botId) ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 0 ||
    typeof raw.provider !== "string" ||
    typeof raw.model !== "string" ||
    !MODEL_ID.test(raw.model) ||
    typeof raw.reasoningEffort !== "string" ||
    !EFFORT.test(raw.reasoningEffort) ||
    !(raw.serviceTier === null ||
      (typeof raw.serviceTier === "string" && SERVICE_TIER.test(raw.serviceTier)))
  ) {
    throw inferenceError("CODEX_INFERENCE_INVALID", "Codex inference request is invalid.");
  }
  try { provider = canonicalProviderId(raw.provider); } catch {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  if (!PROVIDERS.has(provider)) {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  let descriptor;
  try { descriptor = providerDescriptor(provider); } catch {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  if (!DYNAMIC_CATALOG_PROVIDERS.has(provider)
    && !descriptor.models.some(({ id }) => id === raw.model)) {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  const reasoningSupported = descriptor.reasoningEfforts.includes(raw.reasoningEffort)
    || (provider === "openai-codex" && raw.reasoningEffort === "ultra")
    || (provider === "openai-api-key" && raw.reasoningEffort === "ultra")
    || (provider === "anthropic-claude" && raw.reasoningEffort === "ultra-code");
  if (!reasoningSupported
    || (raw.reasoningEffort === "ultra-code" && provider !== "anthropic-claude")
    || (raw.serviceTier !== null && descriptor.fastModeSupported !== true)) {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  return Object.freeze({
    botId: raw.botId,
    generation: raw.generation,
    provider,
    model: raw.model,
    reasoningEffort: raw.reasoningEffort,
    serviceTier: raw.serviceTier,
  });
}

function sameSelection(left, right) {
  return right != null &&
    left.botId === right.botId &&
    left.generation === right.generation &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier;
}

function transport(value) {
  return value && typeof value === "object" && !types.isProxy(value) && typeof value.stream === "function";
}

function descriptorValue(value, provider) {
  let descriptor;
  try { descriptor = value(provider); } catch {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  if (!descriptor || typeof descriptor !== "object" || types.isProxy(descriptor)) {
    throw inferenceError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  return descriptor;
}

class InferenceProviderRouter {
  #readSelection;
  #directTransport;
  #createOptionalTransport;
  #transportForProvider;
  #descriptorForProvider;
  #legacyFactory = false;
  #optional = new Map();
  #disposed = false;

  constructor(rawOptions = {}) {
    const options = ownData(rawOptions, new Set([
      "readSelection", "directTransport", "createOptionalTransport",
      "transportForProvider", "descriptorForProvider",
    ]));
    const legacy = options.transportForProvider === undefined;
    if (typeof options.readSelection !== "function"
      || (legacy && (!transport(options.directTransport) || typeof options.createOptionalTransport !== "function"))
      || (!legacy && typeof options.transportForProvider !== "function")
      || (options.descriptorForProvider !== undefined && typeof options.descriptorForProvider !== "function")) {
      throw inferenceError("CODEX_INFERENCE_INVALID", "Codex inference router is invalid.");
    }
    this.#readSelection = options.readSelection;
    this.#directTransport = options.directTransport || null;
    this.#createOptionalTransport = options.createOptionalTransport || null;
    this.#descriptorForProvider = options.descriptorForProvider || providerDescriptor;
    this.#legacyFactory = legacy;
    this.#transportForProvider = options.transportForProvider || (async (provider) => {
      if (provider === "openai-codex") return this.#directTransport;
      return this.#optionalTransport(provider);
    });
  }

  async stream(rawRequest) {
    if (this.#disposed) {
      throw inferenceError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    }
    const request = ownData(rawRequest, REQUEST_KEYS);
    if (
      Object.keys(request).some((key) => !REQUEST_KEYS.has(key)) ||
      !("selection" in request) ||
      typeof request.conversationId !== "string" ||
      !CONVERSATION_ID.test(request.conversationId) ||
      !Array.isArray(request.messages) ||
      !Array.isArray(request.tools) ||
      typeof request.invocationId !== "string" ||
      !INVOCATION_ID.test(request.invocationId) ||
      !(request.workspaceId === undefined || (typeof request.workspaceId === "string"
        && WORKSPACE_ID.test(request.workspaceId)))
    ) {
      throw inferenceError("CODEX_INFERENCE_INVALID", "Codex inference request is invalid.");
    }
    const selected = normalizeSelection(request.selection);
    await this.#assertCurrent(selected);
    const descriptor = descriptorValue(this.#descriptorForProvider, selected.provider);
    const reasoningEfforts = Array.isArray(descriptor.reasoningEfforts)
      ? descriptor.reasoningEfforts : [];
    const upstreamReasoning = selected.reasoningEffort === "ultra-code"
      && selected.provider === "anthropic-claude"
      ? descriptor.reasoningMap?.[selected.reasoningEffort] ?? "max"
      : selected.reasoningEffort;
    const upstreamSelection = Object.freeze({
      botId: selected.botId,
      generation: selected.generation,
      provider: selected.provider,
      model: selected.model,
      serviceTier: selected.serviceTier,
      ...(reasoningEfforts.includes(selected.reasoningEffort)
        || (selected.provider === "openai-codex" && selected.reasoningEffort === "ultra")
        || (selected.provider === "anthropic-claude" && selected.reasoningEffort === "ultra-code")
        ? { reasoningEffort: upstreamReasoning } : {}),
    });
    let selectedTransport;
    try { selectedTransport = await this.#transportForProvider(selected.provider, selected); }
    catch (error) {
      if (error instanceof InferenceProviderError) throw error;
      throw inferenceError("CODEX_INFERENCE_PROVIDER_UNAVAILABLE", "Codex inference provider is unavailable.");
    }
    if (!transport(selectedTransport)) {
      throw inferenceError("CODEX_INFERENCE_PROVIDER_UNAVAILABLE", "Codex inference provider is unavailable.");
    }
    if (this.#disposed) {
      throw inferenceError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    }
    await this.#assertCurrent(selected);
    let result;
    try {
      const transportRequest = {
        selection: upstreamSelection,
        conversationId: request.conversationId,
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        invocationId: request.invocationId,
        signal: request.signal,
        assertCurrent: () => this.#assertCurrent(selected),
      };
      if (selected.provider === "openai-codex" && request.workspaceId !== undefined) {
        transportRequest.workspaceId = request.workspaceId;
      }
      result = await selectedTransport.stream(Object.freeze(transportRequest));
    } catch (error) {
      if (error instanceof InferenceProviderError) throw error;
      throw inferenceError("CODEX_INFERENCE_UNAVAILABLE", "Codex inference is unavailable.");
    }
    if (!result || typeof result !== "object" || types.isProxy(result)
      || !result.fullStream || typeof result.fullStream[Symbol.asyncIterator] !== "function") {
      throw inferenceError("CODEX_INFERENCE_UNAVAILABLE", "Codex inference is unavailable.");
    }
    return result;
  }

  async #optionalTransport(provider) {
    let flight = this.#optional.get(provider);
    if (!flight) {
      flight = Promise.resolve()
        .then(() => this.#createOptionalTransport(
          this.#legacyFactory && provider === "anthropic-claude" ? "cliproxy-anthropic" : provider,
        ))
        .then((value) => {
          if (!transport(value)) {
            throw inferenceError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
          }
          return value;
        })
        .catch((error) => {
          this.#optional.delete(provider);
          if (error instanceof InferenceProviderError) throw error;
          throw inferenceError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
        });
      this.#optional.set(provider, flight);
    }
    return flight;
  }

  async #assertCurrent(selection) {
    if (this.#disposed) {
      throw inferenceError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    }
    let current;
    try { current = normalizeSelection(await this.#readSelection(selection.botId)); }
    catch (error) {
      if (error instanceof InferenceProviderError) throw error;
      throw inferenceError("CODEX_INFERENCE_STALE", "Codex inference selection changed.");
    }
    if (this.#disposed) {
      throw inferenceError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    }
    if (!sameSelection(selection, current)) {
      throw inferenceError("CODEX_INFERENCE_STALE", "Codex inference selection changed.");
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const flight of this.#optional.values()) {
      void flight.then((value) => value.dispose?.(), () => {});
    }
    this.#optional.clear();
  }
}

module.exports = {
  InferenceProviderError,
  InferenceProviderRouter,
  normalizeInferenceSelection: normalizeSelection,
};
