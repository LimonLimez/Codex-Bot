"use strict";

const { EventEmitter } = require("node:events");
const { isIP } = require("node:net");
const { TextDecoder, types } = require("node:util");
const WebSocketImplementation = require("ws");

const DEFAULT_TIMEOUT_MS = 30_000;
const THREAD_START_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_FRAME_BYTES = 1_048_576;
const MIN_AUTH_TOKEN_BYTES = 16;
const MAX_AUTH_TOKEN_BYTES = 8_192;
const MAX_ENDPOINT_BYTES = 2_048;
const MAX_METHOD_BYTES = 256;
const MAX_ERROR_MESSAGE_BYTES = 1_000;
const MAX_PREINIT_NOTIFICATIONS = 128;
const MAX_PREINIT_NOTIFICATION_BYTES = 65_536;
const MAX_PENDING_REQUESTS = 128;
const MAX_INCOMING_REQUESTS = 128;
const MAX_COMPLETED_INCOMING_REQUESTS = 128;
const MAX_TIMED_OUT_IDS = 128;
const MAX_BUFFERED_BYTES = 1_048_576;
const SUBPROTOCOLS = Object.freeze(["codex-app-server"]);
const SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);
const SESSION_KEYS = Object.freeze([
  "authToken",
  "endpoint",
  "generation",
  "provider",
  "runtimeId",
]);
const OPTION_KEYS = new Set([
  "clearTimeout",
  "clientVersion",
  "session",
  "setTimeout",
  "webSocketFactory",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const METHOD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const NON_PUBLIC_IPV4_CIDRS = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);

class RemoteAppServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RemoteAppServerError";
    this.code = code;
  }
}

function remoteError(code, message) {
  return Object.freeze(new RemoteAppServerError(code, message));
}

function sessionError() {
  return new TypeError("Remote runtime session is invalid.");
}

function payloadError() {
  return new TypeError("Remote Codex request payload is invalid.");
}

function credentialPayloadError() {
  return new TypeError("Remote Codex credential or secret payload is forbidden.");
}

function ipv4Integer(hostname) {
  return hostname.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4MatchesCidr(value, base, prefixLength) {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

function ipv6Integer(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6MatchesCidr(value, base, prefixLength) {
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (base >> shift);
}

function isNonPublicIpLiteral(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const version = isIP(normalized);
  if (version === 4) {
    const value = ipv4Integer(normalized);
    return NON_PUBLIC_IPV4_CIDRS.some(([base, prefix]) => (
      ipv4MatchesCidr(value, ipv4Integer(base), prefix)
    ));
  }
  if (version === 6) {
    const value = ipv6Integer(normalized);
    if (value === null || (value >> 125n) !== 1n) return true;
    return ipv6MatchesCidr(value, ipv6Integer("2001::"), 23)
      || ipv6MatchesCidr(value, ipv6Integer("2001:db8::"), 32)
      || ipv6MatchesCidr(value, ipv6Integer("3ffe::"), 16);
  }
  return false;
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key) {
  const normalized = normalizedKey(key);
  if (normalized.includes("endpoint")
    || normalized.includes("provider")
    || normalized === "origin"
    || normalized.endsWith("origin")
    || normalized === "host"
    || normalized === "hostname"
    || normalized.endsWith("host")
    || normalized.endsWith("hostname")
    || normalized === "query"
    || normalized.startsWith("query")
    || normalized.endsWith("query")
    || normalized === "search"
    || normalized.includes("header")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("credential")
    || normalized.includes("authorization")
    || normalized.includes("apikey")
    || normalized.includes("cookie")
    || normalized === "session"
    || normalized.includes("diagnostic")) return true;
  if (!normalized.includes("token")) return false;
  if (/(?:id|csrf|private|auth(?:entication)?|access|refresh|bearer|session|api|oauth|secret|credential)tokens?/.test(normalized)) {
    return true;
  }
  if (normalized === "token" || normalized === "tokens") return true;
  if (/^(?:tokenusage|lasttokenusage|tokenusagebreakdown)$/.test(normalized)) return false;
  if (/^(?:total|input|output|maxoutput|cachedinput|cached|reasoning|visible|lifetime|context|prompt|completion)tokens?$/.test(normalized)) {
    return false;
  }
  if (/^(?:total|input|output|cachedinput|cached|reasoning|context|prompt|completion)?tokencount$/.test(normalized)) {
    return false;
  }
  return true;
}

function isKeyCode(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || code === 95
    || code === 45
    || (code >= 97 && code <= 122)
    || (Number.isInteger(code)
      && (code < 32 || code >= 127)
      && !isWhitespaceCode(code));
}

function isWordCode(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || code === 95
    || (code >= 97 && code <= 122);
}

function isInlineKeyCode(code) {
  return isKeyCode(code) && code >= 32;
}

function isQuoteCode(code) {
  return code === 34 || code === 39 || code === 96;
}

function isWhitespaceCode(code) {
  return (code >= 9 && code <= 13)
    || code === 32
    || code === 160
    || code === 5760
    || (code >= 8192 && code <= 8202)
    || code === 8232
    || code === 8233
    || code === 8239
    || code === 8287
    || code === 12288
    || code === 65279;
}

function skipWhitespace(value, index) {
  while (index < value.length && isWhitespaceCode(value.charCodeAt(index))) index += 1;
  return index;
}

function hexDigitValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function decodeFixedHex(value, index, length) {
  if (index + length > value.length) return null;
  let decoded = 0;
  for (let offset = 0; offset < length; offset += 1) {
    const digit = hexDigitValue(value.charCodeAt(index + offset));
    if (digit < 0) return null;
    decoded = (decoded * 16) + digit;
  }
  return decoded;
}

function jsonShortEscapeCode(code) {
  if (code === 34 || code === 47 || code === 92) return code;
  if (code === 98) return 8;
  if (code === 102) return 12;
  if (code === 110) return 10;
  if (code === 114) return 13;
  if (code === 116) return 9;
  return -1;
}

function canonicalizeStructuralEscapes(value) {
  let parts = null;
  let rawStart = 0;
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) !== 92 || index + 1 >= value.length) {
      index += 1;
      continue;
    }

    const escaped = value.charCodeAt(index + 1);
    let decoded = null;
    let next = index + 2;
    if (escaped === 117) {
      if (value.charCodeAt(index + 2) === 123) {
        let cursor = index + 3;
        let codePoint = 0;
        let digits = 0;
        while (digits < 6) {
          const digit = hexDigitValue(value.charCodeAt(cursor));
          if (digit < 0) break;
          codePoint = (codePoint * 16) + digit;
          cursor += 1;
          digits += 1;
        }
        if (digits > 0
          && value.charCodeAt(cursor) === 125
          && codePoint <= 0x10ffff) {
          decoded = String.fromCodePoint(codePoint);
          next = cursor + 1;
        }
      } else {
        const codePoint = decodeFixedHex(value, index + 2, 4);
        if (codePoint !== null) {
          decoded = String.fromCharCode(codePoint);
          next = index + 6;
        }
      }
    } else if (escaped === 120) {
      const codePoint = decodeFixedHex(value, index + 2, 2);
      if (codePoint !== null) {
        decoded = String.fromCharCode(codePoint);
        next = index + 4;
      }
    } else {
      const shortEscape = jsonShortEscapeCode(escaped);
      if (shortEscape >= 0) decoded = String.fromCharCode(shortEscape);
      else if (escaped === 39 || escaped === 96 || escaped === 58 || escaped === 61) {
        decoded = String.fromCharCode(escaped);
      }
    }

    if (decoded === null) {
      index += 1;
      continue;
    }

    if (parts === null) parts = [];
    parts.push(value.slice(rawStart, index), decoded);
    index = next;
    rawStart = next;
  }

  if (parts === null) return value;
  parts.push(value.slice(rawStart));
  return parts.join("");
}

