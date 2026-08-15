"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let loadLiveGateDependencies;
let runRemoteProviderLiveGate;
let validateComputerExercise;
let moduleLoadError = null;
try {
  ({
    loadLiveGateDependencies,
    runRemoteProviderLiveGate,
    validateComputerExercise,
  } = require("../src/bots/remote-provider-live-gate.cjs"));
} catch (error) {
  moduleLoadError = error;
}

const BOT_ID = "bot-00000000-0000-4000-8000-000000000001";
const { validateProvider } = require("../src/bots/runtime-provider.cjs");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-live-gate-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writePrivateModule(directory, name, source, mode = 0o600) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, source, { encoding: "utf8", mode });
  await fs.chmod(filePath, mode);
  return filePath;
}

function providerSource(extraExport = "") {
  return `
"use strict";
module.exports = {
  createProvider() {
    return {
      async capabilities() {
        return {
          provision: true,
          reconcile: true,
          retire: true,
          remoteAppServer: true,
          computerFrames: true,
        };
      },
      async provision({ botId }) {
        return {
          provider: "fixture-provider",
          runtimeId: "runtime-" + botId,
          ownerBotId: botId,
          endpoint: "wss://runtime.provider.example/app-server",
          authToken: "fixture-private-auth-token-value",
          state: "ready",
        };
      },
      async inspect({ runtimeId }) {
        return { runtimeId, ownerBotId: "${BOT_ID}", state: "ready" };
      },
      async retire({ runtimeId }) {
        return { runtimeId, state: "retired" };
      },
      subscribe() { return () => {}; },
    };
  },
  ${extraExport}
};
`;
}

function exerciseSource(extraExport = "") {
  return `
"use strict";
module.exports = {
  createExercise() {
    return {
      async openRemoteUrl(input) {
        return { accepted: true, ...input, providerDiagnostic: "private" };
      },
      async dispose() {},
    };
  },
  ${extraExport}
};
`;
}

async function validModulePaths(t) {
  const directory = await temporaryDirectory(t);
  return {
    providerModulePath: await writePrivateModule(directory, "provider.cjs", providerSource()),
    exerciseModulePath: await writePrivateModule(directory, "exercise.cjs", exerciseSource()),
  };
}

test("loads absolute regular private provider and exercise modules", async (t) => {
  assert.ifError(moduleLoadError);
  const loaded = loadLiveGateDependencies(await validModulePaths(t));

  assert.deepEqual(await loaded.provider.capabilities(), {
    provision: true,
    reconcile: true,
    retire: true,
    remoteAppServer: true,
    computerFrames: true,
  });
  assert.equal(typeof loaded.exercise.openRemoteUrl, "function");
  assert.equal(typeof loaded.exercise.dispose, "function");
  assert.deepEqual(Reflect.ownKeys(loaded), ["provider", "exercise"]);
  assert.equal(Object.isFrozen(loaded), true);
});

test("rejects missing relative symlinked public and extra-export modules", async (t) => {
  assert.ifError(moduleLoadError);
  const directory = await temporaryDirectory(t);
  const valid = await validModulePaths(t);
  const publicProvider = await writePrivateModule(directory, "public-provider.cjs", providerSource(), 0o644);
  const extraProvider = await writePrivateModule(
    directory,
    "extra-provider.cjs",
    providerSource("extra: true,"),
  );
  const extraExercise = await writePrivateModule(
    directory,
    "extra-exercise.cjs",
    exerciseSource("extra: true,"),
  );
  const providerLink = path.join(directory, "provider-link.cjs");
  await fs.symlink(valid.providerModulePath, providerLink);

  const cases = [
    { providerModulePath: path.join(directory, "missing.cjs"), exerciseModulePath: valid.exerciseModulePath },
    { providerModulePath: "relative-provider.cjs", exerciseModulePath: valid.exerciseModulePath },
    { providerModulePath: providerLink, exerciseModulePath: valid.exerciseModulePath },
    { providerModulePath: publicProvider, exerciseModulePath: valid.exerciseModulePath },
    { providerModulePath: extraProvider, exerciseModulePath: valid.exerciseModulePath },
    { providerModulePath: valid.providerModulePath, exerciseModulePath: extraExercise },
  ];

  for (const options of cases) {
    assert.throws(() => loadLiveGateDependencies(options), {
      code: "REMOTE_PROVIDER_GATE_BLOCKED",
      message: "Remote provider verification is not configured.",
    });
  }
});

