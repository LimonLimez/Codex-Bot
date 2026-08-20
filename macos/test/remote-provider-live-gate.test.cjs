"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let loadLiveGateDependencies;
let runRemoteProviderLiveGate;
let validateComputerExercise;
let isReviewedAdapterEnvelope;
let moduleLoadError = null;
try {
  ({
    isReviewedAdapterEnvelope,
    loadLiveGateDependencies,
    runRemoteProviderLiveGate,
    validateComputerExercise,
  } = require("../src/bots/remote-provider-live-gate.cjs"));
} catch (error) {
  moduleLoadError = error;
}

let runCliMain;
let cliLoadError = null;
try {
  ({ main: runCliMain } = require("../scripts/verify-remote-provider.cjs"));
} catch (error) {
  cliLoadError = error;
}

const BOT_ID = "bot-00000000-0000-4000-8000-000000000001";
const ACTION_ID = "exercise-00000000-0000-4000-8000-000000000001";
const FRAME_DIGEST = `sha256:${"a".repeat(64)}`;
const SECOND_FRAME_DIGEST = `sha256:${"b".repeat(64)}`;
const { BotStore } = require("../src/bots/bot-store.cjs");
const {
  assertBoundedAdapterData,
} = require("../src/bots/reviewed-adapter-worker-source.cjs");
const {
  providerContractVersion,
  validateProvider,
} = require("../src/bots/runtime-provider.cjs");

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

function sha256Text(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
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

function providerV2Source() {
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
          issuanceFencedRetire: true,
        };
      },
      async provision({ botId, issuanceKey }) {
        return {
          provider: "fixture-provider-v2",
          runtimeId: "runtime-" + botId,
          ownerBotId: botId,
          issuanceKey,
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
      async inspectIssuance({ runtimeId, ownerBotId, issuanceKey }) {
        return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "ready" };
      },
      async retireIssuance({ runtimeId, ownerBotId, issuanceKey }) {
        return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "retired" };
      },
      subscribe() { return () => {}; },
    };
  },
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
  const provider = providerSource();
  const exercise = exerciseSource();
  return {
    providerModulePath: await writePrivateModule(directory, "provider.cjs", provider),
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath: await writePrivateModule(directory, "exercise.cjs", exercise),
    exerciseModuleSha256: sha256Text(exercise),
  };
}

async function validV2ModulePaths(t) {
  const directory = await temporaryDirectory(t);
  const provider = providerV2Source();
  const exercise = exerciseSource();
  return {
    providerModulePath: await writePrivateModule(directory, "provider-v2.cjs", provider),
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath: await writePrivateModule(directory, "exercise.cjs", exercise),
    exerciseModuleSha256: sha256Text(exercise),
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
    issuanceFencedRetire: false,
  });
  assert.equal(typeof loaded.exercise.openRemoteUrl, "function");
  assert.equal(typeof loaded.exercise.dispose, "function");
  assert.deepEqual(Reflect.ownKeys(loaded), ["provider", "exercise"]);
  assert.equal(Object.isFrozen(loaded), true);
});

test("reviewed worker handshake exposes v2 issuance methods only for enhanced providers", async (t) => {
  const loaded = loadLiveGateDependencies(await validV2ModulePaths(t));
  assert.equal(providerContractVersion(loaded.provider), 2);
  assert.equal(typeof loaded.provider.inspectIssuance, "function");
  assert.equal(typeof loaded.provider.retireIssuance, "function");
  assert.deepEqual(await loaded.provider.capabilities(), {
    provision: true,
    reconcile: true,
    retire: true,
    remoteAppServer: true,
    computerFrames: true,
    issuanceFencedRetire: true,
  });
  const provisioned = await loaded.provider.provision({
    botId: BOT_ID,
    idempotencyKey: "codex-bot:v2",
    issuanceKey: "issuance-00000000-0000-4000-8000-000000000001",
  });
  assert.equal(provisioned.issuanceKey, "issuance-00000000-0000-4000-8000-000000000001");
  assert.deepEqual(await loaded.provider.inspectIssuance({
    runtimeId: provisioned.runtimeId,
    ownerBotId: BOT_ID,
    issuanceKey: "issuance-00000000-0000-4000-8000-000000000001",
  }), {
    matched: true,
    runtimeId: provisioned.runtimeId,
    ownerBotId: BOT_ID,
    issuanceKey: "issuance-00000000-0000-4000-8000-000000000001",
    state: "ready",
  });
  const oversized = "x".repeat(300_000);
  await assert.rejects(() => loaded.provider.provision({
    botId: BOT_ID,
    idempotencyKey: "codex-bot:v2-oversized",
    issuanceKey: oversized,
  }), /issuance|canonical|identifier|invalid/i);
  await assert.rejects(() => loaded.provider.retireIssuance({
    runtimeId: provisioned.runtimeId,
    ownerBotId: BOT_ID,
    issuanceKey: "issuance-00000000-0000-4000-8000-000000000001",
    retirementKey: oversized,
  }), /retire|canonical|identifier|invalid/i);
  await assert.rejects(() => loaded.provider.provision({
    botId: oversized,
    idempotencyKey: "codex-bot:v2-oversized-bot",
    issuanceKey: "issuance-00000000-0000-4000-8000-000000000001",
  }), /botId|identifier|invalid/i);
  await assert.rejects(() => loaded.provider.provision({
    botId: BOT_ID,
    idempotencyKey: oversized,
    issuanceKey: "issuance-00000000-0000-4000-8000-000000000001",
  }), /idempotency|identifier|invalid/i);
  await loaded.exercise.dispose();
  const unsubscribe = loaded.provider.subscribe(() => {});
  unsubscribe();
});

test("rejects a private FIFO module path without blocking the verifier process", async (t) => {
  assert.ifError(moduleLoadError);
  const directory = await temporaryDirectory(t);
  const fifoPath = path.join(directory, "provider.fifo");
  childProcess.execFileSync("/usr/bin/mkfifo", [fifoPath]);
  await fs.chmod(fifoPath, 0o600);
  const exercise = exerciseSource();
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const gatePath = path.join(__dirname, "..", "src", "bots", "remote-provider-live-gate.cjs");
  const childSource = [
    `const { loadLiveGateDependencies } = require(${JSON.stringify(gatePath)});`,
    "try {",
    `  loadLiveGateDependencies(${JSON.stringify({
      providerModulePath: fifoPath,
      providerModuleSha256: "0".repeat(64),
      exerciseModulePath,
      exerciseModuleSha256: sha256Text(exercise),
    })});`,
    "  process.exitCode = 1;",
    "} catch (error) { process.exitCode = error?.code === \"REMOTE_PROVIDER_GATE_BLOCKED\" ? 0 : 2; }",
  ].join("\n");
  const child = childProcess.spawn(process.execPath, ["-e", childSource], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  const exit = new Promise((resolve) => child.once("close", (code, signal) => {
    exited = true;
    resolve({ code, signal });
  }));
  const outcome = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve(null), 250)),
  ]);
  if (!exited) child.kill("SIGKILL");
  await exit;
  assert.deepEqual(outcome, { code: 0, signal: null });
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
    { ...valid, providerModulePath: path.join(directory, "missing.cjs") },
    { ...valid, providerModulePath: "relative-provider.cjs" },
    { ...valid, providerModulePath: providerLink },
    { ...valid, providerModulePath: publicProvider, providerModuleSha256: sha256Text(providerSource()) },
    { ...valid, providerModulePath: extraProvider, providerModuleSha256: sha256Text(providerSource("extra: true,")) },
    { ...valid, exerciseModulePath: extraExercise, exerciseModuleSha256: sha256Text(exerciseSource("extra: true,")) },
    { ...valid, providerModuleSha256: "0".repeat(64) },
  ];

  for (const options of cases) {
    assert.throws(() => loadLiveGateDependencies(options), {
      code: "REMOTE_PROVIDER_GATE_BLOCKED",
      message: "Remote provider verification is not configured.",
    });
  }
});