function assignmentHasValue(value, separatorIndex) {
  let cursor = skipWhitespace(value, separatorIndex + 1);
  const quote = value.charCodeAt(cursor);
  if (isQuoteCode(quote)) {
    cursor += 1;
    return cursor < value.length && value.charCodeAt(cursor) !== quote;
  }
  const code = value.charCodeAt(cursor);
  return cursor < value.length
    && !isWhitespaceCode(code)
    && code !== 41
    && code !== 44
    && code !== 59
    && code !== 93
    && code !== 125;
}

function quotedLocalAssignmentIsSecret(value, candidateStart, separatorIndex, boundaryIndex) {
  if (candidateStart < 0 || separatorIndex <= candidateStart) return false;
  let cursor = skipWhitespace(value, separatorIndex + 1);
  if (cursor >= boundaryIndex) return false;
  const quote = value.charCodeAt(cursor);
  if (isQuoteCode(quote)) {
    cursor += 1;
    if (cursor >= boundaryIndex || value.charCodeAt(cursor) === quote) return false;
  }
  const code = value.charCodeAt(cursor);
  if (code === 41 || code === 44 || code === 59 || code === 93 || code === 125) return false;
  return isSecretKey(value.slice(candidateStart, separatorIndex));
}

function hasCredentialAssignment(value) {
  let candidateStart = -1;
  let candidateEnd = -1;
  let quoteStart = -1;
  let quotedAssignmentSecret = false;
  let quotedLocalStart = -1;
  let quotedLocalSeparator = -1;
  let quotedLocalSeparated = false;
  let quotedLocalBoundary = -1;
  let quotedLocalValueStarted = false;
  let quotedLocalValueQuote = -1;
  let quoteClosed = false;
  let separated = false;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (isQuoteCode(code)) {
      if (quoteClosed && separated) {
        if (quotedAssignmentSecret) return true;
        quotedAssignmentSecret = false;
        quoteClosed = false;
      }
      if (quoteStart >= 0 && code === quotedLocalValueQuote) {
        quotedLocalValueQuote = -1;
        index += 1;
        continue;
      }
      if (quoteStart >= 0
        && quotedLocalSeparator >= 0
        && !quotedLocalValueStarted
        && skipWhitespace(value, quotedLocalSeparator + 1) === index) {
        if (quotedLocalAssignmentIsSecret(
          value,
          quotedLocalStart,
          quotedLocalSeparator,
          value.length,
        )) return true;
        quotedLocalValueStarted = true;
        quotedLocalValueQuote = code;
        quotedLocalSeparated = false;
        quotedLocalBoundary = -1;
        separated = false;
        index += 1;
        continue;
      }
      const previousIsKey = index > 0 && isInlineKeyCode(value.charCodeAt(index - 1));
      const nextIsKey = isInlineKeyCode(value.charCodeAt(index + 1));
      if (quoteStart >= 0) {
        if (!previousIsKey && nextIsKey) {
          if (quotedLocalAssignmentIsSecret(value, quotedLocalStart, quotedLocalSeparator, index)) {
            quotedAssignmentSecret = true;
          }
          if (quotedAssignmentSecret) return true;
          quoteStart = index;
          candidateStart = index + 1;
          candidateEnd = index + 1;
          quotedAssignmentSecret = false;
          quotedLocalStart = index + 1;
          quotedLocalSeparator = -1;
          quotedLocalSeparated = false;
          quotedLocalBoundary = -1;
          quotedLocalValueStarted = false;
          quotedLocalValueQuote = -1;
          quoteClosed = false;
        } else if (!(previousIsKey && nextIsKey)) {
          if (quotedLocalAssignmentIsSecret(value, quotedLocalStart, quotedLocalSeparator, index)) {
            quotedAssignmentSecret = true;
          }
          candidateEnd = index;
          quoteStart = -1;
          quotedLocalStart = -1;
          quotedLocalSeparator = -1;
          quotedLocalSeparated = false;
          quotedLocalBoundary = -1;
          quotedLocalValueStarted = false;
          quotedLocalValueQuote = -1;
          quoteClosed = true;
        }
      } else if (previousIsKey && !nextIsKey && candidateStart >= 0) {
        candidateEnd = index;
      } else if (!(previousIsKey && nextIsKey)) {
        quoteStart = index;
        candidateStart = index + 1;
        candidateEnd = index + 1;
        quotedAssignmentSecret = false;
        quotedLocalStart = index + 1;
        quotedLocalSeparator = -1;
        quotedLocalSeparated = false;
        quotedLocalBoundary = -1;
        quotedLocalValueStarted = false;
        quotedLocalValueQuote = -1;
        quoteClosed = false;
      }
      separated = false;
      index += 1;
      continue;
    }

    if (isKeyCode(code)) {
      if (quoteClosed && separated) {
        if (quotedAssignmentSecret) return true;
        quotedAssignmentSecret = false;
        quoteClosed = false;
      }
      const start = index;
      index += 1;
      while (index < value.length && isKeyCode(value.charCodeAt(index))) index += 1;
      if (quoteStart >= 0) {
        if (quotedLocalSeparated) {
          if (quotedLocalSeparator >= 0 && quotedLocalValueStarted) {
            if (quotedLocalAssignmentIsSecret(
              value,
              quotedLocalStart,
              quotedLocalSeparator,
              quotedLocalBoundary,
            )) quotedAssignmentSecret = true;
            quotedLocalStart = start;
            quotedLocalSeparator = -1;
            quotedLocalValueStarted = false;
            quotedLocalValueQuote = -1;
          } else if (quotedLocalSeparator < 0) {
            quotedLocalStart = start;
          }
          quotedLocalBoundary = -1;
        }
        if (quotedLocalStart < 0) quotedLocalStart = start;
        if (quotedLocalSeparator >= 0) quotedLocalValueStarted = true;
        quotedLocalSeparated = false;
      }
      if (candidateStart < 0 || (separated && quoteStart < 0)) candidateStart = start;
      candidateEnd = index;
      separated = false;
      continue;
    }

    if ((code === 58 || code === 61) && quoteStart >= 0) {
      candidateEnd = index + 1;
      quotedLocalSeparator = index;
      quotedLocalSeparated = false;
      quotedLocalBoundary = -1;
      quotedLocalValueStarted = false;
      quotedLocalValueQuote = -1;
      separated = false;
      index += 1;
      continue;
    }

    if (code === 58 || code === 61) {
      if (candidateStart >= 0
        && candidateEnd > candidateStart
        && assignmentHasValue(value, index)
        && isSecretKey(value.slice(candidateStart, candidateEnd))) return true;
      candidateStart = -1;
      candidateEnd = -1;
      quoteStart = -1;
      quotedAssignmentSecret = false;
      quotedLocalStart = -1;
      quotedLocalSeparator = -1;
      quotedLocalSeparated = false;
      quotedLocalBoundary = -1;
      quotedLocalValueStarted = false;
      quotedLocalValueQuote = -1;
      quoteClosed = false;
      separated = false;
      index += 1;
      continue;
    }

    if (isWhitespaceCode(code)) {
      if (quoteStart < 0) separated = true;
      else {
        if (!quotedLocalSeparated) quotedLocalBoundary = index;
        quotedLocalSeparated = true;
      }
    } else if (code === 40
      || code === 41
      || code === 91
      || code === 93
      || code === 123
      || code === 125) {
      if (quoteStart < 0) separated = true;
      else {
        if (quotedLocalAssignmentIsSecret(value, quotedLocalStart, quotedLocalSeparator, index)) {
          quotedAssignmentSecret = true;
        }
        quotedLocalStart = -1;
        quotedLocalSeparator = -1;
        quotedLocalSeparated = true;
        quotedLocalBoundary = index;
        quotedLocalValueStarted = false;
        quotedLocalValueQuote = -1;
      }
    } else if (quoteStart >= 0) {
      candidateEnd = index + 1;
      if (quotedLocalSeparated) {
        if (quotedLocalSeparator >= 0 && quotedLocalValueStarted) {
          if (quotedLocalAssignmentIsSecret(
            value,
            quotedLocalStart,
            quotedLocalSeparator,
            quotedLocalBoundary,
          )) quotedAssignmentSecret = true;
          quotedLocalStart = index;
          quotedLocalSeparator = -1;
          quotedLocalValueStarted = false;
          quotedLocalValueQuote = -1;
        } else if (quotedLocalSeparator < 0) {
          quotedLocalStart = index;
        }
        quotedLocalBoundary = -1;
      }
      if (quotedLocalStart < 0) quotedLocalStart = index;
      if (quotedLocalSeparator >= 0) quotedLocalValueStarted = true;
      quotedLocalSeparated = false;
    } else {
      if (quoteClosed && separated) {
        if (quotedAssignmentSecret) return true;
        quotedAssignmentSecret = false;
        quoteClosed = false;
      }
      if (candidateStart < 0 || separated) candidateStart = index;
      candidateEnd = index + 1;
      separated = false;
    }
    index += 1;
  }
  if (quoteStart >= 0
    && quotedLocalAssignmentIsSecret(value, quotedLocalStart, quotedLocalSeparator, value.length)) return true;
  return quotedAssignmentSecret;
}

