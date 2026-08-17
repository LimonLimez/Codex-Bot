# Signed-Out Local Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exact Grok Bot 0.20 Routines UI execute durable per-bot local cron jobs through each bot's current Direct Codex or CLIProxy model while Cursor is truthfully signed out.

**Architecture:** Add a pure bounded cron calculator, a private atomic automation store, and an EventEmitter controller that schedules one earliest-due timer and reuses the durable standalone conversation runtime. Adapt exact Grok coordinator RPCs and full-snapshot events, then compose automation startup/deletion/disposal into the current runtime without changing the renderer or mapping Free Local Desktop to Forever Box.

**Tech Stack:** Node.js CommonJS, Electron MessagePort coordinator protocol v1, `node:test`, `node:fs/promises`, `Intl.DateTimeFormat`, existing standalone conversation controller, existing macOS patch/package pipeline.

## Global Constraints

- Preserve the exact Grok Bot 0.20 renderer, component tree, CSS, routes, and Routines controls; do not add or modify renderer markup or styles.
- Cursor/Grok remains truthfully signed out. Only Remote VM / Forever Box and remote event connectors are unavailable.
- Direct Codex and CLIProxy use each bot's existing durable model selection; no on-device fallback and no fake remote state.
- Local Routines run while the OpenBot process is alive, including when all windows are closed. Explicit Quit stops scheduling.
- Support five-field cron, `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually`, `@every N[s|m|h|d]`, and optional `CRON_TZ=` / `TZ=` IANA time zones.
- At most 50 Routines per bot, 100 aggregate rows, 20 newest-first runs per Routine, and one concurrent run per Routine.
- Restart catch-up is bounded to one missed scheduled run. An interrupted running record becomes a terminal error before catch-up is evaluated.
- `runAgentAutomationNow` remains pending until terminal run persistence and final event publication, then resolves `undefined`, matching Grok 0.20.
- Automation mutation replies and events are full current snapshots. No mutation reports success before its private atomic commit.
- Bot deletion and app disposal dominate late timers, store reads, conversation events, and native publications.
- Do not enable MCP, plugin execution, recursive child tools, Cursor authentication mutations, remote connector triggers, or app-closed daemon execution in this plan.

---

## File map

- `macos/src/desktop/local-cron-schedule.cjs`: pure validation, normalization, and next-occurrence calculation.
- `macos/src/desktop/local-automation-store.cjs`: schema-v1 private durable automation/run/conversation-binding state.
- `macos/src/desktop/local-automation-controller.cjs`: native automation operations, one-timer scheduler, standalone-conversation execution, events, deletion, and disposal.
- `macos/src/desktop/openbot-native-coordinator.cjs`: exact Grok RPC dispatch, automation/workflow projections, and port events.
- `macos/src/desktop/bot-deletion-coordinator.cjs`: cleanup ordering for durable automation records.
- `macos/src/desktop/runtime.cjs`: production construction, startup readiness, native injection, and shutdown ordering.
- `macos/src/patch/desktop.cjs`, `macos/scripts/patch-app.cjs`: packaged-file and mutation closure.
- One focused `node:test` file per new module plus existing native/runtime/package suites.

---

### Task 1: Bounded cron parsing and next-occurrence calculation

**Files:**
- Create: `macos/src/desktop/local-cron-schedule.cjs`
- Create: `macos/test/local-cron-schedule.test.cjs`

**Interfaces:**
- Produces: `parseLocalCron(expression: string) -> Frozen<LocalCronSchedule>`
- Produces: `nextLocalCronAt(schedule: LocalCronSchedule, afterEpochMs: number) -> number`
- `LocalCronSchedule` is an opaque frozen record returned only by `parseLocalCron`; later tasks persist `schedule.normalized` and reparse it on read.
- Throws `LocalCronScheduleError` with code `OPENBOT_LOCAL_AUTOMATION_INVALID` and sanitized message for every invalid input.

- [ ] **Step 1: Write the alias, interval, and five-field RED tests**

```js
const { parseLocalCron, nextLocalCronAt } = require("../src/desktop/local-cron-schedule.cjs");

test("local cron supports aliases intervals and bounded five-field syntax", () => {
  assert.equal(parseLocalCron("@daily").normalized, "0 0 * * *");
  assert.equal(nextLocalCronAt(parseLocalCron("@every 15m"), Date.UTC(2026, 7, 17, 12)),
    Date.UTC(2026, 7, 17, 12, 15));
  assert.equal(nextLocalCronAt(parseLocalCron("*/10 9-10 * * 1-5"),
    Date.UTC(2026, 7, 17, 8, 59)), Date.UTC(2026, 7, 17, 9, 0));
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/local-cron-schedule.test.cjs`

