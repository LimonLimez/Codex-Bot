# Reviewed Remote Adapter Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute exact SHA-256-reviewed remote provider and Computer exercise adapters behind an enforceable no-filesystem Node Worker boundary while preserving the current live-gate contracts.

**Architecture:** The main gate verifies private regular-file bytes, then starts an eval Worker under `--permission` with no grants. A structured-clone RPC proxy preserves the provider/exercise interfaces, recreates abort signals inside the worker, and owns deterministic subscription and shutdown lifecycles.

**Tech Stack:** Node.js 22.13.0+ Worker Threads, Node permission model, CommonJS, `node:test`

## Global Constraints

- macOS-only branch and files; no Windows edits.
- Exact reviewed adapter bytes remain limited to 1 MiB and paired with lowercase SHA-256.
- Reviewed source gets no filesystem, child-process, native-addon, WASI, or nested-worker grant.
- Reviewed source is trusted exact-hash code; the permission model is defense in depth, not a malicious-code sandbox.
- Provider networking remains possible; local Chrome, local VM, SSH, and local browser automation remain forbidden.
- All public failures remain sanitized and contain no adapter path, source, endpoint, token, credential, or diagnostic.
- Real remote Chrome/YouTube acceptance, DMG signing, notarization, installation, and push remain blocked until the external provider gate passes.

---

### Task 1: Permissioned Worker Bootstrap and Readiness Handshake

**Files:**
- Create: `macos/src/bots/reviewed-adapter-worker-source.cjs`
- Modify: `macos/src/bots/remote-provider-live-gate.cjs:3-260`
- Test: `macos/test/remote-provider-live-gate.test.cjs:177-270`

**Interfaces:**
- Consumes: `{ modulePath, source, factoryName, adapterKind, handshake, port }` through `workerData`.
- Produces: `createReviewedAdapterWorker({ modulePath, source, factoryName, adapterKind })` returning a private worker channel after a bounded synchronous ready/error handshake.

- [ ] **Step 1: Preserve the failing host-constructor regression**

The reviewed source must attempt:

```js
const hostProcess = Buffer.constructor("return process")();
const createRequire = hostProcess.getBuiltinModule("node:module").createRequire;
module.exports = createRequire(__filename)("./helper.cjs");
```

and `loadLiveGateDependencies(...)` must throw only
`REMOTE_PROVIDER_GATE_BLOCKED`.

- [ ] **Step 2: Run the RED**

Run:

```bash
cd macos
node --test --test-name-pattern='loads exact reviewed module bytes' test/remote-provider-live-gate.test.cjs
```

Expected: `0` pass, `1` fail with `Missing expected exception` at the new constructor-escape assertion.

- [ ] **Step 3: Implement the bootstrap**

Export one frozen source string. In the worker, evaluate `Module.wrap(source)`
with a throwing `require`, call the exact factory, validate exact provider
methods `capabilities,provision,inspect,retire,subscribe` or exact exercise
methods `openRemoteUrl,dispose`, and report readiness through the transferred
port before notifying the shared handshake flag.

- [ ] **Step 4: Start the worker with no permission grants**

Use:

```js
new Worker(REVIEWED_ADAPTER_WORKER_SOURCE, {
  eval: true,
  execArgv: ["--permission"],
  workerData,
  transferList: [port],
});
```

Wait at most 1,000 ms for the shared flag and consume exactly one ready/error
message with `receiveMessageOnPort`. Terminate and throw `blockedError()` for
timeout, exit, malformed readiness, or permission failure.

- [ ] **Step 5: Run the exact-byte test GREEN**

Run the Step 2 command. Expected: `1` pass, `0` fail, and the helper module has
no observable side effect.

### Task 2: Structured-Clone RPC, Abort, Events, and Shutdown

**Files:**
- Modify: `macos/src/bots/reviewed-adapter-worker-source.cjs`
- Modify: `macos/src/bots/remote-provider-live-gate.cjs:185-380`
- Modify: `macos/test/remote-provider-live-gate.test.cjs:120-360`

**Interfaces:**
- Produces provider proxy methods `capabilities()`, `provision(input)`, `inspect(input)`, `retire(input)`, and `subscribe(callback)`.
- Produces exercise proxy methods `openRemoteUrl(input)` and `dispose()`.
- RPC messages are exact data-only records keyed by positive safe-integer `id`; abort messages recreate a worker-local signal.
- Worker-side result and event validation bounds string values and property
  keys, total bytes, fields, nodes, and depth before structured-clone IPC.
- Worker resource limits bound old generation, young generation, and stack.

- [ ] **Step 1: Add REDs for cloned inputs and abort**

Use a reviewed provider that records whether `input.constructor === Object` in
the worker and waits for its worker-local signal. Assert the main operation
resolves with cloned data and rejects promptly after the main signal aborts.

