# Cursor Forever Box Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every tool-capable OpenBot inference provider to the selected bot's legitimate Cursor Forever Box without GitHub, Codex Cloud, credential extraction, entitlement bypass, or generic remote-provider substitution.

**Architecture:** The preserved Grok 0.20 renderer/preload remains the only caller of the native desktop Forever Box facade. A correlation-only renderer bridge normalizes native results into a main-process `CursorForeverBoxAdapter`; `ComputerTargetRouter` then binds those sanitized operations to the immutable OpenBot bot/native-agent/box identity. Model selection remains independent of Cursor lifecycle.

**Tech Stack:** Preserved Grok Bot 0.20 Electron shell, Cursor native coordinator facade, CommonJS main modules, injected renderer JavaScript, Node.js 22.13+, `node:test`.

## Global Constraints

- Use only the preserved native methods `getForeverBoxStatus`, `ensureForeverBox`, `resetForeverBox`, `updateForeverBox`, and `handBackForeverBox` with exact `{ id }` or `{ id, trigger }` inputs.
- Do not implement a private Cursor RPC client or call backend endpoints from new code.
- Use the normal preserved Cursor sign-in and entitlement UI; never import tokens, profiles, shell environment, or another app's credentials.
- OpenAI Codex and reviewed optional providers remain inference-only and receive the same target-bound tool schema.
- Model/provider/effort/speed changes never ensure, reset, update, hand back, or replace a box.
- One top-level bot maps to one immutable native agent ID and one current box identity; subagents share it with isolated task workspaces.
- All bridge messages are exact, bounded, correlated, current-generation plain data. Private VNC, gateway, endpoint, execution, network, and auth values never enter public snapshots, logs, reports, or BotStore.
- Cursor denial or protocol mismatch is truthful `BLOCKED`/unavailable; never fall back to Free Local Desktop without explicit user selection.

---

### Task 1: Capture and Normalize the Preserved Native Facade Contract

**Files:**
- Create: `macos/src/computer/cursor-forever-box-contract.cjs`
- Create: `macos/test/cursor-forever-box-contract.test.cjs`
- Create: `macos/src/renderer/cursor-forever-box-bridge.js`
- Create: `macos/test/cursor-forever-box-bridge.test.cjs`
- Modify: `macos/src/patch/renderer.cjs`
- Test: `macos/test/renderer-integration.test.cjs`

**Interfaces:**
- Produces: `normalizeCursorRequest(value)` and `sanitizeCursorResult(operation, value)`.
- Request: `{ requestId, botId, nativeAgentId, targetGeneration, operation, trigger? }`.
- Sanitized result: `{ requestId, botId, nativeAgentId, targetGeneration, operation, state, boxId, frameAvailable, errorCode }`.
- Renderer bridge consumes only `window.desktop` and `window.openbotComputerNative` correlation methods.

- [ ] **Step 1: Write exact-method, secret-redaction, and malformed-result RED tests**

