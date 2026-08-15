const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateProvider,
  unavailableProvider,
} = require("../src/bots/runtime-provider.cjs");

const REQUIRED_CAPABILITIES = Object.freeze({
  provision: true,
  reconcile: true,
  retire: true,
  remoteAppServer: true,
  computerFrames: true,
});

function fakeProvider(overrides = {}) {
  const events = [];
  const provider = {
    async capabilities() {
      return { ...REQUIRED_CAPABILITIES };
    },
    async provision({ botId }) {
      return {
        provider: "authorized-test-provider",
        runtimeId: `runtime-${botId}`,
        ownerBotId: botId,
        endpoint: "wss://runtime.example.test/app-server",
        authToken: "memory-only-token",
        state: "ready",
      };
    },
    async inspect({ runtimeId }) {
      return {
        runtimeId,
        ownerBotId: runtimeId.replace(/^runtime-/, ""),
        state: "ready",
      };
    },
    async retire({ runtimeId }) {
      return { runtimeId, state: "retired" };
    },
    subscribe(callback) {
      events.push(callback);
      return () => {
        const index = events.indexOf(callback);
        if (index >= 0) events.splice(index, 1);
      };
    },
    ...overrides,
  };
  return provider;
}

function captureThrow(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to throw.");
}

test("rejects adapters missing a required method", () => {
  const missing = fakeProvider();
  delete missing.inspect;
  const missingError = captureThrow(() => validateProvider(missing));
  assert.equal(missingError.constructor, TypeError);
  assert.equal(missingError.message, "Remote runtime provider must implement inspect().");

  const nonFunction = fakeProvider({ inspect: { unsafe: true } });
  const nonFunctionError = captureThrow(() => validateProvider(nonFunction));
  assert.equal(nonFunctionError.constructor, TypeError);
  assert.equal(nonFunctionError.message, "Remote runtime provider must implement inspect().");

  const nullError = captureThrow(() => validateProvider(null));
  assert.equal(nullError.constructor, TypeError);
  assert.equal(nullError.message, "provider must be an object.");
});

test("sanitizes hostile getters and proxies during initial provider shape inspection", async (t) => {
  const secretMessage = "initial-shape-secret from private.internal";

  await t.test("required-method getter", () => {
    const provider = fakeProvider();
    Object.defineProperty(provider, "inspect", {
      configurable: true,
      get() {
        throw new Error(secretMessage);
      },
    });
    const error = captureThrow(() => validateProvider(provider));
    assert.equal(error.message, "Remote runtime provider failed.");
    assert.doesNotMatch(error.message, /initial-shape-secret|private\.internal/);
  });

  await t.test("required-method proxy trap", () => {
    const provider = new Proxy(fakeProvider(), {
      get(target, property, receiver) {
        if (property === "retire") throw new Error(secretMessage);
        return Reflect.get(target, property, receiver);
      },
    });
    const error = captureThrow(() => validateProvider(provider));
    assert.equal(error.message, "Remote runtime provider failed.");
    assert.doesNotMatch(error.message, /initial-shape-secret|private\.internal/);
  });
});

test("rejects missing, false, and non-boolean capability flags", async (t) => {
  const cases = [
    ["missing computerFrames", { provision: true, reconcile: true, retire: true, remoteAppServer: true }],
    ["false remoteAppServer", { ...REQUIRED_CAPABILITIES, remoteAppServer: false }],
    ["string provision", { ...REQUIRED_CAPABILITIES, provision: "yes" }],
  ];

  for (const [name, capabilities] of cases) {
    await t.test(name, async () => {
      const provider = validateProvider(fakeProvider({
        capabilities: async () => capabilities,
      }));
      await assert.rejects(() => provider.capabilities(), /capabilit/i);
    });
  }
});

