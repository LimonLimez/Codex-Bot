# Remote Runtime Live Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS-only verifier that proves two bot-scoped remote runtimes work, makes Bot A open Chrome to YouTube inside its VM, rejects every local fallback, and retires all verifier-owned resources with sanitized evidence.

**Architecture:** A testable live-gate module will compose the existing `BotStore`, validated remote provider, `BotRuntimeController`, and `RemoteAppServerClient`. A separately reviewed provider exercise module will request the remote Chrome navigation using only bot/runtime/generation identity; the gate will accept success only after the production controller emits a matching current Computer frame. A thin CLI will load absolute private modules, run the gate, write mode-`0600` reports in a mode-`0700` temporary directory, and return distinct `PASS`, `BLOCKED`, and `FAIL` exit codes.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:test`, existing BotStore/runtime controller/provider/client modules, `ws` 8.21.3, macOS filesystem privacy controls.

## Global Constraints

- Work only on branch `macos/codex-bot` and only under `macos/`; do not touch Windows files or the collaborator's Windows branch.
- A live result is `PASS` only when two distinct public-remote `wss:` runtimes, exact owners, remote app-server handshakes, Chrome-to-YouTube proof, cross-bot isolation, privacy, and cleanup all succeed.
- The Mac's Chrome, AppleScript, local browser automation, SSH, a local VM, Codex cloud tasks, fixtures, and manually opened pages cannot satisfy the live gate.
- The YouTube exercise must not sign in, play media, search, click content, import a profile, or reuse a personal browser profile.
- Provider endpoints, auth tokens, account identities, provider diagnostics, credentials, and developer paths must never enter public events, logs, reports, screenshots, command arguments, or Git.
- Provider and exercise module paths must be absolute regular non-symlink files; credentials may come only from the provider's reviewed Keychain or environment mechanism.
- Every created runtime must be retired in `finally`; a changed/successor runtime that is no longer the captured bot/runtime/generation receipt must not be retired.
- Unit providers prove verifier behavior only. A real configured provider run is a separate acceptance lane and remains `BLOCKED` until the real provider and private credentials exist.
- Packaging, signing, notarization, installation, release placement, and pushing remain later explicit gates and are not authorized by this plan.

---

## File Structure

- Create `macos/src/bots/remote-provider-live-gate.cjs`: dependency loading, exercise-adapter validation, two-bot orchestration, protocol proof, frame correlation, timeouts, and cleanup.
- Create `macos/src/bots/remote-provider-live-report.cjs`: strict public result schema, redaction scan, runtime fingerprinting, private report-directory creation, and atomic JSON/Markdown writes.
- Create `macos/scripts/verify-remote-provider.cjs`: no-argument CLI that reads only named environment paths, maps gate status to exit code, and prints one sanitized summary line.
- Create `macos/test/remote-provider-live-gate.test.cjs`: hostile loader, lifecycle, app-server, Chrome/YouTube, isolation, cancellation, replacement, and cleanup tests.
- Create `macos/test/remote-provider-live-report.test.cjs`: report schema, permissions, redaction, atomic-write, and hostile-data tests.
- Modify `macos/package.json`: add the explicit `verify:remote-provider` script; add no dependency.

---

### Task 1: Private Module and Exercise Contract

**Files:**
- Create: `macos/src/bots/remote-provider-live-gate.cjs`
- Create: `macos/test/remote-provider-live-gate.test.cjs`

**Interfaces:**
- Consumes: `validateProvider(rawProvider)` from `macos/src/bots/runtime-provider.cjs`.
- Produces: `loadLiveGateDependencies({ providerModulePath, exerciseModulePath })` returning frozen `{ provider, exercise }`.
- Produces: `validateComputerExercise(raw)` returning frozen `{ openRemoteUrl(input), dispose() }`.
- `openRemoteUrl` input is frozen `{ botId, runtimeId, generation, url }`; its validated result is frozen `{ accepted: true, botId, runtimeId, generation, url }`.

- [ ] **Step 1: Write the failing loader and adapter tests**

Add tests that create mode-`0600` temporary CommonJS modules and prove:

```js
test("loads absolute regular private provider and exercise modules", async (t) => {
  const fixture = await moduleFixture(t, {
    providerSource: validProviderModuleSource(),
    exerciseSource: validExerciseModuleSource(),
  });
  const loaded = loadLiveGateDependencies(fixture);
  assert.equal((await loaded.provider.capabilities()).computerFrames, true);
  assert.equal(typeof loaded.exercise.openRemoteUrl, "function");
  assert.equal(Object.isFrozen(loaded), true);
});

