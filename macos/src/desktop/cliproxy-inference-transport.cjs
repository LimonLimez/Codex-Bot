"use strict";

const { types } = require("node:util");
const { CodexClient } = require("../bridge/codex-client.cjs");
const { normalizeInferenceSelection } = require("./inference-provider-router.cjs");

class CLIProxyInferenceError extends Error {
  constructor(code = "CODEX_INFERENCE_UNAVAILABLE", message = "Optional inference is unavailable.") {
    super(message);
    this.name = "CLIProxyInferenceError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function optionalError(code, message) { return new CLIProxyInferenceError(code, message); }

function sessionValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch {
    throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
  }
  const endpoint = descriptors.endpoint?.value;
  const credential = descriptors.credential?.value;
  if (typeof endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(endpoint)
    || typeof credential !== "string" || credential.length < 32 || credential.length > 256
    || credential.trim() !== credential || !/^[\x21-\x7e]+$/.test(credential)) {
    throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
  }
  return { endpoint, credential };
}

class CLIProxyInferenceTransport {
  #session;
  #ClientClass;
  #clients = new Set();
  #disposed = false;

  constructor({ session, ClientClass = CodexClient } = {}) {
    if (typeof ClientClass !== "function") {
      throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
    }
    this.#session = sessionValues(session);
    this.#ClientClass = ClientClass;
  }

  stream(request) {
    if (this.#disposed) throw optionalError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    let selection;
    try { selection = normalizeInferenceSelection(request?.selection); }
    catch { throw optionalError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable."); }
    if (selection.provider !== "cliproxy-anthropic" || typeof request?.assertCurrent !== "function") {
      throw optionalError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
    }
    const config = {
      botId: selection.botId,
      generation: selection.generation,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    };
    Object.defineProperties(config, {
      endpoint: { value: this.#session.endpoint, enumerable: false },
      credential: { value: this.#session.credential, enumerable: false },
    });
    Object.freeze(config);
    let client;
    let result;
    try {
      client = new this.#ClientClass({ config, isCurrent: () => !this.#disposed });
      this.#clients.add(client);
      result = client.stream(request);
    } catch {
      try { client?.dispose?.(); } catch {}
      if (client) this.#clients.delete(client);
      throw optionalError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
    }
    const owner = this;
    const fullStream = (async function* () {
      try {
        for await (const value of result.fullStream) {
          if (owner.#disposed) throw optionalError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
          try { await request.assertCurrent(); }
          catch { throw optionalError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
          yield value;
        }
        try { await request.assertCurrent(); }
        catch { throw optionalError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
      } finally {
        owner.#clients.delete(client);
        try { client.dispose(); } catch {}
      }
    })();
    return Object.freeze({ ...result, fullStream });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const client of this.#clients) {
      try { client.dispose(); } catch {}
    }
    this.#clients.clear();
  }
}

module.exports = { CLIProxyInferenceError, CLIProxyInferenceTransport };