test("returns frozen exact capability metadata", async () => {
  const provider = validateProvider(fakeProvider({
    capabilities: async () => ({ ...REQUIRED_CAPABILITIES, diagnostic: "must-not-leak" }),
  }));

  const capabilities = await provider.capabilities();

  assert.deepEqual(capabilities, REQUIRED_CAPABILITIES);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(provider), true);
  assert.equal("diagnostic" in capabilities, false);
});

test("validates and freezes provision results while keeping auth only in memory", async () => {
  const provider = validateProvider(fakeProvider());

  const provisioned = await provider.provision({
    botId: "bot-1",
    idempotencyKey: "codex-bot:bot-1",
    endpoint: "wss://renderer-supplied.invalid",
  });

  assert.equal(Object.isFrozen(provisioned), true);
  assert.deepEqual(Object.keys(provisioned), [
    "provider",
    "runtimeId",
    "ownerBotId",
    "endpoint",
    "state",
  ]);
  assert.equal(provisioned.authToken, "memory-only-token");
  assert.doesNotMatch(JSON.stringify(provisioned), /memory-only-token/);
  assert.deepEqual(provisioned, {
    provider: "authorized-test-provider",
    runtimeId: "runtime-bot-1",
    ownerBotId: "bot-1",
    endpoint: "wss://runtime.example.test/app-server",
    state: "ready",
  });
});

test("rejects empty provision identifiers before calling the adapter", async (t) => {
  for (const input of [
    { botId: "", idempotencyKey: "codex-bot:bot-1" },
    { botId: "bot-1", idempotencyKey: "  " },
    { botId: null, idempotencyKey: "codex-bot:bot-1" },
  ]) {
    await t.test(JSON.stringify(input), async () => {
      let called = false;
      const provider = validateProvider(fakeProvider({
        provision: async () => {
          called = true;
          throw new Error("must not run");
        },
      }));
      await assert.rejects(() => provider.provision(input), /botId|idempotencyKey/);
      assert.equal(called, false);
    });
  }
});

test("passes only canonical provision identifiers to the adapter", async () => {
  let received;
  const provider = validateProvider(fakeProvider({
    provision: async (input) => {
      received = input;
      return {
        provider: "authorized-test-provider",
        runtimeId: "runtime-bot-1",
        ownerBotId: "bot-1",
        endpoint: "wss://runtime.example.test/app-server",
        authToken: "memory-only-token",
        state: "provisioning",
      };
    },
  }));

  const result = await provider.provision({
    botId: "bot-1",
    idempotencyKey: "codex-bot:bot-1",
    runtimeId: "renderer-runtime",
    authToken: "renderer-token",
  });

  assert.deepEqual(received, { botId: "bot-1", idempotencyKey: "codex-bot:bot-1" });
  assert.equal(result.state, "provisioning");
});

test("passes cooperative cancellation privately on every provider operation", async () => {
  const controller = new AbortController();
  const received = [];
  const raw = fakeProvider({
    async capabilities(input) {
      received.push(["capabilities", input]);
      return { ...REQUIRED_CAPABILITIES };
    },
    async provision(input) {
      received.push(["provision", input]);
      return {
        provider: "authorized-test-provider",
        runtimeId: "runtime-bot-1",
        ownerBotId: "bot-1",
        endpoint: "wss://runtime.example.test/app-server",
        authToken: "memory-only-token",
        state: "ready",
      };
    },
    async inspect(input) {
      received.push(["inspect", input]);
      return { runtimeId: input.runtimeId, ownerBotId: "bot-1", state: "ready" };
    },
    async retire(input) {
      received.push(["retire", input]);
      return { runtimeId: input.runtimeId, state: "retired" };
    },
  });
  const provider = validateProvider(raw);

  await provider.capabilities({ signal: controller.signal });
  await provider.provision({
    botId: "bot-1",
    idempotencyKey: "codex-bot:bot-1",
    signal: controller.signal,
  });
  await provider.inspect({ runtimeId: "runtime-bot-1", signal: controller.signal });
  await provider.retire({ runtimeId: "runtime-bot-1", signal: controller.signal });

  assert.deepEqual(received.map(([method, input]) => [method, Object.keys(input)]), [
    ["capabilities", []],
    ["provision", ["botId", "idempotencyKey"]],
    ["inspect", ["runtimeId"]],
    ["retire", ["runtimeId"]],
  ]);
  assert.equal(received.every(([, input]) => input.signal === controller.signal), true);
  assert.equal(received.every(([, input]) => Object.isFrozen(input)), true);
  await assert.rejects(
    provider.inspect({ runtimeId: "runtime-bot-1", signal: {} }),
    /signal/i,
  );
});