test("rejects missing, relative, symlinked, group-readable, hostile, and extra exports", async (t) => {
  for (const fixture of await invalidModuleFixtures(t)) {
    assert.throws(() => loadLiveGateDependencies(fixture), {
      code: "REMOTE_PROVIDER_GATE_BLOCKED",
      message: "Remote provider verification is not configured.",
    });
  }
});

test("narrows and freezes remote exercise acknowledgements", async () => {
  const exercise = validateComputerExercise({
    async openRemoteUrl(input) {
      return { ...input, accepted: true, providerDiagnostic: "must disappear" };
    },
    async dispose() {},
  });
  const input = Object.freeze({
    botId: "bot-00000000-0000-4000-8000-000000000001",
    runtimeId: "runtime-a",
    generation: 1,
    url: "https://www.youtube.com/",
  });
  assert.deepEqual(await exercise.openRemoteUrl(input), { accepted: true, ...input });
});
```

- [ ] **Step 2: Run the tests and verify strict RED**

Run:

```bash
cd macos
node --test --test-name-pattern='absolute regular private|rejects missing|narrows and freezes' test/remote-provider-live-gate.test.cjs
```

Expected: FAIL because `remote-provider-live-gate.cjs` and its exports do not exist.

- [ ] **Step 3: Implement the strict loader and exercise validator**

Implement the public skeleton and keep raw dependencies in closure-private state:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { types } = require("node:util");
const { validateProvider } = require("./runtime-provider.cjs");

const BLOCKED_CODE = "REMOTE_PROVIDER_GATE_BLOCKED";
const BLOCKED_MESSAGE = "Remote provider verification is not configured.";
const YOUTUBE_URL = "https://www.youtube.com/";

function blockedError() {
  const error = new Error(BLOCKED_MESSAGE);
  error.code = BLOCKED_CODE;
  return error;
}

function privateModulePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw blockedError();
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw blockedError();
  return value;
}

function exactPlainObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw new TypeError(`${label} must contain data fields only.`);
  }
  if (Object.keys(descriptors).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError(`${label} has invalid fields.`);
  }
  return value;
}
```

Require provider modules to export exactly `createProvider`; require exercise modules to export exactly `createExercise`; require the created exercise to own exactly `openRemoteUrl` and `dispose`. Catch loader, constructor, accessor, proxy, and permission failures and replace them with `blockedError()` without including paths or raw diagnostics.

- [ ] **Step 4: Run the focused file GREEN**

Run:

```bash
cd macos
node --test test/remote-provider-live-gate.test.cjs
node --check src/bots/remote-provider-live-gate.cjs
```

Expected: all Task 1 tests PASS and syntax exits `0`.

- [ ] **Step 5: Commit Task 1**

```bash
git add macos/src/bots/remote-provider-live-gate.cjs macos/test/remote-provider-live-gate.test.cjs
git commit -m "test(mac): define the remote provider live gate"
```

---

### Task 2: Two-Bot Production Lifecycle and App-Server Proof

**Files:**
- Modify: `macos/src/bots/remote-provider-live-gate.cjs`
- Modify: `macos/test/remote-provider-live-gate.test.cjs`

**Interfaces:**
- Consumes: frozen `{ provider, exercise }` from Task 1.
- Consumes: `BotStore`, `BotRuntimeController`, and `RemoteAppServerClient` defaults, all injectable through `dependencies` in tests.
- Produces: `runRemoteProviderLiveGate({ provider, exercise, workspacePath, dependencies, signal })` returning a private internal result that contains no endpoint or token fields.
- Produces: helper `readRemoteProtocol(client)` returning frozen `{ accountReadable: true, modelCount }` after bounded `account/read` and paginated `model/list`.

- [ ] **Step 1: Write failing two-bot lifecycle and protocol tests**

Add an in-memory provider/socket harness and assert the real orchestration calls:

```js
test("provisions two distinct bot runtimes through the production controller", async (t) => {
  const harness = liveGateHarness(t);
  const result = await runRemoteProviderLiveGate(harness.options);
  assert.equal(result.status, "awaiting-computer-proof");
  assert.equal(harness.provisions.length, 2);
  assert.notEqual(harness.provisions[0].runtimeId, harness.provisions[1].runtimeId);
  assert.deepEqual(harness.provisions.map(({ idempotencyKey, botId }) => idempotencyKey),
    harness.provisions.map(({ botId }) => `codex-bot:${botId}`));
  assert.deepEqual(harness.protocolMethods, [
    "account/read", "model/list", "account/read", "model/list",
  ]);
  assert.equal(JSON.stringify(result).includes("authToken"), false);
  assert.equal(JSON.stringify(result).includes("wss://"), false);
});

test("fails before Computer work for duplicate runtimes, endpoints, or owners", async (t) => {
  for (const collision of ["runtimeId", "endpoint", "ownerBotId"]) {
    const harness = liveGateHarness(t, { collision });
    await assert.rejects(runRemoteProviderLiveGate(harness.options), {
      code: "REMOTE_PROVIDER_GATE_FAILED",
      message: "Remote provider verification failed.",
    });
    assert.equal(harness.exerciseCalls.length, 0);
  }
});
```