test("loads exact reviewed module bytes without transitive files or require-cache drift", async (t) => {
  const directory = await temporaryDirectory(t);
  const helper = await writePrivateModule(directory, "helper.cjs", providerSource());
  void helper;
  const transitiveSource = 'module.exports = require("./helper.cjs");\n';
  const transitivePath = await writePrivateModule(directory, "transitive.cjs", transitiveSource);
  const exercise = exerciseSource();
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  assert.throws(() => loadLiveGateDependencies({
    providerModulePath: transitivePath,
    providerModuleSha256: sha256Text(transitiveSource),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });

  const createRequireSource = [
    'const createRequire = require("node:module").createRequire;',
    'module.exports = createRequire(__filename)("./helper.cjs");',
    "",
  ].join("\n");
  const createRequirePath = await writePrivateModule(
    directory,
    "create-require.cjs",
    createRequireSource,
  );
  assert.throws(() => loadLiveGateDependencies({
    providerModulePath: createRequirePath,
    providerModuleSha256: sha256Text(createRequireSource),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });

  const processEscapeSource = [
    'const createRequire = process.getBuiltinModule("node:module").createRequire;',
    'module.exports = createRequire(__filename)("./helper.cjs");',
    "",
  ].join("\n");
  const processEscapePath = await writePrivateModule(
    directory,
    "process-escape.cjs",
    processEscapeSource,
  );
  assert.throws(() => loadLiveGateDependencies({
    providerModulePath: processEscapePath,
    providerModuleSha256: sha256Text(processEscapeSource),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });

  const hostConstructorEscapeSource = [
    'const hostProcess = Buffer.constructor("return process")();',
    'const createRequire = hostProcess.getBuiltinModule("node:module").createRequire;',
    'module.exports = createRequire(__filename)("./helper.cjs");',
    "",
  ].join("\n");
  const hostConstructorEscapePath = await writePrivateModule(
    directory,
    "host-constructor-escape.cjs",
    hostConstructorEscapeSource,
  );
  assert.throws(() => loadLiveGateDependencies({
    providerModulePath: hostConstructorEscapePath,
    providerModuleSha256: sha256Text(hostConstructorEscapeSource),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });

  const firstSource = providerSource();
  const providerModulePath = await writePrivateModule(directory, "replaceable.cjs", firstSource);
  const first = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(firstSource),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });
  assert.equal((await first.provider.provision({
    botId: BOT_ID,
    idempotencyKey: "first",
  })).provider, "fixture-provider");

  const secondSource = firstSource.replaceAll("fixture-provider", "fixture-provider-two");
  await fs.writeFile(providerModulePath, secondSource, { encoding: "utf8", mode: 0o600 });
  const second = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(secondSource),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });
  assert.equal((await second.provider.provision({
    botId: BOT_ID,
    idempotencyKey: "second",
  })).provider, "fixture-provider-two");
});

test("reviewed provider top-level side effects never execute in the main process", async (t) => {
  const directory = await temporaryDirectory(t);
  const markerPath = path.join(directory, "top-level-marker");
  const provider = [
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "main-process");`,
    providerSource().replace(/^\n/, ""),
  ].join("\n");
  const exercise = exerciseSource();
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", provider);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);

  assert.throws(() => loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });
  await assert.rejects(fs.stat(markerPath), { code: "ENOENT" });
});

test("reviewed adapter workers deny local process capabilities", async (t) => {
  const directory = await temporaryDirectory(t);
  const markerPath = path.join(directory, "must-not-exist");
  const exercise = exerciseSource();
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const attempts = [
    `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "private");`,
    `Buffer.constructor("return process")().getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "private");`,
    `process.getBuiltinModule("node:child_process").spawnSync(process.execPath, ["-e", "0"]);`,
    `new (process.getBuiltinModule("node:worker_threads").Worker)("0", { eval: true });`,
  ];

  for (const [index, attempt] of attempts.entries()) {
    const source = providerSource().replace("createProvider() {", `createProvider() { ${attempt}`);
    const providerModulePath = await writePrivateModule(
      directory,
      `denied-capability-${index}.cjs`,
      source,
    );
    assert.throws(() => loadLiveGateDependencies({
      providerModulePath,
      providerModuleSha256: sha256Text(source),
      exerciseModulePath,
      exerciseModuleSha256: sha256Text(exercise),
    }), {
      code: "REMOTE_PROVIDER_GATE_BLOCKED",
      message: "Remote provider verification is not configured.",
    });
  }

  await assert.rejects(fs.stat(markerPath), { code: "ENOENT" });
});

test("reviewed adapter workers require the stable Node permission runtime", async (t) => {
  const paths = await validModulePaths(t);
  const original = Object.getOwnPropertyDescriptor(process.versions, "node");
  t.after(() => Object.defineProperty(process.versions, "node", original));

  Object.defineProperty(process.versions, "node", {
    ...original,
    value: "22.12.0",
  });
  assert.throws(() => loadLiveGateDependencies(paths), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });

  Object.defineProperty(process.versions, "node", {
    ...original,
    value: "22.13.0",
  });
  const loaded = loadLiveGateDependencies(paths);
  assert.equal((await loaded.provider.capabilities()).computerFrames, true);
  await loaded.exercise.dispose();
});

test("reviewed adapter worker bounds results before structured-clone transport", () => {
  const cyclic = { runtimeId: "runtime-cycle" };
  cyclic.self = cyclic;
  assert.equal(assertBoundedAdapterData(cyclic), cyclic);

  assert.throws(() => assertBoundedAdapterData({ value: "x".repeat(65_537) }), {
    message: "Reviewed adapter data exceeds bounded size.",
  });
  assert.throws(() => assertBoundedAdapterData({ ["x".repeat(65_537)]: true }), {
    message: "Reviewed adapter data exceeds bounded size.",
  });
  assert.throws(() => assertBoundedAdapterData(Array.from({ length: 257 }, () => null)), {
    message: "Reviewed adapter data exceeds bounded complexity.",
  });
  let deep = null;
  for (let index = 0; index < 25; index += 1) deep = { deep };
  assert.throws(() => assertBoundedAdapterData(deep), {
    message: "Reviewed adapter data exceeds bounded complexity.",
  });
});

test("reviewed adapter worker rejects oversized event keys before IPC", async (t) => {
  const directory = await temporaryDirectory(t);
  const provider = providerSource().replace(
    "subscribe() { return () => {}; },",
    `subscribe(callback) {
      callback({ runtimeId: "runtime-early", ["x".repeat(65_537)]: true });
      return () => {};
    },`,
  );
  const exercise = exerciseSource();
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", provider);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);

  assert.throws(() => loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
    message: "Remote provider verification is not configured.",
  });
});

test("reviewed adapter worker rejects oversized result keys before IPC", async (t) => {
  const directory = await temporaryDirectory(t);
  const provider = providerSource().replace(
    "async capabilities() {",
    `async capabilities() {
      return { ["x".repeat(65_537)]: true };`,
  );
  const exercise = exerciseSource();
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", provider);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const loaded = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });

  try {
    await assert.rejects(loaded.provider.capabilities(), {
      message: "Remote runtime provider failed.",
    });
  } finally {
    try {
      const unsubscribe = loaded.provider.subscribe(() => {});
      unsubscribe();
    } catch {}
    await loaded.exercise.dispose().catch(() => {});
  }
});

test("reviewed adapter worker envelopes reject null arrays and malformed messages", () => {
  assert.equal(isReviewedAdapterEnvelope(null), false);
  assert.equal(isReviewedAdapterEnvelope(undefined), false);
  assert.equal(isReviewedAdapterEnvelope([]), false);
  assert.equal(isReviewedAdapterEnvelope({}), true);
});

test("reviewed adapter worker has a bounded heap", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = providerSource().replace(
    "async capabilities() {",
    `async capabilities() {
      globalThis.retained = Array.from(
        { length: 1_000_000 },
        (_, index) => ({ index, payload: "reviewed-worker-" + index }),
      );
      return {
        provision: true,
        reconcile: true,
        retire: true,
        remoteAppServer: true,
        computerFrames: true,
      };`,
  );
  const exercise = exerciseSource();
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", source);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const loaded = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(source),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });
  try {
    await assert.rejects(loaded.provider.capabilities(), {
      message: "Remote runtime provider failed.",
    });
  } finally {
    try {
      const unsubscribe = loaded.provider.subscribe(() => {});
      unsubscribe();
    } catch {}
    await loaded.exercise.dispose().catch(() => {});
  }
});

test("reviewed adapter workers clone operations propagate abort and own subscription shutdown", async (t) => {
  const directory = await temporaryDirectory(t);
  const provider = `
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
      async provision(input) {
        if (Object.getPrototypeOf(input) !== null) throw new Error("host input");
        return {
          provider: "fixture-provider",
          runtimeId: "runtime-" + input.botId,
          ownerBotId: input.botId,
          endpoint: "wss://runtime.provider.example/app-server",
          authToken: "fixture-private-auth-token-value",
          state: "ready",
        };
      },
      async inspect({ runtimeId, signal }) {
        if (!signal || signal.constructor.name !== "AbortSignal") throw new Error("missing signal");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { runtimeId, ownerBotId: ${JSON.stringify(BOT_ID)}, state: "ready" };
      },
      async retire({ runtimeId }) {
        return { runtimeId, state: "retired" };
      },
      subscribe(callback) {
        callback({ runtimeId: "runtime-early", type: "state", state: "ready" });
        return () => {};
      },
    };
  },
};
`;
  const exercise = exerciseSource();
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", provider);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const loaded = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });
  const events = [];
  const unsubscribe = loaded.provider.subscribe((event) => events.push(event));
  assert.deepEqual(events, [{ runtimeId: "runtime-early", type: "state", state: "ready" }]);

  assert.equal((await loaded.provider.provision({
    botId: BOT_ID,
    idempotencyKey: "worker-clone",
  })).ownerBotId, BOT_ID);
  const controller = new AbortController();
  const inspection = loaded.provider.inspect({ runtimeId: "runtime-worker", signal: controller.signal });
  controller.abort();
  assert.deepEqual(await inspection, {
    runtimeId: "runtime-worker",
    ownerBotId: BOT_ID,
    state: "ready",
  });

  unsubscribe();
  await assert.rejects(loaded.provider.capabilities(), {
    message: "Remote runtime provider failed.",
  });
  await loaded.exercise.dispose();
});

test("reviewed v2 provider worker preserves issuance fences and rejects missing fences before IPC", async (t) => {
  const directory = await temporaryDirectory(t);
  const issuanceA = "issuance-00000000-0000-4000-8000-000000000001";
  const issuanceB = "issuance-00000000-0000-4000-8000-000000000002";
  const provider = `