test("rejects non-remote and non-wss provision endpoints", async (t) => {
  const invalidEndpoints = [
    "file:///tmp/runtime.sock",
    "unix:///tmp/runtime.sock",
    "http://runtime.example.test/app-server",
    "https://runtime.example.test/app-server",
    "ws://runtime.example.test/app-server",
    "wss://localhost/app-server",
    "wss://localhost./app-server",
    "wss://127.0.0.1/app-server",
    "wss://127.44.3.2/app-server",
    "wss://0.1.2.3/app-server",
    "wss://10.23.4.5/app-server",
    "wss://100.64.0.1/app-server",
    "wss://100.127.255.254/app-server",
    "wss://169.254.10.20/app-server",
    "wss://172.16.0.1/app-server",
    "wss://172.31.255.254/app-server",
    "wss://192.0.0.1/app-server",
    "wss://192.0.2.10/app-server",
    "wss://192.88.99.1/app-server",
    "wss://192.168.10.20/app-server",
    "wss://198.18.0.1/app-server",
    "wss://198.51.100.10/app-server",
    "wss://203.0.113.10/app-server",
    "wss://224.0.0.1/app-server",
    "wss://239.255.255.250/app-server",
    "wss://240.0.0.1/app-server",
    "wss://255.255.255.255/app-server",
    "wss://[::1]/app-server",
    "wss://[0:0:0:0:0:0:0:1]/app-server",
    "wss://[::ffff:127.0.0.1]/app-server",
    "wss://[::ffff:10.0.0.1]/app-server",
    "wss://[::ffff:8.8.8.8]/app-server",
    "wss://[64:ff9b::1]/app-server",
    "wss://[100::1]/app-server",
    "wss://[2001:2::1]/app-server",
    "wss://[2001:db8::1]/app-server",
    "wss://[fc00::1]/app-server",
    "wss://[fd12:3456:789a::1]/app-server",
    "wss://[fe80::1]/app-server",
    "wss://[ff02::1]/app-server",
    "wss://runtime.local/app-server",
    "wss://runtime.LOCAL./app-server",
    "not a URL",
  ];

  for (const endpoint of invalidEndpoints) {
    await t.test(endpoint, async () => {
      const provider = validateProvider(fakeProvider({
        provision: async ({ botId }) => ({
          provider: "authorized-test-provider",
          runtimeId: `runtime-${botId}`,
          ownerBotId: botId,
          endpoint,
          authToken: "memory-only-token",
          state: "ready",
        }),
      }));
      await assert.rejects(
        () => provider.provision({ botId: "bot-1", idempotencyKey: "codex-bot:bot-1" }),
        /remote wss endpoint/i,
      );
    });
  }
});

test("accepts public literal and trusted DNS wss endpoints", async (t) => {
  for (const endpoint of [
    "wss://8.8.8.8/app-server",
    "wss://1.1.1.1/app-server",
    "wss://[2001:4860:4860::8888]/app-server",
    "wss://runtime.provider.example/app-server",
  ]) {
    await t.test(endpoint, async () => {
      const provider = validateProvider(fakeProvider({
        provision: async ({ botId }) => ({
          provider: "authorized-test-provider",
          runtimeId: `runtime-${botId}`,
          ownerBotId: botId,
          endpoint,
          authToken: "memory-only-token",
          state: "ready",
        }),
      }));
      const result = await provider.provision({ botId: "bot-1", idempotencyKey: "codex-bot:bot-1" });
      assert.equal(result.endpoint, endpoint);
    });
  }
});