Expected: FAIL with `Cannot find module '../src/desktop/local-cron-schedule.cjs'`.

- [ ] **Step 3: Add hostile-input, cron-OR, timezone, and DST REDs**

Add exact cases for sparse arrays/proxies/accessors where applicable, invalid numbers, impossible fields, search exhaustion, day-of-month/day-of-week OR behavior, `TZ=America/Indiana/Indianapolis`, spring-forward, fall-back, month end, and year end. Verify error objects never include the submitted expression.

```js
assert.throws(() => parseLocalCron("61 * * * *"), error =>
  error.code === "OPENBOT_LOCAL_AUTOMATION_INVALID" && !error.message.includes("61"));
assert.equal(nextLocalCronAt(parseLocalCron("TZ=America/Indiana/Indianapolis 30 2 * * *"),
  Date.parse("2026-03-08T06:59:00.000Z")), Date.parse("2026-03-09T06:30:00.000Z"));
```

- [ ] **Step 4: Implement the pure schedule module**

Implement these exact exports:

```js
class LocalCronScheduleError extends Error {
  constructor() {
    super("OpenBot local Routine schedule is invalid.");
    this.name = "LocalCronScheduleError";
    this.code = "OPENBOT_LOCAL_AUTOMATION_INVALID";
  }
}

function parseLocalCron(expression) {
  const normalized = normalizeExpression(expression);
  return Object.freeze(compileSchedule(normalized));
}
function nextLocalCronAt(schedule, afterEpochMs) {
  validateCompiledSchedule(schedule);
  return schedule.kind === "interval"
    ? checkedIntervalNext(schedule, afterEpochMs)
    : boundedCronNext(schedule, afterEpochMs);
}

module.exports = { LocalCronScheduleError, nextLocalCronAt, parseLocalCron };
```

Normalize aliases before token parsing. Parse `*`, comma lists, ranges, and `/step` into sorted frozen integer arrays. Enforce minute `0..59`, hour `0..23`, day `1..31`, month `1..12`, and weekday `0..7` with `7` normalized to Sunday. Search minute candidates with a fixed five-year ceiling; interval schedules use checked integer arithmetic. Use cached `Intl.DateTimeFormat(...).formatToParts()` for time-zone wall-clock matching and skip nonexistent DST wall times rather than inventing them.

- [ ] **Step 5: Run focused GREEN and checks**

Run: `cd macos && node --test test/local-cron-schedule.test.cjs`

Run: `node --check macos/src/desktop/local-cron-schedule.cjs && node --check macos/test/local-cron-schedule.test.cjs && git diff --check`

Expected: all focused tests pass and all checks exit 0.

- [ ] **Step 6: Commit the pure schedule slice**

```bash
git add macos/src/desktop/local-cron-schedule.cjs macos/test/local-cron-schedule.test.cjs
git commit -m "feat(macOS): add bounded local cron schedules"
git push origin macos/codex-bot
```

---

### Task 2: Private atomic automation store

**Files:**
- Create: `macos/src/desktop/local-automation-store.cjs`
- Create: `macos/test/local-automation-store.test.cjs`
- Modify: `macos/native/openbot-profile-publish.c`
- Modify: `macos/test/openbot-user-data.test.cjs`

**Interfaces:**
- Consumes: normalized cron strings from Task 1.
- Produces: `LocalAutomationStore` and `LocalAutomationStoreError`.
- Constructor: `new LocalAutomationStore({filePath, helperPath, fs?, spawn?, randomUUID?, now?})` with absolute `filePath` and signed native-helper paths.
- Read methods: `list(botId)`, `listAll()`.
- Config mutations: `create({botId, automation})`, `replace({botId, automationId, expectedRevision, automation})`, `delete({botId, automationId, expectedRevision})`.
- Run mutations: `claimRun({botId, automationId, expectedRevision, run, nextRunAt})`, `acceptRun({botId, automationId, runId, invocationId, conversationId})`, `finishRun({botId, automationId, runId, finishedAt, status, detail, errorKind})`.
- Private binding: `bindConversation({botId, automationId, expectedRevision, conversationId})`.
- Recovery/deletion: `recoverRunning({finishedAt})`, `deleteBots({botIds})`.
- Every success returns a frozen current record or frozen current bot/aggregate snapshot; conflict returns `{claimed:false, automation}` rather than overwriting a newer revision.