test("narrows freezes and validates remote exercise acknowledgements", async () => {
  assert.ifError(moduleLoadError);
  let received;
  let disposeCalls = 0;
  const exercise = validateComputerExercise({
    async openRemoteUrl(input) {
      received = input;
      return { accepted: true, ...input, providerDiagnostic: "must disappear" };
    },
    async dispose() {
      disposeCalls += 1;
    },
  });
  const input = {
    botId: BOT_ID,
    runtimeId: "runtime-a",
    generation: 1,
    url: "https://www.youtube.com/",
  };

  const acknowledgement = await exercise.openRemoteUrl(input);

  assert.deepEqual(acknowledgement, { accepted: true, ...input });
  assert.equal(Object.isFrozen(acknowledgement), true);
  assert.notEqual(received, input);
  assert.equal(Object.isFrozen(received), true);
  await exercise.dispose();
  await exercise.dispose();
  assert.equal(disposeCalls, 1);
});

test("exercise adapter rejects hostile shapes and mismatched acknowledgements without diagnostics", async (t) => {
  assert.ifError(moduleLoadError);
  const invalidAdapters = [
    null,
    {},
    { openRemoteUrl() {}, dispose: true },
    { openRemoteUrl() {}, dispose() {}, extra: true },
    new Proxy({}, { get() { throw new Error("private-proxy-diagnostic"); } }),
  ];
  for (const adapter of invalidAdapters) {
    assert.throws(() => validateComputerExercise(adapter), /exercise|configured|remote/i);
  }

  const acknowledgements = [
    null,
    { accepted: false, botId: BOT_ID, runtimeId: "runtime-a", generation: 1, url: "https://www.youtube.com/" },
    { accepted: true, botId: `${BOT_ID}9`, runtimeId: "runtime-a", generation: 1, url: "https://www.youtube.com/" },
    { accepted: true, botId: BOT_ID, runtimeId: "runtime-b", generation: 1, url: "https://www.youtube.com/" },
    { accepted: true, botId: BOT_ID, runtimeId: "runtime-a", generation: 2, url: "https://www.youtube.com/" },
    { accepted: true, botId: BOT_ID, runtimeId: "runtime-a", generation: 1, url: "https://example.com/" },
  ];
  for (const raw of acknowledgements) {
    await t.test(JSON.stringify(raw), async () => {
      const exercise = validateComputerExercise({
        async openRemoteUrl() {
          if (raw === null) throw new Error("provider /Users/private token=secret");
          return raw;
        },
        async dispose() {},
      });
      const error = await exercise.openRemoteUrl({
        botId: BOT_ID,
        runtimeId: "runtime-a",
        generation: 1,
        url: "https://www.youtube.com/",
      }).then(() => null, (failure) => failure);
      assert.equal(error?.code, "REMOTE_PROVIDER_GATE_FAILED");
      assert.equal(error?.message, "Remote provider verification failed.");
      assert.doesNotMatch(String(error?.stack), /private-proxy-diagnostic|\/Users\/private|token=secret/);
    });
  }
});

