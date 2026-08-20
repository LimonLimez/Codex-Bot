const { isIP } = require("node:net");
const { types } = require("node:util");

const LEGACY_METHODS = Object.freeze([
  "capabilities",
  "provision",
  "inspect",
  "retire",
  "subscribe",
]);

const ENHANCED_METHODS = Object.freeze([
  "capabilities",
  "provision",
  "inspect",
  "retire",
  "inspectIssuance",
  "retireIssuance",
  "subscribe",
]);

const CAPABILITY_NAMES = Object.freeze([
  "provision",
  "reconcile",
  "retire",
  "remoteAppServer",
  "computerFrames",
  "issuanceFencedRetire",
]);

const PROVISION_STATES = new Set(["ready", "provisioning"]);
const RETIRE_STATES = new Set(["retired", "detached"]);
const ISSUANCE_STATES = new Set(["ready", "provisioning", "reconnecting", "retiring", "retired", "detached"]);
const PROVIDER_FAILURE = "Remote runtime provider failed.";
const UNAVAILABLE = "Remote computer unavailable.";
const MAX_PROVIDER_DATA_DEPTH = 24;
const MAX_PROVIDER_DATA_FIELDS = 256;
const MAX_PROVIDER_DATA_NODES = 4_096;
const MAX_PROVIDER_STRING_BYTES = 65_536;
const MAX_PROVIDER_TOTAL_STRING_BYTES = 262_144;
const providerContractVersions = new WeakMap();
const MAX_PROVIDER_IDENTIFIER_BYTES = 256;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ISSUANCE_KEY_PATTERN = new RegExp(`^issuance-${CANONICAL_UUID}$`);
const RETIREMENT_KEY_PATTERN = new RegExp(`^retire-${CANONICAL_UUID}$`);

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactDataDescriptors(value, label, expectedKeys) {
  requiredObject(value, label);
  if (types.isProxy(value)) throw sanitizedProviderFailure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw sanitizedProviderFailure();
  }
  if (!intrinsicObjectPrototype(prototype)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (expectedKeys && (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)))) {
    throw new TypeError(`${label} has invalid fields.`);
  }
  for (const key of expectedKeys || keys) {
    if (!(key in descriptors) || !("value" in descriptors[key])) {
      throw sanitizedProviderFailure();
    }
  }
  return descriptors;
}