- [ ] **Step 1: Write schema-v1 CRUD and ordering REDs**

```js
const ids = { next: () => "00000000-0000-4000-8000-000000000101" };
const clock = { now: () => "2026-08-17T12:00:00.000Z" };
const automation = {
  name: "Morning summary", prompt: "Summarize the project.",
  trigger: { type: "cron", schedule: "0 9 * * 1-5" },
  triggerDescription: "At 9:00 AM, Monday through Friday",
  isEnabled: true, nextRunAt: Date.parse("2026-08-17T13:00:00.000Z"),
};
const store = new LocalAutomationStore({ filePath, randomUUID: ids.next, now: clock.now });
const created = await store.create({ botId: BOT_A, automation });
assert.equal(created.length, 1);
assert.equal(created[0].revision, 1);
assert.deepEqual(await new LocalAutomationStore({ filePath }).list(BOT_A), created);
```

Assert the 50-per-bot cap, 100 aggregate cap, deterministic next-run/created ordering, unique canonical IDs, 80-character names, 64-KiB prompt bound, and 20-run truncation. Store reads intentionally retain the private `conversationId` for the controller; Task 3 must strip it from every native projection.

- [ ] **Step 2: Run the store RED**

Run: `cd macos && node --test test/local-automation-store.test.cjs`

Expected: FAIL because `local-automation-store.cjs` does not exist.

- [ ] **Step 3: Add atomicity, recovery, deletion, and hostile DTO REDs**

Cover inherited-directory-fd read/write, temporary-file write, file sync, atomic rename, directory sync, committed-uncertain read-back, restart recovery of `running` to terminal `error`, exact bot deletion retry/idempotency, symlink/private-directory refusal, parent/file substitution after validation, oversized descriptors before traversal, proxies, accessors, cycles, unknown keys, sparse arrays, and cross-bot isolation. Compile the real native helper in the focused test and prove that a deterministic spawn-time parent replacement cannot redirect either a read or write.

```js
const recovered = await restarted.recoverRunning({ finishedAt: NOW_2 });
assert.equal(recovered[0].runs[0].status, "error");
assert.equal(recovered[0].runs[0].errorKind, "interrupted");
assert.deepEqual(await restarted.deleteBots({ botIds: [BOT_A] }), { deletedAutomationIds: [AUTOMATION_A] });
```

- [ ] **Step 4: Implement the store**

Persist exactly:

```js
{
  schemaVersion: 1,
  automations: [{
    botId, id, name, prompt,
    trigger: { type: "cron", schedule },
    triggerDescription, isEnabled, provenance: "local",
    createdAt, updatedAt, lastRunAt, nextRunAt,
    runs, revision, conversationId
  }]
}
```

Use descriptor-first validation and frozen clones at every public boundary. Require the existing private state directory rather than creating or chmod-repairing it. Open it with `O_DIRECTORY | O_NOFOLLOW`, validate the descriptor and current pathname identity, and keep the handle alive while passing it as child fd 3 to the signed helper. Extend `openbot-profile-publish.c` without changing its existing two-absolute-path profile-publication behavior: bounded, versioned `--state-read-v1` and `--state-write-v1` commands must validate fd 3 against the passed identity, use only `openat`/`fstatat`/`unlinkat`/`renameatx_np` operations relative to it, reject symlinks and non-private modes, sync the file and directory, and expose no private path or content in errors. Node must recheck that the pathname still names the opened directory after the helper settles. On a post-replacement uncertainty, re-read through the same descriptor-relative helper and accept only the exact expected state. Keep all mutations on one private promise queue.

- [ ] **Step 5: Run focused and adjacent GREEN**

Run: `cd macos && node --test test/local-automation-store.test.cjs test/standalone-conversation-store.test.cjs test/model-selection-store.test.cjs`

Run: `node --check macos/src/desktop/local-automation-store.cjs && node --check macos/test/local-automation-store.test.cjs && node --test macos/test/openbot-user-data.test.cjs && git diff --check`

- [ ] **Step 6: Commit the durable store slice**