test("rejects malformed and mismatched provision metadata without leaking secrets", async (t) => {
  const cases = [
    ["empty provider", { provider: "" }],
    ["empty runtime", { runtimeId: "" }],
    ["wrong owner", { ownerBotId: "bot-2" }],
    ["missing token", { authToken: "" }],
    ["invalid state", { state: "local" }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const provider = validateProvider(fakeProvider({
        provision: async ({ botId }) => ({
          provider: "authorized-test-provider",
          runtimeId: `runtime-${botId}`,
          ownerBotId: botId,
          endpoint: "wss://runtime.example.test/app-server",
          authToken: "secret-that-must-not-leak",
          state: "ready",
          ...patch,
        }),
      }));
      const error = await provider
        .provision({ botId: "bot-1", idempotencyKey: "codex-bot:bot-1" })
        .then(() => null, (failure) => failure);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-that-must-not-leak/);
    });
  }
});

test("validates, freezes, and narrows inspect metadata", async () => {
  const provider = validateProvider(fakeProvider({
    inspect: async ({ runtimeId }) => ({
      runtimeId,
      ownerBotId: "bot-1",
      state: "reconnecting",
      providerDiagnostic: "must-not-leak",
    }),
  }));

  const inspected = await provider.inspect({ runtimeId: "runtime-bot-1", ignored: true });

  assert.deepEqual(inspected, {
    runtimeId: "runtime-bot-1",
    ownerBotId: "bot-1",
    state: "reconnecting",
  });
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal("providerDiagnostic" in inspected, false);
});

test("rejects empty or mismatched inspect metadata", async (t) => {
  const cases = [
    ["empty request", { input: { runtimeId: "" } }],
    ["wrong runtime", { result: { runtimeId: "runtime-other" } }],
    ["empty owner", { result: { ownerBotId: "" } }],
    ["empty state", { result: { state: "" } }],
  ];

  for (const [name, { input = { runtimeId: "runtime-bot-1" }, result = {} }] of cases) {
    await t.test(name, async () => {
      const provider = validateProvider(fakeProvider({
        inspect: async ({ runtimeId }) => ({
          runtimeId,
          ownerBotId: "bot-1",
          state: "ready",
          ...result,
        }),
      }));
      await assert.rejects(() => provider.inspect(input), /runtimeId|ownerBotId|state/);
    });
  }
});

test("rejects secret material returned by inspect at any nesting depth", async (t) => {
  const secretResults = [
    { authToken: "top-level-token" },
    { accessToken: "access-token" },
    { refreshToken: "refresh-token" },
    { bearerToken: "bearer-token" },
    { sessionToken: "session-token" },
    { apiToken: "api-token" },
    { credentials: { value: "credential-value" } },
    { metadata: { apiKey: "nested-api-key" } },
    { diagnostics: [{ authorization: "Bearer secret" }] },
  ];

  for (const secretResult of secretResults) {
    await t.test(JSON.stringify(secretResult), async () => {
      const provider = validateProvider(fakeProvider({
        inspect: async ({ runtimeId }) => ({
          runtimeId,
          ownerBotId: "bot-1",
          state: "ready",
          ...secretResult,
        }),
      }));
      const error = await provider.inspect({ runtimeId: "runtime-bot-1" }).then(
        () => null,
        (failure) => failure,
      );
      assert.match(error.message, /secret material/i);
      assert.doesNotMatch(error.message, /top-level-token|nested-api-key|Bearer secret/);
    });
  }
});

