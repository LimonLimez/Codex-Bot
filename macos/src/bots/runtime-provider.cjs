const { isIP } = require("node:net");
const { types } = require("node:util");

const REQUIRED_METHODS = Object.freeze([
  "capabilities",
  "provision",
  "inspect",
  "retire",
  "subscribe",
]);

const CAPABILITY_NAMES = Object.freeze([
  "provision",
  "reconcile",
  "retire",
  "remoteAppServer",
  "computerFrames",
]);

const PROVISION_STATES = new Set(["ready", "provisioning"]);
const RETIRE_STATES = new Set(["retired", "detached"]);
const PROVIDER_FAILURE = "Remote runtime provider failed.";
const UNAVAILABLE = "Remote computer unavailable.";
const MAX_PROVIDER_DATA_DEPTH = 24;
const MAX_PROVIDER_DATA_FIELDS = 256;
const MAX_PROVIDER_DATA_NODES = 4_096;
const MAX_PROVIDER_STRING_BYTES = 65_536;
const MAX_PROVIDER_TOTAL_STRING_BYTES = 262_144;

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requiredIdentifier(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
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
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) {
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

function frozenProvisionResult(raw, expectedBotId) {
  requiredObject(raw, "provision result");
  const provider = requiredIdentifier(raw.provider, "provider");
  const runtimeId = requiredIdentifier(raw.runtimeId, "runtimeId");
  const ownerBotId = requiredIdentifier(raw.ownerBotId, "ownerBotId");
  if (ownerBotId !== expectedBotId) throw new Error("Provider returned a mismatched ownerBotId.");
  const endpoint = validateRemoteEndpoint(raw.endpoint);
  const authToken = requiredIdentifier(raw.authToken, "authToken");
  if (!PROVISION_STATES.has(raw.state)) {
    throw new Error("Provider returned an invalid provision state.");
  }

  const result = {
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

function frozenInspectResult(raw, expectedRuntimeId) {
  requiredObject(raw, "inspect result");
  if (containsSecretMaterial(raw)) {
    throw new Error("Provider inspect result contains secret material.");
  }
  const runtimeId = requiredIdentifier(raw.runtimeId, "runtimeId");
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
  const runtimeId = requiredIdentifier(raw.runtimeId, "runtimeId");
  if (runtimeId !== expectedRuntimeId) throw new Error("Provider returned a mismatched runtimeId.");
  if (!RETIRE_STATES.has(raw.state)) {
    throw new Error('Provider retire state must be "retired" or "detached".');
  }
  return Object.freeze({ runtimeId, state: raw.state });
}

function validateProvider(provider) {
  requiredObject(provider, "provider");
  for (const method of REQUIRED_METHODS) requiredProviderMethod(provider, method);

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
      for (const name of CAPABILITY_NAMES) {
        if (raw[name] !== true) {
          throw new Error(`Remote runtime provider capability ${name} must be true.`);
        }
      }
      return Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, true])));
    },

    async provision(input) {
      requiredObject(input, "provision input");
      const botId = requiredIdentifier(input.botId, "botId");
      const idempotencyKey = requiredIdentifier(input.idempotencyKey, "idempotencyKey");
      const signal = optionalOperationSignal(input);
      const raw = detachProviderData(
        await invoke(provider, "provision", providerOperationInput({ botId, idempotencyKey }, signal)),
      );
      return frozenProvisionResult(raw, botId);
    },

    async inspect(input) {
      requiredObject(input, "inspect input");
      const runtimeId = requiredIdentifier(input.runtimeId, "runtimeId");
      const signal = optionalOperationSignal(input);
      const raw = detachProviderData(
        await invoke(provider, "inspect", providerOperationInput({ runtimeId }, signal)),
      );
      return frozenInspectResult(raw, runtimeId);
    },

    async retire(input) {
      requiredObject(input, "retire input");
      const runtimeId = requiredIdentifier(input.runtimeId, "runtimeId");
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
            const event = detachProviderData(rawEvent);
            requiredObject(event, "subscription event");
            if (containsSecretMaterial(event)) {
              throw new Error("Provider subscription event contains secret material.");
            }
            requiredIdentifier(event.runtimeId, "runtimeId");
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

  return Object.freeze(wrapper);
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
  validateProvider,
  unavailableProvider,
};