function hasCredentialScheme(value) {
  let index = 0;
  while (index < value.length) {
    let schemeLength = 0;
    if (value.startsWith("Basic", index)) schemeLength = 5;
    else if (value.startsWith("Bearer", index)) schemeLength = 6;
    if (schemeLength === 0 || (index > 0 && isWordCode(value.charCodeAt(index - 1)))) {
      index += 1;
      continue;
    }
    let cursor = index + schemeLength;
    if (!isWhitespaceCode(value.charCodeAt(cursor))) {
      index += schemeLength;
      continue;
    }
    cursor = skipWhitespace(value, cursor);
    const quote = value.charCodeAt(cursor);
    if (isQuoteCode(quote)) cursor += 1;
    if (cursor < value.length
      && !isWhitespaceCode(value.charCodeAt(cursor))
      && (!isQuoteCode(quote) || value.charCodeAt(cursor) !== quote)) return true;
    index = Math.max(index + schemeLength, cursor + 1);
  }
  return false;
}

function isSensitiveString(value, redactions) {
  const canonical = canonicalizeStructuralEscapes(value);
  for (const secret of redactions) {
    if (!secret) continue;
    const canonicalSecret = canonicalizeStructuralEscapes(secret);
    if (value.includes(secret)
      || value.includes(canonicalSecret)
      || canonical.includes(secret)
      || canonical.includes(canonicalSecret)) return true;
  }
  return /(?:sk|sess)-[A-Za-z0-9_-]+/i.test(canonical)
    || /(?:^|[^A-Za-z0-9-])(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\s,;]+/i.test(canonical)
    || hasCredentialAssignment(canonical)
    || hasCredentialScheme(canonical);
}

function credentialQuery(endpoint) {
  for (const [key, value] of endpoint.searchParams) {
    if (isSecretKey(key)
      || /^(?:bearer\s+|sk-|sess-)/i.test(value)
      || /(?:access|refresh|auth|session)[_-]?token/i.test(value)) return true;
  }
  return false;
}

function validateEndpoint(value) {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value) > MAX_ENDPOINT_BYTES) throw sessionError();
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw sessionError();
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  if (endpoint.protocol !== "wss:"
    || !hostname
    || endpoint.username
    || endpoint.password
    || endpoint.hash
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || isNonPublicIpLiteral(hostname)
    || credentialQuery(endpoint)) throw sessionError();
  return value;
}

