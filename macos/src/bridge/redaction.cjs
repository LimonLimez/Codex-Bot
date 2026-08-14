"use strict";

const SAFE_USAGE_KEYS = new Set([
  "inputtokens",
  "outputtokens",
  "prompttokens",
  "completiontokens",
  "totaltokens",
  "lasttokenusage",
  "tokenusage",
  "tokenusagebreakdown",
]);
const SENSITIVE_KEY =
  /^(?:authorization|proxyauthorization|auth|apikey|accesstoken|refreshtoken|idtoken|password|passwd|secret|credential|cookie|endpoint|url|uri|path|providerdiagnostic|headers?)/;
const MAX_TEXT = 4_000;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactText(value, secrets = []) {
  let text;
  try {
    text = String(value ?? "");
  } catch {
    return "[Untrusted diagnostic]";
  }
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    text = text.replace(
      new RegExp(escapeRegularExpression(secret), "g"),
      "[REDACTED]",
    );
  }
  text = text.replace(
    /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g,
    "Authorization: [REDACTED]",
  );
  text = text.replace(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
    "[REDACTED CREDENTIAL]",
  );
  text = text.replace(
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
    "[REDACTED]",
  );
  text = text.replace(
    /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|credential|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "[REDACTED CREDENTIAL]",
  );
  text = text.replace(
    /https?:\/\/(?:[^\s/@]+(?::[^\s/@]*)?@)?[^\s/"'<>]+(?:\/[^\s"'<>]*)?/gi,
    "[REDACTED URL]",
  );
  text = text.replace(
    /(?:\/Users\/[^/\s]+|\/private\/tmp|\/var\/folders)\/[^\s,;"']*/g,
    "[REDACTED PATH]",
  );
  return text.slice(0, MAX_TEXT);
}

function keyIsSensitive(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SAFE_USAGE_KEYS.has(normalized)) return false;
  return SENSITIVE_KEY.test(normalized);
}

function cloneDiagnostic(value, secrets, seen, depth) {
  if (typeof value === "string") return redactText(value, secrets);
  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return "[Unsupported diagnostic]";
  if (depth > MAX_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";

  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return "[Untrusted diagnostic]";
  }
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    prototype !== Array.prototype
  ) {
    return "[Untrusted diagnostic]";
  }
  const descriptorEntries = Object.entries(descriptors);
  if (
    descriptorEntries.some(
      ([, descriptor]) =>
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function" ||
        !("value" in descriptor),
    )
  ) {
    return "[Untrusted diagnostic]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const output = descriptorEntries
      .filter(([key]) => /^(?:0|[1-9]\d*)$/.test(key))
      .sort((left, right) => Number(left[0]) - Number(right[0]))
      .slice(0, MAX_ENTRIES)
      .map(([, descriptor]) =>
        cloneDiagnostic(descriptor.value, secrets, seen, depth + 1),
      );
    seen.delete(value);
    return Object.freeze(output);
  }

  const output = Object.create(null);
  for (const [key, descriptor] of descriptorEntries.slice(0, MAX_ENTRIES)) {
    if (keyIsSensitive(key)) continue;
    output[key] = cloneDiagnostic(
      descriptor.value,
      secrets,
      seen,
      depth + 1,
    );
  }
  seen.delete(value);
  return Object.freeze(output);
}

function sanitizeDetails(value, secrets = []) {
  return cloneDiagnostic(value, secrets, new WeakSet(), 0);
}

class CodexBridgeError extends Error {
  constructor() {
    super("Codex bridge request failed.");
    this.name = "CodexBridgeError";
    this.code = "CODEX_BRIDGE_FAILED";
  }
}

function sanitizeError() {
  return new CodexBridgeError();
}

module.exports = {
  CodexBridgeError,
  redactText,
  sanitizeDetails,
  sanitizeError,
};
