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

function upstreamFetch(providerId, serviceTier) {
  const baseFetch = globalThis.fetch;
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-OpenBot-Provider", providerId);
    if (serviceTier !== null) headers.set("X-OpenBot-Service-Tier", serviceTier);
    let body = init.body;
    if (typeof body === "string") {
      try {
        const payload = JSON.parse(body);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          payload.provider = providerId;
          if (serviceTier !== null) payload.service_tier = serviceTier;
          body = JSON.stringify(payload);
        }
      } catch {}
    }
    if (typeof baseFetch !== "function") throw new Error();
    return baseFetch(input, { ...init, headers, body });
  };
}

class CLIProxyInferenceTransport {
  #providerId;
  #session;
  #resolveConnection;
  #assertConnectionCurrent;
  #ClientClass;
  #clients = new Set();
  #disposed = false;

  constructor({ providerId = "anthropic-claude", session = undefined, resolveConnection = null,
    assertConnectionCurrent = null, ClientClass = CodexClient } = {}) {
    let canonical;
    try { canonical = canonicalProviderId(providerId); } catch {
      throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
    }
    const descriptor = providerDescriptor(canonical);
    if (!new Set(["oauth", "device", "service-account"]).has(descriptor.loginKind)
      || typeof ClientClass !== "function"
      || (resolveConnection !== null && typeof resolveConnection !== "function")
      || (assertConnectionCurrent !== null && typeof assertConnectionCurrent !== "function")
      || (session !== undefined && resolveConnection !== null)) {
      throw optionalError("CODEX_INFERENCE_CONFIGURATION", "Optional inference configuration is invalid.");
    }
    this.#providerId = canonical;
    this.#resolveConnection = resolveConnection;
    this.#assertConnectionCurrent = assertConnectionCurrent || (() => true);
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
    const verifyProvider = () => {
      let current;
      try { current = this.#assertConnectionCurrent(selection, session); }
      catch { throw optionalError("CODEX_INFERENCE_STALE", "Codex inference provider generation changed."); }
      if (current && typeof current.then === "function") {
        return Promise.resolve(current).then((value) => {
          if (value !== true) throw optionalError("CODEX_INFERENCE_STALE", "Codex inference provider generation changed.");
        });
      }
      if (current !== true) throw optionalError("CODEX_INFERENCE_STALE", "Codex inference provider generation changed.");
      return undefined;
    };
    const construct = () => {
      const config = {
        botId: selection.botId,
        generation: selection.generation,
        provider: this.#providerId,
        providerId: this.#providerId,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        serviceTier: selection.serviceTier,
      };
      Object.defineProperties(config, {
        endpoint: { value: session.endpoint, enumerable: false },
        credential: { value: session.credential, enumerable: false },
      });
      Object.freeze(config);
      let client;
      try {
        const clientOptions = { config, isCurrent: () => !this.#disposed };
        if (this.#ClientClass === CodexClient) {
          clientOptions.fetchImpl = upstreamFetch(this.#providerId, selection.serviceTier);
        }
        client = new this.#ClientClass(clientOptions);
        this.#clients.add(client);
      } catch {
        try { client?.dispose?.(); } catch {}
        if (client) this.#clients.delete(client);
        throw optionalError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
      }
      const send = () => {
        let result;
        try {
          result = client.stream(request);
          return this.#wrapResult(request, result, client);
        } catch (error) {
          try { client?.dispose?.(); } catch {}
          this.#clients.delete(client);
          if (error instanceof CLIProxyInferenceError) throw error;
          throw optionalError("CODEX_INFERENCE_UNAVAILABLE", "Optional inference is unavailable.");
        }
      };
      try {
        const beforeSend = verifyProvider();
        return beforeSend && typeof beforeSend.then === "function"
          ? beforeSend.then(send, (error) => {
            try { client?.dispose?.(); } catch {}
            this.#clients.delete(client);
            throw error;
          })
          : send();
      } catch (error) {
        try { client?.dispose?.(); } catch {}
        this.#clients.delete(client);
        throw error;
      }
    };
    const first = verifyProvider();
    if (first && typeof first.then === "function") return first.then(() => {
      const second = verifyProvider();
      return second && typeof second.then === "function" ? second.then(construct) : construct();
    });
    const second = verifyProvider();
    return second && typeof second.then === "function" ? second.then(construct) : construct();
  }

  #wrapResult(request, result, client) {
    if (!result || typeof result !== "object" || types.isProxy(result)
      || !result.fullStream || typeof result.fullStream[Symbol.asyncIterator] !== "function") {
      try { client?.dispose?.(); } catch {}
      this.#clients.delete(client);
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