```bash
git add macos/src/desktop/local-automation-store.cjs macos/test/local-automation-store.test.cjs macos/native/openbot-profile-publish.c macos/test/openbot-user-data.test.cjs
git commit -m "feat(macOS): persist local bot routines"
git push origin macos/codex-bot
```

---

### Task 3: Local automation controller and scheduler

**Files:**
- Create: `macos/src/desktop/local-automation-controller.cjs`
- Create: `macos/test/local-automation-controller.test.cjs`

**Interfaces:**
- Consumes: Task 1 parser/calculator, Task 2 store, and `StandaloneConversationController` methods `list(botId)`, `create({botId})`, `read({botId,conversationId})`, `send({botId,conversationId,text})`, plus its `event` subscription.
- Constructor: `new LocalAutomationController({store, conversations, parseCron?, nextCronAt?, randomUUID?, now?, setTimer?, clearTimer?})`.
- Lifecycle: `start()`, `dispose()`.
- Native methods: `getAgentAutomations({id})`, `listAllAutomations({})`, `createAgentAutomation({id,spec})`, `updateAgentAutomation({id,automationId,spec})`, `setAgentAutomationEnabled({id,automationId,isEnabled})`, `deleteAgentAutomation({id,automationId})`, `runAgentAutomationNow({id,automationId})`.
- Cleanup: `deleteBots({botIds})`.
- Events: emits `changed` with `{agentId, automations, workflows}` only after authoritative commits.

- [ ] **Step 1: Write exact native CRUD REDs**

Use only the supported local spec:

```js
const spec = {
  name: "Morning summary",
  prompt: "Summarize the current project status.",
  trigger: { type: "cron", schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5" },
  isEnabled: true,
};
const rows = await controller.createAgentAutomation({ id: BOT_A, spec });
assert.equal(rows[0].name, "Morning summary");
assert.equal(events.at(-1).agentId, BOT_A);
```

Verify create/update/enable/delete replies are complete sorted arrays and that Slack/GitHub/Teams/Linear/Sentry/PagerDuty/group triggers reject with `OPENBOT_LOCAL_AUTOMATION_UNAVAILABLE` without store mutation.

- [ ] **Step 2: Run the controller CRUD RED**

Run: `cd macos && node --test --test-name-pattern='automation (creates|updates|enables|deletes|rejects remote)' test/local-automation-controller.test.cjs`

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Add scheduler, terminal run, catch-up, deletion, and disposal REDs**

Use a manual clock and deferred conversation events to prove:

- exactly one earliest timer;
- timer rearming beyond `2_147_483_647` ms;
- `running` persists and publishes before `conversations.send`;
- `runAgentAutomationNow` stays pending through the exact invocation terminal event;
- wrong-bot/wrong-conversation/wrong-invocation events are ignored;
- model failure persists terminal `error` but run-now resolves `undefined` after publication;
- duplicate/manual/scheduled overlap coalesces;
- restart marks an orphaned run interrupted and performs at most one catch-up;
- deletion and disposal suppress held timer/store/read/send/event continuations;
- Bot B remains runnable while Bot A is failing or deleting.

```js
let runSettled = false;
const running = controller.runAgentAutomationNow({ id: BOT_A, automationId: AUTO_A });
void running.then(() => { runSettled = true; });
await enteredSend;
assert.equal(runSettled, false);
conversations.emit("event", { type: "completed", botId: BOT_A,
  conversationId: CONVERSATION_A, invocationId: INVOCATION_A, generation: 1 });
await running;
assert.equal((await controller.getAgentAutomations({ id: BOT_A }))[0].runs[0].status, "ok");
```

- [ ] **Step 4: Implement validation, scheduling, and execution**

Make the controller an `EventEmitter`. Normalize exact own-data DTOs before the first await. Keep one `#timer`, a per-automation run claim map, per-bot epochs/deletion claims, and a dispose epoch. `start()` must call store recovery, arm the earliest enabled next run, and be idempotent. Every async continuation rechecks its bot/run/dispose token.

Create or reuse a private durable conversation by verifying `conversations.read`; if missing, call `conversations.create` then persist the binding before send. Match only the `send` result's exact invocation identity. Persist running, accepted, and terminal states in order, and emit `changed` after each authoritative snapshot. `runAgentAutomationNow` returns only after terminal persistence and publication. Scheduled callbacks launch the same operation without blocking timer rearming.

- [ ] **Step 5: Implement exact workflow projections**