async function liveGateHarness(t, options = {}) {
  const workspacePath = await temporaryDirectory(t);
  const provisionCalls = [];
  const runtimes = new Map();
  const retired = [];
  const subscribers = new Set();
  const exerciseCalls = [];
  const clients = [];
  const protocolCalls = [];
  let exerciseDisposed = 0;
  let lookupCalls = 0;

  const provider = validateProvider({
    async capabilities() {
      return {
        provision: true,
        reconcile: true,
        retire: true,
        remoteAppServer: true,
        computerFrames: true,
      };
    },
    async provision(input) {
      const index = provisionCalls.length;
      provisionCalls.push(input);
      const runtimeId = options.collision === "runtimeId" ? "runtime-shared" : `runtime-${index + 1}`;
      const endpointIndex = options.collision === "endpoint" ? 1 : index + 1;
      const ownerBotId = options.collision === "ownerBotId" && index === 1
        ? provisionCalls[0].botId
        : input.botId;
      const record = {
        provider: "fixture-provider",
        runtimeId,
        ownerBotId,
        endpoint: `wss://runtime-${endpointIndex}.provider.example/app-server`,
        authToken: `fixture-private-auth-token-${index + 1}-value`,
        state: "ready",
      };
      runtimes.set(runtimeId, { ...record });
      return record;
    },
    async inspect({ runtimeId }) {
      const record = runtimes.get(runtimeId);
      if (!record) return { runtimeId, ownerBotId: BOT_ID, state: "retired" };
      return { runtimeId, ownerBotId: record.ownerBotId, state: record.state };
    },
    async retire({ runtimeId }) {
      if (options.retireFailure && runtimeId === "runtime-1") {
        throw new Error("provider endpoint token private-retire-diagnostic");
      }
      const record = runtimes.get(runtimeId);
      if (record) record.state = "retired";
      retired.push(runtimeId);
      return { runtimeId, state: "retired" };
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  });

  const exercise = validateComputerExercise({
    async openRemoteUrl(input) {
      exerciseCalls.push(input);
      if (options.frameMutation !== "no-frame" && options.frameMutation !== "cached") {
        const runtimeId = options.frameMutation === "wrong-runtime"
          ? "runtime-unknown"
          : options.frameMutation === "wrong-bot"
            ? "runtime-2"
            : input.runtimeId;
        const browserName = options.frameMutation === "wrong-browser" ? "Safari" : "Google Chrome";
        const browserUrl = options.frameMutation === "wrong-host"
          ? "https://example.com/"
          : "https://www.youtube.com/";
        const title = options.frameMutation === "missing-title" ? "" : "YouTube";
        const sequence = options.frameMutation === "stale-sequence" ? 0 : 1;
        const frame = options.frameMutation === "malformed-frame"
          ? { width: 0, height: 720, digest: "invalid" }
          : { width: 1280, height: 720, digest: "sha256:fixture-frame" };
        setImmediate(() => {
          for (const callback of subscribers) {
            callback({
              runtimeId,
              type: "computer/frame",
              sequence,
              payload: {
                browser: { name: browserName, url: browserUrl, title },
                frame,
              },
            });
            if (options.frameMutation === "replayed") {
              callback({
                runtimeId,
                type: "computer/frame",
                sequence,
                payload: {
                  browser: { name: browserName, url: browserUrl, title },
                  frame,
                },
              });
            }
          }
        });
      }
      return { accepted: true, ...input };
    },
    async dispose() {
      exerciseDisposed += 1;
    },
  });

  const dependencies = {
    async lookup(hostname) {
      lookupCalls += 1;
      if (options.privateDns) return [{ address: "127.0.0.1", family: 4 }];
      const suffix = hostname.includes("runtime-2") ? "2" : "1";
      if (options.rebindingDns && lookupCalls > 2) {
        return [{ address: `1.1.1.${suffix}`, family: 4 }];
      }
      return [{ address: `8.8.8.${suffix}`, family: 4 }];
    },
    clientFactory(session) {
      const client = {
        session,
        started: false,
        stopped: false,
        async start() {
          this.started = true;
          if (options.hungClientStart) return new Promise(() => {});
        },
        async request(method, params) {
          protocolCalls.push({ runtimeId: session.runtimeId, method, params });
          if (method === "account/read") return { account: { type: "chatgpt" } };
          if (method === "model/list") {
            if (options.frameMutation === "cached" && session.runtimeId === "runtime-2") {
              for (const callback of subscribers) {
                callback({
                  runtimeId: "runtime-1",
                  type: "computer/frame",
                  sequence: 1,
                  payload: {
                    browser: {
                      name: "Google Chrome",
                      url: "https://www.youtube.com/",
                      title: "YouTube",
                    },
                    frame: { width: 1280, height: 720, digest: "sha256:cached-frame" },
                  },
                });
              }
            }
            if (options.modelOverflow) {
              return { data: Array.from({ length: 4097 }, () => ({ id: "gpt-5.6-sol" })), nextCursor: null };
            }
            if (options.cyclicCatalog) {
              return { data: [{ id: "gpt-5.6-sol" }], nextCursor: "same-page" };
            }
            return { data: [{ id: "gpt-5.6-sol" }], nextCursor: null };
          }
          throw new Error("unexpected method");
        },
        stop() {
          this.stopped = true;
        },
      };
      clients.push(client);
      return client;
    },
  };

  return {
    options: { provider, exercise, workspacePath, dependencies },
    provisionCalls,
    runtimes,
    retired,
    subscribers,
    exerciseCalls,
    clients,
    protocolCalls,
    get exerciseDisposed() { return exerciseDisposed; },
    get lookupCalls() { return lookupCalls; },
  };
}

async function raceWithSentinel(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "sentinel" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("provisions two distinct bot runtimes through the production controller", async (t) => {
  assert.equal(typeof runRemoteProviderLiveGate, "function");
  const harness = await liveGateHarness(t);

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  assert.equal(harness.provisionCalls.length, 2);
  assert.notEqual(
    harness.runtimes.get("runtime-1").runtimeId,
    harness.runtimes.get("runtime-2").runtimeId,
  );
  assert.deepEqual(
    harness.provisionCalls.map(({ botId, idempotencyKey }) => idempotencyKey),
    harness.provisionCalls.map(({ botId }) => `codex-bot:${botId}`),
  );
  assert.deepEqual(harness.protocolCalls.map(({ method }) => method), [
    "account/read", "model/list", "account/read", "model/list",
  ]);
  assert.equal(harness.clients.every(({ started, stopped }) => started && stopped), true);
  assert.equal(harness.exerciseCalls.length, 1);
  assert.equal(harness.exerciseDisposed, 1);
  assert.equal(JSON.stringify(result).includes("authToken"), false);
  assert.equal(JSON.stringify(result).includes("wss://"), false);
});

test("fails before Computer work for duplicate runtimes endpoints or owners", async (t) => {
  assert.equal(typeof runRemoteProviderLiveGate, "function");
  for (const collision of ["runtimeId", "endpoint", "ownerBotId"]) {
    await t.test(collision, async (t) => {
      const harness = await liveGateHarness(t, { collision });
      await assert.rejects(runRemoteProviderLiveGate(harness.options), {
        code: "REMOTE_PROVIDER_GATE_FAILED",
        message: "Remote provider verification failed.",
      });
      assert.equal(harness.exerciseCalls.length, 0);
      assert.equal(harness.clients.every(({ stopped }) => stopped), true);
      assert.equal(harness.exerciseDisposed, 1);
      await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
        code: "ENOENT",
      });
    });
  }
});