```js
test("renderer bridge calls only the verified native Forever Box methods", async () => {
  const desktop = exactDesktopFacade();
  const result = await bridge.handle(request("ensure"), desktop);
  assert.deepEqual(desktop.calls, [["ensureForeverBox", { id: NATIVE_A }]]);
  assert.deepEqual(result, sanitizedReady(REQUEST_A, BOT_A, NATIVE_A, BOX_A));
});

test("native private connection values never survive normalization", () => {
  const raw = { state: "ready", boxId: BOX_A, vncUrl: "wss://secret", gatewayToken: "secret" };
  const value = sanitizeCursorResult("status", raw);
  assert.deepEqual(Object.keys(value).sort(), ["boxId", "errorCode", "frameAvailable", "state"]);
  assert.doesNotMatch(JSON.stringify(value), /wss|token|secret/i);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/cursor-forever-box-contract.test.cjs test/cursor-forever-box-bridge.test.cjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement exact request/result normalization**

```js
const OPERATIONS = Object.freeze({
  status: "getForeverBoxStatus",
  ensure: "ensureForeverBox",
  reset: "resetForeverBox",
  update: "updateForeverBox",
  handBack: "handBackForeverBox",
});
```

Reject unknown methods, extra/missing keys, invalid IDs, accessors, symbols, proxies, cycles, oversized strings, and secret-labeled fields. Map native states only to `starting`, `ready`, `reconnecting`, or `unavailable`; map all raw errors to fixed codes. Do not return raw objects.

- [ ] **Step 4: Inject the bridge after the preserved desktop facade exists**

The injected renderer receives main correlation events, rechecks exact active bot/native ID/generation, calls the corresponding existing `window.desktop` method, sanitizes locally, and replies once. It has no method that accepts arbitrary method names, URLs, credentials, or RPC payloads.

- [ ] **Step 5: Run focused and renderer tests**

Run: `cd macos && node --test test/cursor-forever-box-contract.test.cjs test/cursor-forever-box-bridge.test.cjs test/renderer-integration.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add macos/src/computer/cursor-forever-box-contract.cjs macos/test/cursor-forever-box-contract.test.cjs macos/src/renderer/cursor-forever-box-bridge.js macos/test/cursor-forever-box-bridge.test.cjs macos/src/patch/renderer.cjs macos/test/renderer-integration.test.cjs
git commit -m "feat(mac): bridge preserved Cursor computer methods"
```

---

### Task 2: Correlate Native Operations in Main

**Files:**
- Create: `macos/src/computer/cursor-forever-box-adapter.cjs`
- Create: `macos/test/cursor-forever-box-adapter.test.cjs`
- Modify: `macos/src/desktop/runtime.cjs`
- Modify: `macos/src/patch/desktop.cjs`
- Test: `macos/test/desktop-runtime.test.cjs`

**Interfaces:**
- Consumes: Task 1 request/result contract and current-window IPC sender.
- Produces: `CursorForeverBoxAdapter({ dispatch, readCurrentComputer, timeoutMs })`.
- Produces: `status(input)`, `ensure(input)`, `reset(input)`, `update(input)`, `handBack(input)`, `dispose()`.
- Every method input is `{ botId, nativeAgentId, targetGeneration, signal? }`; `handBack` also receives a fixed allowlisted trigger.

- [ ] **Step 1: Write timeout, stale, duplicate, and disposal RED tests**

```js
test("adapter accepts one current correlated native reply", async () => {
  const pending = adapter.ensure(identityA(3));
  dispatch.reply(sanitizedReady(dispatch.last.requestId, BOT_A, NATIVE_A, BOX_A, 3));
  assert.deepEqual(await pending, readyTarget(BOT_A, NATIVE_A, BOX_A, 3));
  assert.equal(dispatch.listenerCount(), 0);
});

