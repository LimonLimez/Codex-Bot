"use strict";

const { types } = require("node:util");
const { CodexClient } = require("../bridge/codex-client.cjs");
const { canonicalProviderId, providerDescriptor } = require("../provider-descriptors.cjs");
const { normalizeInferenceSelection } = require("./inference-provider-router.cjs");

class OpenAICompatibleInferenceError extends Error {
  constructor(code = "CODEX_INFERENCE_UNAVAILABLE", message = "OpenAI-compatible inference is unavailable.") {
    super(message);
    this.name = "OpenAICompatibleInferenceError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function compatibleError(code, message) {
  return new OpenAICompatibleInferenceError(code, message);
}

function ownData(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw compatibleError("CODEX_INFERENCE_CONFIGURATION", "OpenAI-compatible inference configuration is invalid.");
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw compatibleError("CODEX_INFERENCE_CONFIGURATION", "OpenAI-compatible inference configuration is invalid.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !fields.has(key)
      || !("value" in descriptors[key]))
    || required.some((key) => !Object.hasOwn(descriptors, key))) {
    throw compatibleError("CODEX_INFERENCE_CONFIGURATION", "OpenAI-compatible inference configuration is invalid.");
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function connectionValues(value, providerId) {
  const raw = ownData(value, new Set(["endpoint", "credential"]), ["endpoint", "credential"]);
  if (typeof raw.endpoint !== "string"
    || !/^(?:https:\/\/api\.openai\.com\/v1|http:\/\/127\.0\.0\.1:\d+\/v1)$/.test(raw.endpoint)
    || (providerId === "openai-api-key" && raw.endpoint !== "https://api.openai.com/v1")
    || (providerId === "local-openai-compatible" && !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(raw.endpoint))
    || typeof raw.credential !== "string"
    || raw.credential.length < 32 || raw.credential.length > 256
    || raw.credential.trim() !== raw.credential || !/^[\x21-\x7e]+$/.test(raw.credential)) {
    throw compatibleError("CODEX_INFERENCE_CONFIGURATION", "OpenAI-compatible inference configuration is invalid.");
  }
  const connection = { endpoint: raw.endpoint };
  Object.defineProperty(connection, "credential", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: raw.credential,
  });
  return Object.freeze(connection);
}

function validStream(value) {
  return value && typeof value === "object" && !types.isProxy(value)
    && value.fullStream && typeof value.fullStream[Symbol.asyncIterator] === "function";
}

class OpenAICompatibleInferenceTransport {
  #providerId;
  #resolveConnection;
  #ClientClass;
  #clients = new Set();
  #disposed = false;

  constructor(rawOptions = {}) {
    const options = ownData(rawOptions, new Set(["providerId", "resolveConnection", "ClientClass"]), []);
    let providerId;
    try { providerId = canonicalProviderId(options.providerId); } catch {
      throw compatibleError("CODEX_INFERENCE_CONFIGURATION", "OpenAI-compatible inference configuration is invalid.");
    }
    const descriptor = providerDescriptor(providerId);
    if (!new Set(["api-key", "local"]).has(descriptor.loginKind)
      || typeof options.resolveConnection !== "function"
      || (options.ClientClass !== undefined && typeof options.ClientClass !== "function")) {
      throw compatibleError("CODEX_INFERENCE_CONFIGURATION", "OpenAI-compatible inference configuration is invalid.");
    }
    this.#providerId = providerId;
    this.#resolveConnection = options.resolveConnection;
    this.#ClientClass = options.ClientClass || CodexClient;
  }

  stream(request) {
    if (this.#disposed) throw compatibleError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    let selection;
    try { selection = normalizeInferenceSelection(request?.selection); }
    catch { throw compatibleError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable."); }
    if (selection.provider !== this.#providerId || typeof request?.assertCurrent !== "function") {
      throw compatibleError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
    }
    let resolved;
    try {
      resolved = this.#resolveConnection();
    } catch (error) {
      if (error instanceof OpenAICompatibleInferenceError) throw error;
      throw compatibleError("CODEX_INFERENCE_UNAVAILABLE", "OpenAI-compatible inference is unavailable.");
    }
    if (resolved && typeof resolved.then === "function") {
      return Promise.resolve(resolved)
        .then(async (value) => {
          try { await request.assertCurrent(); }
          catch { throw compatibleError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
          return this.#streamWithConnection(request, selection, value);
        })
        .catch((error) => {
          if (error instanceof OpenAICompatibleInferenceError) throw error;
          throw compatibleError("CODEX_INFERENCE_UNAVAILABLE", "OpenAI-compatible inference is unavailable.");
        });
    }
    return this.#streamWithConnection(request, selection, resolved);
  }

  #streamWithConnection(request, selection, rawConnection) {
    let connection;
    try { connection = connectionValues(rawConnection, this.#providerId); }
    catch (error) {
      if (error instanceof OpenAICompatibleInferenceError) throw error;
      throw compatibleError("CODEX_INFERENCE_UNAVAILABLE", "OpenAI-compatible inference is unavailable.");
    }
    if (this.#disposed) throw compatibleError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    const config = {
      botId: selection.botId,
      generation: selection.generation,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    };
    Object.defineProperties(config, {
      endpoint: { value: connection.endpoint, enumerable: false },
      credential: { value: connection.credential, enumerable: false },
    });
    Object.freeze(config);
    let client;
    let result;
    try {
      client = new this.#ClientClass({ config, isCurrent: () => !this.#disposed });
      this.#clients.add(client);
      result = client.stream(request);
      if (!validStream(result)) throw new Error();
    } catch (error) {
      try { client?.dispose?.(); } catch {}
      if (client) this.#clients.delete(client);
      if (error instanceof OpenAICompatibleInferenceError) throw error;
      throw compatibleError("CODEX_INFERENCE_UNAVAILABLE", "OpenAI-compatible inference is unavailable.");
    }
    const owner = this;
    const fullStream = (async function* () {
      try {
        for await (const value of result.fullStream) {
          if (owner.#disposed) throw compatibleError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
          try { await request.assertCurrent(); }
          catch { throw compatibleError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
          yield value;
        }
        try { await request.assertCurrent(); }
        catch { throw compatibleError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
      } finally {
        owner.#clients.delete(client);
        try { client.dispose?.(); } catch {}
      }
    })();
    return Object.freeze({ ...result, fullStream });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const client of this.#clients) {
      try { client.dispose?.(); } catch {}
    }
    this.#clients.clear();
  }
}

module.exports = {
  OpenAICompatibleInferenceError,
  OpenAICompatibleInferenceTransport,
};