"use strict";
module.exports = {
  createProvider() {
    let emit;
    return {
      async capabilities() {
        return {
          provision: true,
          reconcile: true,
          retire: true,
          remoteAppServer: true,
          computerFrames: true,
          issuanceFencedRetire: true,
        };
      },
      async provision(input) {
        emit?.({ runtimeId: "runtime-shared", issuanceKey: ${JSON.stringify(issuanceB)}, type: "state", state: "ready" });
        return {
          provider: "fixture-provider-v2",
          runtimeId: "runtime-shared",
          ownerBotId: input.botId,
          issuanceKey: input.issuanceKey,
          endpoint: "wss://runtime.provider.example/app-server",
          authToken: "fixture-private-auth-token-value",
          state: "ready",
        };
      },
      async inspect({ runtimeId }) {
        return { runtimeId, ownerBotId: ${JSON.stringify(BOT_ID)}, state: "ready" };
      },
      async retire({ runtimeId }) {
        return { runtimeId, state: "retired" };
      },
      async inspectIssuance({ runtimeId, ownerBotId, issuanceKey }) {
        return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "ready" };
      },
      async retireIssuance({ runtimeId, ownerBotId, issuanceKey }) {
        return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "retired" };
      },
      subscribe(callback) {
        emit = callback;
        callback({ runtimeId: "runtime-shared", issuanceKey: ${JSON.stringify(issuanceA)}, type: "state", state: "ready" });
        return () => {};
      },
    };
  },
};
`;
  const exercise = exerciseSource();
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", provider);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const loaded = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });
  try {
    const events = [];
    const unsubscribe = loaded.provider.subscribe((event) => events.push(event));
    await loaded.provider.provision({
      botId: BOT_ID,
      idempotencyKey: "worker-v2-event-fence",
      issuanceKey: issuanceA,
    });
    assert.deepEqual(events.map(({ runtimeId, issuanceKey }) => ({ runtimeId, issuanceKey })), [
      { runtimeId: "runtime-shared", issuanceKey: issuanceA },
      { runtimeId: "runtime-shared", issuanceKey: issuanceB },
    ]);
    unsubscribe();
  } finally {
    await loaded.exercise.dispose().catch(() => {});
  }

  const earlyEvent = `callback({ runtimeId: "runtime-shared", issuanceKey: ${JSON.stringify(issuanceA)}, type: "state", state: "ready" });`;
  const malformedEvents = [
    ["missing", `callback({ runtimeId: "runtime-shared", type: "state", state: "ready" });`],
    ["malformed", `callback({ runtimeId: "runtime-shared", issuanceKey: "issuance-not-canonical", type: "state", state: "ready" });`],
    ["oversized", `callback({ runtimeId: "runtime-shared", issuanceKey: "issuance-" + "x".repeat(300), type: "state", state: "ready" });`],
    ["accessor", `const event = { runtimeId: "runtime-shared", type: "state", state: "ready" }; Object.defineProperty(event, "issuanceKey", { enumerable: true, get() { throw new Error("accessor"); } }); callback(event);`],
    ["proxy", `callback(new Proxy({ runtimeId: "runtime-shared", issuanceKey: ${JSON.stringify(issuanceA)}, type: "state", state: "ready" }, {}));`],
  ];
  for (const [name, replacement] of malformedEvents) {
    const malformed = provider.replace(earlyEvent, replacement);
    const malformedProviderModulePath = await writePrivateModule(directory, `${name}-provider.cjs`, malformed);
    assert.throws(() => loadLiveGateDependencies({
      providerModulePath: malformedProviderModulePath,
      providerModuleSha256: sha256Text(malformed),
      exerciseModulePath,
      exerciseModuleSha256: sha256Text(exercise),
    }), {
      code: "REMOTE_PROVIDER_GATE_BLOCKED",
      message: "Remote provider verification is not configured.",
    });
  }
});

test("reviewed exercise disposal keeps the provider alive for authoritative cleanup", async (t) => {
  const loaded = loadLiveGateDependencies(await validModulePaths(t));

  await loaded.exercise.dispose();

  assert.equal((await loaded.provider.capabilities()).retire, true);
});

test("invalid live-gate setup closes both reviewed adapter workers", async (t) => {
  const loaded = loadLiveGateDependencies(await validModulePaths(t));

  await assert.rejects(runRemoteProviderLiveGate({
    provider: loaded.provider,
    exercise: loaded.exercise,
    workspacePath: "relative-workspace",
    dependencies: {},
  }), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });

  await assert.rejects(loaded.provider.capabilities(), {
    message: "Remote runtime provider failed.",
  });
});

test("aborting reviewed exercise disposal terminates it without preempting provider cleanup", async (t) => {
  const directory = await temporaryDirectory(t);
  const provider = providerSource();
  const exercise = `
