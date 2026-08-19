"use strict";

const { types } = require("node:util");
const { CodexClient } = require("../bridge/codex-client.cjs");
const { normalizeInferenceSelection } = require("./inference-provider-router.cjs");
const { canonicalProviderId, providerDescriptor } = require("../provider-descriptors.cjs");

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
  #providerId;
  #session;
  #resolveConnection;
  #ClientClass;
  #clients = new Set();
  #disposed = false;

  constructor({ providerId = "anthropic-claude", session = undefined, resolveConnection = null,
    ClientClass = CodexClient } = {}) {
    let canonical;
    try { canonical = canonicalProviderId(providerId); } catch {
      throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
    }
    const descriptor = providerDescriptor(canonical);
    if (!new Set(["oauth", "device", "service-account"]).has(descriptor.loginKind)
      || typeof ClientClass !== "function"
      || (resolveConnection !== null && typeof resolveConnection !== "function")
      || (session !== undefined && resolveConnection !== null)) {
      throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
    }
    this.#providerId = canonical;
    this.#resolveConnection = resolveConnection;
    this.#session = session === undefined ? null : sessionValues(session);
    this.#ClientClass = ClientClass;
  }

  stream(request) {
    if (this.#disposed) throw optionalError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    let selection;
    try { selection = normalizeInferenceSelection(request?.selection); }
    catch { throw optionalError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable."); }
    if (selection.provider !== this.#providerId || typeof request?.assertCurrent !== "function") {
      throw optionalError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
    }
    if (this.#resolveConnection !== null) {
      let connection;
      try { connection = this.#resolveConnection(); }
      catch { throw optionalError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable."); }
      if (connection && typeof connection.then === "function") {
        return Promise.resolve(connection)
          .then(async (value) => {
            try { await request.assertCurrent(); }
            catch { throw optionalError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
            return this.#streamWithSession(request, selection, value);
          })
          .catch((error) => {
            if (error instanceof CLIProxyInferenceError) throw error;
            throw optionalError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
          });
      }
      return this.#streamWithSession(request, selection, connection);
    }
    return this.#streamWithSession(request, selection, this.#session);
  }

  #streamWithSession(request, selection, rawSession) {
    let session;
    try { session = sessionValues(rawSession); }
    catch (error) {
      if (error instanceof CLIProxyInferenceError) throw error;
      throw optionalError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
    }
    const config = {
      botId: selection.botId,
      generation: selection.generation,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    };
    Object.defineProperties(config, {
      endpoint: { value: session.endpoint, enumerable: false },
      credential: { value: session.credential, enumerable: false },
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
