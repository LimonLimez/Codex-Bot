"use strict";

const http = require("node:http");
const https = require("node:https");
const { types } = require("node:util");
const { providerDescriptor } = require("../provider-descriptors.cjs");

const API_PROVIDER = "openai-api-key";
const LOCAL_PROVIDER = "local-openai-compatible";
const API_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MODELS = 200;
const REQUEST_TIMEOUT_MS = 5_000;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

class OpenAICompatibleProviderError extends Error {
  constructor(message = "OpenAI-compatible provider is unavailable.", code = "OPENAI_COMPATIBLE_UNAVAILABLE") {
    super(message);
    this.name = "OpenAICompatibleProviderError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function invalid(message = "OpenAI-compatible provider request is invalid.") {
  return new OpenAICompatibleProviderError(message, "OPENAI_COMPATIBLE_INVALID");
}

function unavailable(code = "OPENAI_COMPATIBLE_UNAVAILABLE") {
  const message = code === "OPENAI_COMPATIBLE_REDIRECT"
    ? "OpenAI-compatible provider returned a redirect."
    : code === "OPENAI_COMPATIBLE_TOO_LARGE"
      ? "OpenAI-compatible provider response is too large."
      : code === "OPENAI_COMPATIBLE_CANCELLED"
        ? "OpenAI-compatible provider request was cancelled."
        : "OpenAI-compatible provider is unavailable.";
  return new OpenAICompatibleProviderError(message, code);
}

function ownData(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw invalid(); }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))
    || required.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function safeSecret(value, { optional = false } = {}) {
  if (optional && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")
    || /[\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > 16 * 1024) throw invalid();
  return value;
}

function localEndpoint(value) {
  if (typeof value !== "string" || value.length > 512 || /[\0\r\n]/.test(value)) throw invalid("Local provider loopback URL is invalid.");
  const literal = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/v1$/.exec(value);
  if (!literal || Number(literal[1]) < 1 || Number(literal[1]) > 65535) {
    throw invalid("Local provider loopback URL is invalid.");
  }
  let url;
  try { url = new URL(value); } catch { throw invalid("Local provider loopback URL is invalid."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== "/v1") {
    throw invalid("Local provider loopback URL is invalid.");
  }
  return url.href;
}

function safeSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (!signal || typeof signal !== "object" || types.isProxy(signal)
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function") throw invalid();
  return signal;
}

function publicModel(providerId, raw) {
  const model = ownData(raw, new Set(["id", "object", "owned_by", "created", "permission", "root", "parent"]), ["id"]);
  if (typeof model.id !== "string" || !MODEL_ID.test(model.id)) throw invalid("Provider model is invalid.");
  if (model.object !== undefined && model.object !== "model") throw invalid("Provider model is invalid.");
  return Object.freeze({ provider: providerId, model: model.id, label: model.id });
}

function parseCatalog(providerId, body) {
  if (typeof body !== "string" && !Buffer.isBuffer(body)) throw invalid("Provider catalog is invalid.");
  let parsed;
  try { parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body); } catch { throw invalid("Provider catalog is invalid."); }
  const raw = ownData(parsed, new Set(["object", "data"]), ["data"]);
  if (raw.object !== undefined && raw.object !== "list") throw invalid("Provider catalog is invalid.");
  const entries = [];
  const seen = new Set();
  for (const value of denseArray(raw.data, MAX_MODELS)) {
    const model = publicModel(providerId, value);
    if (seen.has(model.model)) throw invalid("Provider catalog is invalid.");
    seen.add(model.model);
    entries.push(model);
  }
  return Object.freeze({ providerId, models: Object.freeze(entries) });
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) throw invalid();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw invalid(); }
  const length = descriptors.length?.value;
  const keys = Reflect.ownKeys(descriptors);
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || keys.length !== length + 1
    || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)))) throw invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function requestHttp(requestOrUrl, options = {}) {
  const url = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl?.url;
  const headers = typeof requestOrUrl === "string" ? options.headers : requestOrUrl?.headers;
  const signal = typeof requestOrUrl === "string" ? options.signal : requestOrUrl?.signal;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { reject(unavailable()); return; }
    const transport = parsed.protocol === "https:" ? https : http;
    let settled = false;
    let request;
    let response;
    let timer;
    const chunks = [];
    let total = 0;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      try { request?.destroy(); } catch { /* cleanup is best effort */ }
      finish(() => reject(unavailable("OPENAI_COMPATIBLE_CANCELLED")));
    };
    if (signal?.aborted) { onAbort(); return; }
    try {
      request = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { ...headers, Connection: "close" },
        timeout: REQUEST_TIMEOUT_MS,
      }, (incoming) => {
        response = incoming;
        const contentLength = Number(incoming.headers?.["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          incoming.resume();
          try { request.destroy(); } catch { /* best effort */ }
          finish(() => reject(unavailable("OPENAI_COMPATIBLE_TOO_LARGE")));
          return;
        }
        incoming.on("data", (chunk) => {
          total += Buffer.byteLength(chunk);
          if (total > MAX_RESPONSE_BYTES) {
            try { request.destroy(); } catch { /* best effort */ }
            finish(() => reject(unavailable("OPENAI_COMPATIBLE_TOO_LARGE")));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.once("end", () => finish(() => resolve({
          statusCode: incoming.statusCode,
          headers: incoming.headers || {},
          body: Buffer.concat(chunks),
        })));
        incoming.once("error", () => finish(() => reject(unavailable())));
      });
      request.once("timeout", () => {
        try { request.destroy(); } catch { /* best effort */ }
        finish(() => reject(unavailable()));
      });
      request.once("error", () => finish(() => reject(unavailable())));
      signal?.addEventListener("abort", onAbort, { once: true });
      request.end();
      timer = setTimeout(() => {
        try { request.destroy(); } catch { /* best effort */ }
        finish(() => reject(unavailable()));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    } catch { finish(() => reject(unavailable())); }
  });
}

class OpenAICompatibleProvider {
  #request;
  #configurations = new Map();

  constructor(rawOptions = {}) {
    const options = ownData(rawOptions, new Set(["request"]));
    if (options.request !== undefined && typeof options.request !== "function") throw invalid();
    this.#request = options.request || requestHttp;
  }

  discover(rawRequest) {
    let request;
    try {
      request = ownData(rawRequest, new Set(["providerId", "baseUrl", "apiKey", "signal"]), ["providerId"]);
    } catch (error) {
      return Promise.reject(error);
    }
    let descriptor;
    try { descriptor = providerDescriptor(request.providerId); } catch { return Promise.reject(invalid()); }
    const providerId = descriptor.providerId;
    if (providerId !== API_PROVIDER && providerId !== LOCAL_PROVIDER) return Promise.reject(invalid());
    let endpoint;
    let apiKey;
    try {
      const signal = safeSignal(request.signal);
      if (providerId === API_PROVIDER) {
        apiKey = safeSecret(request.apiKey);
        endpoint = `${API_BASE_URL}/models`;
      } else {
        endpoint = `${localEndpoint(request.baseUrl)}/models`;
        apiKey = request.apiKey === undefined ? null : safeSecret(request.apiKey, { optional: true });
      }
      const headers = { Accept: "application/json" };
      if (apiKey !== null && apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      return Promise.resolve(this.#request({
        url: endpoint,
        method: "GET",
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        redirects: 0,
        signal,
      })).then((response) => {
        if (signal?.aborted) throw unavailable("OPENAI_COMPATIBLE_CANCELLED");
        const result = ownData(response, new Set(["statusCode", "headers", "body"]), ["statusCode", "body"]);
        if (result.statusCode >= 300 && result.statusCode < 400) throw unavailable("OPENAI_COMPATIBLE_REDIRECT");
        if (result.statusCode !== 200) throw unavailable();
        let body = result.body;
        if (Buffer.byteLength(Buffer.isBuffer(body) ? body : String(body), "utf8") > MAX_RESPONSE_BYTES) {
          throw unavailable("OPENAI_COMPATIBLE_TOO_LARGE");
        }
        const catalog = parseCatalog(providerId, body);
        if (catalog.models.length < 1) throw invalid("Provider catalog is empty.");
        const baseUrl = endpoint.slice(0, -"/models".length);
        const configuration = { providerId, baseUrl };
        Object.defineProperty(configuration, "apiKey", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: apiKey,
        });
        this.#configurations.set(providerId, Object.freeze(configuration));
        return catalog;
      }).catch((error) => {
        if (error instanceof OpenAICompatibleProviderError) throw error;
        throw unavailable();
      });
    } catch (error) {
      return Promise.reject(error instanceof OpenAICompatibleProviderError ? error : invalid());
    }
  }

  streamConfiguration(rawProviderId) {
    let descriptor;
    try { descriptor = providerDescriptor(rawProviderId); } catch { throw invalid(); }
    const configuration = this.#configurations.get(descriptor.providerId);
    if (!configuration) throw unavailable();
    const result = { providerId: configuration.providerId, baseUrl: configuration.baseUrl };
    Object.defineProperty(result, "apiKey", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: configuration.apiKey,
    });
    return Object.freeze(result);
  }
}

module.exports = {
  API_BASE_URL,
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
  parseCatalog,
};