function exactProviderTopology(provider) {
  requiredObject(provider, "provider");
  if (types.isProxy(provider)) throw sanitizedProviderFailure();
  let descriptors;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(provider);
    descriptors = Object.getOwnPropertyDescriptors(provider);
  } catch {
    throw sanitizedProviderFailure();
  }
  if (!intrinsicObjectPrototype(prototype)) throw sanitizedProviderFailure();

  const keys = Reflect.ownKeys(descriptors);
  const requiredMissing = LEGACY_METHODS.find((method) => !descriptors[method]);
  if (requiredMissing) {
    throw new TypeError(`Remote runtime provider must implement ${requiredMissing}().`);
  }
  for (const method of LEGACY_METHODS) {
    const descriptor = descriptors[method];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      if (descriptor && !("value" in descriptor)) throw sanitizedProviderFailure();
      throw new TypeError(`Remote runtime provider must implement ${method}().`);
    }
  }

  const hasInspectIssuance = Boolean(descriptors.inspectIssuance);
  const hasRetireIssuance = Boolean(descriptors.retireIssuance);
  if (hasInspectIssuance !== hasRetireIssuance) {
    throw new TypeError("Remote runtime provider issuance methods must be paired.");
  }
  const version = hasInspectIssuance ? 2 : 1;
  const expected = version === 2 ? ENHANCED_METHODS : LEGACY_METHODS;
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    throw new TypeError("Remote runtime provider has an invalid method topology.");
  }
  if (version === 2) {
    for (const method of ["inspectIssuance", "retireIssuance"]) {
      const descriptor = descriptors[method];
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`Remote runtime provider must implement ${method}().`);
      }
    }
  }
  return version;
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_IDENTIFIER_BYTES) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredSafeIdentifier(value, label) {
  const normalized = requiredIdentifier(value, label);
  if (!SAFE_IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a safe identifier.`);
  }
  return normalized;
}

function requiredCanonicalKey(value, label, pattern) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new TypeError(`${label} must be canonical.`);
  }
  const normalized = requiredIdentifier(value, label);
  if (!pattern.test(normalized)) throw new TypeError(`${label} must be canonical.`);
  return normalized;
}

function optionalOperationSignal(input) {
  if (input === undefined) return undefined;
  requiredObject(input, "provider operation input");
  const descriptor = Object.getOwnPropertyDescriptor(input, "signal");
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !(descriptor.value instanceof AbortSignal)) {
    throw new TypeError("Provider operation signal is invalid.");
  }
  return descriptor.value;
}

function providerOperationInput(fields, signal) {
  const input = { ...fields };
  if (signal !== undefined) {
    Object.defineProperty(input, "signal", {
      value: signal,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(input);
}

function sanitizedProviderFailure() {
  return new Error(PROVIDER_FAILURE);
}

async function invoke(provider, method, input) {
  try {
    return await provider[method].call(provider, input);
  } catch {
    throw sanitizedProviderFailure();
  }
}

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
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const value = ipv4Integer(normalized);
    return NON_PUBLIC_IPV4_CIDRS.some(([base, prefix]) => (
      ipv4MatchesCidr(value, ipv4Integer(base), prefix)
    ));
  }
  if (ipVersion === 6) {
    const value = ipv6Integer(normalized);
    if (value === null || (value >> 125n) !== 1n) return true;
    return ipv6MatchesCidr(value, ipv6Integer("2001::"), 23)
      || ipv6MatchesCidr(value, ipv6Integer("2001:db8::"), 32)
      || ipv6MatchesCidr(value, ipv6Integer("3ffe::"), 16);
  }
  return false;
}

function validateRemoteEndpoint(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Provider must return a remote wss endpoint.");
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Provider must return a remote wss endpoint.");
  }

  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  if (
    endpoint.protocol !== "wss:"
    || !hostname
    || endpoint.username
    || endpoint.password
    || hostname.endsWith(".local")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || isNonPublicIpLiteral(hostname)
  ) {
    throw new Error("Provider must return a remote wss endpoint.");
  }
  return value;
}

function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("credential")
    || normalized.includes("authorization")
    || normalized.includes("apikey")
    || normalized.includes("cookie")) return true;
  if (!normalized.includes("token")) return false;
  if (/(?:auth(?:entication)?|access|refresh|bearer|session|api)tokens?/.test(normalized)) return true;
  if (normalized === "token" || normalized === "tokens") return true;
  if (normalized.includes("tokenusage")) return false;
  if (/^(?:total|input|output|maxoutput|cachedinput|cached|reasoning|visible|lifetime|context|prompt|completion)tokens?$/.test(normalized)) {
    return false;
  }
  if (/^(?:total|input|output|cachedinput|cached|reasoning|context|prompt|completion)?tokencount$/.test(normalized)) {
    return false;
  }
  return true;
}

function containsSecretMaterial(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const nested = value[key];
    if (isSecretKey(key) || containsSecretMaterial(nested, seen)) return true;
  }
  return false;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function intrinsicObjectPrototype(prototype) {
  if (prototype === null || prototype === Object.prototype) return true;
  try {
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const actual = Object.getOwnPropertyDescriptors(prototype);
    const expected = Object.getOwnPropertyDescriptors(Object.prototype);
    const actualKeys = Reflect.ownKeys(actual);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(actual, key))) return false;
    return expectedKeys.every((key) => {
      const left = actual[key];
      const right = expected[key];
      if (left.enumerable !== right.enumerable || left.configurable !== right.configurable) return false;
      if ("value" in right) {
        if (!("value" in left) || left.writable !== right.writable) return false;
        if (typeof right.value === "function") {
          return typeof left.value === "function"
            && Function.prototype.toString.call(left.value) === Function.prototype.toString.call(right.value);
        }
        return left.value === right.value;
      }
      return !("value" in left)
        && Function.prototype.toString.call(left.get) === Function.prototype.toString.call(right.get)
        && Function.prototype.toString.call(left.set) === Function.prototype.toString.call(right.set);
    });
  } catch {
    return false;
  }
}

function intrinsicArrayPrototype(prototype) {
  if (prototype === Array.prototype) return true;
  try {
    if (!intrinsicObjectPrototype(Object.getPrototypeOf(prototype))) return false;
    const actual = Object.getOwnPropertyDescriptors(prototype);
    const expected = Object.getOwnPropertyDescriptors(Array.prototype);
    const actualKeys = Reflect.ownKeys(actual);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(actual, key))) return false;
    return expectedKeys.every((key) => {
      const left = actual[key];
      const right = expected[key];
      if (left.enumerable !== right.enumerable || left.configurable !== right.configurable) return false;
      if ("value" in right) {
        if (!("value" in left) || left.writable !== right.writable) return false;
        if (typeof right.value === "function") {
          return typeof left.value === "function"
            && Function.prototype.toString.call(left.value) === Function.prototype.toString.call(right.value);
        }
        return left.value === right.value;
      }
      return false;
    });
  } catch {
    return false;
  }
}

function cloneProviderData(value, seen, budget, depth = 0) {
  if (value && typeof value === "object") {
    if (types.isProxy(value)) throw new TypeError("Provider data cannot contain proxies.");
    if (seen.has(value)) return seen.get(value);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_PROVIDER_DATA_NODES || depth > MAX_PROVIDER_DATA_DEPTH) {
    throw new TypeError("Provider data exceeds bounded complexity.");
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    budget.stringBytes += bytes;
    if (bytes > MAX_PROVIDER_STRING_BYTES
      || budget.stringBytes > MAX_PROVIDER_TOTAL_STRING_BYTES) {
      throw new TypeError("Provider data exceeds bounded size.");
    }
    return value;
  }
  if (value === null || ["undefined", "string", "number", "boolean", "bigint"].includes(typeof value)) {
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Provider data must contain values only.");

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && !intrinsicArrayPrototype(prototype))
    || (!array && !intrinsicObjectPrototype(prototype))) {
    throw new TypeError("Provider data must use plain objects and arrays.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_PROVIDER_DATA_FIELDS
    || (array && descriptors.length?.value > MAX_PROVIDER_DATA_FIELDS)
    || keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Provider data cannot contain symbol fields.");
  }
  for (const key of keys) {
    if (!("value" in descriptors[key])) throw new TypeError("Provider data cannot contain accessors.");
  }

  const clone = array ? [] : Object.create(prototype === null ? null : Object.prototype);
  seen.set(value, clone);
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    Object.defineProperty(clone, key, {
      value: cloneProviderData(descriptor.value, seen, budget, depth + 1),
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    });
  }
  if (array) clone.length = descriptors.length.value;
  return clone;
}

function detachProviderData(value) {
  try {
    return cloneProviderData(value, new Map(), { nodes: 0, stringBytes: 0 });
  } catch {
    throw sanitizedProviderFailure();
  }
}

function requiredProviderMethod(provider, method) {
  let implementation;
  try {
    implementation = provider[method];
  } catch {
    throw sanitizedProviderFailure();
  }
  if (typeof implementation !== "function") {
    throw new TypeError(`Remote runtime provider must implement ${method}().`);
  }
}

function frozenProvisionResult(raw, expectedBotId, version, expectedIssuanceKey = undefined) {
  requiredObject(raw, "provision result");
  if (version === 2) {
    exactDataDescriptors(raw, "provision result", [
      "provider",
      "runtimeId",
      "ownerBotId",
      "issuanceKey",
      "endpoint",
      "authToken",
      "state",
    ]);
  }
  const provider = requiredSafeIdentifier(raw.provider, "provider");
  const runtimeId = requiredSafeIdentifier(raw.runtimeId, "runtimeId");
  const ownerBotId = requiredIdentifier(raw.ownerBotId, "ownerBotId");
  if (ownerBotId !== expectedBotId) throw new Error("Provider returned a mismatched ownerBotId.");
  const endpoint = validateRemoteEndpoint(raw.endpoint);
  const authToken = requiredIdentifier(raw.authToken, "authToken");
  const issuanceKey = version === 2
    ? requiredCanonicalKey(raw.issuanceKey, "issuanceKey", ISSUANCE_KEY_PATTERN)
    : undefined;
  if (version === 2 && issuanceKey !== expectedIssuanceKey) {
    throw new Error("Provider returned a mismatched issuanceKey.");
  }
  if (!PROVISION_STATES.has(raw.state)) {
    throw new Error("Provider returned an invalid provision state.");
  }

  const result = version === 2
    ? {
      provider,
      runtimeId,
      ownerBotId,
      issuanceKey,
      endpoint,
      state: raw.state,
    }
    : {
      provider,
      runtimeId,
      ownerBotId,
      endpoint,
      state: raw.state,
    };
  Object.defineProperty(result, "authToken", {
    value: authToken,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}

function frozenIssuanceResult(raw, expected, method) {
  const matchedDescriptors = exactDataDescriptors(raw, `${method} result`);
  if (!matchedDescriptors.matched || !("value" in matchedDescriptors.matched)) {
    throw new Error(`${method} result is invalid.`);
  }
  const keys = Reflect.ownKeys(matchedDescriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error(`${method} result is invalid.`);
  }
  const keySet = keys.sort().join(",");
  const matched = matchedDescriptors.matched.value;
  if (matched === false) {
    if (keySet !== "matched,runtimeId,state"
      || matchedDescriptors.runtimeId.value !== expected.runtimeId
      || matchedDescriptors.state.value !== "superseded") {
      throw new Error(`${method} result is invalid.`);
    }
    return Object.freeze({
      matched: false,
      runtimeId: expected.runtimeId,
      state: "superseded",
    });
  }
  if (matched !== true
    || keySet !== "issuanceKey,matched,ownerBotId,runtimeId,state"
    || matchedDescriptors.runtimeId.value !== expected.runtimeId
    || matchedDescriptors.ownerBotId.value !== expected.ownerBotId
    || matchedDescriptors.issuanceKey.value !== expected.issuanceKey
    || !ISSUANCE_STATES.has(matchedDescriptors.state.value)) {
    throw new Error(`${method} result is invalid.`);
  }
  return Object.freeze({
    matched: true,
    runtimeId: expected.runtimeId,
    ownerBotId: expected.ownerBotId,
    issuanceKey: expected.issuanceKey,
    state: matchedDescriptors.state.value,
  });
}

function frozenInspectResult(raw, expectedRuntimeId) {
  requiredObject(raw, "inspect result");
  if (containsSecretMaterial(raw)) {
    throw new Error("Provider inspect result contains secret material.");
  }
  const runtimeId = requiredSafeIdentifier(raw.runtimeId, "runtimeId");
  if (runtimeId !== expectedRuntimeId) throw new Error("Provider returned a mismatched runtimeId.");
  const ownerBotId = requiredIdentifier(raw.ownerBotId, "ownerBotId");
  const state = requiredIdentifier(raw.state, "state");
  return Object.freeze({ runtimeId, ownerBotId, state });
}

function frozenRetireResult(raw, expectedRuntimeId) {
  requiredObject(raw, "retire result");
  if (containsSecretMaterial(raw)) {
    throw new Error("Provider retire result contains secret material.");
  }
  const runtimeId = requiredSafeIdentifier(raw.runtimeId, "runtimeId");
  if (runtimeId !== expectedRuntimeId) throw new Error("Provider returned a mismatched runtimeId.");
  if (!RETIRE_STATES.has(raw.state)) {
    throw new Error('Provider retire state must be "retired" or "detached".');
  }
  return Object.freeze({ runtimeId, state: raw.state });
}

function exactIssuanceInput(input, fields, label) {
  if (input === undefined) throw new TypeError(`${label} is required.`);
  const descriptors = exactDataDescriptors(input, label);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...fields, "signal"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has invalid fields.`);
  }
  if (keys.length !== fields.length && !(keys.length === fields.length + 1 && descriptors.signal)) {
    throw new TypeError(`${label} has invalid fields.`);
  }
  for (const field of fields) {
    if (!descriptors[field]) throw new TypeError(`${label} is missing ${field}.`);
  }
  const signal = descriptors.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("Provider operation signal is invalid.");
  }
  const values = Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
  return Object.freeze({ values, signal });
}