Also cover unavailable capabilities, non-ready inspection, a public hostname
whose DNS answers include loopback/link-local/private/documentation space,
address changes between the preflight and connection checks, cyclic
`nextCursor`, more than 16 catalog pages, more than 4096 models, client start
failure, stale sessions, and abort before the second provision.

- [ ] **Step 2: Run the lifecycle tests RED**

Run:

```bash
cd macos
node --test --test-name-pattern='production controller|duplicate runtimes|catalog pages|abort before' test/remote-provider-live-gate.test.cjs
```

Expected: FAIL because `runRemoteProviderLiveGate` is not implemented.

- [ ] **Step 3: Implement the isolated production pipeline**

Use a verifier-owned store file and the existing controller rather than calling provision as a stand-alone fixture path:

```js
const { BotStore } = require("./bot-store.cjs");
const { BotRuntimeController } = require("./runtime-controller.cjs");
const { RemoteAppServerClient } = require("./remote-app-server-client.cjs");
const dns = require("node:dns/promises");

async function createReadyBot(context) {
  const bot = await context.controller.createBot();
  const session = await context.controller.runtimeSession(bot.botId);
  if (!session || bot.runtime.state !== "ready") throw failedError();
  const inspected = await context.provider.inspect({ runtimeId: session.runtimeId });
  if (inspected.ownerBotId !== bot.botId || inspected.state !== "ready") throw failedError();
  return Object.freeze({ botId: bot.botId, session, runtimeId: session.runtimeId, generation: session.generation });
}

async function readRemoteProtocol(client) {
  await client.start();
  const account = await client.request("account/read", { refreshToken: false }, 30_000);
  if (!account || typeof account !== "object") throw failedError();
  let cursor = null;
  let modelCount = 0;
  const seen = new Set();
  for (let page = 0; page < 16; page += 1) {
    const result = await client.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    }, 30_000);
    if (!Array.isArray(result?.data)) throw failedError();
    modelCount += result.data.length;
    if (modelCount > 4096) throw failedError();
    const next = result.nextCursor ?? null;
    if (next === null) return Object.freeze({ accountReadable: true, modelCount });
    if (typeof next !== "string" || next.length > 512 || seen.has(next)) throw failedError();
    seen.add(next);
    cursor = next;
  }
  throw failedError();
}
```

Create two bots sequentially so each failure boundary is attributable; create both clients only after uniqueness and exact-owner inspection pass. Race every provision, inspect, client start, and request against `signal` plus a bounded timeout. Keep sessions inside the private context and return only bot IDs, shortened runtime fingerprints, generations, booleans, counts, and states.

Before constructing each client and again immediately before the WebSocket
start, resolve the endpoint hostname with
`dns.lookup(hostname, { all: true, verbatim: true })`. Require one or more
answers and reject every IPv4 or IPv6 answer in unspecified, loopback,
link-local, private, carrier-grade NAT, benchmarking, documentation, multicast,
reserved, or unique-local ranges. Require the second answer set to equal the
first sorted set so DNS rebinding cannot turn a reviewed public hostname into a
local connection. Inject the lookup function in tests; never write resolved
addresses to reports.

- [ ] **Step 4: Run Task 2 and existing runtime regressions GREEN**

Run:

```bash
cd macos
node --test test/remote-provider-live-gate.test.cjs test/remote-runtime-provider.test.cjs test/bot-runtime-controller.test.cjs test/remote-app-server-client.test.cjs
```

Expected: all tests PASS with no timeout, unhandled rejection, or open handle.

- [ ] **Step 5: Commit Task 2**

```bash
git add macos/src/bots/remote-provider-live-gate.cjs macos/test/remote-provider-live-gate.test.cjs
git commit -m "feat(mac): verify two remote bot runtimes"
```

---

### Task 3: Chrome-to-YouTube Computer Evidence and Isolation

**Files:**
- Modify: `macos/src/bots/remote-provider-live-gate.cjs`
- Modify: `macos/test/remote-provider-live-gate.test.cjs`