- [ ] **Step 2: Add REDs for early events and shutdown**

Use a provider that emits once during subscription startup. Assert the event is
delivered exactly once after the main subscriber attaches, unsubscribe stops
later delivery, exercise disposal terminates its worker, and the provider
worker terminates after its single live-gate subscription is removed.

- [ ] **Step 3: Implement RPC**

The main proxy allocates monotonic IDs, stores one pending promise per ID, sends
cloneable fields without `AbortSignal`, mirrors abort by ID, accepts each reply
once, and rejects every pending request on exit. The worker owns one
`AbortController` per operation and posts only `{ type:'result', id, ok, value }`
or `{ type:'event', value }` records.

- [ ] **Step 4: Implement bounded event ownership**

Start and validate the provider's raw subscription during worker startup.
Buffer no more than `MAX_GATE_EVENTS` cloned events before the main callback
attaches. Accept one active main subscriber. Unsubscribe calls the raw worker
unsubscribe, rejects further operations, clears pending state, and terminates
the worker.

- [ ] **Step 5: Make RPC and lifecycle tests GREEN**

Run:

```bash
cd macos
node --test test/remote-provider-live-gate.test.cjs
```

Expected: all live-gate tests pass with no warning, leaked worker, or open test
handle.

### Task 3: Adversarial Protocol and Permission Closure

**Files:**
- Modify: `macos/test/remote-provider-live-gate.test.cjs`
- Modify: `macos/src/bots/reviewed-adapter-worker-source.cjs`
- Modify: `macos/src/bots/remote-provider-live-gate.cjs`

**Interfaces:**
- Preserves public `loadLiveGateDependencies(options) -> frozen { provider, exercise }`.
- All loader failures remain the exact sanitized blocked error.

- [ ] **Step 1: Add REDs for filesystem and process capabilities**

Assert reviewed source cannot load an unhashed private or mode-0644 helper via
direct require, `createRequire`, recovered `process`, or `Buffer.constructor`;
cannot write a marker file; cannot spawn a child; and cannot create a nested
Worker.

- [ ] **Step 2: Add REDs for malformed worker traffic**

Assert duplicate/unknown replies, uncloneable values, invalid subscription
return values, post-unsubscribe events, worker exit, and worker error cannot
resolve a pending operation or leak raw diagnostics.

- [ ] **Step 3: Apply minimal fail-closed handling**

Reject the exact affected worker/proxy on the first protocol violation, clear
its bounded queues and pending map, remove abort listeners, and terminate it.
Do not add retries, alternate loaders, local module fallback, or source-text
denylists.

- [ ] **Step 4: Run focused security regressions**

Run:

```bash
cd macos
node --test test/remote-provider-live-gate.test.cjs test/remote-runtime-provider.test.cjs
node --check src/bots/reviewed-adapter-worker-source.cjs
node --check src/bots/remote-provider-live-gate.cjs
```

Expected: all pass, syntax exits `0`, and no temporary helper marker exists.

### Task 4: Broad Verification and Independent Review

**Files:**
- Modify only if a confirmed review finding requires it: the three Task 1-3 files.

**Interfaces:**
- Consumes the final reviewed worker boundary.
- Produces review evidence; does not produce a DMG or live-runtime PASS.

- [ ] **Step 1: Run the complete configured-file boundary**

Run:

```bash
cd macos
node --test \
  test/remote-provider-live-gate.test.cjs \
  test/remote-provider-live-report.test.cjs \
  test/remote-runtime-provider.test.cjs \
  test/bot-runtime-controller.test.cjs \
  test/bot-store.test.cjs \
  test/remote-app-server-client.test.cjs \
  test/release-package.test.cjs \
  test/installer-bundle.test.cjs \
  test/patch-app.test.cjs
```

Expected: all pass with zero unexpected skips.

- [ ] **Step 2: Run authoritative macOS tests**

Run:

```bash
cd macos
npm test
```

Expected: exit `0`; only explicitly documented live/external skips may remain.

- [ ] **Step 3: Run static and scope checks**

Run syntax checks for every changed CJS file, `git diff --check`, inspect exact
branch status, and scan the diff for Windows paths, credentials, endpoints,
home paths, private reports, local browser execution, or package artifacts.

- [ ] **Step 4: Request independent review**

Ask the existing read-only reviewer to replay the constructor escape, import
closure, worker lifecycle, abort, protocol, privacy, and full focused suite.
Address each confirmed finding through its own RED/GREEN cycle.

- [ ] **Step 5: Commit the reviewed boundary**

Stage only the worker source, live gate/CLI source, focused tests, Node engine
metadata, and these two reviewed design/plan amendments. Commit with:

```bash
git commit -m "fix(mac): isolate reviewed provider workers"
```

Do not package, sign, notarize, install, or push at this step.
