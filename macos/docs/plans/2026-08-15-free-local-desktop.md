# Free Local Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly selected, per-bot Free Local Desktop with a dedicated local browser/workspace and Codex-style per-bot permissions, without weakening Cursor Remote Computer or silently executing locally.

**Architecture:** BotStore schema version 2 owns the selected Computer mode and stable local/native target IDs. A main-process `LocalDesktopManager` owns bot-specific Electron browser sessions and a constrained helper, while `LocalPermissionBroker` and a private atomic permission store authorize every external file/app capability. The renderer receives only frozen sanitized state and decisions through a narrow preload facade.

**Tech Stack:** Node.js 22.13+, CommonJS, Electron BrowserWindow/session APIs, macOS TCC and security-scoped bookmarks, `node:test`, existing preserve-and-patch packaging.

## Global Constraints

- Platform is macOS Apple Silicon only; do not modify Windows-owned files.
- New Bot remains a zero-argument create with the literal name `New Bot` before explicit rename/profile/model setup.
- Computer setup asks `Free Local Desktop`, `Cursor Remote Computer`, or `Not Now`; no answer is preselected.
- Local execution is always labeled `Runs on this Mac` and is never described as remote, cloud-isolated, or a VM.
- The default local boundary is one OpenBot browser partition and one private workspace per top-level bot.
- External access requires `Deny`, `Allow Once`, or `Always Allow for This Bot`; persistent decisions never apply to other bots.
- macOS TCC approval is app-wide but never replaces an exact current per-bot OpenBot decision.
- No root, privileged helper, silent Full Disk Access, personal browser profile reuse, or local/remote fallback is permitted.
- Subagents share the parent target and receive isolated task workspaces.
- Every public payload is bounded plain data with no bookmark bytes, paths, tokens, file contents, screenshots, raw errors, accessors, proxies, cycles, or custom prototypes.

---

### Task 1: Persist Computer Mode and Stable Target Identity

**Files:**
- Modify: `macos/src/bots/bot-store.cjs`
- Test: `macos/test/bot-store.test.cjs`

**Interfaces:**
- Produces: `BotStore.updateComputer(botId, patch)` returning the frozen current bot.
- Produces: bot field `computer: { mode, generation, localProfileId, nativeAgentId, state, lastConfirmedAt, lastErrorCode }`.
- Consumes: existing atomic mutation, path locking, durability receipt, hostile-data validation, and zero-argument `create()` behavior.

- [ ] **Step 1: Add schema-migration and hostile-input RED tests**

```js
test("schema v1 migrates to an explicit not-now Computer target", async (t) => {
  const { store, filePath } = await fixture(t);
  await writeV1Store(filePath, [v1Bot(BOT_A)]);
  const bot = await store.read(BOT_A);
  assert.deepEqual(bot.computer, {
    mode: "not-now", generation: 0, localProfileId: null,
    nativeAgentId: null, state: "unconfigured",
    lastConfirmedAt: null, lastErrorCode: null,
  });
});

test("Computer selection is exact, monotonic, and rejects hostile patches", async (t) => {
  const { store } = await fixture(t);
  const bot = await store.create();
  const selected = await store.updateComputer(bot.botId, {
    mode: "local", localProfileId: "local-11111111-1111-4111-8111-111111111111",
    generation: 1, state: "starting", lastConfirmedAt: null, lastErrorCode: null,
  });
  assert.equal(selected.computer.mode, "local");
  await assert.rejects(store.updateComputer(bot.botId, new Proxy({}, {
    ownKeys() { throw new Error("secret-path-token"); },
  })), /Computer operation failed|plain data/i);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test --test-name-pattern='schema v1 migrates|Computer selection is exact' test/bot-store.test.cjs`

Expected: FAIL because schema version 1 has no `computer` field and `updateComputer` does not exist.

- [ ] **Step 3: Implement schema version 2 and exact Computer normalization**