**Interfaces:**
- Consumes: Bot A receipt `{ botId, runtimeId, generation }` from Task 2.
- Consumes: `exercise.openRemoteUrl({ botId, runtimeId, generation, url })` from Task 1.
- Produces: `waitForYouTubeFrame({ controller, receipt, exercise, signal, timeoutMs })` returning frozen `{ browser: "Google Chrome", host: "www.youtube.com", titleMarker: "YouTube", frameReceived: true }`.
- Accepts controller events only in exact public shape `{ botId, generation, runtime, event }` with `event.type === "computer/frame"`.

- [ ] **Step 1: Write the failing success and rejection matrix**

```js
test("passes only after Bot A remote Chrome shows YouTube", async (t) => {
  const harness = liveGateHarness(t, { emitYouTubeFrame: true });
  const result = await runRemoteProviderLiveGate(harness.options);
  assert.equal(result.status, "PASS");
  assert.deepEqual(harness.exerciseCalls, [{
    botId: harness.botIds[0],
    runtimeId: harness.runtimeIds[0],
    generation: 1,
    url: "https://www.youtube.com/",
  }]);
  assert.deepEqual(result.computer, {
    browser: "Google Chrome",
    host: "www.youtube.com",
    titleMarker: "YouTube",
    frameReceived: true,
  });
  assert.equal(harness.botBFrames.length, 0);
  assert.equal(harness.localBrowserCalls, 0);
});

test("rejects acknowledgement without an exact current YouTube frame", async (t) => {
  for (const mutation of [
    "no-frame", "wrong-bot", "wrong-runtime", "wrong-generation", "stale",
    "cached", "replayed", "wrong-browser", "wrong-host", "missing-title", "malformed-frame",
  ]) {
    const harness = liveGateHarness(t, { frameMutation: mutation });
    await assert.rejects(runRemoteProviderLiveGate(harness.options), {
      code: "REMOTE_PROVIDER_GATE_FAILED",
    });
  }
});

test("rejects any exercise adapter that invokes a local fallback capability", async (t) => {
  const harness = liveGateHarness(t, { exerciseUsesLocalBrowser: true });
  await assert.rejects(runRemoteProviderLiveGate(harness.options), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
  });
  assert.equal(harness.proofAccepted, false);
});
```

The fake frame must contain ordinary proof only:

```js
{
  runtimeId,
  type: "computer/frame",
  sequence: 1,
  payload: {
    browser: { name: "Google Chrome", url: "https://www.youtube.com/", title: "YouTube" },
    frame: { width: 1280, height: 720, digest: "sha256:fixture-frame" },
  },
}
```

- [ ] **Step 2: Run the Computer tests RED**

Run:

```bash
cd macos
node --test --test-name-pattern='remote Chrome shows YouTube|without an exact current|local fallback capability' test/remote-provider-live-gate.test.cjs
```

Expected: FAIL because the live gate does not yet invoke the exercise or correlate frames.

- [ ] **Step 3: Implement acknowledgement and frame correlation**

Register the event listener before calling the exercise, capture one immutable receipt, and remove the listener in `finally`:

```js
async function waitForYouTubeFrame({ controller, receipt, exercise, signal, timeoutMs }) {
  const frameFlight = currentRuntimeEvent(controller, receipt, signal, timeoutMs);
  const acknowledgement = await exercise.openRemoteUrl(Object.freeze({
    botId: receipt.botId,
    runtimeId: receipt.runtimeId,
    generation: receipt.generation,
    url: YOUTUBE_URL,
  }));
  if (!sameReceipt(acknowledgement, receipt) || acknowledgement.url !== YOUTUBE_URL) throw failedError();
  const event = await frameFlight;
  const browser = event.event.payload?.browser;
  const url = new URL(browser?.url);
  if (browser?.name !== "Google Chrome"
    || url.protocol !== "https:"
    || url.hostname !== "www.youtube.com"
    || typeof browser.title !== "string"
    || !browser.title.includes("YouTube")
    || !validFrameDescriptor(event.event.payload?.frame)) throw failedError();
  return Object.freeze({
    browser: "Google Chrome",
    host: "www.youtube.com",
    titleMarker: "YouTube",
    frameReceived: true,
  });
}
```

Require a monotonically increasing positive sequence and accept it once. Reject later duplicates. Before accepting, call `controller.runtimeSession(botId)` and require the same runtime ID and generation again. Assert that the event's public runtime remote ID matches and that no event with Bot A's runtime has been observed under Bot B.

The gate has no import or callback for local Chrome, Playwright, AppleScript, `open`, `osascript`, SSH, or a hypervisor. Add a source-level test that the live-gate and CLI files contain none of those execution imports or commands.