test("retirement failure keeps the gate failed while closing clients and removing local state", async (t) => {
  const harness = await liveGateHarness(t, { retireFailure: true });
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  const error = await runRemoteProviderLiveGate(harness.options).then(
    () => null,
    (failure) => failure,
  );

  assert.equal(error?.code, "REMOTE_PROVIDER_GATE_FAILED");
  assert.equal(error?.message, "Remote provider verification failed.");
  assert.doesNotMatch(String(error?.stack), /endpoint|token|private-retire/i);
  assert.equal(harness.clients.every(({ stopped }) => stopped), true);
  assert.equal(harness.exerciseDisposed, 1);
  await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
    code: "ENOENT",
  });
});

test("rejects private DNS answers before constructing a remote client", async (t) => {
  assert.equal(typeof runRemoteProviderLiveGate, "function");
  const harness = await liveGateHarness(t, { privateDns: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
  });

  assert.equal(harness.clients.length, 0);
  assert.equal(harness.exerciseCalls.length, 0);
});

test("rejects DNS rebinding between preflight and client start", async (t) => {
  const harness = await liveGateHarness(t, { rebindingDns: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
  });

  assert.equal(harness.lookupCalls, 4);
  assert.equal(harness.clients.every(({ started, stopped }) => !started && stopped), true);
  assert.equal(harness.exerciseCalls.length, 0);
});