Project every automation as:

```js
{
  id, name, description: "", body: prompt,
  trigger: { schedule: trigger.type === "cron" ? trigger.schedule : "", isEnabled },
  source: "automation", sourceRef: null, pluginId: null,
  publishedByCurrentUser: false, isEnabledForAgent: true,
  scheduleDescription: triggerDescription,
  createdAt, lastRunAt, nextRunAt,
  helperScripts: [], runs, filePath
}
```

Always include every key above; nullable timestamps are `null`. The logical `filePath` is `openbot-local-routine:<botId>:<automationId>`, never a filesystem path.

- [ ] **Step 6: Run focused and adjacent GREEN**

Run: `cd macos && node --test test/local-automation-controller.test.cjs test/local-automation-store.test.cjs test/local-cron-schedule.test.cjs test/standalone-conversation-controller.test.cjs`

Run: `node --check macos/src/desktop/local-automation-controller.cjs && node --check macos/test/local-automation-controller.test.cjs && git diff --check`

- [ ] **Step 7: Commit the controller slice**

```bash
git add macos/src/desktop/local-automation-controller.cjs macos/test/local-automation-controller.test.cjs
git commit -m "feat(macOS): run durable local bot routines"
git push origin macos/codex-bot
```

---

### Task 4: Exact native coordinator automation protocol

**Files:**
- Modify: `macos/src/desktop/openbot-native-coordinator.cjs`
- Modify: `macos/test/openbot-native-coordinator.test.cjs`

**Interfaces:**
- Consumes: `automationController` from Task 3.
- Constructor adds optional `automationController`; when absent, automation mutations fail exact `source/capability-unavailable` and reads do not claim fake success.
- Produces exact coordinator RPC replies and complete `agents-automation` / `agents-workflow` events.

- [ ] **Step 1: Replace fake-empty behavior with protocol REDs**

Add a fake automation controller and exact MessagePort frames for all seven methods. Assert `{}` for no-arg `listAllAutomations`, exact own fields for other args, malformed extra/missing/accessor/proxy values fail `source/malformed-request`, and mutation failures never close the port.

```js
port.emit("message", { data: {
  kind: "request", requestId: "r1", method: "getAgentAutomations", args: { id: BOT_A },
} });
await turn();
const reply = port.sent.find(frame => frame.kind === "reply" && frame.requestId === "r1");
assert.deepEqual(reply.outcome.value, AUTOMATIONS_A);
const event = port.sent.filter(frame => frame.kind === "event"
  && frame.family === "agents-workflow").at(-1);
assert.deepEqual(event.payload.workflows, WORKFLOWS_A);
```

- [ ] **Step 2: Run native REDs**

Run: `cd macos && node --test --test-name-pattern='native automation' test/openbot-native-coordinator.test.cjs`

Expected: FAIL because the current dispatcher returns empty arrays and rejects every automation mutation.

- [ ] **Step 3: Implement dispatcher delegation and full-snapshot events**

Remove `getAgentAutomations` and `listAllAutomations` from fake-empty sets. Add the seven mutation/read methods to the supported set only when dispatch can delegate. Validate the exact Grok fields before calling the controller. Subscribe once to controller `changed`; broadcast both event families with cloned frozen snapshots. Reuse the coordinator's per-bot deletion epochs and roster publication revision so held reads/events cannot republish a deleted bot. Detach the listener during coordinator disposal.

- [ ] **Step 4: Add adversarial native lifecycle REDs and GREEN**

Hold controller reads and run-now operations across delete, port cancel, port close, and coordinator dispose. Prove deleted-bot/post-dispose output is suppressed, cancellation gives one exact `cancelled` reply without killing the port, and unrelated bot requests continue.

Run: `cd macos && node --test test/openbot-native-coordinator.test.cjs test/openbot-native-coordinator-ipc.test.cjs`

- [ ] **Step 5: Commit the native protocol slice**

```bash
git add macos/src/desktop/openbot-native-coordinator.cjs macos/test/openbot-native-coordinator.test.cjs
git commit -m "feat(macOS): expose local routines in native Grok UI"
git push origin macos/codex-bot
```

---

### Task 5: Runtime startup, bot deletion, and shutdown composition