```js
const SCHEMA_VERSION = 2;
const COMPUTER_MODES = new Set(["not-now", "local", "cursor"]);
const COMPUTER_STATES = new Set(["unconfigured", "starting", "ready", "reconnecting", "unavailable"]);
const COMPUTER_FIELDS = new Set([
  "mode", "generation", "localProfileId", "nativeAgentId",
  "state", "lastConfirmedAt", "lastErrorCode",
]);
const DEFAULT_COMPUTER = Object.freeze({
  mode: "not-now", generation: 0, localProfileId: null,
  nativeAgentId: null, state: "unconfigured",
  lastConfirmedAt: null, lastErrorCode: null,
});

async updateComputer(botId, value) {
  const normalizedBotId = normalizeBotId(botId);
  const patch = normalizedComputerPatch(value);
  return this.#mutate((next) => {
    const bot = this.#requiredBot(next, normalizedBotId);
    if (patch.generation < bot.computer.generation) throw new Error("Computer generation is stale.");
    bot.computer = normalizeComputer({ ...bot.computer, ...patch });
    bot.updatedAt = safeNow(this.#now);
    return bot.botId;
  });
}
```

Migration must accept only exact schema-1 records, add a cloned `DEFAULT_COMPUTER`, validate to schema 2, and atomically rewrite on the first mutating operation. It must not change `botId`, runtime ownership, conversations, timestamps, or legacy-import fingerprints.

- [ ] **Step 4: Run BotStore tests**

Run: `cd macos && node --test test/bot-store.test.cjs`

Expected: PASS, including existing concurrency, receipt, and durability tests.

- [ ] **Step 5: Commit**

```bash
git add macos/src/bots/bot-store.cjs macos/test/bot-store.test.cjs
git commit -m "feat(mac): persist per-bot computer targets"
```

---

### Task 2: Store Private Per-Bot Permission Grants

**Files:**
- Create: `macos/src/local/local-permission-store.cjs`
- Create: `macos/test/local-permission-store.test.cjs`
- Modify: `macos/src/patch/desktop.cjs`
- Test: `macos/test/desktop-patch.test.cjs`

**Interfaces:**
- Produces: `LocalPermissionStore({ filePath, fs, now, randomUUID })`.
- Produces: `authorize(request)`, `remember(request, bookmark)`, `revoke(botId, grantId)`, `deleteBot(botId)`, and `listPublic(botId)`.
- Permission request: `{ botId, targetId, targetGeneration, capability, resourceId, resourceLabel }`.
- Public grant: `{ grantId, botId, capability, resourceId, resourceLabel, scope: "always", createdAt }`.
- Private record additionally owns `bookmark` and never returns it from a public method.

- [ ] **Step 1: Write atomicity, permissions, and cross-bot RED tests**