function dataDescriptors(value, allowedKeys, errorFactory) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw errorFactory();
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw errorFactory();
  }
  if (prototype !== Object.prototype && prototype !== null) throw errorFactory();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) throw errorFactory();
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) throw errorFactory();
  }
  return descriptors;
}

function validateIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function privateSession(raw) {
  const descriptors = dataDescriptors(raw, new Set(SESSION_KEYS), sessionError);
  if (Object.keys(descriptors).length !== SESSION_KEYS.length
    || SESSION_KEYS.some((key) => !Object.hasOwn(descriptors, key))) throw sessionError();
  const provider = descriptors.provider.value;
  const runtimeId = descriptors.runtimeId.value;
  const endpoint = validateEndpoint(descriptors.endpoint.value);
  const authToken = descriptors.authToken.value;
  const canonicalAuthToken = typeof authToken === "string"
    ? canonicalizeStructuralEscapes(authToken)
    : null;
  const generation = descriptors.generation.value;
  if (!validateIdentifier(provider)
    || !validateIdentifier(runtimeId)
    || typeof authToken !== "string"
    || authToken.length === 0
    || authToken !== authToken.trim()
    || Buffer.byteLength(authToken) > MAX_AUTH_TOKEN_BYTES
    || Buffer.byteLength(canonicalAuthToken) < MIN_AUTH_TOKEN_BYTES
    || canonicalAuthToken !== canonicalAuthToken.trim()
    || /[\u0000-\u001f\u007f-\u009f]/.test(canonicalAuthToken)
    || !Number.isSafeInteger(generation)
    || generation <= 0) throw sessionError();
  return Object.freeze({ provider, runtimeId, endpoint, authToken, generation });
}

function validateOptions(options) {
  const descriptors = dataDescriptors(options, OPTION_KEYS, () => new TypeError("Remote client options are invalid."));
  if (!Object.hasOwn(descriptors, "session")) throw new TypeError("Remote client options are invalid.");
  const result = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  if (result.webSocketFactory !== undefined && typeof result.webSocketFactory !== "function") {
    throw new TypeError("Remote client options are invalid.");
  }
  if (result.setTimeout !== undefined && typeof result.setTimeout !== "function") {
    throw new TypeError("Remote client options are invalid.");
  }
  if (result.clearTimeout !== undefined && typeof result.clearTimeout !== "function") {
    throw new TypeError("Remote client options are invalid.");
  }
  if ((result.setTimeout === undefined) !== (result.clearTimeout === undefined)) {
    throw new TypeError("Remote client options are invalid.");
  }
  if (result.clientVersion !== undefined
    && (typeof result.clientVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(result.clientVersion))) {
    throw new TypeError("Remote client options are invalid.");
  }
  return result;
}