function validateProvider(provider) {
  const version = exactProviderTopology(provider);
  const wrapper = {
    async capabilities(input) {
      const signal = optionalOperationSignal(input);
      const raw = requiredObject(
        detachProviderData(await invoke(
          provider,
          "capabilities",
          signal === undefined ? undefined : providerOperationInput({}, signal),
        )),
        "provider capabilities",
      );
      for (const name of CAPABILITY_NAMES.slice(0, -1)) {
        if (raw[name] !== true) {
          throw new Error(`Remote runtime provider capability ${name} must be true.`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(raw, "issuanceFencedRetire")
        && typeof raw.issuanceFencedRetire !== "boolean") {
        throw new Error("Remote runtime provider capability issuanceFencedRetire must be boolean.");
      }
      if (version === 2 && raw.issuanceFencedRetire !== true) {
        throw new Error("Remote runtime provider capability issuanceFencedRetire must be true.");
      }
      if (version === 1 && raw.issuanceFencedRetire === true) {
        throw new Error("Remote runtime provider capability issuanceFencedRetire disagrees with provider topology.");
      }
      return Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map((name) => [
        name,
        name === "issuanceFencedRetire" ? version === 2 : true,
      ])));
    },

    async provision(input) {
      requiredObject(input, "provision input");
      let fields;
      let signal;
      if (version === 2) {
        const normalized = exactIssuanceInput(
          input,
          ["botId", "idempotencyKey", "issuanceKey"],
          "provision input",
        );
        fields = {
          botId: requiredIdentifier(normalized.values.botId, "botId"),
          idempotencyKey: requiredIdentifier(normalized.values.idempotencyKey, "idempotencyKey"),
          issuanceKey: requiredCanonicalKey(normalized.values.issuanceKey, "issuanceKey", ISSUANCE_KEY_PATTERN),
        };
        signal = normalized.signal;
      } else {
        const botId = requiredIdentifier(input.botId, "botId");
        const idempotencyKey = requiredIdentifier(input.idempotencyKey, "idempotencyKey");
        signal = optionalOperationSignal(input);
        fields = { botId, idempotencyKey };
      }
      const raw = detachProviderData(
        await invoke(provider, "provision", providerOperationInput(fields, signal)),
      );
      return frozenProvisionResult(raw, fields.botId, version, fields.issuanceKey);
    },

    async inspect(input) {
      requiredObject(input, "inspect input");
      const runtimeId = requiredSafeIdentifier(input.runtimeId, "runtimeId");
      const signal = optionalOperationSignal(input);
      const raw = detachProviderData(
        await invoke(provider, "inspect", providerOperationInput({ runtimeId }, signal)),
      );
      return frozenInspectResult(raw, runtimeId);
    },

    async retire(input) {
      requiredObject(input, "retire input");
      const runtimeId = requiredSafeIdentifier(input.runtimeId, "runtimeId");
      const signal = optionalOperationSignal(input);
      const raw = detachProviderData(
        await invoke(provider, "retire", providerOperationInput({ runtimeId }, signal)),
      );
      return frozenRetireResult(raw, runtimeId);
    },

    subscribe(callback) {
      if (typeof callback !== "function") {
        throw new TypeError("Remote runtime subscription callback must be a function.");
      }
      let unsubscribe;
      let contractFailure = null;
      let active = true;
      try {
        unsubscribe = provider.subscribe.call(provider, (rawEvent) => {
          if (!active) return;
          try {
            // Inspect the provider-owned event descriptors before detaching any
            // values. V2's issuance fence is the private identity that keeps a
            // late event from a superseded runtime distinguishable from the
            // current issuance sharing its runtimeId.
            const rawDescriptors = exactDataDescriptors(rawEvent, "subscription event");
            if (version === 2) {
              if (!rawDescriptors.issuanceKey
                || !rawDescriptors.issuanceKey.enumerable
                || !("value" in rawDescriptors.issuanceKey)) {
                throw new TypeError("subscription event must include an issuanceKey.");
              }
              requiredCanonicalKey(
                rawDescriptors.issuanceKey.value,
                "issuanceKey",
                ISSUANCE_KEY_PATTERN,
              );
            }
            const event = detachProviderData(rawEvent);
            requiredObject(event, "subscription event");
            if (containsSecretMaterial(event)) {
              throw new Error("Provider subscription event contains secret material.");
            }
            requiredSafeIdentifier(event.runtimeId, "runtimeId");
            if (version === 2) {
              requiredCanonicalKey(event.issuanceKey, "issuanceKey", ISSUANCE_KEY_PATTERN);
            }
            callback(deepFreeze(event));
          } catch (error) {
            contractFailure = error;
            throw error;
          }
        });
      } catch (error) {
        active = false;
        if (error === contractFailure) throw error;
        throw sanitizedProviderFailure();
      }
      if (typeof unsubscribe !== "function") {
        active = false;
        throw new Error("Remote runtime provider subscription must return an unsubscribe function.");
      }
      return () => {
        if (!active) return undefined;
        active = false;
        const retireSubscription = unsubscribe;
        unsubscribe = null;
        try {
          return retireSubscription();
        } catch {
          throw sanitizedProviderFailure();
        }
      };
    },
  };

  if (version === 2) {
    wrapper.inspectIssuance = async (input) => {
      const normalized = exactIssuanceInput(
        input,
        ["runtimeId", "ownerBotId", "issuanceKey"],
        "inspectIssuance input",
      );
      const expected = {
        runtimeId: requiredSafeIdentifier(normalized.values.runtimeId, "runtimeId"),
        ownerBotId: requiredIdentifier(normalized.values.ownerBotId, "ownerBotId"),
        issuanceKey: requiredCanonicalKey(normalized.values.issuanceKey, "issuanceKey", ISSUANCE_KEY_PATTERN),
      };
      const raw = detachProviderData(await invoke(
        provider,
        "inspectIssuance",
        providerOperationInput(expected, normalized.signal),
      ));
      return frozenIssuanceResult(raw, expected, "inspectIssuance");
    };
    wrapper.retireIssuance = async (input) => {
      const normalized = exactIssuanceInput(
        input,
        ["runtimeId", "ownerBotId", "issuanceKey", "retirementKey"],
        "retireIssuance input",
      );
      const expected = {
        runtimeId: requiredSafeIdentifier(normalized.values.runtimeId, "runtimeId"),
        ownerBotId: requiredIdentifier(normalized.values.ownerBotId, "ownerBotId"),
        issuanceKey: requiredCanonicalKey(normalized.values.issuanceKey, "issuanceKey", ISSUANCE_KEY_PATTERN),
      };
      const retirementKey = requiredCanonicalKey(
        normalized.values.retirementKey,
        "retirementKey",
        RETIREMENT_KEY_PATTERN,
      );
      const raw = detachProviderData(await invoke(
        provider,
        "retireIssuance",
        providerOperationInput({ ...expected, retirementKey }, normalized.signal),
      ));
      return frozenIssuanceResult(raw, expected, "retireIssuance");
    };
  }

  const orderedWrapper = version === 2
    ? {
      capabilities: wrapper.capabilities,
      provision: wrapper.provision,
      inspect: wrapper.inspect,
      retire: wrapper.retire,
      inspectIssuance: wrapper.inspectIssuance,
      retireIssuance: wrapper.retireIssuance,
      subscribe: wrapper.subscribe,
    }
    : wrapper;
  const validated = Object.freeze(orderedWrapper);
  providerContractVersions.set(validated, version);
  return validated;
}

function providerContractVersion(provider) {
  return providerContractVersions.get(provider) ?? null;
}

function unavailableProvider() {
  const capabilities = Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, false])));
  const rejectUnavailable = async () => {
    throw new Error(UNAVAILABLE);
  };

  return Object.freeze({
    async capabilities() {
      return capabilities;
    },
    provision: rejectUnavailable,
    inspect: rejectUnavailable,
    retire: rejectUnavailable,
    subscribe(callback) {
      if (typeof callback !== "function") {
        throw new TypeError("Remote runtime subscription callback must be a function.");
      }
      return () => {};
    },
  });
}

module.exports = {
  providerContractVersion,
  validateProvider,
  unavailableProvider,
};