"use strict";
module.exports = {
  createExercise() {
    return {
      async openRemoteUrl(input) { return { accepted: true, ...input }; },
      async dispose({ signal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        await new Promise(() => {});
      },
    };
  },
};
`;
  const providerModulePath = await writePrivateModule(directory, "provider.cjs", provider);
  const exerciseModulePath = await writePrivateModule(directory, "exercise.cjs", exercise);
  const loaded = loadLiveGateDependencies({
    providerModulePath,
    providerModuleSha256: sha256Text(provider),
    exerciseModulePath,
    exerciseModuleSha256: sha256Text(exercise),
  });
  const controller = new AbortController();
  const disposal = loaded.exercise.dispose({ signal: controller.signal });
  controller.abort();

  await assert.rejects(Promise.race([
    disposal,
    new Promise((_, reject) => setTimeout(() => reject(new Error("dispose timeout")), 200)),
  ]), {
    message: "Remote provider verification failed.",
  });
  assert.equal((await loaded.provider.capabilities()).retire, true);
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
    actionId: ACTION_ID,
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
    {
      accepted: true,
      actionId: `${ACTION_ID}-wrong`,
      botId: BOT_ID,
      runtimeId: "runtime-a",
      generation: 1,
      url: "https://www.youtube.com/",
    },
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
        actionId: ACTION_ID,
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
  const provisionAttempts = [];
  const idempotentProvision = new Map();
  const runtimes = new Map();
  const retired = [];
  const issuanceInspectCalls = [];
  const issuanceRetireCalls = [];
  const subscribers = new Set();
  const exerciseCalls = [];
  const clients = [];
  const protocolCalls = [];
  const pinnedTransports = [];
  let exerciseDisposed = 0;
  let providerAbortCount = 0;
  let exerciseAbortCount = 0;
  let lookupAbortCount = 0;
  let lookupCalls = 0;
  let inspectCalls = 0;
  let lastExerciseInput = null;
  let delayedProvision = false;
  const retirementPolls = new Map();
  const retirementAttempts = new Map();
  const durableRetirementKeys = new Map();
  const cleanupOrder = [];
  const issuanceKeyFor = (runtimeId) => runtimes.get(runtimeId)?.issuanceKey
    ?? "issuance-00000000-0000-4000-8000-000000000099";

  const pendingUntilAbort = (signal, counter) => new Promise((resolve, reject) => {
    if (!(signal instanceof AbortSignal)) return;
    const abort = () => {
      if (counter === "provider") providerAbortCount += 1;
      if (counter === "exercise") exerciseAbortCount += 1;
      if (counter === "lookup") lookupAbortCount += 1;
      reject(new Error("private aborted operation"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

  const provider = validateProvider({
    async capabilities(input) {
      if (options.hungCapabilities) return pendingUntilAbort(input?.signal, "provider");
      return {
        provision: true,
        reconcile: true,
        retire: true,
        remoteAppServer: true,
        computerFrames: true,
        issuanceFencedRetire: true,
      };
    },
    async provision(input) {
      provisionAttempts.push(input);
      if (options.requireDurableRetirementKey) {
        const durableStore = new BotStore({ filePath: path.join(workspacePath, "bots.json") });
        const durableIssuances = await durableStore.readRuntimeIssuances(input.botId);
        const durable = durableIssuances.find((entry) => entry.issuanceKey === input.issuanceKey);
        if (!durable) throw new Error("durable issuance intent missing before provision");
        durableRetirementKeys.set(input.issuanceKey, durable.retirementKey);
      }
      if (options.hungProvision && !idempotentProvision.has(input.idempotencyKey)) {
        return pendingUntilAbort(input.signal, "provider");
      }
      if (options.lateProvisionAfterTimeout && !delayedProvision
        && !idempotentProvision.has(input.idempotencyKey)) {
        delayedProvision = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const recovered = idempotentProvision.get(input.idempotencyKey);
      if (recovered) {
        if (options.replayProvisionFailure) {
          throw new Error("private replay provision response failed");
        }
        return { ...recovered };
      }
      const index = provisionCalls.length;
      provisionCalls.push(input);
      const runtimeId = options.runtimeIdWithSpaces && index === 0
        ? "runtime with spaces"
        : options.collision === "runtimeId" ? "runtime-shared" : `runtime-${index + 1}`;
      const endpointIndex = options.collision === "endpoint" ? 1 : index + 1;
      const ownerBotId = options.collision === "ownerBotId" && index === 1
        ? provisionCalls[0].botId
        : input.botId;
      const record = {
        provider: options.collision === "provider" && index === 1
          ? "fixture-provider-two"
          : "fixture-provider",
        runtimeId,
        ownerBotId,
        endpoint: options.collision === "canonicalEndpoint"
          ? index === 0
            ? "wss://RUNTIME.provider.example:443/app-server"
            : "wss://runtime.provider.example/app-server"
          : `wss://runtime-${endpointIndex}.provider.example/app-server`,
        authToken: options.collision === "authToken"
          ? "fixture-private-shared-auth-token-value"
          : `fixture-private-auth-token-${index + 1}-value`,
        issuanceKey: input.issuanceKey,
        state: options.partialProvision && index === 0 ? "provisioning" : "ready",
      };
      runtimes.set(runtimeId, { ...record });
      idempotentProvision.set(input.idempotencyKey, { ...record });
      if (options.lostProvisionResponse && index === 0) {
        throw new Error("private provision response lost after ready side effect");
      }
      return record;
    },
    async inspect(input) {
      const { runtimeId } = input;
      if (options.recordCleanupOrder) cleanupOrder.push(`provider-inspect:${runtimeId}`);
      inspectCalls += 1;
      if (options.hungInspect && inspectCalls === 1) {
        return pendingUntilAbort(input.signal, "provider");
      }
      const record = runtimes.get(runtimeId);
      if (!record) return { runtimeId, ownerBotId: BOT_ID, state: "retired" };
      if (record.state === "retiring") {
        const polls = (retirementPolls.get(runtimeId) ?? 0) + 1;
        retirementPolls.set(runtimeId, polls);
        if (polls >= 2) record.state = "retired";
      }
      return { runtimeId, ownerBotId: record.ownerBotId, state: record.state };
    },
    async retire(input) {
      const { runtimeId } = input;
      if (options.recordCleanupOrder) cleanupOrder.push(`provider-retire:${runtimeId}`);
      if (options.hungRetire) return pendingUntilAbort(input.signal, "provider");
      if (options.retireFailure && runtimeId === "runtime-1") {
        throw new Error("provider endpoint token private-retire-diagnostic");
      }
      const record = runtimes.get(runtimeId);
      if (record) record.state = options.eventuallyConsistentRetire ? "retiring" : "retired";
      retired.push(runtimeId);
      return { runtimeId, state: "retired" };
    },
    async inspectIssuance(input) {
      const { runtimeId, ownerBotId, issuanceKey } = input;
      issuanceInspectCalls.push({ runtimeId, ownerBotId, issuanceKey });
      const record = runtimes.get(runtimeId);
      if (options.supersededIssuance && runtimeId === "runtime-1") {
        return { matched: false, runtimeId, state: "superseded" };
      }
      if (!record || record.ownerBotId !== ownerBotId || record.issuanceKey !== issuanceKey) {
        return { matched: false, runtimeId, state: "superseded" };
      }
      if (record.state === "retiring") {
        const polls = (retirementPolls.get(runtimeId) ?? 0) + 1;
        retirementPolls.set(runtimeId, polls);
        if (polls >= 2) record.state = "retired";
      }
      if (options.nonterminalReadback && runtimeId === "runtime-1") {
        return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "ready" };
      }
      return {
        matched: true,
        runtimeId,
        ownerBotId,
        issuanceKey,
        state: record.state,
      };
    },
    async retireIssuance(input) {
      const { runtimeId, ownerBotId, issuanceKey, retirementKey } = input;
      issuanceRetireCalls.push({ runtimeId, ownerBotId, issuanceKey, retirementKey });
      if (options.requireDurableRetirementKey
        && durableRetirementKeys.get(issuanceKey) !== retirementKey) {
        throw new Error("retirement key did not match durable issuance intent");
      }
      if (options.recordCleanupOrder) cleanupOrder.push(`provider-retire:${runtimeId}`);
      if (options.hungRetire) return pendingUntilAbort(input.signal, "provider");
      if (options.retireFailure && runtimeId === "runtime-1") {
        throw new Error("provider endpoint token private-retire-diagnostic");
      }
      const record = runtimes.get(runtimeId);
      if (!record || record.ownerBotId !== ownerBotId || record.issuanceKey !== issuanceKey) {
        return { matched: false, runtimeId, state: "superseded" };
      }
      record.state = options.eventuallyConsistentRetire ? "retiring" : "retired";
      retired.push(runtimeId);
      if (options.lostRetireResponse && runtimeId === "runtime-1") {
        const attempts = (retirementAttempts.get(runtimeId) ?? 0) + 1;
        retirementAttempts.set(runtimeId, attempts);
        if (attempts === 1) throw new Error("private response lost after commit");
      }
      if (options.mismatchedTerminalReadback && runtimeId === "runtime-1") {
        return {
          matched: true,
          runtimeId: "runtime-mismatched",
          ownerBotId,
          issuanceKey,
          state: "retired",
        };
      }
      return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "retired" };
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  });

  const exercise = validateComputerExercise({
    async openRemoteUrl(input) {
      exerciseCalls.push(input);
      lastExerciseInput = input;
      if (options.hungExerciseOpen) {
        return pendingUntilAbort(input.signal, "exercise");
      }
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
        const sequence = options.frameMutation === "stale-sequence"
          ? 0
          : options.frameMutation === "cached-new-sequence"
            || options.frameMutation === "fresh-after-cached"
            ? 2
            : 1;
        const frame = options.frameMutation === "malformed-frame"
          ? { width: 0, height: 720, digest: "invalid" }
          : {
            width: 1280,
            height: 720,
            digest: options.frameMutation === "fresh-after-cached"
              ? SECOND_FRAME_DIGEST
              : FRAME_DIGEST,
          };
        setImmediate(() => {
          for (const callback of subscribers) {
            callback({
              runtimeId,
              issuanceKey: issuanceKeyFor(runtimeId),
              type: "computer/frame",
              sequence,
              payload: {
                actionId: options.frameMutation === "wrong-action"
                  ? `${input.actionId}-wrong`
                  : input.actionId,
                browser: { name: browserName, url: browserUrl, title },
                frame,
              },
            });
            if (options.frameMutation === "replayed") {
              callback({
                runtimeId,
                issuanceKey: issuanceKeyFor(runtimeId),
                type: "computer/frame",
                sequence,
                payload: {
                  actionId: input.actionId,
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
    async dispose(input) {
      exerciseDisposed += 1;
      if (options.recordCleanupOrder) cleanupOrder.push("exercise-dispose");
      if (options.hungExerciseDispose) {
        return pendingUntilAbort(input?.signal, "exercise");
      }
      if (options.successorOnDispose) {
        const store = new BotStore({ filePath: path.join(workspacePath, "bots.json") });
        await store.updateRuntime(provisionCalls[0].botId, {
          provider: "fixture-provider",
          remoteRuntimeId: "runtime-successor",
          state: "ready",
          lastErrorCode: null,
        });
      }
      if (options.sameIdSuccessorOnDispose) {
        const original = idempotentProvision.get(provisionCalls[0].idempotencyKey);
        const successor = {
          ...original,
          issuanceKey: "fixture-private-successor-issuance-key",
        };
        idempotentProvision.set(provisionCalls[0].idempotencyKey, successor);
        const runtime = runtimes.get(original.runtimeId);
        if (runtime) runtime.issuanceKey = successor.issuanceKey;
      }
      if (options.frameMutation === "late-frame" && lastExerciseInput) {
        for (const callback of subscribers) {
          callback({
            runtimeId: lastExerciseInput.runtimeId,
            issuanceKey: issuanceKeyFor(lastExerciseInput.runtimeId),
            type: "computer/frame",
            sequence: 2,
            payload: {
              actionId: lastExerciseInput.actionId,
              browser: {
                name: "Google Chrome",
                url: "https://www.youtube.com/",
                title: "YouTube",
              },
              frame: { width: 1280, height: 720, digest: SECOND_FRAME_DIGEST },
            },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (options.eventFloodOnDispose && lastExerciseInput) {
        for (let sequence = 2; sequence <= 302; sequence += 1) {
          for (const callback of subscribers) {
            callback({
              runtimeId: lastExerciseInput.runtimeId,
              issuanceKey: issuanceKeyFor(lastExerciseInput.runtimeId),
              type: "computer/cursor",
              sequence,
              payload: { x: sequence, y: sequence },
            });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  });

  const dependencies = {
    operationTimeoutMs: options.operationTimeoutMs ?? 30_000,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 30_000,
    computerTimeoutMs: options.computerTimeoutMs ?? 30_000,
    frameSettleMs: options.frameSettleMs ?? 250,
    async lookup(hostname, lookupOptions) {
      lookupCalls += 1;
      if (options.hungDns) return pendingUntilAbort(lookupOptions?.signal, "lookup");
      if (options.privateDns) return [{ address: "127.0.0.1", family: 4 }];
      const suffix = hostname.includes("runtime-2") ? "2" : "1";
      if (options.rebindingDns && lookupCalls > 2) {
        return [{ address: `1.1.1.${suffix}`, family: 4 }];
      }
      return [{ address: `8.8.8.${suffix}`, family: 4 }];
    },
    clientFactory(session, transport) {
      if (options.requirePinnedDns) {
        if (!transport || typeof transport.lookup !== "function"
          || !Array.isArray(transport.expectedRemoteAddresses)) {
          throw new Error("missing pinned DNS transport");
        }
        pinnedTransports.push(transport);
      }
      if (options.collision === "clientObject" && clients.length > 0) return clients[0];
      const client = {
        session,
        provider: options.collision === "clientTuple" ? "wrong-provider" : session.provider,
        runtimeId: options.collision === "clientTuple" ? "wrong-runtime" : session.runtimeId,
        generation: options.collision === "clientTuple" ? session.generation + 1 : session.generation,
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
            if ((options.frameMutation === "cached"
              || options.frameMutation === "cached-new-sequence"
              || options.frameMutation === "fresh-after-cached")
              && session.runtimeId === "runtime-2") {
              for (const callback of subscribers) {
                callback({
                  runtimeId: "runtime-1",
                  issuanceKey: issuanceKeyFor("runtime-1"),
                  type: "computer/frame",
                  sequence: 1,
                  payload: {
                    actionId: "exercise-prior-cached-action",
                    browser: {
                      name: "Google Chrome",
                      url: "https://www.youtube.com/",
                      title: "YouTube",
                    },
                    frame: { width: 1280, height: 720, digest: FRAME_DIGEST },
                  },
                });
              }
              if (options.frameMutation === "cached-new-sequence"
                || options.frameMutation === "fresh-after-cached") {
                await new Promise((resolve) => setTimeout(resolve, 30));
              }
            }
            if (options.modelOverflow) {
              return { data: Array.from({ length: 4097 }, () => ({ id: "gpt-5.6-sol" })), nextCursor: null };
            }
            if (options.cyclicCatalog) {
              return { data: [{ id: "gpt-5.6-sol" }], nextCursor: "same-page" };
            }
            if (options.emptyCatalog) return { data: [], nextCursor: null };
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
    provisionAttempts,
    runtimes,
    retired,
    issuanceInspectCalls,
    issuanceRetireCalls,
    retirementAttempts,
    subscribers,
    exerciseCalls,
    clients,
    protocolCalls,
    pinnedTransports,
    get exerciseDisposed() { return exerciseDisposed; },
    get providerAbortCount() { return providerAbortCount; },
    get exerciseAbortCount() { return exerciseAbortCount; },
    get lookupAbortCount() { return lookupAbortCount; },
    get lookupCalls() { return lookupCalls; },
    cleanupOrder,
  };
}

test("legacy configured providers fail closed before provision, retirement, or exercise cleanup", async (t) => {
  const workspacePath = await temporaryDirectory(t);
  let provisions = 0;
  let retires = 0;
  let disposals = 0;
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
    async provision() {
      provisions += 1;
      throw new Error("legacy provision must not run");
    },
    async inspect({ runtimeId }) {
      return { runtimeId, ownerBotId: BOT_ID, state: "ready" };
    },
    async retire() {
      retires += 1;
      throw new Error("legacy retirement must not run");
    },
    subscribe() { return () => {}; },
  });
  const exercise = validateComputerExercise({
    async openRemoteUrl() {
      throw new Error("legacy exercise must not run");
    },
    async dispose() { disposals += 1; },
  });

  await assert.rejects(runRemoteProviderLiveGate({ provider, exercise, workspacePath, dependencies: {} }), {
    code: "REMOTE_PROVIDER_GATE_BLOCKED",
  });
  assert.equal(provisions, 0);
  assert.equal(retires, 0);
  assert.equal(disposals, 0);
});

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

function outputSink() {
  const chunks = [];
  return {
    stream: { write(value) { chunks.push(String(value)); } },
    value() { return chunks.join(""); },
  };
}

test("provisions two distinct bot runtimes through the production controller", async (t) => {
  assert.equal(typeof runRemoteProviderLiveGate, "function");
  const harness = await liveGateHarness(t, { requireDurableRetirementKey: true });

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
  assert.equal(harness.provisionCalls.every(({ issuanceKey }) => (
    /^issuance-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(issuanceKey)
  )), true);
  assert.equal(harness.issuanceRetireCalls.every(({ retirementKey }) => (
    /^retire-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(retirementKey)
  )), true);
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
      const storePath = path.join(harness.options.workspacePath, "bots.json");
      if (collision === "endpoint") {
        await assert.rejects(fs.stat(storePath), { code: "ENOENT" });
      } else {
        assert.equal((await fs.stat(storePath)).isFile(), true);
        assert.doesNotMatch(await fs.readFile(storePath, "utf8"), /authToken|fixture-private-auth-token/i);
      }
    });
  }
});

test("rejects every shared or mismatched two-bot private transport identity", async (t) => {
  for (const collision of [
    "canonicalEndpoint",
    "authToken",
    "provider",
    "clientObject",
    "clientTuple",
  ]) {
    await t.test(collision, async () => {
      const harness = await liveGateHarness(t, { collision });
      await assert.rejects(runRemoteProviderLiveGate(harness.options), {
        code: "REMOTE_PROVIDER_GATE_FAILED",
        message: "Remote provider verification failed.",
      });
      assert.equal(harness.exerciseCalls.length, 0);
    });
  }
});

test("retirement failure keeps the gate failed and preserves its private replay ledger", async (t) => {
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
  const storePath = path.join(harness.options.workspacePath, "bots.json");
  assert.equal((await fs.stat(storePath)).isFile(), true);
  assert.doesNotMatch(await fs.readFile(storePath, "utf8"), /authToken|fixture-private-auth-token/i);
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

  assert.equal(harness.lookupCalls, 3);
  assert.equal(harness.clients.every(({ started, stopped }) => !started && stopped), true);
  assert.equal(harness.exerciseCalls.length, 0);
});

test("pins each immediately revalidated public DNS set into its client connection", async (t) => {
  const harness = await liveGateHarness(t, { requirePinnedDns: true });

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  assert.equal(harness.pinnedTransports.length, 2);
  assert.deepEqual(
    harness.pinnedTransports.map(({ expectedRemoteAddresses }) => expectedRemoteAddresses),
    [["8.8.8.1"], ["8.8.8.2"]],
  );
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

test("rejects an empty remote model catalog before Computer work", async (t) => {
  const harness = await liveGateHarness(t, { emptyCatalog: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.equal(harness.exerciseCalls.length, 0);
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

test("abort cancels a hung provider capability check and completes bounded cleanup", async (t) => {
  const harness = await liveGateHarness(t, { hungCapabilities: true });
  harness.options.dependencies.operationTimeoutMs = 80;
  harness.options.dependencies.cleanupTimeoutMs = 160;
  const controller = new AbortController();
  const operation = runRemoteProviderLiveGate({
    ...harness.options,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  const outcome = await raceWithSentinel(operation.then(
    () => ({ status: "resolved" }),
    (error) => ({ status: "rejected", error }),
  ), 300);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error?.code, "REMOTE_PROVIDER_GATE_FAILED");
  assert.equal(harness.providerAbortCount, 1);
  assert.equal(harness.exerciseDisposed, 1);
  await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
    code: "ENOENT",
  });
});

for (const [name, options, abortCounter] of [
  ["provision operation", { hungProvision: true }, "providerAbortCount"],
  ["inspection operation", { hungInspect: true }, "providerAbortCount"],
  ["DNS lookup", { hungDns: true }, "lookupAbortCount"],
  ["computer exercise", { hungExerciseOpen: true }, "exerciseAbortCount"],
  ["exercise disposal", { hungExerciseDispose: true }, "exerciseAbortCount"],
  ["runtime retirement", { hungRetire: true }, "providerAbortCount"],
]) {
  test(`bounds a hung ${name} and returns only after cooperative cancellation`, async (t) => {
    const harness = await liveGateHarness(t, options);
    harness.options.dependencies.operationTimeoutMs = 60;
    harness.options.dependencies.cleanupTimeoutMs = 180;
    harness.options.dependencies.computerTimeoutMs = 100;
    harness.options.dependencies.frameSettleMs = 20;

    const outcome = await raceWithSentinel(
      runRemoteProviderLiveGate(harness.options).then(
        () => ({ status: "resolved" }),
        (error) => ({ status: "rejected", error }),
      ),
      600,
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error?.code, "REMOTE_PROVIDER_GATE_FAILED");
    assert.ok(harness[abortCounter] >= 1);
  });
}

test("retires a provision that ignores abort and resolves after the operation timeout", async (t) => {
  const harness = await liveGateHarness(t, { lateProvisionAfterTimeout: true });
  harness.options.dependencies.operationTimeoutMs = 30;
  harness.options.dependencies.cleanupTimeoutMs = 300;

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.deepEqual(harness.retired, ["runtime-1"]);
  assert.equal(harness.runtimes.get("runtime-1").state, "retired");
  await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
    code: "ENOENT",
  });
});

test("replays a lost provision response from the durable issuance intent and retires it exactly", async (t) => {
  const harness = await liveGateHarness(t, {
    lostProvisionResponse: true,
    requireDurableRetirementKey: true,
  });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });

  assert.equal(harness.provisionAttempts.length, 2);
  assert.deepEqual(
    harness.provisionAttempts.map(({ botId, idempotencyKey, issuanceKey }) => ({
      botId,
      idempotencyKey,
      issuanceKey,
    })),
    Array(2).fill({
      botId: harness.provisionCalls[0].botId,
      idempotencyKey: harness.provisionCalls[0].idempotencyKey,
      issuanceKey: harness.provisionCalls[0].issuanceKey,
    }),
  );
  assert.deepEqual(harness.retired, ["runtime-1"]);
  assert.equal(harness.issuanceRetireCalls.length, 1);
  assert.equal(harness.issuanceRetireCalls[0].issuanceKey, harness.provisionCalls[0].issuanceKey);
  await assert.rejects(fs.stat(path.join(harness.options.workspacePath, "bots.json")), {
    code: "ENOENT",
  });
});

test("a failed lost-provision replay preserves the private durable issuance ledger", async (t) => {
  const harness = await liveGateHarness(t, {
    lostProvisionResponse: true,
    replayProvisionFailure: true,
  });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });

  assert.equal(harness.provisionAttempts.length, 2);
  assert.deepEqual(harness.retired, []);
  const storePath = path.join(harness.options.workspacePath, "bots.json");
  assert.equal((await fs.stat(storePath)).isFile(), true);
  const persisted = await fs.readFile(storePath, "utf8");
  assert.doesNotMatch(persisted, /authToken|fixture-private-auth-token|response lost|replay provision/i);
  const store = new BotStore({ filePath: storePath });
  const issuances = await store.readRuntimeIssuances(harness.provisionCalls[0].botId);
  assert.equal(issuances.length, 1);
  assert.deepEqual({
    phase: issuances[0].phase,
    idempotencyKey: issuances[0].idempotencyKey,
    issuanceKey: issuances[0].issuanceKey,
  }, {
    phase: "pending",
    idempotencyKey: harness.provisionCalls[0].idempotencyKey,
    issuanceKey: harness.provisionCalls[0].issuanceKey,
  });
});

test("an unstorable runtime result preserves its pending replay ledger without false cleanup", async (t) => {
  const harness = await liveGateHarness(t, { runtimeIdWithSpaces: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });

  assert.equal(harness.provisionAttempts.length, 2);
  assert.deepEqual(harness.retired, []);
  const storePath = path.join(harness.options.workspacePath, "bots.json");
  assert.equal((await fs.stat(storePath)).isFile(), true);
  const store = new BotStore({ filePath: storePath });
  const issuances = await store.readRuntimeIssuances(harness.provisionCalls[0].botId);
  assert.equal(issuances.length, 1);
  assert.equal(issuances[0].phase, "pending");
  assert.equal(issuances[0].runtimeId, null);
});

test("retires an exact partial provisioning issuance after readiness fails", async (t) => {
  const harness = await liveGateHarness(t, { partialProvision: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.deepEqual(harness.retired, ["runtime-1"]);
  assert.equal(harness.issuanceRetireCalls.filter(({ runtimeId }) => runtimeId === "runtime-1").length, 1);
  assert.equal(harness.runtimes.get("runtime-1").state, "retired");
});

test("polls bounded provider inspection until retirement becomes authoritative", async (t) => {
  const harness = await liveGateHarness(t, { eventuallyConsistentRetire: true });
  harness.options.dependencies.operationTimeoutMs = 100;
  harness.options.dependencies.cleanupTimeoutMs = 500;

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  assert.equal(harness.runtimes.get("runtime-1").state, "retired");
  assert.equal(harness.runtimes.get("runtime-2").state, "retired");
});

test("passes only after Bot A remote Chrome shows YouTube", async (t) => {
  const harness = await liveGateHarness(t);
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  assert.equal(harness.exerciseCalls.length, 1);
  assert.deepEqual({
    botId: harness.exerciseCalls[0].botId,
    runtimeId: harness.exerciseCalls[0].runtimeId,
    generation: harness.exerciseCalls[0].generation,
    url: harness.exerciseCalls[0].url,
  }, {
    botId: harness.provisionCalls[0].botId,
    runtimeId: "runtime-1",
    generation: 1,
    url: "https://www.youtube.com/",
  });
  assert.match(harness.exerciseCalls[0].actionId, /^exercise-[0-9a-f-]{36}$/);
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

test("owner or issuance supersession returns matched false and performs zero fenced retirement", async (t) => {
  const harness = await liveGateHarness(t, { supersededIssuance: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.equal(harness.issuanceRetireCalls.some(({ runtimeId }) => runtimeId === "runtime-1"), false);
});

test("terminal-looking retirement fails when the mandatory issuance readback is nonterminal", async (t) => {
  const harness = await liveGateHarness(t, {
    nonterminalReadback: true,
    operationTimeoutMs: 100,
    cleanupTimeoutMs: 500,
  });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.equal(harness.issuanceRetireCalls.some(({ runtimeId }) => runtimeId === "runtime-1"), true);
});

test("replays a lost retirement response with the same retirement key", async (t) => {
  const harness = await liveGateHarness(t, { lostRetireResponse: true });

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  const attempts = harness.issuanceRetireCalls.filter(({ runtimeId }) => runtimeId === "runtime-1");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].retirementKey, attempts[1].retirementKey);
});

test("authoritative provider retirement and terminal inspection precede exercise disposal", async (t) => {
  const harness = await liveGateHarness(t, { recordCleanupOrder: true });
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  const lastExerciseDispose = harness.cleanupOrder.lastIndexOf("exercise-dispose");
  assert.ok(lastExerciseDispose >= 0);
  assert.ok(harness.cleanupOrder.slice(0, lastExerciseDispose).every((entry) => (
    entry.startsWith("provider-retire:") || entry.startsWith("provider-inspect:")
  )));
  assert.ok(harness.cleanupOrder.indexOf("provider-retire:runtime-1") < lastExerciseDispose);
  assert.ok(harness.cleanupOrder.indexOf("provider-inspect:runtime-1") < lastExerciseDispose);
});

test("accepts a fresh action-scoped digest after a fully settled prior frame", async (t) => {
  const harness = await liveGateHarness(t, { frameMutation: "fresh-after-cached" });
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  const result = await runRemoteProviderLiveGate(harness.options);

  assert.equal(result.status, "PASS");
  assert.equal(harness.exerciseCalls.length, 1);
});

test("fails closed when provider evidence exceeds the bounded verifier ledger", async (t) => {
  const harness = await liveGateHarness(t, { eventFloodOnDispose: true });
  harness.options.dependencies.computerTimeoutMs = 500;
  harness.options.dependencies.frameSettleMs = 80;

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
});

test("cleanup retires captured runtimes before refusing a successor receipt", async (t) => {
  const harness = await liveGateHarness(t, { successorOnDispose: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.deepEqual(harness.retired, ["runtime-2", "runtime-1"]);
  assert.equal(harness.runtimes.get("runtime-1").state, "retired");
});

test("cleanup fences same-ID same-owner issuance replacement with different credentials", async (t) => {
  const harness = await liveGateHarness(t, { sameIdSuccessorOnDispose: true });

  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });
  assert.deepEqual(harness.retired, ["runtime-2", "runtime-1"]);
  assert.equal(harness.runtimes.get("runtime-1").state, "retired");
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
    "cached-new-sequence",
    "replayed",
    "wrong-action",
    "late-frame",
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

test("CLI reports BLOCKED without configured modules and leaks no environment", async () => {
  assert.ifError(cliLoadError);
  const stdout = outputSink();
  const stderr = outputSink();

  const code = await runCliMain({
    argv: [],
    env: {
      PRIVATE_TOKEN: "must-not-print",
      HOME: "/Users/private",
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(code, 2);
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=BLOCKED\n");
  assert.equal(stderr.value(), "");
});

test("CLI main maps injected PASS and FAIL without printing report paths", async () => {
  assert.ifError(cliLoadError);
  const dependencies = Object.freeze({
    provider: Object.freeze({}),
    exercise: Object.freeze({ async dispose() {} }),
  });
  const base = {
    argv: [],
    env: {},
    loadDependencies: () => dependencies,
    createWorkspace: async () => "/private/tmp/private-workspace",
    resolveOutputDirectory: async () => ({ directory: "/private/tmp/private-output", owned: false }),
    removeWorkspace: async () => undefined,
    buildReport: () => Object.freeze({ status: "PASS" }),
    writeReport: async () => Object.freeze({
      jsonPath: "/private/tmp/private-output/result.json",
      markdownPath: "/private/tmp/private-output/result.md",
    }),
  };

  const passStdout = outputSink();
  const passStderr = outputSink();
  let receivedGateOptions;
  const passCode = await runCliMain({
    ...base,
    stdout: passStdout.stream,
    stderr: passStderr.stream,
    async runGate(options) {
      receivedGateOptions = options;
      return Object.freeze({ status: "PASS" });
    },
  });
  assert.equal(passCode, 0);
  assert.equal(passStdout.value(), "REMOTE_PROVIDER_GATE=PASS\n");
  assert.equal(passStderr.value(), "");
  assert.equal(receivedGateOptions.workspacePath, "/private/tmp/private-workspace");
  assert.equal(receivedGateOptions.provider, dependencies.provider);
  assert.equal(receivedGateOptions.exercise, dependencies.exercise);

  const failStdout = outputSink();
  const failStderr = outputSink();
  const failCode = await runCliMain({
    ...base,
    stdout: failStdout.stream,
    stderr: failStderr.stream,
    async runGate() {
      const error = new Error("private endpoint token diagnostic");
      error.code = "REMOTE_PROVIDER_GATE_FAILED";
      throw error;
    },
  });
  assert.equal(failCode, 1);
  assert.equal(failStdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
  assert.equal(failStderr.value(), "");
});

test("CLI rejects positional arguments before loading provider code", async () => {
  assert.ifError(cliLoadError);
  const stdout = outputSink();
  let loaderCalls = 0;

  const code = await runCliMain({
    argv: ["--provider", "/Users/private/provider.cjs"],
    env: {},
    stdout: stdout.stream,
    stderr: outputSink().stream,
    loadDependencies() {
      loaderCalls += 1;
      return {};
    },
  });

  assert.equal(code, 1);
  assert.equal(loaderCalls, 0);
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
  assert.doesNotMatch(stdout.value(), /Users|provider\.cjs/);
});

test("CLI removes its private default report directory after a failed gate", async () => {
  const stdout = outputSink();
  const removed = [];
  const code = await runCliMain({
    argv: [],
    env: {},
    stdout: stdout.stream,
    stderr: outputSink().stream,
    loadDependencies: () => Object.freeze({
      provider: Object.freeze({}),
      exercise: Object.freeze({ async dispose() {} }),
    }),
    createWorkspace: async () => "/private/tmp/private-workspace",
    resolveOutputDirectory: async () => ({
      directory: "/private/tmp/owned-private-output",
      owned: true,
    }),
    removeWorkspace: async () => undefined,
    removeOutputDirectory: async (directory) => { removed.push(directory); },
    async runGate() {
      throw new Error("private failure");
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(removed, ["/private/tmp/owned-private-output"]);
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
});

test("CLI closes both reviewed dependencies when setup fails before the live gate", async () => {
  const stdout = outputSink();
  const dependencies = Object.freeze({
    provider: Object.freeze({}),
    exercise: Object.freeze({ async dispose() {} }),
  });
  let disposed = 0;

  const code = await runCliMain({
    argv: [],
    env: {},
    stdout: stdout.stream,
    stderr: outputSink().stream,
    loadDependencies: () => dependencies,
    async createWorkspace() {
      throw new Error("private setup failure");
    },
    disposeDependencies(value) {
      assert.equal(value, dependencies);
      disposed += 1;
    },
  });

  assert.equal(code, 1);
  assert.equal(disposed, 1);
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
});

test("CLI output setup failure closes the actual reviewed provider worker", async (t) => {
  const dependencies = loadLiveGateDependencies(await validModulePaths(t));
  const stdout = outputSink();

  const code = await runCliMain({
    argv: [],
    env: {},
    stdout: stdout.stream,
    stderr: outputSink().stream,
    loadDependencies: () => dependencies,
    createWorkspace: async () => "/private/tmp/private-workspace",
    async resolveOutputDirectory() {
      throw new Error("private output setup failure");
    },
    removeWorkspace: async () => undefined,
  });

  assert.equal(code, 1);
  await assert.rejects(dependencies.provider.capabilities(), {
    message: "Remote runtime provider failed.",
  });
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
});

test("CLI waits for workspace cleanup and forwards cancellation before PASS", async () => {
  assert.ifError(cliLoadError);
  const stdout = outputSink();
  const controller = new AbortController();
  let removalAttempts = 0;

  const code = await runCliMain({
    argv: [],
    env: {},
    signal: controller.signal,
    stdout: stdout.stream,
    stderr: outputSink().stream,
    loadDependencies: () => Object.freeze({
      provider: Object.freeze({}),
      exercise: Object.freeze({ async dispose() {} }),
    }),
    createWorkspace: async () => "/private/tmp/private-workspace",
    resolveOutputDirectory: async () => ({ directory: "/private/tmp/private-output", owned: false }),
    buildReport: () => Object.freeze({ status: "PASS" }),
    writeReport: async () => undefined,
    async runGate(options) {
      assert.equal(options.signal, controller.signal);
      return Object.freeze({ status: "PASS" });
    },
    async removeWorkspace() {
      removalAttempts += 1;
      throw new Error("private cleanup path");
    },
  });

  assert.equal(code, 1);
  assert.equal(removalAttempts, 2);
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
});

test("CLI never writes a PASS report before workspace removal succeeds", async () => {
  assert.ifError(cliLoadError);
  const stdout = outputSink();
  let reportWrites = 0;
  let removalAttempts = 0;
  const code = await runCliMain({
    argv: [],
    env: {},
    stdout: stdout.stream,
    stderr: outputSink().stream,
    loadDependencies: () => Object.freeze({
      provider: Object.freeze({}),
      exercise: Object.freeze({ async dispose() {} }),
    }),
    createWorkspace: async () => "/private/tmp/private-workspace",
    resolveOutputDirectory: async () => ({ directory: "/private/tmp/private-output", owned: false }),
    runGate: async () => Object.freeze({ status: "PASS" }),
    buildReport: () => Object.freeze({ status: "PASS" }),
    writeReport: async () => { reportWrites += 1; },
    async removeWorkspace() {
      removalAttempts += 1;
      throw new Error("private cleanup path");
    },
  });

  assert.equal(code, 1);
  assert.equal(removalAttempts, 2);
  assert.equal(reportWrites, 0);
  assert.equal(stdout.value(), "REMOTE_PROVIDER_GATE=FAIL\n");
});

test("live gate and CLI contain no local browser execution path", async () => {
  const source = [
    await fs.readFile(path.join(__dirname, "../src/bots/remote-provider-live-gate.cjs"), "utf8"),
    await fs.readFile(path.join(__dirname, "../scripts/verify-remote-provider.cjs"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(
    source,
    /child_process|osascript|AppleScript|\bssh\b|playwright|localhost|127\.0\.0\.1/i,
  );

  const packageJson = JSON.parse(
    await fs.readFile(path.join(__dirname, "../package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["verify:remote-provider"],
    "node scripts/verify-remote-provider.cjs",
  );
});