test("bot switch, timeout, duplicate reply, and dispose cause no late effect", async () => {
  const pending = adapter.ensure(identityA(3));
  current = identityB(4);
  dispatch.reply(sanitizedReady(dispatch.last.requestId, BOT_A, NATIVE_A, BOX_A, 3));
  await assert.rejects(pending, /stale|unavailable/i);
  assert.equal(publications.length, 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/cursor-forever-box-adapter.test.cjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement one-flight correlation**

```js
async ensure(input) {
  return this.#request("ensure", normalizeIdentity(input));
}

#request(operation, identity) {
  const requestId = this.#randomUUID();
  return this.#pendingOperation({ requestId, operation, ...identity });
}
```

Register pending state before dispatch. Race reply, abort, timeout, window destruction, target-generation change, and adapter disposal. Delete pending state before settlement, re-read current identity before and after every await, ignore duplicate/late replies, and return fixed sanitized errors. A dispatch failure sends no retry to another renderer or provider.

- [ ] **Step 4: Add private IPC correlation channels**

Use two non-public channels: `openbot-native-computer:request` main-to-renderer and `openbot-native-computer:reply` renderer-to-main. Validate `event.sender` against the exact window that received the request. Do not expose these methods on `window.openbotComputer`.

- [ ] **Step 5: Run adapter and desktop tests**

Run: `cd macos && node --test test/cursor-forever-box-adapter.test.cjs test/desktop-runtime.test.cjs test/desktop-patch.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add macos/src/computer/cursor-forever-box-adapter.cjs macos/test/cursor-forever-box-adapter.test.cjs macos/src/desktop/runtime.cjs macos/src/patch/desktop.cjs macos/test/desktop-runtime.test.cjs
git commit -m "feat(mac): correlate Cursor computer lifecycle"
```

---

### Task 3: Bind OpenBot Bots to Native Agent and Box Identities

**Files:**
- Modify: `macos/src/computer/computer-target-router.cjs`
- Modify: `macos/src/desktop/runtime.cjs`
- Modify: `macos/src/bots/runtime-controller.cjs`
- Test: `macos/test/computer-target-router.test.cjs`
- Test: `macos/test/bot-runtime-controller.test.cjs`
- Test: `macos/test/desktop-runtime.test.cjs`

**Interfaces:**
- Consumes: `CursorForeverBoxAdapter` and BotStore `computer.nativeAgentId`.
- Produces: target router cursor resolution with `{ mode: "cursor", targetId: nativeAgentId, boxId, targetGeneration, workspaceId, tools }`.
- Produces: `selectMode({ botId, mode: "cursor" })` that persists identity before readiness publication.

- [ ] **Step 1: Write two-bot identity and model-switch RED tests**

```js
test("two cursor bots bind distinct native agents and boxes", async () => {
  const a = await controller.selectMode({ botId: BOT_A, mode: "cursor" });
  const b = await controller.selectMode({ botId: BOT_B, mode: "cursor" });
  assert.notEqual(a.computer.nativeAgentId, b.computer.nativeAgentId);
  assert.notEqual(adapter.boxFor(BOT_A), adapter.boxFor(BOT_B));
});

test("provider/model/effort/speed changes never call Cursor lifecycle", async () => {
  await controller.selectModel(selection(BOT_A, "gpt-5.6-sol", "ultra", "priority"));
  await controller.selectModel(selection(BOT_A, "claude-fable-5", "ultra-code", null));
  assert.deepEqual(adapter.lifecycleCalls, []);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test --test-name-pattern='distinct native agents|never call Cursor lifecycle' test/computer-target-router.test.cjs test/bot-runtime-controller.test.cjs test/desktop-runtime.test.cjs`

Expected: FAIL because Cursor mode is not routed.

- [ ] **Step 3: Implement an exact mode transaction**

Persist `mode: "cursor"`, incremented generation, and immutable `nativeAgentId` before adapter ensure. After ensure, commit `ready` only if bot/mode/native ID/generation still match. On signed-out, denied, malformed, timeout, or stale response, persist a fixed unavailable code while retaining the chosen mode. Never write box connection credentials or generic provider runtime IDs.

- [ ] **Step 4: Replace production generic-provider selection**

Production Computer routing must choose only `local`, `cursor`, or `not-now`. Keep generic runtime-provider code solely for its existing reviewed test/live-gate history until a later deletion task can prove no consumers; it cannot be selected by renderer, environment variable, or release configuration.

- [ ] **Step 5: Run controller and target tests**

Run: `cd macos && node --test test/computer-target-router.test.cjs test/bot-runtime-controller.test.cjs test/desktop-runtime.test.cjs test/bridge-runtime-config.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add macos/src/computer/computer-target-router.cjs macos/src/desktop/runtime.cjs macos/src/bots/runtime-controller.cjs macos/test/computer-target-router.test.cjs macos/test/bot-runtime-controller.test.cjs macos/test/desktop-runtime.test.cjs
git commit -m "feat(mac): bind bots to Cursor Forever Boxes"
```

---

### Task 4: Render Cursor Account and Remote State Truthfully

**Files:**
- Modify: `macos/src/renderer/bot-runtime-ui.js`
- Modify: `macos/src/renderer/codex-ui.css`
- Test: `macos/test/bot-runtime-ui.test.cjs`
- Test: `macos/test/renderer-integration.test.cjs`
- Modify: `macos/test/visual/renderer-panel-runtime.cjs`

**Interfaces:**
- Consumes: sanitized Computer state from Tasks 2-3 and preserved native sign-in UI.
- Produces status states `Connect Cursor for Remote Computer`, `Starting remote computer`, `Remote computer ready`, `Reconnecting`, and `Remote computer unavailable`.

- [ ] **Step 1: Write account-denial, setup, and mode-switch RED tests**

```js
test("Cursor setup uses preserved sign-in and never selects local fallback", async () => {
  const mounted = mount({ cursorAccount: "signed-out" });
  await mounted.chooseComputer("cursor");
  assert.equal(mounted.statusText(), "Connect Cursor for Remote Computer");
  assert.equal(mounted.desktopCalls.openNativeSignIn, 1);
  assert.equal(mounted.localDesktopOpenCalls(), 0);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test --test-name-pattern='preserved sign-in|Remote computer' test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs`

Expected: FAIL until Cursor mode state is rendered.

- [ ] **Step 3: Implement mode-specific state without account conflation**

Keep inference account/provider UI separate. Selecting Cursor invokes only the preserved native sign-in flow when required. Selecting local never invokes Cursor. Mode change clears Computer frame synchronously before any await. Retry re-reads only the selected target. Every label is sanitized and contains no account email, tenant, backend, endpoint, or raw error.

- [ ] **Step 4: Capture remote setup/ready/unavailable and switch-clear frames**

Capture 1024x680 and 1920x1080 dark/light/reduced-motion frames. Prove the Computer frame is empty immediately after Bot A to Bot B and local to cursor switches. Confirm Max blue, Ultra/Ultra Code animation, Fast, and normal New Bot setup remain unchanged.

- [ ] **Step 5: Run renderer tests and commit**

Run: `cd macos && node --test test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs`

Expected: PASS.

```bash
git add macos/src/renderer/bot-runtime-ui.js macos/src/renderer/codex-ui.css macos/test/bot-runtime-ui.test.cjs macos/test/renderer-integration.test.cjs macos/test/visual/renderer-panel-runtime.cjs
git commit -m "feat(mac): present Cursor remote computer state"
```

---

### Task 5: Prove Provider-Neutral Tools and Subagent Isolation

**Files:**
- Modify: `macos/src/bridge/runtime-config.cjs`
- Modify: `macos/src/computer/computer-target-router.cjs`
- Test: `macos/test/bridge-runtime-config.test.cjs`
- Test: `macos/test/computer-target-router.test.cjs`
- Test: `macos/test/inference-provider-router.test.cjs`

**Interfaces:**
- Consumes: selected model tuple and current cursor target binding.
- Produces identical bounded tool definitions for direct Codex and connected optional tool-capable models.
- Produces distinct `workspaceId` per subagent task with the same `targetId`/box.

- [ ] **Step 1: Write direct-Codex/optional-provider parity RED tests**

```js
test("Codex and Fable use the same Bot A box and tool schema", async () => {
  const codex = await configFor(selection(BOT_A, "openai-codex", "gpt-5.6-sol"), "task-a");
  const fable = await configFor(selection(BOT_A, "cliproxy-anthropic", "claude-fable-5"), "task-b");
  assert.equal(codex.computer.targetId, fable.computer.targetId);
  assert.deepEqual(codex.tools, fable.tools);
  assert.notEqual(codex.computer.workspaceId, fable.computer.workspaceId);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test --test-name-pattern='same Bot A box|subagent' test/bridge-runtime-config.test.cjs test/computer-target-router.test.cjs test/inference-provider-router.test.cjs`

Expected: FAIL until cursor binding is included.

- [ ] **Step 3: Implement provider-neutral target binding**

Resolve target after model selection but before session creation. Re-read exact bot/target generation before each tool effect. Tool-incapable models receive Chat only. A subagent cannot change selection/mode, hand back/reset/update a box, or publish another bot's frames.

- [ ] **Step 4: Run inference/bridge tests and commit**

Run: `cd macos && node --test test/bridge-runtime-config.test.cjs test/bridge-server.test.cjs test/inference-provider-router.test.cjs test/computer-target-router.test.cjs`

Expected: PASS.

```bash
git add macos/src/bridge/runtime-config.cjs macos/src/computer/computer-target-router.cjs macos/test/bridge-runtime-config.test.cjs macos/test/computer-target-router.test.cjs macos/test/inference-provider-router.test.cjs
git commit -m "feat(mac): share bot computers across model providers"
```

---

### Task 6: Package and Privacy-Audit the Cursor Bridge

**Files:**
- Modify: `macos/src/patch/desktop.cjs`
- Modify: `macos/scripts/patch-app.cjs`
- Modify: `macos/scripts/audit-release.cjs`
- Test: `macos/test/desktop-patch.test.cjs`
- Test: `macos/test/patch-app.test.cjs`
- Test: `macos/test/release-package.test.cjs`
- Test: `macos/test/platform-boundary.test.cjs`

**Interfaces:**
- Produces an exact package closure containing Task 1-5 modules and no credentials, native replies, private service diagnostics, evidence, or non-macOS changes.

- [ ] **Step 1: Write exact-closure and binary-secret RED tests**

```js
test("Cursor bridge package contains code only and rejects native credential residue", async (t) => {
  const staged = await stagedApp(t);
  assert.deepEqual(cursorBridgeMembers(staged), EXPECTED_CURSOR_BRIDGE_MEMBERS);
  await injectMember(staged, "Contents/Resources/cursor-reply.bin", Buffer.from("gatewayToken=private"));
  await assert.rejects(auditRelease(staged), /unexpected member|secret/i);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/desktop-patch.test.cjs test/patch-app.test.cjs test/release-package.test.cjs test/platform-boundary.test.cjs`

Expected: FAIL until exact bridge files are included and residue is rejected.

- [ ] **Step 3: Update allowlists, docs, and privacy copy**

Document Cursor as Remote Computer infrastructure and inference providers separately. State that the private service integration may be distributed only with the required permission. A local-only build must omit/disable Cursor mode rather than ship an unproven feature.

- [ ] **Step 4: Run full macOS verification and commit**

Run: `cd macos && npm test && npm run check && git diff --check`

Expected: PASS with only explicit live-gate skips.

```bash
git add macos/src/patch/desktop.cjs macos/scripts/patch-app.cjs macos/scripts/audit-release.cjs macos/test/desktop-patch.test.cjs macos/test/patch-app.test.cjs macos/test/release-package.test.cjs macos/test/platform-boundary.test.cjs macos/docs
git commit -m "build(mac): package Cursor computer bridge safely"
```

---

### Task 7: Run the Live Two-Bot Cursor Gate

**Files:**
- Create: `macos/scripts/verify-cursor-forever-box.cjs`
- Create: `macos/test/cursor-forever-box-live.test.cjs`
- Modify: `macos/package.json`
- Create: `macos/docs/reports/cursor-forever-box-acceptance.md`

**Interfaces:**
- Produces command `npm run verify:cursor-forever-box`.
- Produces sanitized report with exact keys `{ result, commit, appVersion, accountState, botCount, distinctAgentIds, distinctBoxIds, directCodex, youtubeCurrentFrame, optionalProvider, subagentIsolation, inFlightSwitchIsolation, cleanup, evidenceHashes }`.

- [ ] **Step 1: Write BLOCKED/report-schema RED tests**

```js
test("unentitled Cursor gate is sanitized BLOCKED and never uses local", async () => {
  const result = await runGate({ fixture: "denied" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.result, "BLOCKED");
  assert.equal(result.localEffects, 0);
  assert.doesNotMatch(JSON.stringify(result.report), /token|endpoint|vnc|gateway|Users\//i);
});
```

- [ ] **Step 2: Run the focused RED**

Run: `cd macos && node --test test/cursor-forever-box-live.test.cjs`

Expected: FAIL with module-not-found or missing script.

- [ ] **Step 3: Implement fixtures and the explicit live gate**

The real lane uses the normal signed-in Cursor UI, creates two verifier-owned top-level bots, proves distinct native agents/boxes, selects direct Codex for Bot A, opens Google Chrome in Bot A's remote box at `https://www.youtube.com/`, proves a new current frame, proves Bot B receives no A state, switches A to a connected tool-capable optional provider without changing the box, proves a subagent shares the box but not workspace, exercises in-flight A/B switching, and cleans only verifier-recorded resources in `finally` without retiring a successor.

- [ ] **Step 4: Run live and focused verification**

Run: `cd macos && npm run verify:cursor-forever-box`

Expected: `CURSOR_FOREVER_BOX=PASS` only when every live assertion and cleanup passes. Missing sign-in/entitlement or optional provider is reported as the exact documented `BLOCKED` field, never simulated.

Run: `cd macos && node --test test/cursor-forever-box-contract.test.cjs test/cursor-forever-box-bridge.test.cjs test/cursor-forever-box-adapter.test.cjs test/computer-target-router.test.cjs test/desktop-runtime.test.cjs test/bot-runtime-ui.test.cjs`

Expected: PASS.

- [ ] **Step 5: Independent review and commit**

Commission a read-only code, privacy, lifecycle, two-bot, and live-evidence review of the exact frozen diff. Resolve every Critical/Important finding with an independent RED/GREEN loop before committing the final report.

```bash
git add macos/scripts/verify-cursor-forever-box.cjs macos/test/cursor-forever-box-live.test.cjs macos/package.json macos/docs/reports/cursor-forever-box-acceptance.md
git commit -m "test(mac): verify Cursor Forever Boxes live"
```