- [ ] **Step 4: Run Task 3 and event-fencing regressions GREEN**

Run:

```bash
cd macos
node --test test/remote-provider-live-gate.test.cjs test/bot-runtime-controller.test.cjs
```

Expected: the YouTube success test and every stale/cross-bot/failure case PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add macos/src/bots/remote-provider-live-gate.cjs macos/test/remote-provider-live-gate.test.cjs
git commit -m "feat(mac): prove remote Chrome with a scoped frame"
```

---

### Task 4: Fail-Closed Cleanup and Sanitized Reports

**Files:**
- Create: `macos/src/bots/remote-provider-live-report.cjs`
- Create: `macos/test/remote-provider-live-report.test.cjs`
- Modify: `macos/src/bots/remote-provider-live-gate.cjs`
- Modify: `macos/test/remote-provider-live-gate.test.cjs`

**Interfaces:**
- Produces: `runtimeFingerprint(runtimeId)` as `sha256:<first 16 lowercase hex>`.
- Produces: `publicGateReport(privateResult)` with exact frozen keys `schemaVersion,status,startedAt,finishedAt,provider,bots,capabilities,protocol,computer,isolation,cleanup`.
- Produces: `writeGateReport({ report, outputDirectory })` returning frozen absolute `{ jsonPath, markdownPath }` without logging either path.
- Gate errors expose only code `REMOTE_PROVIDER_GATE_BLOCKED` or `REMOTE_PROVIDER_GATE_FAILED` and fixed public messages.

- [ ] **Step 1: Write report privacy and cleanup REDs**

```js
test("writes exact sanitized reports with private permissions", async (t) => {
  const outputDirectory = await privateOutputFixture(t);
  const privateResult = successfulPrivateResult({
    endpoint: "wss://runtime.example/private?access_token=never-print",
    authToken: "private-auth-token-value",
    account: { email: "private@example.com" },
    providerDiagnostic: "/Users/private/source",
  });
  const report = publicGateReport(privateResult);
  const paths = await writeGateReport({ report, outputDirectory });
  assert.deepEqual(Reflect.ownKeys(report), [
    "schemaVersion", "status", "startedAt", "finishedAt", "provider", "bots",
    "capabilities", "protocol", "computer", "isolation", "cleanup",
  ]);
  assert.equal((await fs.stat(outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(paths.jsonPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(paths.jsonPath, "utf8"),
    /access_token|private-auth|private@example|\/Users\/private|wss:/i);
});

test("retires both exact owned runtimes after every failure boundary", async (t) => {
  for (const failAt of [
    "bot-a-provision", "bot-b-provision", "inspect", "client-start", "account-read",
    "model-list", "exercise", "frame-timeout", "frame-invalid", "report-write",
  ]) {
    const harness = liveGateHarness(t, { failAt });
    await assert.rejects(runRemoteProviderLiveGate(harness.options));
    assert.deepEqual(harness.retired.sort(), harness.createdRuntimeIds.sort());
    assert.equal(harness.clients.every((client) => client.stopped), true);
    assert.equal(harness.unsubscribeCount, 1);
    assert.equal(harness.exerciseDisposed, 1);
  }
});

test("does not retire a replacement runtime after the captured receipt changes", async (t) => {
  const harness = liveGateHarness(t, { replaceBotABeforeCleanup: true });
  await assert.rejects(runRemoteProviderLiveGate(harness.options));
  assert.equal(harness.retired.includes(harness.replacementRuntimeId), false);
  assert.equal(harness.cleanup.safe, false);
});
```

- [ ] **Step 2: Run report and cleanup tests RED**

Run:

```bash
cd macos
node --test test/remote-provider-live-report.test.cjs
node --test --test-name-pattern='every failure boundary|replacement runtime' test/remote-provider-live-gate.test.cjs
```

Expected: FAIL because report and final cleanup contracts are missing.

- [ ] **Step 3: Implement exact reports and authoritative cleanup**

Use a fixed allowlist rather than recursively copying private execution state:

```js
function publicGateReport(result) {
  const report = {
    schemaVersion: 1,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    provider: result.provider,
    bots: result.bots.map(({ botId, runtimeFingerprint, generation }) => ({
      botId, runtimeFingerprint, generation,
    })),
    capabilities: { ...result.capabilities },
    protocol: { ...result.protocol },
    computer: { ...result.computer },
    isolation: { ...result.isolation },
    cleanup: { ...result.cleanup },
  };
  assertPublicReport(report);
  return deepFreeze(report);
}
```

Create `outputDirectory` with `0o700`, reject symlinks and pre-existing non-private directories, write unique temporary files with `0o600` and `O_EXCL`, `fsync`, atomically rename to `result.json` and `result.md`, then sync the directory. Scan both serialized outputs for raw and canonical endpoint/token/account/path material before rename.

In `runRemoteProviderLiveGate`, pass the controller a narrow recording wrapper
around the validated provider. Record each successful provision result before
returning it to the controller so even a later controller-activation failure
has an exact cleanup receipt. Keep that ledger private and per bot:

```js
const cleanupLedger = new Map();

async function retireCaptured(context, captured) {
  const currentBot = await context.store.read(captured.botId).catch(() => null);
  const currentSession = await context.controller.runtimeSession(captured.botId).catch(() => null);
  const inspected = await context.provider.inspect({ runtimeId: captured.runtimeId }).catch(() => null);
  const storeStillOwnsReceipt = currentBot?.runtime.remoteRuntimeId === captured.runtimeId
    && currentBot.runtime.provider === captured.provider;
  const sessionStillOwnsReceipt = currentSession === null
    || (currentSession.runtimeId === captured.runtimeId
      && currentSession.generation === captured.generation);
  if (!storeStillOwnsReceipt
    || !sessionStillOwnsReceipt
    || inspected?.runtimeId !== captured.runtimeId
    || inspected.ownerBotId !== captured.botId) return false;
  const retired = await context.provider.retire({ runtimeId: captured.runtimeId });
  return retired.runtimeId === captured.runtimeId
    && (retired.state === "retired" || retired.state === "detached");
}
```

Stop clients first, dispose the exercise, call authoritative `retireCaptured`
for each successful provision receipt, poll inspect with a 30-second total
cleanup deadline, dispose the controller, remove only the verifier-owned store
directory, and record cleanup `safe:false` if identity cannot be proven. The
provider contract for this gate requires a runtime ID to remain unique for the
entire verifier run; detected reuse or replacement is a contract failure and
must not cause retirement of the replacement. Do not convert an unsafe cleanup
to `PASS`.

- [ ] **Step 4: Run privacy, cleanup, and release-audit regressions GREEN**

Run:

```bash
cd macos
node --test test/remote-provider-live-report.test.cjs test/remote-provider-live-gate.test.cjs test/release-package.test.cjs
node --check scripts/audit-release.cjs
```

Expected: all tests PASS and the release-audit syntax check exits `0` without creating a release.

- [ ] **Step 5: Commit Task 4**

```bash
git add macos/src/bots/remote-provider-live-gate.cjs macos/src/bots/remote-provider-live-report.cjs macos/test/remote-provider-live-gate.test.cjs macos/test/remote-provider-live-report.test.cjs
git commit -m "fix(mac): retire live-gate runtimes safely"
```

---

### Task 5: Explicit CLI and Status Contract

**Files:**
- Create: `macos/scripts/verify-remote-provider.cjs`
- Modify: `macos/package.json`
- Modify: `macos/test/remote-provider-live-gate.test.cjs`

**Interfaces:**
- Reads: `CODEX_BOT_REMOTE_PROVIDER_MODULE` and `CODEX_BOT_REMOTE_EXERCISE_MODULE` only as absolute module paths, paired with exact lowercase-hex `CODEX_BOT_REMOTE_PROVIDER_SHA256` and `CODEX_BOT_REMOTE_EXERCISE_SHA256` values.
- Reads: optional `CODEX_BOT_REMOTE_GATE_OUTPUT_DIR` only when it is an absolute verifier-owned private directory.
- Prints exactly one sanitized line: `REMOTE_PROVIDER_GATE=<PASS|BLOCKED|FAIL>`.
- Exits `0` for `PASS`, `2` for `BLOCKED`, and `1` for `FAIL`.

- [ ] **Step 1: Write failing CLI subprocess tests**

```js
test("CLI reports BLOCKED without modules and leaks no environment", async () => {
  const result = await runGateCli({
    env: { PRIVATE_TOKEN: "must-not-print", HOME: "/Users/private" },
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "REMOTE_PROVIDER_GATE=BLOCKED\n");
  assert.equal(result.stderr, "");
});

test("CLI main maps injected PASS and FAIL without printing report paths", async () => {
  const injected = {
    loadDependencies: () => Object.freeze({ provider: {}, exercise: {} }),
    writeReport: async () => undefined,
  };
  const pass = await runCliMain({ ...injected, runGate: async () => successfulPrivateResult() });
  assert.deepEqual(pass, { code: 0, stdout: "REMOTE_PROVIDER_GATE=PASS\n", stderr: "" });
  const fail = await runCliMain({
    ...injected,
    runGate: async () => { throw Object.assign(new Error("private"), { code: "REMOTE_PROVIDER_GATE_FAILED" }); },
  });
  assert.deepEqual(fail, { code: 1, stdout: "REMOTE_PROVIDER_GATE=FAIL\n", stderr: "" });
});
```

- [ ] **Step 2: Run CLI tests RED**

Run:

```bash
cd macos
node --test --test-name-pattern='CLI reports|CLI maps' test/remote-provider-live-gate.test.cjs
```

Expected: FAIL because the CLI and package script do not exist.

- [ ] **Step 3: Implement the no-argument CLI**

```js
#!/usr/bin/env node
"use strict";

const { loadLiveGateDependencies, runRemoteProviderLiveGate } = require("../src/bots/remote-provider-live-gate.cjs");
const { publicGateReport, writeGateReport } = require("../src/bots/remote-provider-live-report.cjs");

async function main({
  env = process.env,
  stdout = process.stdout,
  runGate = runRemoteProviderLiveGate,
  loadDependencies = loadLiveGateDependencies,
  writeReport = writeGateReport,
} = {}) {
  try {
    const dependencies = loadDependencies({
      providerModulePath: env.CODEX_BOT_REMOTE_PROVIDER_MODULE,
      providerModuleSha256: env.CODEX_BOT_REMOTE_PROVIDER_SHA256,
      exerciseModulePath: env.CODEX_BOT_REMOTE_EXERCISE_MODULE,
      exerciseModuleSha256: env.CODEX_BOT_REMOTE_EXERCISE_SHA256,
    });
    const privateResult = await runGate(dependencies);
    await writeReport({
      report: publicGateReport(privateResult),
      outputDirectory: env.CODEX_BOT_REMOTE_GATE_OUTPUT_DIR,
    });
    stdout.write("REMOTE_PROVIDER_GATE=PASS\n");
    return 0;
  } catch (error) {
    const blocked = error?.code === "REMOTE_PROVIDER_GATE_BLOCKED";
    stdout.write(`REMOTE_PROVIDER_GATE=${blocked ? "BLOCKED" : "FAIL"}\n`);
    return blocked ? 2 : 1;
  }
}

if (require.main === module) void main().then((code) => { process.exitCode = code; });

module.exports = { main };
```

Add to `macos/package.json`:

```json
"verify:remote-provider": "node scripts/verify-remote-provider.cjs"
```

Reject positional arguments so secrets and paths cannot be passed on the command line. Ensure subprocess signal termination reaches the gate's `AbortController` and awaits cleanup before exit.

- [ ] **Step 4: Run CLI and full focused verification GREEN**

Run:

```bash
cd macos
node scripts/verify-remote-provider.cjs
test "$?" -eq 2
node --test test/remote-provider-live-gate.test.cjs test/remote-provider-live-report.test.cjs
npm test
npm run check
```

Expected: the unconfigured live command prints `REMOTE_PROVIDER_GATE=BLOCKED` and exits `2`; all tests and source checks PASS. Run the exit-code assertion in a shell block that temporarily disables immediate exit so the expected `2` can be inspected without aborting the verification script.

- [ ] **Step 5: Commit Task 5**

```bash
git add macos/scripts/verify-remote-provider.cjs macos/package.json macos/test/remote-provider-live-gate.test.cjs
git commit -m "feat(mac): add the remote provider verification command"
```

---

### Task 6: Independent Review and Generic Gate Verification

**Files:**
- Modify only files from Tasks 1-5 when a reviewer confirms a defect under a new failing test.

**Interfaces:**
- Consumes all Task 1-5 public exports and commands.
- Produces a reviewed generic verifier whose truthful local outcome is `BLOCKED` without a real provider.

- [ ] **Step 1: Run the complete macOS verification boundary**

```bash
cd macos
node --test test/remote-provider-live-gate.test.cjs test/remote-provider-live-report.test.cjs test/remote-runtime-provider.test.cjs test/bot-runtime-controller.test.cjs test/remote-app-server-client.test.cjs test/release-package.test.cjs
npm test
npm run check
git diff --check
```

Expected: every unit/regression command exits `0`.

- [ ] **Step 2: Audit source and Git scope**

```bash
git status --short
git diff --name-only HEAD~5..HEAD
rg -n 'authToken|Authorization|wss:|/Users/|osascript|AppleScript|child_process|ssh|localhost|127\.0\.0\.1' \
  macos/src/bots/remote-provider-live-*.cjs \
  macos/scripts/verify-remote-provider.cjs \
  macos/test/remote-provider-live-*.test.cjs
```

Expected: only the five planned macOS source/test/script files plus `macos/package.json` changed; matches exist only in rejection/redaction tests or private in-memory handling, never output/log statements or local execution code.

- [ ] **Step 3: Request an independent read-only review**

Give the reviewer the approved design, this plan, the exact diff, and test evidence. Require explicit findings for loader security, session privacy, two-bot ownership, same-runtime collisions, frame receipt correlation, timeout/cancellation, successor-safe cleanup, report redaction, and no-local-fallback behavior.

- [ ] **Step 4: Address each confirmed finding with its own RED/GREEN loop**

For each confirmed finding, add one deterministic named test to the relevant live-gate or report test file, run it against unchanged production to capture RED, make the smallest fix, rerun the focused group, then repeat Step 1.

- [ ] **Step 5: Confirm the honest unconfigured status**

```bash
cd macos
env -u CODEX_BOT_REMOTE_PROVIDER_MODULE \
    -u CODEX_BOT_REMOTE_PROVIDER_SHA256 \
    -u CODEX_BOT_REMOTE_EXERCISE_MODULE \
    -u CODEX_BOT_REMOTE_EXERCISE_SHA256 \
    node scripts/verify-remote-provider.cjs
```

Expected: stdout is exactly `REMOTE_PROVIDER_GATE=BLOCKED`, stderr is empty, and exit status is `2`. Do not commit a generated report or call this VM proof.

---

### Task 7: Real Provider Chrome-to-YouTube Acceptance

**Files:**
- Read only: reviewed provider module named by `CODEX_BOT_REMOTE_PROVIDER_MODULE`.
- Read only: provider SHA-256 named by `CODEX_BOT_REMOTE_PROVIDER_SHA256`.
- Read only: reviewed exercise module named by `CODEX_BOT_REMOTE_EXERCISE_MODULE`.
- Read only: exercise SHA-256 named by `CODEX_BOT_REMOTE_EXERCISE_SHA256`.
- Generate privately: verifier-owned report directory outside the repository.

**Interfaces:**
- Consumes the exact private module/environment contract from Tasks 1 and 5.
- Produces one sanitized `PASS`, `BLOCKED`, or `FAIL` report; only `PASS` is live VM proof.

- [ ] **Step 1: Verify private configuration without printing values**

```bash
test -n "$CODEX_BOT_REMOTE_PROVIDER_MODULE"
test -n "$CODEX_BOT_REMOTE_PROVIDER_SHA256"
test -n "$CODEX_BOT_REMOTE_EXERCISE_MODULE"
test -n "$CODEX_BOT_REMOTE_EXERCISE_SHA256"
test -f "$CODEX_BOT_REMOTE_PROVIDER_MODULE"
test -f "$CODEX_BOT_REMOTE_EXERCISE_MODULE"
```

Expected: all checks exit `0`. If any check fails, stop with `BLOCKED`; do not request credentials in chat or substitute a fixture.

- [ ] **Step 2: Run the live gate once**

```bash
cd macos
node scripts/verify-remote-provider.cjs
```

Expected: stdout is exactly `REMOTE_PROVIDER_GATE=PASS`, stderr is empty, and exit status is `0`. The selected bot's disposable remote runtime opens Google Chrome to `https://www.youtube.com/`; the Mac's Chrome is not intentionally opened or changed.

- [ ] **Step 3: Inspect sanitized evidence and cleanup**

Inspect the current Bot A Computer frame during the run and require the visible
Google Chrome chrome plus the signed-out YouTube landing page. Read the
mode-`0600` JSON and Markdown files from the verifier-owned private report
directory. Confirm two different runtime fingerprints, exact bot ownership,
both app-server handshakes, model counts, Bot A Chrome/YouTube proof, no Bot A
frame under Bot B, and terminal cleanup for both runtimes. Search the reports
for endpoint schemes, credentials, account identifiers, `/Users/`, provider
diagnostics, and raw frame data; require zero matches. Retain a screenshot only
when it contains no login/account identity, cookies, history, bookmarks,
notifications, developer paths, or other personal content and the release
privacy scan passes; otherwise record only the frame digest and discard pixels.

- [ ] **Step 4: Record the acceptance result without secrets**

If the result is `PASS`, record only the gate timestamp, provider display name, sanitized report hashes, pass status, and cleanup status in the task report. If the result is `BLOCKED` or `FAIL`, preserve only sanitized diagnostic codes and keep packaging, signing, notarization, release placement, and push blocked.

- [ ] **Step 5: Stop at the release boundary**

Do not build or overwrite `/Applications/Codex Bot.app`, sign, notarize, package a final DMG, upload a release asset, or push the branch in this task. Those actions require the already planned privacy/package verification and explicit release authorization after the live report is reviewed.