function clonePlain(value, redactions = null, seen = new Map()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (redactions && isSensitiveString(value, redactions)) throw credentialPayloadError();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw payloadError();
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) throw payloadError();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw payloadError();
  }
  const array = Array.isArray(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) throw payloadError();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw payloadError();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) throw payloadError();
    if (array && key === "length") continue;
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw payloadError();
    if (redactions && isSecretKey(key)) throw credentialPayloadError();
  }
  const clone = array ? [] : {};
  seen.set(value, clone);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    Object.defineProperty(clone, key, {
      value: clonePlain(descriptor.value, redactions, seen),
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function sanitizeIncoming(value, secrets, seen = new Map()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid");
    return value;
  }
  if (typeof value === "string") {
    return isSensitiveString(value, secrets) ? "<redacted>" : value;
  }
  if (typeof value !== "object" || types.isProxy(value)) throw new Error("invalid");
  if (seen.has(value)) return seen.get(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) throw new Error("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new Error("invalid");
  const clone = array ? [] : {};
  seen.set(value, clone);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    if (!("value" in descriptor)) throw new Error("invalid");
    if (key === "__proto__" || key === "prototype" || key === "constructor" || isSecretKey(key)) continue;
    Object.defineProperty(clone, key, {
      value: sanitizeIncoming(descriptor.value, secrets, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

function validateMethod(method) {
  if (typeof method !== "string"
    || Buffer.byteLength(method) > MAX_METHOD_BYTES
    || !METHOD_PATTERN.test(method)) throw new TypeError("Remote Codex method is invalid.");
  return method;
}

function validateTimeout(method, timeoutMs) {
  if (timeoutMs === undefined) return method === "thread/start" ? THREAD_START_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("Remote Codex timeout is invalid.");
  }
  return timeoutMs;
}

function validateRequestId(id) {
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError("Remote Codex request ID is invalid.");
  return id;
}

function defaultWebSocketFactory(url, protocols, options) {
  return new WebSocketImplementation(url, protocols, options);
}

function addSocketListener(socket, eventName, listener) {
  let add;
  let remove;
  try {
    add = socket.on;
    remove = socket.removeListener;
  } catch {
    throw new Error("invalid socket");
  }
  if (typeof add === "function" && typeof remove === "function") {
    const detach = () => remove.call(socket, eventName, listener);
    try {
      add.call(socket, eventName, listener);
    } catch (error) {
      try { detach(); } catch { /* Registration failure remains authoritative. */ }
      throw error;
    }
    return detach;
  }
  try {
    add = socket.addEventListener;
    remove = socket.removeEventListener;
  } catch {
    throw new Error("invalid socket");
  }
  if (typeof add === "function" && typeof remove === "function") {
    const detach = () => remove.call(socket, eventName, listener);
    try {
      add.call(socket, eventName, listener);
    } catch (error) {
      try { detach(); } catch { /* Registration failure remains authoritative. */ }
      throw error;
    }
    return detach;
  }
  throw new Error("invalid socket");
}

function frameText(frame, isBinary) {
  if (isBinary === true) throw new Error("binary");
  if (typeof frame === "string") return frame;
  if (Buffer.isBuffer(frame)) return UTF8_DECODER.decode(frame);
  if (frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)) throw new Error("binary");
  if (!frame || typeof frame !== "object" || types.isProxy(frame)) throw new Error("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(frame);
  const dataDescriptor = descriptors.data;
  if (dataDescriptor) {
    if (!("value" in dataDescriptor)) throw new Error("invalid");
    return frameText(dataDescriptor.value, isBinary);
  }
  if (typeof MessageEvent !== "undefined" && Object.getPrototypeOf(frame) === MessageEvent.prototype) {
    return frameText(frame.data, isBinary);
  }
  throw new Error("invalid");
}

class RemoteAppServerClient extends EventEmitter {
  #session;
  #redactions;
  #webSocketFactory;
  #setTimeout;
  #clearTimeout;
  #clientVersion;
  #active = null;
  #startFlight = null;
  #nextRequestId = 1;
  #state = "idle";
  #initialized = false;
  #socketEpoch = 0;
  #pending = new Map();
  #timedOutIds = new Set();
  #incomingRequestIds = new Set();
  #completedIncomingRequestIds = new Set();

  constructor(rawOptions = {}) {
    super();
    const options = validateOptions(rawOptions);
    this.#session = privateSession(options.session);
    const endpoint = new URL(this.#session.endpoint);
    this.#redactions = Object.freeze([
      this.#session.authToken,
      this.#session.endpoint,
      endpoint.origin,
      endpoint.host,
      endpoint.search,
      endpoint.search.slice(1),
      this.#session.provider,
    ].filter(Boolean));
    this.#webSocketFactory = options.webSocketFactory || defaultWebSocketFactory;
    this.#setTimeout = options.setTimeout || setTimeout;
    this.#clearTimeout = options.clearTimeout || clearTimeout;
    this.#clientVersion = options.clientVersion || "1.0.0";
  }

  get runtimeId() {
    return this.#session.runtimeId;
  }

  get generation() {
    return this.#session.generation;
  }

  get state() {
    return this.#state;
  }

  get initialized() {
    return this.#initialized;
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Main-process observers cannot change transport or protocol outcomes.
      }
    }
    return true;
  }

  start() {
    if (this.#initialized && this.#active && !this.#active.terminal) return Promise.resolve();
    if (this.#startFlight) return this.#startFlight;

    this.#state = "connecting";
    this.#initialized = false;
    const epoch = ++this.#socketEpoch;
    let resolveStart;
    let rejectStart;
    const flight = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.#startFlight = flight;

    let socket;
    try {
      socket = this.#webSocketFactory(
        this.#session.endpoint,
        [...SUBPROTOCOLS],
        {
          followRedirects: false,
          handshakeTimeout: DEFAULT_TIMEOUT_MS,
          headers: { Authorization: `Bearer ${this.#session.authToken}` },
          maxPayload: MAX_FRAME_BYTES,
          perMessageDeflate: false,
        },
      );
      if (!socket || typeof socket !== "object" || types.isProxy(socket)) throw new Error("invalid socket");
    } catch (error) {
      const safe = error instanceof RemoteAppServerError
        ? error
        : remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
      this.#state = "offline";
      this.#startFlight = null;
      rejectStart(safe);
      this.emit("offline", safe);
      return flight;
    }

    const connection = {
      socket,
      epoch,
      terminal: false,
      opened: false,
      detach: [],
      openTimer: null,
      acknowledgement: null,
      queuedNotifications: [],
      queuedNotificationBytes: 0,
      terminalError: null,
      resolveStart,
      rejectStart,
    };
    this.#active = connection;

    try {
      if (!this.#registerSocketListener(connection, "close", () => this.#terminal(
        connection,
        remoteError("REMOTE_TRANSPORT_CLOSED", "Remote Codex disconnected."),
        { emitOffline: true, closeSocket: false },
      ))) return flight;
      if (!this.#registerSocketListener(connection, "error", () => this.#terminal(
        connection,
        remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed."),
        { emitOffline: true, closeSocket: true },
      ))) return flight;
      if (!this.#registerSocketListener(
        connection,
        "message",
        (frame, isBinary) => this.#handleMessage(connection, frame, isBinary),
      )) return flight;
      if (!this.#registerSocketListener(connection, "open", () => this.#handleOpen(connection))) return flight;
      if (!connection.opened && this.#socketIsOpen(connection)) this.#handleOpen(connection);
      if (this.#active === connection && !connection.terminal && !connection.opened) {
        const openTimer = this.#scheduleTimer(() => {
          if (this.#active === connection && !connection.terminal && !connection.opened) {
            this.#terminal(
              connection,
              remoteError("REMOTE_HANDSHAKE_TIMEOUT", "Remote Codex connection timed out."),
              { emitOffline: true, closeSocket: true },
            );
          }
        }, DEFAULT_TIMEOUT_MS);
        if (this.#active === connection && !connection.terminal && !connection.opened) {
          connection.openTimer = openTimer;
        } else {
          try { this.#cancelTimer(openTimer); } catch { /* Established state remains authoritative. */ }
        }
      }
    } catch (error) {
      const safe = error instanceof RemoteAppServerError
        ? error
        : remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
      this.#terminal(
        connection,
        safe,
        { emitOffline: true, closeSocket: true },
      );
    }
    return flight;
  }

  stop() {
    const connection = this.#active;
    if (!connection) {
      this.#initialized = false;
      this.#state = "stopped";
      return;
    }
    this.#terminal(
      connection,
      remoteError("REMOTE_CLIENT_STOPPED", "Remote Codex client stopped."),
      { emitOffline: false, closeSocket: true, state: "stopped" },
    );
  }

  request(method, params, timeoutMs) {
    const safeMethod = validateMethod(method);
    const timeout = validateTimeout(safeMethod, timeoutMs);
    const safeParams = params === undefined ? undefined : clonePlain(params, this.#redactions);
    const connection = this.#readyConnection();
    if (!connection) {
      return Promise.reject(remoteError("REMOTE_CLIENT_NOT_READY", "Remote Codex client is not ready."));
    }
    return this.#sendRequest(connection, safeMethod, safeParams, timeout);
  }

  respond(id, result) {
    const connection = this.#requireReadyConnection();
    validateRequestId(id);
    const safeResult = clonePlain(result, this.#redactions);
    const prepared = this.#serializeMessage({ id, result: safeResult });
    if (!this.#incomingRequestIds.has(id)) {
      throw new Error("Remote Codex server request is unknown or stale.");
    }
    this.#incomingRequestIds.delete(id);
    this.#completedIncomingRequestIds.add(id);
    this.#sendPreparedOrThrow(connection, prepared);
  }

  respondError(id, code, message) {
    const connection = this.#requireReadyConnection();
    validateRequestId(id);
    if (!Number.isSafeInteger(code)
      || typeof message !== "string"
      || message.length === 0
      || message !== message.trim()
      || Buffer.byteLength(message) > MAX_ERROR_MESSAGE_BYTES
      || /[\u0000\r\n]/.test(message)) throw payloadError();
    if (isSensitiveString(message, this.#redactions)) throw credentialPayloadError();
    const prepared = this.#serializeMessage({ id, error: { code, message } });
    if (!this.#incomingRequestIds.has(id)) {
      throw new Error("Remote Codex server request is unknown or stale.");
    }
    this.#incomingRequestIds.delete(id);
    this.#completedIncomingRequestIds.add(id);
    this.#sendPreparedOrThrow(connection, prepared);
  }

  sendNotification(method, params) {
    const safeMethod = validateMethod(method);
    const safeParams = params === undefined ? undefined : clonePlain(params, this.#redactions);
    const connection = this.#requireReadyConnection();
    this.#write(connection, safeParams === undefined ? { method: safeMethod } : { method: safeMethod, params: safeParams });
  }

  #readyConnection() {
    const connection = this.#active;
    if (!connection
      || connection.terminal
      || !this.#initialized
      || this.#state !== "ready"
      || connection.epoch !== this.#socketEpoch) return null;
    return connection;
  }

  #requireReadyConnection() {
    const connection = this.#readyConnection();
    if (!connection) throw remoteError("REMOTE_CLIENT_NOT_READY", "Remote Codex client is not ready.");
    return connection;
  }

  #registerSocketListener(connection, eventName, listener) {
    const detach = addSocketListener(connection.socket, eventName, listener);
    if (this.#active === connection && !connection.terminal && connection.epoch === this.#socketEpoch) {
      connection.detach.push(detach);
      return true;
    }
    try { detach(); } catch { /* Terminal registration cleanup is best effort. */ }
    return false;
  }

  #socketIsOpen(connection) {
    let readyState;
    try {
      readyState = connection.socket.readyState;
    } catch {
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
    return readyState === 1;
  }

  #handleOpen(connection) {
    if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) return;
    if (connection.opened) {
      this.#protocolFailure(connection);
      return;
    }
    connection.opened = true;
    if (connection.openTimer !== null) {
      try {
        this.#cancelTimer(connection.openTimer);
      } catch (error) {
        connection.openTimer = null;
        this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
        return;
      }
      connection.openTimer = null;
    }
    if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) return;
    const initialization = this.#sendRequest(connection, "initialize", {
      clientInfo: {
        name: "codex-bot",
        title: "Codex Bot",
        version: this.#clientVersion,
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    }, DEFAULT_TIMEOUT_MS);
    void initialization.then(async () => {
      if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) return;
      try {
        await this.#writeAcknowledged(connection, { method: "initialized" }, DEFAULT_TIMEOUT_MS);
      } catch {
        return;
      }
      if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) return;
      this.#initialized = true;
      this.#state = "ready";
      this.#startFlight = null;
      connection.resolveStart();
      this.emit("ready", deepFreeze({
        runtimeId: this.#session.runtimeId,
        generation: this.#session.generation,
        state: "ready",
      }));
      for (const notification of connection.queuedNotifications) this.emit("notification", notification);
      connection.queuedNotifications.length = 0;
      connection.queuedNotificationBytes = 0;
    }).catch(() => {
      if (this.#active !== connection || connection.terminal) return;
      this.#terminal(
        connection,
        remoteError("REMOTE_INITIALIZE_FAILED", "Remote Codex initialization failed."),
        { emitOffline: true, closeSocket: true },
      );
    });
  }

  #sendRequest(connection, method, params, timeoutMs) {
    if (this.#pending.size >= MAX_PENDING_REQUESTS || !Number.isSafeInteger(this.#nextRequestId)) {
      const error = remoteError("REMOTE_REQUEST_CAPACITY", "Remote Codex request capacity exceeded.");
      this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
      return Promise.reject(error);
    }
    const id = this.#nextRequestId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    const prepared = this.#serializeMessage(message);
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const entry = { connection, method, resolve: resolveRequest, reject: rejectRequest, timer: null };
    let firedSynchronously = false;
    try {
      entry.timer = this.#scheduleTimer(() => {
        if (entry.timer === null) {
          firedSynchronously = true;
          return;
        }
        if (this.#pending.get(id) !== entry) return;
        this.#pending.delete(id);
        if (this.#timedOutIds.size >= MAX_TIMED_OUT_IDS) {
          const error = remoteError("REMOTE_REQUEST_CAPACITY", "Remote Codex request capacity exceeded.");
          entry.reject(error);
          this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
          return;
        }
        this.#timedOutIds.add(id);
        entry.reject(remoteError("REMOTE_REQUEST_TIMEOUT", "Remote Codex request timed out."));
      }, timeoutMs);
    } catch (error) {
      rejectRequest(error);
      this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
      return promise;
    }
    if (firedSynchronously) {
      try { this.#cancelTimer(entry.timer); } catch { /* The stable timer error below governs. */ }
      const error = remoteError("REMOTE_TIMER_ERROR", "Remote Codex timer failed.");
      rejectRequest(error);
      this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
      return promise;
    }
    if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) {
      try { this.#cancelTimer(entry.timer); } catch { /* The established terminal error governs. */ }
      rejectRequest(connection.terminalError || remoteError("REMOTE_CLIENT_NOT_READY", "Remote Codex client is not ready."));
      return promise;
    }
    this.#pending.set(id, entry);
    try {
      this.#sendPreparedOrThrow(connection, prepared);
    } catch (error) {
      if (this.#pending.get(id) === entry) {
        this.#pending.delete(id);
        try { this.#cancelTimer(entry.timer); } catch { /* Terminal cleanup is already in progress. */ }
        entry.reject(error);
      }
    }
    return promise;
  }

  #write(connection, message) {
    this.#sendPreparedOrThrow(connection, this.#serializeMessage(message));
  }

  #writeAcknowledged(connection, message, timeoutMs) {
    const prepared = this.#serializeMessage(message);
    return new Promise((resolve, reject) => {
      const acknowledgement = {
        resolve,
        reject,
        settled: false,
        settling: false,
        timer: null,
        timerAssigned: false,
      };
      connection.acknowledgement = acknowledgement;
      let firedSynchronously = false;
      try {
        acknowledgement.timer = this.#scheduleTimer(() => {
          if (!acknowledgement.timerAssigned) {
            firedSynchronously = true;
            return;
          }
          this.#timeoutAcknowledgement(connection, acknowledgement);
        }, timeoutMs);
        acknowledgement.timerAssigned = true;
        if (acknowledgement.settled) {
          try { this.#cancelTimer(acknowledgement.timer); } catch { /* Established terminal state governs. */ }
          acknowledgement.timer = null;
          return;
        }
        if (firedSynchronously) {
          const error = remoteError("REMOTE_TIMER_ERROR", "Remote Codex timer failed.");
          this.#settleAcknowledgement(connection, acknowledgement, error);
          return;
        }
        if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) {
          this.#settleAcknowledgement(
            connection,
            acknowledgement,
            connection.terminalError || remoteError("REMOTE_CLIENT_NOT_READY", "Remote Codex client is not ready."),
          );
          return;
        }
        this.#sendPreparedOrThrow(connection, prepared, (error) => {
          this.#settleAcknowledgement(connection, acknowledgement, error || null);
        });
      } catch (error) {
        this.#settleAcknowledgement(connection, acknowledgement, error);
      }
    });
  }

  #settleAcknowledgement(connection, acknowledgement, error) {
    if (acknowledgement.settled || acknowledgement.settling) return;
    acknowledgement.settling = true;
    let finalError = error;
    if (acknowledgement.timerAssigned && acknowledgement.timer !== null) {
      try {
        this.#cancelTimer(acknowledgement.timer);
      } catch (timerError) {
        finalError = timerError;
      }
    }
    acknowledgement.timer = null;
    if (!finalError
      && (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch)) {
      finalError = connection.terminalError || remoteError("REMOTE_CLIENT_NOT_READY", "Remote Codex client is not ready.");
    }
    acknowledgement.settled = true;
    acknowledgement.settling = false;
    if (connection.acknowledgement === acknowledgement) connection.acknowledgement = null;
    if (finalError) {
      acknowledgement.reject(finalError);
      if (this.#active === connection && !connection.terminal && connection.epoch === this.#socketEpoch) {
        this.#terminal(connection, finalError, { emitOffline: true, closeSocket: true });
      }
    } else acknowledgement.resolve();
  }

  #timeoutAcknowledgement(connection, acknowledgement) {
    if (acknowledgement.settled || acknowledgement.settling) return;
    const error = remoteError("REMOTE_HANDSHAKE_TIMEOUT", "Remote Codex connection timed out.");
    acknowledgement.timer = null;
    acknowledgement.settled = true;
    if (connection.acknowledgement === acknowledgement) connection.acknowledgement = null;
    acknowledgement.reject(error);
    if (this.#active === connection && !connection.terminal && connection.epoch === this.#socketEpoch) {
      this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
    }
  }

  #abortAcknowledgement(connection, error) {
    const acknowledgement = connection.acknowledgement;
    if (!acknowledgement || acknowledgement.settled || acknowledgement.settling) return;
    acknowledgement.settling = true;
    if (acknowledgement.timerAssigned && acknowledgement.timer !== null) {
      try { this.#cancelTimer(acknowledgement.timer); } catch { /* Terminal error remains authoritative. */ }
    }
    acknowledgement.timer = null;
    acknowledgement.settled = true;
    acknowledgement.settling = false;
    if (connection.acknowledgement === acknowledgement) connection.acknowledgement = null;
    acknowledgement.reject(error);
  }

  #serializeMessage(message) {
    let serialized;
    try {
      serialized = JSON.stringify(message);
    } catch {
      throw payloadError();
    }
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) throw payloadError();
    return { serialized, bytes: Buffer.byteLength(serialized) };
  }

  #sendPreparedOrThrow(connection, prepared, callback) {
    try {
      this.#sendPrepared(connection, prepared, callback);
    } catch (error) {
      const safe = error instanceof RemoteAppServerError
        ? error
        : remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
      this.#terminal(connection, safe, { emitOffline: true, closeSocket: true });
      throw safe;
    }
  }

  #requireActiveConnection(connection) {
    if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) {
      throw connection.terminalError
        || remoteError("REMOTE_CLIENT_NOT_READY", "Remote Codex client is not ready.");
    }
  }

  #sendPrepared(connection, prepared, callback) {
    this.#requireActiveConnection(connection);
    let send;
    try {
      send = connection.socket.send;
    } catch {
      this.#requireActiveConnection(connection);
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
    this.#requireActiveConnection(connection);
    if (typeof send !== "function") {
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
    let bufferedAmount;
    try {
      bufferedAmount = connection.socket.bufferedAmount ?? 0;
    } catch {
      this.#requireActiveConnection(connection);
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
    this.#requireActiveConnection(connection);
    if (!Number.isSafeInteger(bufferedAmount)
      || bufferedAmount < 0) {
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
    if (bufferedAmount + prepared.bytes > MAX_BUFFERED_BYTES) {
      throw remoteError("REMOTE_TRANSPORT_BACKPRESSURE", "Remote Codex transport is backpressured.");
    }
    let callbackCalled = false;
    const complete = (rawError) => {
      if (callbackCalled) return;
      callbackCalled = true;
      if (connection.terminal || this.#active !== connection || connection.epoch !== this.#socketEpoch) {
        callback?.(connection.terminalError || remoteError("REMOTE_CLIENT_STOPPED", "Remote Codex client stopped."));
        return;
      }
      if (rawError) {
        const safe = remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
        this.#terminal(connection, safe, { emitOffline: true, closeSocket: true });
        callback?.(safe);
        return;
      }
      callback?.(null);
    };
    let sendLength;
    try {
      sendLength = send.length;
    } catch {
      this.#requireActiveConnection(connection);
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
    this.#requireActiveConnection(connection);
    try {
      if (sendLength >= 3) {
        this.#requireActiveConnection(connection);
        Reflect.apply(send, connection.socket, [
          prepared.serialized,
          { binary: false, compress: false },
          complete,
        ]);
      } else if (sendLength === 2) {
        this.#requireActiveConnection(connection);
        Reflect.apply(send, connection.socket, [prepared.serialized, complete]);
      } else {
        this.#requireActiveConnection(connection);
        Reflect.apply(send, connection.socket, [prepared.serialized]);
        complete(null);
      }
    } catch {
      this.#requireActiveConnection(connection);
      throw remoteError("REMOTE_TRANSPORT_ERROR", "Remote Codex transport failed.");
    }
  }

  #scheduleTimer(callback, delay) {
    try {
      return this.#setTimeout(callback, delay);
    } catch {
      throw remoteError("REMOTE_TIMER_ERROR", "Remote Codex timer failed.");
    }
  }

  #cancelTimer(timer) {
    try {
      this.#clearTimeout(timer);
    } catch {
      throw remoteError("REMOTE_TIMER_ERROR", "Remote Codex timer failed.");
    }
  }

  #handleMessage(connection, frame, isBinary) {
    if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) return;
    let message;
    let frameBytes;
    try {
      const text = frameText(frame, isBinary);
      frameBytes = Buffer.byteLength(text);
      if (frameBytes > MAX_FRAME_BYTES) throw new Error("oversized");
      const parsed = JSON.parse(text);
      message = deepFreeze(sanitizeIncoming(
        parsed,
        this.#redactions,
      ));
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("shape");
    } catch {
      this.#protocolFailure(connection);
      return;
    }
    this.#routeMessage(connection, message, frameBytes);
  }

  #routeMessage(connection, message, frameBytes) {
    const keys = Object.keys(message);
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    const hasGeneration = Object.hasOwn(message, "generation");
    if (hasGeneration && message.generation !== this.#session.generation) {
      this.#protocolFailure(connection);
      return;
    }
    const allowedExtra = hasGeneration ? 1 : 0;

    if (hasId && (hasResult || hasError)) {
      if (!Number.isSafeInteger(message.id)
        || message.id <= 0
        || hasMethod
        || hasResult === hasError
        || keys.length !== 2 + allowedExtra) {
        this.#protocolFailure(connection);
        return;
      }
      const entry = this.#pending.get(message.id);
      if (!entry) {
        if (this.#timedOutIds.delete(message.id)) return;
        this.#protocolFailure(connection);
        return;
      }
      if (entry.connection !== connection) return;
      try {
        this.#cancelTimer(entry.timer);
      } catch (error) {
        this.#pending.delete(message.id);
        entry.reject(error);
        this.#terminal(connection, error, { emitOffline: true, closeSocket: true });
        return;
      }
      if (this.#active !== connection
        || connection.terminal
        || connection.epoch !== this.#socketEpoch
        || this.#pending.get(message.id) !== entry) return;
      this.#pending.delete(message.id);
      if (hasError) entry.reject(remoteError("REMOTE_REQUEST_FAILED", "Remote Codex request failed."));
      else entry.resolve(message.result);
      return;
    }

    if (hasId && hasMethod) {
      if (!this.#initialized
        || !Number.isSafeInteger(message.id)
        || message.id < 0
        || typeof message.method !== "string"
        || !METHOD_PATTERN.test(message.method)
        || !SERVER_REQUEST_METHODS.has(message.method)
        || hasResult
        || hasError
        || keys.some((key) => !["generation", "id", "method", "params"].includes(key))
        || this.#incomingRequestIds.has(message.id)
        || this.#completedIncomingRequestIds.has(message.id)) {
        this.#protocolFailure(connection);
        return;
      }
      if (this.#incomingRequestIds.size + this.#completedIncomingRequestIds.size >= MAX_INCOMING_REQUESTS
        || this.#completedIncomingRequestIds.size >= MAX_COMPLETED_INCOMING_REQUESTS) {
        this.#capacityFailure(connection);
        return;
      }
      this.#incomingRequestIds.add(message.id);
      this.emit("server-request", message);
      return;
    }

    if (!hasId && hasMethod) {
      if (typeof message.method !== "string"
        || !METHOD_PATTERN.test(message.method)
        || hasResult
        || hasError
        || keys.some((key) => !["generation", "method", "params"].includes(key))) {
        this.#protocolFailure(connection);
        return;
      }
      if (!this.#initialized) {
        if (connection.queuedNotifications.length >= MAX_PREINIT_NOTIFICATIONS
          || connection.queuedNotificationBytes + frameBytes > MAX_PREINIT_NOTIFICATION_BYTES) {
          this.#capacityFailure(connection);
          return;
        }
        connection.queuedNotifications.push(message);
        connection.queuedNotificationBytes += frameBytes;
      } else this.emit("notification", message);
      return;
    }

    this.#protocolFailure(connection);
  }

  #protocolFailure(connection) {
    this.#terminal(
      connection,
      remoteError("REMOTE_PROTOCOL_ERROR", "Remote Codex protocol error."),
      { emitOffline: true, closeSocket: true },
    );
  }

  #capacityFailure(connection) {
    this.#terminal(
      connection,
      remoteError("REMOTE_PROTOCOL_CAPACITY", "Remote Codex protocol capacity exceeded."),
      { emitOffline: true, closeSocket: true },
    );
  }

  #terminal(connection, error, { emitOffline, closeSocket, state = "offline" }) {
    if (this.#active !== connection || connection.terminal || connection.epoch !== this.#socketEpoch) return;
    connection.terminal = true;
    connection.terminalError = error;
    this.#active = null;
    this.#initialized = false;
    this.#state = state;
    this.#startFlight = null;
    this.#abortAcknowledgement(connection, error);
    if (connection.openTimer !== null) {
      try { this.#cancelTimer(connection.openTimer); } catch { /* Terminal state already governs. */ }
      connection.openTimer = null;
    }
    for (const detach of connection.detach.splice(0)) {
      try { detach(); } catch { /* Ignore hostile socket cleanup. */ }
    }
    try {
      if (typeof connection.socket.on === "function") {
        connection.socket.on("error", () => {});
      } else if (typeof connection.socket.addEventListener === "function") {
        connection.socket.addEventListener("error", () => {});
      }
    } catch {
      // A terminal socket gets one inert error sink so late EventEmitter errors
      // cannot become process-level exceptions after functional listeners detach.
    }
    for (const [id, entry] of this.#pending) {
      if (entry.connection !== connection) continue;
      this.#pending.delete(id);
      try { this.#cancelTimer(entry.timer); } catch { /* Terminal state already governs. */ }
      entry.reject(error);
    }
    this.#timedOutIds.clear();
    this.#incomingRequestIds.clear();
    this.#completedIncomingRequestIds.clear();
    connection.queuedNotifications.length = 0;
    connection.queuedNotificationBytes = 0;
    connection.rejectStart(error);
    if (closeSocket) {
      try {
        if (typeof connection.socket.close === "function") connection.socket.close();
      } catch {
        // Terminal cleanup never exposes a raw socket error.
      }
    }
    if (emitOffline) this.emit("offline", error);
  }

}

module.exports = {
  RemoteAppServerClient,
};
