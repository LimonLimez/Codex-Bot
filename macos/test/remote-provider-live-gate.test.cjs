"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let loadLiveGateDependencies;
let validateComputerExercise;
let moduleLoadError = null;
try {
  ({
    loadLiveGateDependencies,
    validateComputerExercise,
  } = require("../src/bots/remote-provider-live-gate.cjs"));
} catch (error) {
  moduleLoadError = error;
}

const BOT_ID = "bot-00000000-0000-4000-8000-000000000001";

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