test("allows Codex token-usage metrics and event names in public metadata", async () => {
  const provider = validateProvider(fakeProvider({
    inspect: async ({ runtimeId }) => ({
      runtimeId,
      ownerBotId: "bot-1",
      state: "ready",
      latestEvent: "thread/tokenUsage/updated",
      tokenUsage: {
        inputTokens: 8,
        outputTokens: 5,
        totalTokens: 13,
      },
      lifetimeTokens: 9000,
    }),
  }));

  assert.deepEqual(await provider.inspect({ runtimeId: "runtime-bot-1" }), {
    runtimeId: "runtime-bot-1",
    ownerBotId: "bot-1",
    state: "ready",
  });
});

test("validates, freezes, and narrows retire metadata", async () => {
  const provider = validateProvider(fakeProvider({
    retire: async ({ runtimeId }) => ({ runtimeId, state: "detached", diagnostic: "drop-me" }),
  }));

  const retired = await provider.retire({ runtimeId: "runtime-bot-1", force: true });

  assert.deepEqual(retired, { runtimeId: "runtime-bot-1", state: "detached" });
  assert.equal(Object.isFrozen(retired), true);
});

test("rejects empty, mismatched, and non-terminal retire metadata", async (t) => {
  const cases = [
    ["empty request", { input: { runtimeId: "" } }],
    ["wrong runtime", { result: { runtimeId: "runtime-other" } }],
    ["non-terminal state", { result: { state: "ready" } }],
  ];

  for (const [name, { input = { runtimeId: "runtime-bot-1" }, result = {} }] of cases) {
    await t.test(name, async () => {
      const provider = validateProvider(fakeProvider({
        retire: async ({ runtimeId }) => ({ runtimeId, state: "retired", ...result }),
      }));
      await assert.rejects(() => provider.retire(input), /runtimeId|retired|detached/);
    });
  }
});

test("sanitizes adapter failures instead of forwarding provider details", async (t) => {
  for (const method of ["capabilities", "provision", "inspect", "retire"]) {
    await t.test(method, async () => {
      const provider = validateProvider(fakeProvider({
        [method]: async () => {
          throw new Error("Bearer provider-secret from private.internal");
        },
      }));
      const operation = method === "capabilities"
        ? () => provider.capabilities()
        : method === "provision"
          ? () => provider.provision({ botId: "bot-1", idempotencyKey: "codex-bot:bot-1" })
          : () => provider[method]({ runtimeId: "runtime-bot-1" });
      const error = await operation().then(() => null, (failure) => failure);
      assert.equal(error.message, "Remote runtime provider failed.");
    });
  }
});

test("sanitizes hostile adapter-result getters and proxies without invoking accessors", async (t) => {
  const secretMessage = "getter-secret from private.internal";

  await t.test("capabilities accessor", async () => {
    let getterCalls = 0;
    const result = { ...REQUIRED_CAPABILITIES };
    Object.defineProperty(result, "provision", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secretMessage);
      },
    });
    const provider = validateProvider(fakeProvider({ capabilities: async () => result }));
    await assert.rejects(() => provider.capabilities(), { message: "Remote runtime provider failed." });
    assert.equal(getterCalls, 0);
  });

  await t.test("provision proxy", async () => {
    const result = {
      provider: "authorized-test-provider",
      runtimeId: "runtime-bot-1",
      ownerBotId: "bot-1",
      endpoint: "wss://runtime.example.test/app-server",
      authToken: "memory-only-token",
      state: "ready",
    };
    const hostile = new Proxy(result, {
      ownKeys() {
        throw new Error(secretMessage);
      },
    });
    const provider = validateProvider(fakeProvider({ provision: async () => hostile }));
    await assert.rejects(
      () => provider.provision({ botId: "bot-1", idempotencyKey: "codex-bot:bot-1" }),
      { message: "Remote runtime provider failed." },
    );
  });

  await t.test("inspect accessor", async () => {
    let getterCalls = 0;
    const result = { runtimeId: "runtime-bot-1", ownerBotId: "bot-1", state: "ready" };
    Object.defineProperty(result, "diagnostics", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secretMessage);
      },
    });
    const provider = validateProvider(fakeProvider({ inspect: async () => result }));
    await assert.rejects(
      () => provider.inspect({ runtimeId: "runtime-bot-1" }),
      { message: "Remote runtime provider failed." },
    );
    assert.equal(getterCalls, 0);
  });

  await t.test("retire revoked proxy", async () => {
    const { proxy, revoke } = Proxy.revocable({ runtimeId: "runtime-bot-1", state: "retired" }, {});
    revoke();
    const provider = validateProvider(fakeProvider({ retire: async () => proxy }));
    await assert.rejects(
      () => provider.retire({ runtimeId: "runtime-bot-1" }),
      { message: "Remote runtime provider failed." },
    );
  });

  await t.test("subscription event accessor", () => {
    let emit;
    let getterCalls = 0;
    const provider = validateProvider(fakeProvider({
      subscribe: (callback) => {
        emit = callback;
        return () => {};
      },
    }));
    provider.subscribe(() => {});
    const event = { runtimeId: "runtime-bot-1", type: "computer/frame" };
    Object.defineProperty(event, "payload", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secretMessage);
      },
    });

    assert.throws(() => emit(event), { message: "Remote runtime provider failed." });
    assert.equal(getterCalls, 0);
  });
});