test("rejects cyclic remote model pagination before Computer work", async (t) => {
  assert.equal(typeof runRemoteProviderLiveGate, "function");
  const harness = await liveGateHarness(t, { cyclicCatalog: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
  });

  assert.equal(harness.exerciseCalls.length, 0);
  assert.equal(harness.clients.every(({ stopped }) => stopped), true);
});

test("rejects an oversized remote model catalog", async (t) => {
  const harness = await liveGateHarness(t, { modelOverflow: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
  });

  assert.equal(harness.exerciseCalls.length, 0);
  assert.equal(harness.clients.every(({ stopped }) => stopped), true);
});

test("bounds a hung remote client start and still performs cleanup", async (t) => {
  assert.equal(typeof runRemoteProviderLiveGate, "function");
  const harness = await liveGateHarness(t, { hungClientStart: true });
  harness.options.dependencies.operationTimeoutMs = 20;

  const outcome = await raceWithSentinel(
    runRemoteProviderLiveGate(harness.options).then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error }),
    ),
    500,
  );

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, "REMOTE_PROVIDER_GATE_FAILED");
  assert.equal(harness.clients.every(({ stopped }) => stopped), true);
  assert.equal(harness.exerciseDisposed, 1);
});

test("abort interrupts a hung remote client and still performs cleanup", async (t) => {
  const harness = await liveGateHarness(t, { hungClientStart: true });
  harness.options.dependencies.operationTimeoutMs = 500;
  const controller = new AbortController();
  harness.options.signal = controller.signal;
  const abortTimer = setTimeout(() => controller.abort(), 20);
  t.after(() => clearTimeout(abortTimer));

  const outcome = await raceWithSentinel(
    runRemoteProviderLiveGate(harness.options).then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error }),
    ),
    500,
  );

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, "REMOTE_PROVIDER_GATE_FAILED");
  assert.equal(harness.clients.every(({ stopped }) => stopped), true);
  assert.equal(harness.exerciseDisposed, 1);
});

test("passes only after Bot A remote Chrome shows YouTube", async (t) => {
  const harness = await liveGateHarness(t);
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  assert.equal(harness.exerciseCalls.length, 1);
  assert.deepEqual(harness.exerciseCalls[0], {
    botId: harness.provisionCalls[0].botId,
    runtimeId: "runtime-1",
    generation: 1,
    url: "https://www.youtube.com/",
  });
  assert.deepEqual(result.computer, {
    browser: "Google Chrome",
    host: "www.youtube.com",
    titleMarker: "YouTube",
    frameReceived: true,
  });
  assert.deepEqual(result.isolation, { crossBotFrameCount: 0, passed: true });
  assert.equal(JSON.stringify(result).includes("fixture-frame"), false);
});

test("successful proof records terminal cleanup and removes the verifier store", async (t) => {
  const harness = await liveGateHarness(t);
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.deepEqual(result.cleanup, {
    safe: true,
    retiredRuntimeCount: 2,
    terminalRuntimeCount: 2,
    storeRemoved: true,
  });
  await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
    code: "ENOENT",
  });
});

test("rejects acknowledgement without an exact current YouTube frame", async (t) => {
  for (const frameMutation of [
    "no-frame",
    "wrong-runtime",
    "wrong-bot",
    "wrong-browser",
    "wrong-host",
    "missing-title",
    "stale-sequence",
    "malformed-frame",
    "cached",
    "replayed",
  ]) {
    await t.test(frameMutation, async (t) => {
      const harness = await liveGateHarness(t, { frameMutation });
      harness.options.dependencies.computerTimeoutMs = 120;
      harness.options.dependencies.frameSettleMs = 80;
      await assert.rejects(runRemoteProviderLiveGate(harness.options), {
        code: "REMOTE_PROVIDER_GATE_FAILED",
        message: "Remote provider verification failed.",
      });
      assert.equal(harness.clients.every(({ stopped }) => stopped), true);
      assert.equal(harness.exerciseDisposed, 1);
      assert.deepEqual([...new Set(harness.retired)].sort(), ["runtime-1", "runtime-2"]);
      await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
        code: "ENOENT",
      });
    });
  }
});