```js
test("persistent grants are private, mode 0600, exact-bot, and revocable", async (t) => {
  const { store, filePath } = await fixture(t);
  const grant = await store.remember(request(BOT_A, "filesystem.read", "folder-a"), "bookmark-private");
  assert.equal(Object.hasOwn(grant, "bookmark"), false);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await store.authorize(request(BOT_A, "filesystem.read", "folder-a"))).allowed, true);
  assert.equal((await store.authorize(request(BOT_B, "filesystem.read", "folder-a"))).allowed, false);
  await store.revoke(BOT_A, grant.grantId);
  assert.equal((await store.authorize(request(BOT_A, "filesystem.read", "folder-a"))).allowed, false);
  assert.doesNotMatch(await fs.readFile(filePath, "utf8"), /bookmark-private|Users\//);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/local-permission-store.test.cjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the private store**

```js
class LocalPermissionStore {
  constructor({ filePath, fs: fsApi = fs, now = () => new Date().toISOString(), randomUUID = crypto.randomUUID }) {}
  async authorize(request) {}
  async remember(request, bookmark) {}
  async revoke(botId, grantId) {}
  async deleteBot(botId) {}
  async listPublic(botId) {}
}
```

Use the BotStore atomic-write pattern: private parent directory, real regular files only, temporary file `0600`, file fsync, exclusive rename, directory fsync, exact schema and key allowlists, dense arrays, no symlinks, and serialized per-path operations. Store bookmark bytes as base64 only after a platform bookmark adapter returns them; never persist raw user paths or labels containing a path.

- [ ] **Step 4: Add the module to the audited desktop package closure**

Add `local/local-permission-store.cjs` to `DESKTOP_FILES` and to the patch-app allowed-mutation list. Assert the exact ordered path in `desktop-patch.test.cjs`.

- [ ] **Step 5: Run focused and packaging tests**

Run: `cd macos && node --test test/local-permission-store.test.cjs test/desktop-patch.test.cjs test/patch-app.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add macos/src/local/local-permission-store.cjs macos/test/local-permission-store.test.cjs macos/src/patch/desktop.cjs macos/test/desktop-patch.test.cjs macos/test/patch-app.test.cjs
git commit -m "feat(mac): store private per-bot local grants"
```

---

### Task 3: Broker Current Permission Requests

**Files:**
- Create: `macos/src/local/local-permission-broker.cjs`
- Create: `macos/test/local-permission-broker.test.cjs`
- Modify: `macos/src/patch/desktop.cjs`

**Interfaces:**
- Consumes: `LocalPermissionStore` from Task 2.
- Produces: `LocalPermissionBroker({ store, readCurrentComputer, chooseResource, tcc })`.
- Produces: `request(input, effect)`, `decide(input)`, `list(botId)`, `revoke(input)`, `cancelBot(botId)`, and `dispose()`.
- Emits: frozen `request` payload `{ requestId, botId, targetId, targetGeneration, capability, resourceLabel, reason }`.
- Decision input: `{ requestId, botId, targetId, targetGeneration, decision: "deny"|"once"|"always" }`.

- [ ] **Step 1: Write stale-decision and exact-once RED tests**

```js
test("broker applies one current per-bot decision exactly once", async () => {
  const effect = mock.fn(async () => "done");
  const pending = broker.request(request(BOT_A, 4), effect);
  const prompt = seen.at(-1);
  await broker.decide({ ...identity(prompt), decision: "once" });
  assert.equal(await pending, "done");
  await assert.rejects(broker.decide({ ...identity(prompt), decision: "once" }), /unavailable/i);
  assert.equal(effect.mock.callCount(), 1);
});