test("rejects malformed subscriptions and returns a usable unsubscribe function", () => {
  const provider = validateProvider(fakeProvider());

  assert.throws(() => provider.subscribe(null), /callback/i);
  const unsubscribe = provider.subscribe(() => {});
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(() => unsubscribe());

  const malformed = validateProvider(fakeProvider({ subscribe: () => undefined }));
  assert.throws(() => malformed.subscribe(() => {}), /unsubscribe/i);

  const leaking = validateProvider(fakeProvider({
    subscribe: () => {
      throw new Error("runtimeId provider-secret at private.internal");
    },
  }));
  assert.throws(
    () => leaking.subscribe(() => {}),
    { message: "Remote runtime provider failed." },
  );
});

test("rejects unscoped or secret-bearing subscription events and freezes valid events", () => {
  let emit;
  const provider = validateProvider(fakeProvider({
    subscribe: (callback) => {
      emit = callback;
      return () => {};
    },
  }));
  const seen = [];
  provider.subscribe((event) => seen.push(event));

  assert.throws(() => emit({ type: "computer/frame" }), /runtimeId/);
  assert.throws(
    () => emit({ runtimeId: "runtime-bot-1", authToken: "must-not-leak" }),
    /secret material/i,
  );
  emit({ runtimeId: "runtime-bot-1", type: "computer/frame", sequence: 1 });

  assert.deepEqual(seen, [{ runtimeId: "runtime-bot-1", type: "computer/frame", sequence: 1 }]);
  assert.equal(Object.isFrozen(seen[0]), true);
});

test("subscription events allow Codex token-usage metrics", () => {
  let emit;
  const provider = validateProvider(fakeProvider({
    subscribe: (callback) => {
      emit = callback;
      return () => {};
    },
  }));
  const seen = [];
  provider.subscribe((event) => seen.push(event));

  emit({
    runtimeId: "runtime-bot-1",
    type: "thread/tokenUsage/updated",
    tokenUsage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
  });

  assert.equal(seen[0].type, "thread/tokenUsage/updated");
  assert.equal(seen[0].tokenUsage.totalTokens, 13);
});

test("subscription events are deeply detached and frozen before delivery", () => {
  let emit;
  const provider = validateProvider(fakeProvider({
    subscribe: (callback) => {
      emit = callback;
      return () => {};
    },
  }));
  const seen = [];
  provider.subscribe((event) => seen.push(event));
  const source = {
    runtimeId: "runtime-bot-1",
    type: "computer/frame",
    payload: { frames: [{ sequence: 1, pixels: [1, 2, 3] }] },
  };

  emit(source);

  assert.notEqual(seen[0], source);
  assert.notEqual(seen[0].payload, source.payload);
  assert.notEqual(seen[0].payload.frames, source.payload.frames);
  assert.notEqual(seen[0].payload.frames[0], source.payload.frames[0]);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen(seen[0].payload), true);
  assert.equal(Object.isFrozen(seen[0].payload.frames), true);
  assert.equal(Object.isFrozen(seen[0].payload.frames[0]), true);
  assert.equal(Object.isFrozen(seen[0].payload.frames[0].pixels), true);

  source.payload.frames[0].sequence = 99;
  source.payload.frames[0].pixels.push(4);
  assert.deepEqual(seen[0].payload, { frames: [{ sequence: 1, pixels: [1, 2, 3] }] });
});