**Files:**
- Modify: `macos/src/desktop/runtime.cjs`
- Modify: `macos/src/desktop/bot-deletion-coordinator.cjs`
- Modify: `macos/test/bot-deletion-runtime-wiring.test.cjs`
- Modify: `macos/test/bot-deletion-coordinator.test.cjs`
- Modify: `macos/test/standalone-desktop-wiring.test.cjs`

**Interfaces:**
- Consumes: Tasks 2-4.
- Production store path: `<stateRoot>/local-automations.v1.json`.
- `BotDeletionCoordinator` constructor adds `automationController` with `deleteBots({botIds})`.
- Cleanup order after the canonical BotStore tombstone: automation controller, standalone conversations, Computer boundary, model selections, conversation bindings, remote receipt cleanup, tombstone completion.

- [ ] **Step 1: Write production construction and readiness REDs**

Assert `productionDependencies` constructs the store/controller, passes the controller to the native coordinator, and does not start scheduling before deletion replay resolves. Hold deletion replay, request the native coordinator port, and prove no automation read/start occurs; release replay and prove recovery/start precedes the first automation method.

- [ ] **Step 2: Write deletion and shutdown ordering REDs**

```js
assert.deepEqual(order, [
  "bot-anchor", "automation-delete", "conversation-delete", "computer-delete",
  "model-delete", "bindings-delete", "complete-tombstone",
]);
```

Hold an active automation terminal write. Verify bot deletion waits it, permanent-fences the bot, purges its store rows, and leaves another bot's timer live. Verify runtime disposal closes ingress, awaits automation disposal, then disposes conversations/controller/providers. A 5-second quit handoff still removes only the OpenBot listener and never calls `app.exit()`.

- [ ] **Step 3: Run runtime/deletion REDs**

Run: `cd macos && node --test test/bot-deletion-runtime-wiring.test.cjs test/bot-deletion-coordinator.test.cjs test/standalone-desktop-wiring.test.cjs`

Expected: FAIL at missing automation composition and cleanup calls.

- [ ] **Step 4: Implement production composition**

Require the new store/controller modules in `runtime.cjs`. Construct them from `stateRoot` and `inferenceBridge.conversations`. Define `automationReady = startupReady.then(() => automationController.start())` and attach a rejection handler so startup never produces an unhandled rejection. Only native automation delegates await `automationReady`; roster/chat/account/model/Computer methods continue through the existing deletion gate if automation startup fails. Pass the controller plus an automation-ready delegate into `createBotDeletionCoordinator` and `OpenBotNativeCoordinator`.

During dispose, stop native ingress first, await `automationController.dispose()`, then proceed through the existing owner disposal phase. In `BotDeletionCoordinator.#cleanupReceipt`, await `automationController.deleteBots({botIds})` immediately before conversation deletion. Any cleanup error retains the tombstone and startup replay retries idempotently.

- [ ] **Step 5: Add same-bot race and failure isolation GREEN tests**

Prove a held pre-delete timer cannot recreate a conversation after commit, a failed automation-store purge retains the tombstone, replay later converges, bad Bot A scheduling does not block Bot B or chat startup, and explicit Quit cancels the next timer without publishing a late run.

Run: `cd macos && node --test test/bot-deletion-runtime-wiring.test.cjs test/bot-deletion-coordinator.test.cjs test/standalone-desktop-wiring.test.cjs test/desktop-runtime.test.cjs test/local-automation-controller.test.cjs`

- [ ] **Step 6: Commit runtime composition**

```bash
git add macos/src/desktop/runtime.cjs macos/src/desktop/bot-deletion-coordinator.cjs macos/test/bot-deletion-runtime-wiring.test.cjs macos/test/bot-deletion-coordinator.test.cjs macos/test/standalone-desktop-wiring.test.cjs
git commit -m "feat(macOS): wire local routine lifecycle"
git push origin macos/codex-bot
```

---

### Task 6: Package and mutation closure

**Files:**
- Modify: `macos/src/patch/desktop.cjs`
- Modify: `macos/scripts/patch-app.cjs`
- Modify: `macos/test/desktop-patch.test.cjs`
- Modify: `macos/test/patch-app.test.cjs`
- Modify: `macos/test/installer-bundle.test.cjs`

**Interfaces:**
- Adds the three new production modules to `DESKTOP_FILES`, `ALLOWED_MUTATIONS`, exact patch fixture lists, and installer source closure.
- Does not add renderer/CSS mutations.

- [ ] **Step 1: Write package-closure REDs**

Require all three new paths:

```js
"desktop/local-cron-schedule.cjs"
"desktop/local-automation-store.cjs"
"desktop/local-automation-controller.cjs"
```

Assert exact patch copy, exact derived installer source closure, mutation allowlisting, source existence, and rejection when any one file is omitted or modified unexpectedly.

- [ ] **Step 2: Run package REDs**

Run: `cd macos && node --test test/desktop-patch.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs`

Expected: the new required-file assertions fail.

- [ ] **Step 3: Update package manifests without renderer drift**

Add only the three `dist/codex/desktop/...` production files to the patch/install closures. Do not change `dist/renderer`, vendor asset hashes, renderer mutation counts, preload facades, entitlements, bundle identifiers, or signing behavior.

- [ ] **Step 4: Run package GREEN and source checks**

Run: `cd macos && node --test test/desktop-patch.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs test/release-package.test.cjs`

Run: `cd macos && npm run check`

Run: `git diff --check`

- [ ] **Step 5: Commit package closure**

```bash
git add macos/src/patch/desktop.cjs macos/scripts/patch-app.cjs macos/test/desktop-patch.test.cjs macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs
git commit -m "build(macOS): package local routine runtime"
git push origin macos/codex-bot
```

---

### Task 7: Frozen review, full verification, and staged acceptance boundary

**Files:**
- Modify only files required by demonstrated REDs from review.
- Create a sanitized acceptance receipt under the existing release-evidence convention only after a freshly packaged app is available.

**Interfaces:**
- Produces source, package, and staged/live evidence without conflating them.

- [ ] **Step 1: Run the complete focused matrix**

```bash
cd macos
node --test \
  test/local-cron-schedule.test.cjs \
  test/local-automation-store.test.cjs \
  test/local-automation-controller.test.cjs \
  test/openbot-native-coordinator.test.cjs \
  test/openbot-native-coordinator-ipc.test.cjs \
  test/bot-deletion-coordinator.test.cjs \
  test/bot-deletion-runtime-wiring.test.cjs \
  test/standalone-conversation-controller.test.cjs \
  test/standalone-desktop-wiring.test.cjs \
  test/desktop-patch.test.cjs \
  test/patch-app.test.cjs \
  test/installer-bundle.test.cjs
```

- [ ] **Step 2: Run full static and test gates**

Run: `cd macos && npm run check`

Run: `cd macos && npm test`

Run: `git diff --check && git status --short`

Record exact pass/fail/skip counts. Declared live/build skips remain skips and are not described as passing acceptance.

- [ ] **Step 3: Request independent frozen-diff review**

The reviewer must inspect exact Grok DTO parity, cron/DST arithmetic, private storage, run overlap, restart catch-up, conversation terminal matching, deletion/dispose dominance, signed-out/Forever-Box separation, package closure, and renderer mutation absence. Reproduce every Critical/Important finding with a RED before changing production code.

- [ ] **Step 4: Repair review findings with focused RED-to-GREEN commits**

For each proven finding, add one deterministic regression, run it RED, make the narrow production fix, run focused/adjacent/full gates, and commit/push that repair separately.

- [ ] **Step 5: Verify the remote branch exactly**

```bash
git push origin macos/codex-bot
git rev-parse HEAD
git ls-remote --heads origin macos/codex-bot
git status --short --branch
```

The local SHA and remote SHA must match and the worktree must be clean.

- [ ] **Step 6: Keep staged/live acceptance explicit**

After a fresh package exists, use the native Grok Routines UI—not injected DOM or a screenshot replica—to create a cron Routine while Cursor is signed out. Prove one Direct Codex or CLIProxy Run Now reaches terminal history, one scheduled occurrence fires with the window closed but process alive, restart state persists, Forever Box remains unavailable, and no CLIProxy/remote provider is contacted outside the selected model path. If no fresh package is built in this task, report staged/live acceptance as pending rather than inferred from tests.

---

## Execution order and ownership

Tasks 1 and 2 may run in parallel because their production files do not overlap. Task 3 consumes both and starts only after their interfaces freeze. Tasks 4 and 5 are sequential because both integrate the same controller lifecycle. Task 6 follows the final production file list. Task 7 freezes all implementation files before review.

Every task uses strict RED-to-GREEN TDD, receives an independent spec-compliance and quality review, commits only its owned files, and pushes the checkpoint to `origin/macos/codex-bot` before the next shared-file task begins.