test("bot switch and generation change suppress stale permission effects", async () => {
  const effect = mock.fn();
  const pending = broker.request(request(BOT_A, 4), effect);
  current = computer(BOT_B, 8);
  await assert.rejects(broker.decide({ ...identity(seen.at(-1)), decision: "always" }), /stale/i);
  await assert.rejects(pending, /stale|cancelled/i);
  assert.equal(effect.mock.callCount(), 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/local-permission-broker.test.cjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement currentness fencing and public sanitization**

```js
async request(input, effect) {
  const request = normalizeRequest(input);
  const current = await this.#readCurrentComputer(request.botId);
  assertCurrent(request, current);
  const remembered = await this.#store.authorize(request);
  if (remembered.allowed) return effect(remembered.privateBookmark);
  return new Promise((resolve, reject) => {
    const requestId = this.#randomUUID();
    this.#pending.set(requestId, { request, effect, resolve, reject });
    this.emit("request", publicPrompt(requestId, request));
  });
}
```

`decide()` must delete the pending entry before any await, re-read exact bot/target/generation before and after resource selection/TCC steps, create an always grant only after selection succeeds, execute once, and revoke a just-created grant if currentness changes before effect start. Listener failures cannot affect state.

- [ ] **Step 4: Run permission tests**

Run: `cd macos && node --test test/local-permission-store.test.cjs test/local-permission-broker.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/src/local/local-permission-broker.cjs macos/test/local-permission-broker.test.cjs macos/src/patch/desktop.cjs
git commit -m "feat(mac): broker local computer permissions"
```

---

### Task 4: Own Dedicated Local Browser Sessions and Workspaces

**Files:**
- Create: `macos/src/local/local-desktop-manager.cjs`
- Create: `macos/src/local/local-helper-protocol.cjs`
- Create: `macos/test/local-desktop-manager.test.cjs`
- Create: `macos/test/local-helper-protocol.test.cjs`
- Modify: `macos/src/patch/desktop.cjs`

**Interfaces:**
- Consumes: `LocalPermissionBroker` and BotStore `computer` identity.
- Produces: `LocalDesktopManager({ electron, userDataPath, permissionBroker, helperFactory })`.
- Produces: `open(computer)`, `navigate(input)`, `capture(input)`, `run(input)`, `close(botId)`, `deleteBot(botId)`, and `dispose()`.
- Browser partition: ``persist:openbot-local-${normalizedUuid}`` derived only from validated `localProfileId` after removing the fixed `local-` prefix.
- Helper request: `{ requestId, botId, targetId, targetGeneration, taskId, capability, operation, arguments }`.
- Helper result: `{ requestId, ok, value?, errorCode? }` with no raw diagnostics.

- [ ] **Step 1: Write partition, workspace, cancellation, and payload RED tests**

```js
test("two bots receive distinct partitions, workspaces, and current frames", async (t) => {
  const a = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  assert.notEqual(a.partition, b.partition);
  assert.notEqual(a.workspaceId, b.workspaceId);
  await manager.navigate(action(a, "https://www.youtube.com/"));
  const frame = await manager.capture(identity(a));
  assert.equal(frame.botId, BOT_A);
  assert.equal(frame.targetGeneration, 1);
  assert.equal(eventsFor(BOT_B).length, 0);
});

test("stale helper replies and oversized or secret payloads fail closed", async () => {
  const pending = manager.run(action(sessionA, "shell.execute", { command: "pwd" }));
  currentGeneration = 2;
  helper.reply({ requestId: helper.last.requestId, ok: true, value: "token=/Users/private" });
  await assert.rejects(pending, /stale|failed/i);
  assert.equal(publicEvents.length, 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/local-helper-protocol.test.cjs test/local-desktop-manager.test.cjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement a bounded helper protocol**

```js
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 4096;
const ALLOWED_OPERATIONS = new Set([
  "filesystem.read", "filesystem.write", "shell.execute",
  "application.open", "application.automate", "screen.capture",
]);
```

Validate every key and string byte, depth, node count, exact fields, request correlation, bot/target/generation/task identity, and error code before IPC. The helper receives only broker-approved resource handles and an OpenBot workspace; it receives no environment dump, login shell profile, Keychain contents, or unrestricted home path. Abort, timeout, helper exit, malformed reply, and manager disposal must settle every pending request once and terminate exact child resources.

- [ ] **Step 4: Implement dedicated Electron browser ownership**

Create one hidden child `BrowserWindow` per active local bot using `session.fromPartition(partition)`, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, denied permission handlers by default, navigation allowlists, popup denial, and download denial until a broker-approved destination exists. Use `webContents.capturePage()` for bounded current frames. Never load a normal Chrome/Safari profile.

- [ ] **Step 5: Run manager and leak tests**

Run: `cd macos && node --test test/local-helper-protocol.test.cjs test/local-desktop-manager.test.cjs`

Expected: PASS with zero pending operations/windows/helpers after close, delete, crash, timeout, and dispose.

- [ ] **Step 6: Commit**

```bash
git add macos/src/local/local-desktop-manager.cjs macos/src/local/local-helper-protocol.cjs macos/test/local-desktop-manager.test.cjs macos/test/local-helper-protocol.test.cjs macos/src/patch/desktop.cjs
git commit -m "feat(mac): own isolated local desktop sessions"
```

---

### Task 5: Expose a Narrow Main/Preload Computer Facade

**Files:**
- Modify: `macos/src/desktop/runtime.cjs`
- Modify: `macos/src/patch/desktop.cjs`
- Test: `macos/test/desktop-runtime.test.cjs`
- Test: `macos/test/desktop-patch.test.cjs`

**Interfaces:**
- Consumes: Tasks 1-4 stores, broker, and manager.
- Produces renderer facade `window.openbotComputer` with exact methods:
  - `selectMode({ botId, mode })`
  - `read(botId)`
  - `decidePermission(decision)`
  - `listPermissions(botId)`
  - `revokePermission({ botId, grantId })`
  - `onChanged(callback)`
  - `onPermissionRequested(callback)`
- All methods return frozen sanitized plain data.

- [ ] **Step 1: Write exact topology and hostile IPC RED tests**

```js
test("desktop exposes exact local computer methods and forwards no private data", async () => {
  const runtime = await installedRuntimeFixture();
  assert.deepEqual(Object.keys(runtime.preloadComputer).sort(), [
    "decidePermission", "listPermissions", "onChanged",
    "onPermissionRequested", "read", "revokePermission", "selectMode",
  ]);
  await assert.rejects(runtime.invoke("openbot-computer:select-mode", hostileProxy), /operation failed/i);
  assert.equal(runtime.localEffects.length, 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test --test-name-pattern='exact local computer methods|hostile IPC' test/desktop-runtime.test.cjs test/desktop-patch.test.cjs`

Expected: FAIL because `openbotComputer` and IPC channels do not exist.

- [ ] **Step 3: Register exact IPC channels and preload methods**

```js
const COMPUTER_CHANNELS = Object.freeze({
  selectMode: "openbot-computer:select-mode",
  read: "openbot-computer:read",
  decide: "openbot-computer:permission-decide",
  listPermissions: "openbot-computer:permissions-list",
  revoke: "openbot-computer:permission-revoke",
});
```

Normalize hostile values before property access, require the sending `webContents` to be a current OpenBot window, sanitize all exceptions to `OPENBOT_COMPUTER_OPERATION_FAILED`, and publish frozen state only to non-destroyed current windows. Disposal removes every handler/listener before closing broker/manager resources.

- [ ] **Step 4: Run desktop and patch tests**

Run: `cd macos && node --test test/desktop-runtime.test.cjs test/desktop-patch.test.cjs test/patch-app.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/src/desktop/runtime.cjs macos/src/patch/desktop.cjs macos/test/desktop-runtime.test.cjs macos/test/desktop-patch.test.cjs macos/test/patch-app.test.cjs
git commit -m "feat(mac): expose local computer boundary"
```

---

### Task 6: Add Setup Choice, Local Status, and Permission UI

**Files:**
- Modify: `macos/src/renderer/bot-runtime-ui.js`
- Modify: `macos/src/renderer/codex-ui.css`
- Test: `macos/test/bot-runtime-ui.test.cjs`
- Test: `macos/test/renderer-integration.test.cjs`
- Modify: `macos/test/visual/renderer-panel-runtime.cjs`

**Interfaces:**
- Consumes: `window.openbotComputer` from Task 5.
- Produces setup choice values `local`, `cursor`, and `not-now` with no initial selection.
- Produces permission sheet showing sanitized app/folder label, reason, bot name, and three exact decision buttons.
- Produces status copy `Runs on this Mac`, `Connect Cursor for Remote Computer`, and `Computer not configured`.

- [ ] **Step 1: Write setup, permission, and stale-UI RED tests**

```js
test("New Bot setup asks for Computer mode without a default", async () => {
  const mounted = mountBotRuntime({ bots: [bot(BOT_A, "New Bot")] });
  await mounted.clickNewBot();
  assert.deepEqual(mounted.computerChoices(), [
    ["local", "Free Local Desktop"],
    ["cursor", "Cursor Remote Computer"],
    ["not-now", "Not Now"],
  ]);
  assert.equal(mounted.selectedComputerChoice(), null);
  assert.equal(mounted.computerContinueDisabled(), true);
});

test("permission decisions remain bound to the requesting bot", async () => {
  const mounted = mountBotRuntime({ activeBotId: BOT_A });
  mounted.emitPermission(permission(BOT_A, "Folder A"));
  await mounted.selectBot(BOT_B);
  assert.equal(mounted.permissionSheetVisible(), false);
  assert.equal(mounted.decisionCalls().length, 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test --test-name-pattern='asks for Computer mode|permission decisions remain' test/bot-runtime-ui.test.cjs`

Expected: FAIL because no Computer setup or permission UI exists.

- [ ] **Step 3: Implement controller state and exact rendering**

Extend the controller snapshot with:

```js
{
  computer: { mode, state, label, targetGeneration },
  computerSetup: { open, pending, selectedMode: null },
  permissionRequest: null,
  permissions: [],
}
```

Creation must wait for the zero-argument bot result, preserve the existing rename/profile/model flow, then open the Computer step. Continue remains disabled until explicit selection. A bot switch, mode change, generation change, or disposal closes a pending permission sheet and cannot send a decision. Show local status independently of model/provider status.

- [ ] **Step 4: Add accessible and responsive CSS**

Use existing host tokens and light/dark mappings. The setup and permission sheet must support keyboard focus order, Escape only as Deny, reduced motion, 1024x680 and 1920x1080, narrow composer, 200% bitmap scale, and no overlap with the Power control. Do not alter Max blue or Ultra/Ultra Code effects.

- [ ] **Step 5: Run renderer tests and fresh capture harness**

Run: `cd macos && node --test test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs`

Expected: PASS.

Run: `cd macos && node test/visual/renderer-panel-runtime.cjs --state=computer-setup --viewport=1024x680 --output=/tmp/openbot-local-setup.png`

Expected: a fresh exact-source frame with no preselected mode, readable copy, no clipping, and unchanged Power visuals.

- [ ] **Step 6: Commit**

```bash
git add macos/src/renderer/bot-runtime-ui.js macos/src/renderer/codex-ui.css macos/test/bot-runtime-ui.test.cjs macos/test/renderer-integration.test.cjs macos/test/visual/renderer-panel-runtime.cjs
git commit -m "feat(mac): add local desktop setup and permissions UI"
```

---

### Task 7: Route Work Tools and Subagents to the Selected Target

**Files:**
- Create: `macos/src/computer/computer-target-router.cjs`
- Create: `macos/test/computer-target-router.test.cjs`
- Modify: `macos/src/bots/conversation-router.cjs`
- Modify: `macos/src/bridge/runtime-config.cjs`
- Test: `macos/test/conversation-router.test.cjs`
- Test: `macos/test/bridge-runtime-config.test.cjs`
- Modify: `macos/src/patch/desktop.cjs`

**Interfaces:**
- Consumes: current BotStore computer record, `LocalDesktopManager`, and later `CursorForeverBoxAdapter`.
- Produces: `ComputerTargetRouter.resolve({ botId, conversationId, taskId })` returning `{ mode, botId, targetId, targetGeneration, workspaceId, tools }`.
- Produces: `run(action)` and `disposeTask({ botId, taskId })`.
- Runtime config gains exact `computer: { mode, targetId, targetGeneration, workspaceId }` with no secrets.

- [ ] **Step 1: Write local, not-now, cross-bot, and subagent RED tests**

```js
test("local Work and subagents use one bot target with isolated task workspaces", async () => {
  const parent = await router.resolve({ botId: BOT_A, conversationId: "thread-a", taskId: "parent" });
  const child = await router.resolve({ botId: BOT_A, conversationId: "thread-a", taskId: "child-1" });
  assert.equal(parent.targetId, child.targetId);
  assert.notEqual(parent.workspaceId, child.workspaceId);
  assert.equal(localManager.openCallsFor(BOT_A), 1);
});

test("not-now and wrong-bot actions fail before any target effect", async () => {
  await assert.rejects(router.run(action(BOT_NONE)), /not configured/i);
  await assert.rejects(router.run({ ...action(BOT_A), targetId: LOCAL_B }), /mismatch/i);
  assert.equal(localManager.effects.length, 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/computer-target-router.test.cjs test/conversation-router.test.cjs test/bridge-runtime-config.test.cjs`

Expected: FAIL because target routing does not exist.

- [ ] **Step 3: Implement exact current-target resolution**

```js
async resolve(input) {
  const request = normalizeResolve(input);
  const bot = await this.#store.read(request.botId);
  if (!bot || bot.computer.mode === "not-now") throw unavailable();
  const targetId = bot.computer.mode === "local"
    ? bot.computer.localProfileId
    : bot.computer.nativeAgentId;
  return publicTarget(bot, request, targetId, taskWorkspaceId(request));
}
```

`run()` must re-read and compare exact mode/target/generation before and after each await. Conversation ownership and task ID remain bot-scoped. Local actions go only through the permission broker/manager. Cursor actions remain unavailable until the Cursor plan supplies its adapter; no generic provider or local substitute is called.

- [ ] **Step 4: Run routing tests**

Run: `cd macos && node --test test/computer-target-router.test.cjs test/conversation-router.test.cjs test/bridge-runtime-config.test.cjs test/bridge-server.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/src/computer/computer-target-router.cjs macos/test/computer-target-router.test.cjs macos/src/bots/conversation-router.cjs macos/src/bridge/runtime-config.cjs macos/test/conversation-router.test.cjs macos/test/bridge-runtime-config.test.cjs macos/src/patch/desktop.cjs
git commit -m "feat(mac): route work to per-bot computer targets"
```

---

### Task 8: Package and Audit the Local Runtime Closure

**Files:**
- Modify: `macos/scripts/patch-app.cjs`
- Modify: `macos/scripts/audit-release.cjs`
- Modify: `macos/scripts/build-installer-app.cjs`
- Test: `macos/test/patch-app.test.cjs`
- Test: `macos/test/release-package.test.cjs`
- Test: `macos/test/installer-bundle.test.cjs`
- Test: `macos/test/platform-boundary.test.cjs`

**Interfaces:**
- Consumes: exact new module list from Tasks 1-7.
- Produces: exact ordered package allowlist and privacy audit that rejects profiles, bookmarks, grants, workspaces, paths, logs, screenshots, and secrets in text or binary members.

- [ ] **Step 1: Write closure and adversarial privacy RED tests**

```js
test("release contains the exact local runtime closure and no runtime state", async (t) => {
  const app = await stagedApp(t);
  assert.deepEqual(localRuntimeMembers(app), EXPECTED_LOCAL_RUNTIME_MEMBERS);
  await injectMember(app, "Contents/Resources/private/browser-profile/Cookies", Buffer.from("/Users/private token=abc"));
  await assert.rejects(auditRelease(app), /unexpected member|personal|secret/i);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/patch-app.test.cjs test/release-package.test.cjs test/installer-bundle.test.cjs test/platform-boundary.test.cjs`

Expected: FAIL until the exact new closure is allowed and forbidden runtime-state members are rejected.

- [ ] **Step 3: Update exact package and audit allowlists**

Package only the source modules required by Tasks 1-7. Do not stage test fixtures, evidence, temporary profiles, userData, grant stores, bookmarks, workspaces, helper logs, environment files, signing identities, or local absolute paths. The release audit must enumerate every bundle member, reject extras, scan every regular file including binary bytes for `/Users/`, home paths, secret labels, tokens, and known fixture values, and verify symlinks/special files are absent.

- [ ] **Step 4: Run packaging and full macOS tests**

Run: `cd macos && npm test`

Expected: PASS with only explicitly declared non-live skips.

Run: `cd macos && npm run check && git diff --check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add macos/scripts/patch-app.cjs macos/scripts/audit-release.cjs macos/scripts/build-installer-app.cjs macos/test/patch-app.test.cjs macos/test/release-package.test.cjs macos/test/installer-bundle.test.cjs macos/test/platform-boundary.test.cjs
git commit -m "build(mac): package free local desktop safely"
```

---

### Task 9: Prove Free Local Desktop Live Acceptance

**Files:**
- Create: `macos/scripts/verify-free-local-desktop.cjs`
- Create: `macos/test/free-local-desktop-live.test.cjs`
- Modify: `macos/package.json`
- Create: `macos/docs/reports/free-local-desktop-acceptance.md`

**Interfaces:**
- Produces command `npm run verify:free-local-desktop`.
- Produces sanitized report fields `{ result, commit, appVersion, botCount, distinctProfiles, youtubeCurrentFrame, denyZeroEffects, onceExpired, perBotIsolation, revoked, subagentWorkspaceIsolation, cleanup, evidenceHashes }`.
- Report contains no paths, URLs with queries, account data, prompts, screenshots, frame bytes, bookmarks, workspace names, or raw diagnostics.

- [ ] **Step 1: Write report-schema and unconfigured RED tests**

```js
test("local verifier is fail-closed and emits only sanitized bounded evidence", async (t) => {
  const result = await runVerifier({ fixture: "unconfigured" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.result, "BLOCKED");
  assert.deepEqual(Object.keys(result.report).sort(), EXPECTED_REPORT_KEYS);
  assert.doesNotMatch(JSON.stringify(result.report), /Users|token|bookmark|Cookie|endpoint/i);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/free-local-desktop-live.test.cjs`

Expected: FAIL with module-not-found or missing script.

- [ ] **Step 3: Implement deterministic fixtures and the real local lane**

The real lane creates verifier-owned bots, explicitly chooses local mode, opens the dedicated browser at `https://www.youtube.com/`, requires a new post-action frame sequence, denies a harmless fixture-file action with zero effects, proves once and always/revoke semantics, proves Bot B cannot use Bot A's grant, proves a subagent shares target but not task workspace, and cleans only IDs recorded by the verifier. Every operation is bounded and cancellable; `finally` closes windows/helpers and removes verifier-owned stores even on failure.

- [ ] **Step 4: Run local acceptance and exact focused suite**

Run: `cd macos && npm run verify:free-local-desktop`

Expected: `FREE_LOCAL_DESKTOP=PASS` only after every live assertion and cleanup succeeds; otherwise `BLOCKED` or sanitized `FAIL`.

Run: `cd macos && node --test test/bot-store.test.cjs test/local-permission-store.test.cjs test/local-permission-broker.test.cjs test/local-helper-protocol.test.cjs test/local-desktop-manager.test.cjs test/computer-target-router.test.cjs test/desktop-runtime.test.cjs test/bot-runtime-ui.test.cjs`

Expected: PASS.

- [ ] **Step 5: Perform independent code and fresh visual review**

Review the exact commit diff plus setup, permission, local-ready, denied, and revoked frames at 1024x680 and 1920x1080 in dark/light/reduced-motion/narrow states. Record only hashes and findings in the report; do not commit PNGs containing page content.

- [ ] **Step 6: Commit**

```bash
git add macos/scripts/verify-free-local-desktop.cjs macos/test/free-local-desktop-live.test.cjs macos/package.json macos/docs/reports/free-local-desktop-acceptance.md
git commit -m "test(mac): verify free local desktop live"
```