test("rejects proxied deep wide and oversized provider data before publication", async (t) => {
  const cases = [];
  cases.push(["proxy", new Proxy({
    runtimeId: "runtime-bot-1",
    type: "computer/frame",
    sequence: 1,
  }, {})]);

  const deep = { runtimeId: "runtime-bot-1", type: "computer/frame", sequence: 1, payload: {} };
  let cursor = deep.payload;
  for (let index = 0; index < 40; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  cases.push(["deep", deep]);

  const widePayload = {};
  for (let index = 0; index < 300; index += 1) widePayload[`field${index}`] = index;
  cases.push(["wide", {
    runtimeId: "runtime-bot-1",
    type: "computer/frame",
    sequence: 1,
    payload: widePayload,
  }]);
  cases.push(["oversized string", {
    runtimeId: "runtime-bot-1",
    type: "computer/frame",
    sequence: 1,
    payload: { text: "x".repeat(300_000) },
  }]);

  for (const [name, event] of cases) {
    await t.test(name, () => {
      let retainedCallback;
      let delivered = false;
      const provider = validateProvider(fakeProvider({
        subscribe(callback) {
          retainedCallback = callback;
          return () => {};
        },
      }));
      provider.subscribe(() => { delivered = true; });
      const error = captureThrow(() => retainedCallback(event));
      assert.equal(error.message, "Remote runtime provider failed.");
      assert.equal(delivered, false);
    });
  }
});

test("unsubscribe deactivates first, ignores retained callbacks, and is idempotent", () => {
  let retainedCallback;
  let underlyingUnsubscribeCalls = 0;
  const provider = validateProvider(fakeProvider({
    subscribe: (callback) => {
      retainedCallback = callback;
      return () => {
        underlyingUnsubscribeCalls += 1;
        callback({ runtimeId: "runtime-bot-1", type: "queued-during-unsubscribe" });
      };
    },
  }));
  const seen = [];
  const unsubscribe = provider.subscribe((event) => seen.push(event.type));
  retainedCallback({ runtimeId: "runtime-bot-1", type: "before-unsubscribe" });

  unsubscribe();
  assert.doesNotThrow(() => retainedCallback({
    runtimeId: "runtime-bot-1",
    type: "after-unsubscribe",
    authToken: "queued-secret-must-not-be-read",
  }));
  unsubscribe();

  assert.deepEqual(seen, ["before-unsubscribe"]);
  assert.equal(underlyingUnsubscribeCalls, 1);
});

test("unavailable provider reports frozen false capabilities and fails closed", async () => {
  const provider = unavailableProvider();
  const capabilities = await provider.capabilities();

  assert.deepEqual(capabilities, {
    provision: false,
    reconcile: false,
    retire: false,
    remoteAppServer: false,
    computerFrames: false,
  });
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(provider), true);

  const expected = { message: "Remote computer unavailable." };
  await assert.rejects(
    () => provider.provision({ botId: "bot-1", idempotencyKey: "codex-bot:bot-1" }),
    expected,
  );
  await assert.rejects(() => provider.inspect({ runtimeId: "runtime-bot-1" }), expected);
  await assert.rejects(() => provider.retire({ runtimeId: "runtime-bot-1" }), expected);

  const unsubscribe = provider.subscribe(() => {});
  assert.equal(typeof unsubscribe, "function");
});
