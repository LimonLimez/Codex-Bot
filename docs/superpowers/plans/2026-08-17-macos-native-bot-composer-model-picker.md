# macOS Native Bot and Composer Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Grok's native New Bot flow and place a Codex-style compact/Advanced model picker inside the composer immediately before voice/send.

**Architecture:** Preserve the Grok renderer and add one hash-pinned empty composer host beside its native send cluster. Keep canonical catalog projection in `model-controls.js`, Power gesture state in `reasoning-control.js`, and DOM/menu lifecycle in `bot-runtime-ui.js`; native bot creation opts into a trusted complete setup stage so it never invokes the legacy setup wizard.

**Tech Stack:** Node.js 24 CommonJS, Electron renderer DOM, CSS, `node:test`, the existing Grok ASAR patch pipeline, Swift installer/package tests.

**Spec:** `docs/superpowers/specs/2026-08-17-macos-native-bot-composer-model-picker-design.md`

## Global Constraints

- `/Applications/Grok Bot original 20260811.app` version 0.20.0 is the native-shell and New Bot reference.
- `/Applications/ChatGPT.app` version 26.810.52044 is the model-picker behavior and styling reference.
- Preserve the shipped Grok renderer tree; patch only the reviewed empty composer host.
- Do not restore the old Advanced `<select>` grid or add a separate provider row.
- Preserve Direct Codex and CLIProxy canonical provider/model identity.
- Preserve pointer-only Ultra entry, Fast intent ordering, durable per-bot model selection, and reduced motion.
- Native creation is immediately complete; ordinary non-native creation remains `profile-model`.
- Final acceptance distinguishes source, built installer, generated app, installed location, and running process.

---

### Task 1: Trusted Native Bot Creation Completes Without the Legacy Wizard

**Files:**
- Modify: `macos/src/bots/bot-store.cjs:368-385,1268-1284`
- Modify: `macos/src/desktop/openbot-native-coordinator.cjs:1594-1627`
- Test: `macos/test/bot-store.test.cjs`
- Test: `macos/test/bot-runtime-controller.test.cjs`
- Test: `macos/test/openbot-native-coordinator.test.cjs:650-710`

**Interfaces:**
- Consumes: `BotRuntimeController.createBot(input)` and `BotStore.create(input)`.
- Produces: creation input `{ appearance, notifications, setupStage }`, where `setupStage` is exactly `"profile-model"` or `"complete"`; omission means `"profile-model"`.
- Produces: native `createAgent` calls `createBot({ appearance, notifications: true, setupStage: "complete" })`.

- [ ] **Step 1: Write failing store and controller tests for the trusted creation stage**

Add tests with these assertions:

```js
test("trusted native creation may start complete while ordinary creation remains profile-model", async (t) => {
  const { store } = await temporaryStore(t);
  const ordinary = await store.create();
  const native = await store.create({ setupStage: "complete" });
  assert.equal(ordinary.setupStage, "profile-model");
  assert.equal(native.setupStage, "complete");
  await assert.rejects(store.create({ setupStage: "computer" }), /creation setup stage/i);
});
```

In `bot-runtime-controller.test.cjs`, assert `controller.createBot({ setupStage: "complete" })` returns and publishes `setupStage === "complete"`, while the existing no-argument test remains `profile-model`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd macos
node --test --test-name-pattern='trusted native creation|setup-stage transactions' \
  test/bot-store.test.cjs test/bot-runtime-controller.test.cjs
```

Expected: the complete-stage assertion fails because `normalizeCreateInput` currently drops `setupStage`.

- [ ] **Step 3: Implement exact creation-stage normalization**

Extend `normalizeCreateInput` without accepting `computer`:

```js
const setupStageField = selectedOwnDataField(value, "setupStage", "Create input");
const setupStage = setupStageField.present ? setupStageField.value : "profile-model";
if (!new Set(["profile-model", "complete"]).has(setupStage)) {
  throw new Error("Bot creation setup stage is invalid.");
}
return {
  appearance: appearanceField.present
    ? normalizeCreateAppearance(appearanceField.value)
    : { ...DEFAULT_APPEARANCE },
  notifications,
  setupStage,
};
```

Return the same default field when `value === undefined`, and assign `record.setupStage = setupStage` in `BotStore.create`.

- [ ] **Step 4: Add the native coordinator RED and implementation**

Change the existing roster test's expected call to:

```js
["createBot", {
  appearance: {
    shape: "gem",
    color: "purple",
    title: "",
    description: "Build with Direct Codex.",
  },
  notifications: true,
  setupStage: "complete",
}]
```

Run that test first and observe the mismatch, then add `setupStage: "complete"` only to `OpenBotNativeCoordinator.#createAgent`'s `createBot` call.

- [ ] **Step 5: Verify Task 1 GREEN**

Run:

```bash
cd macos
node --test --test-name-pattern='trusted native creation|setup-stage transactions|native roster requests preserve' \
  test/bot-store.test.cjs test/bot-runtime-controller.test.cjs \
  test/openbot-native-coordinator.test.cjs
```

Expected: all selected tests pass; the ordinary creation assertion still reports `profile-model`.

- [ ] **Step 6: Commit Task 1**

```bash
git add macos/src/bots/bot-store.cjs \
  macos/src/desktop/openbot-native-coordinator.cjs \
  macos/test/bot-store.test.cjs \
  macos/test/bot-runtime-controller.test.cjs \
  macos/test/openbot-native-coordinator.test.cjs
git commit -m "fix(macOS): complete native bot creation inline"
```

---

### Task 2: Add the Exact Grok Composer Host and Mount Only There

**Files:**
- Modify: `macos/src/patch/renderer.cjs`
- Modify: `macos/src/renderer/bot-runtime-ui.js:2234-2275,2738-2765`
- Modify: `macos/src/renderer/codex-ui.css`
- Test: `macos/test/desktop-patch.test.cjs`
- Test: `macos/test/patch-app.test.cjs`
- Test: `macos/test/bot-runtime-ui.test.cjs`
- Test: `macos/test/renderer-integration.test.cjs`

**Interfaces:**
- Consumes: unique Grok 0.20 renderer anchor `se=p.jsx("div",{className:ne,ref:d,style:X.style,children:Q})`.
- Produces: one empty `[data-openbot-model-picker-host]` immediately before `Q`, the native voice/send cluster.
- Produces: `findUiMounts(documentRef)` includes `nativeComposerHost`; native mode mounts only into that host.

- [ ] **Step 1: Write failing patch-source tests for exact host placement**

Extend the synthetic vendor renderer fixture with the unique trailing-action anchor and assert:

```js
assert.match(patched, /children:\[p\.jsx\("div",\{"data-openbot-model-picker-host":!0\}\),Q\]/);
assert.equal((patched.match(/data-openbot-model-picker-host/g) ?? []).length, 1);
assert.throws(() => patchVendorRendererSource(patched, patchedHash), /already|anchor/i);
```

Also assert the unpatched source still contains `children:Q` and no OpenBot host.

- [ ] **Step 2: Run the patch tests and verify RED**

Run:

```bash
cd macos
node --test --test-name-pattern='composer model picker host|renderer assets' \
  test/desktop-patch.test.cjs test/patch-app.test.cjs
```

Expected: host assertion fails because `patchVendorRendererSource` does not add it.

- [ ] **Step 3: Implement the hash-pinned renderer transform**

Add exact constants:

```js
const VENDOR_PROMPT_TRAILING =
  'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:Q})';
const OPENBOT_PROMPT_TRAILING =
  'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:[p.jsx("div",{"data-openbot-model-picker-host":!0}),Q]})';
```

Run `replaceUnique` for this anchor in `patchVendorRendererSource` before returning the final patched renderer. Retain exact source-hash validation and duplicate-patch rejection.

- [ ] **Step 4: Write failing renderer mount tests**

Upgrade the mount harness so `querySelector("[data-openbot-model-picker-host]")` returns a dedicated child of the synthetic composer trailing cluster. Assert:

```js
assert.equal(harness.mounted.modelDock.parentElement, harness.documentRef.nativeModelHost);
assert.equal(harness.documentRef.composer.children.includes(harness.mounted.modelDock), false);
assert.equal(harness.documentRef.nativeModelHost.children.filter(
  (node) => node === harness.mounted.modelDock,
).length, 1);
```

Replace the host object, invoke the captured `MutationObserver`, and assert the same `modelDock` moves to the replacement with no clone left behind. A native document with no exact host must leave `modelDock.dataset.codexMountState === "pending"` and must not append it to the outer form or body.

- [ ] **Step 5: Implement native-only exact-host mounting**

Return both hosts:

```js
const nativeComposerHost = documentRef.querySelector("[data-openbot-model-picker-host]");
return Object.freeze({ sidebarHost, composerHost, nativeComposerHost });
```

In `attachToProductHosts`, select:

```js
const targetComposerHost = nativeProtocolMode ? nativeComposerHost : composerHost;
if (targetComposerHost) {
  if (modelDock.parentElement !== targetComposerHost) targetComposerHost.append(modelDock);
  modelDock.dataset.codexMountState = "mounted";
} else {
  modelDock.dataset.codexMountState = "pending";
}
```

Do not use the outer-composer fallback in native mode. Add scoped CSS making the empty host a shrinkable flex item aligned with the native trailing actions.

- [ ] **Step 6: Verify Task 2 GREEN**

Run:

```bash
cd macos
node --test --test-name-pattern='composer model picker host|native protocol mode|mount' \
  test/desktop-patch.test.cjs test/patch-app.test.cjs \
  test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs
```

Expected: exact host transform, missing-host fail-closed behavior, and remount identity all pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add macos/src/patch/renderer.cjs \
  macos/src/renderer/bot-runtime-ui.js macos/src/renderer/codex-ui.css \
  macos/test/desktop-patch.test.cjs macos/test/patch-app.test.cjs \
  macos/test/bot-runtime-ui.test.cjs macos/test/renderer-integration.test.cjs
git commit -m "fix(macOS): mount model picker beside native send"
```

---

### Task 3: Project Canonical Codex Advanced Options

**Files:**
- Modify: `macos/src/renderer/model-controls.js:322-377`
- Test: `macos/test/model-controls.test.cjs:280-410`

**Interfaces:**
- Consumes: canonical catalog rows `{ provider, model, label, efforts, serviceTiers, catalogGeneration }`.
- Produces: frozen `buildAdvancedOptions(catalog, selectedModel)` result with `models`, `efforts`, and `speeds`.
- Model row fields: `{ key, model, label, provider, providerLabel }`; `providerLabel` is `null` unless another row has the same visible label.
- Effort row fields: `{ effort, label, description }`; Ultra receives `Consumes usage limits faster`.
- Speed row fields retain `{ serviceTier, label, description }`; Fast uses `1.5x speed, more usage`.

- [ ] **Step 1: Write failing projection tests**

Add a catalog with identical visible model labels from `openai-codex` and `cliproxy-anthropic`. Assert distinct keys and only those colliding rows receive `Direct Codex` and `CLIProxy` provider labels. Also assert:

```js
assert.deepEqual(advanced.efforts.find(({ effort }) => effort === "ultra"), {
  effort: "ultra",
  label: "Ultra",
  description: "Consumes usage limits faster",
});
assert.deepEqual(advanced.speeds.find(({ serviceTier }) => serviceTier === "priority"), {
  serviceTier: "priority",
  label: "Fast",
  description: "1.5x speed, more usage",
});
```

Assert every returned array and row is frozen and `resolveAdvancedSelection` still rejects a raw ambiguous model ID.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cd macos
node --test --test-name-pattern='Advanced|provider identity' test/model-controls.test.cjs
```

Expected: missing provider labels and Codex secondary-text assertions fail.

- [ ] **Step 3: Implement deterministic immutable projection**

Build a visible-label count map before mapping models. Use exact provider labels only for collisions:

```js
const providerLabel = duplicateLabels.has(label)
  ? entry.provider === "openai-codex"
    ? "Direct Codex"
    : entry.provider === "cliproxy-anthropic" ? "CLIProxy" : entry.provider
  : null;
```

Map effort descriptions and normalize the Fast tier's label/description without treating `ultrafast` as Fast. Preserve canonical `modelOptionKey(provider, model)` lookup and freeze all output.

- [ ] **Step 4: Verify Task 3 GREEN**

Run:

```bash
cd macos
node --test test/model-controls.test.cjs
```

Expected: the full pure-controls suite passes.

- [ ] **Step 5: Commit Task 3**

```bash
git add macos/src/renderer/model-controls.js macos/test/model-controls.test.cjs
git commit -m "feat(macOS): project Codex advanced picker options"
```

---

### Task 4: Replace Raw Advanced Selects With Measured Codex Views

**Files:**
- Modify: `macos/src/renderer/bot-runtime-ui.js:2643-2738,2770-2920,3140-3190,3270-3450`
- Test: `macos/test/bot-runtime-ui.test.cjs`
- Test: `macos/test/renderer-integration.test.cjs`

**Interfaces:**
- Consumes: Task 3's immutable advanced projection.
- Produces: DOM classes `codex-power-menu`, `codex-power-view-track`, `codex-power-view-simple`, `codex-power-view-advanced`, `codex-power-view-controls`, and three `codex-power-advanced-row` buttons.
- Produces: `setAdvancedView(expanded)` and `measurePickerViews()` internal lifecycle helpers.

- [ ] **Step 1: Replace old tests with strict failing native Codex-view tests**

Remove assertions that native mode owns no Advanced controls. Add assertions that native mode has one Advanced toggle and no raw controls:

```js
assert.ok(harness.find("codex-power-advanced-toggle"));
assert.equal(harness.find("codex-power-model-select"), null);
assert.equal(harness.find("codex-power-effort-select"), null);
assert.equal(harness.find("codex-power-speed-select"), null);
assert.deepEqual(
  harness.findAll("codex-power-advanced-row").map((row) => row.dataset.kind),
  ["model", "effort", "speed"],
);
```

Assert the simple panel starts active, the Advanced panel starts `aria-hidden="true"` and inert, and clicking Advanced swaps all four states plus `data-view="advanced"`.

- [ ] **Step 2: Add failing measurement and reduced-motion tests**

Give fake panels fixed `offsetHeight` values and inject a fake `ResizeObserver`. Assert menu style properties become:

```js
assert.equal(menu.style.getPropertyValue("--simple-view-height"), "121px");
assert.equal(menu.style.getPropertyValue("--advanced-view-height"), "132px");
assert.equal(menu.style.height, "157px"); // active simple + 36px controls
```

After Advanced, assert height uses Advanced plus controls and the track changes view without replacing the nodes. A reduced-motion `matchMedia` fixture must set `data-reduced-motion="true"`.

- [ ] **Step 3: Run the view tests and verify RED**

Run:

```bash
cd macos
node --test --test-name-pattern='Codex Advanced view|measured picker|native protocol mode' \
  test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs
```

Expected: native Advanced is absent and old `<select>` assertions diverge.

- [ ] **Step 4: Build the compact/Advanced view track**

Replace the old `advancedModel`, `advancedEffort`, and `advancedSpeed` elements with:

```js
const pickerMenu = element(documentRef, "div", "codex-power-menu");
pickerMenu.dataset.view = "simple";
const viewTrack = element(documentRef, "div", "codex-power-view-track");
const simplePanel = element(documentRef, "div", "codex-power-view-panel codex-power-view-simple");
const advancedPanel = element(documentRef, "div", "codex-power-view-panel codex-power-view-advanced");
const viewControls = element(documentRef, "div", "codex-power-view-controls");
simplePanel.append(powerShell);
viewTrack.append(simplePanel, advancedPanel);
pickerMenu.append(viewTrack, viewControls);
```

Create three buttons with `role="menuitem"`, label span, right-aligned value span, and chevron. Keep the Advanced control in `viewControls` for both views; keep Fast present only in compact view.

- [ ] **Step 5: Implement measured view ownership**

`measurePickerViews` reads `offsetHeight` only after all nodes exist, sets the two CSS variables, and sets active height plus controls. Observe all three measured nodes. Set transitions ready on the next animation frame. `setAdvancedView` updates `data-view`, `aria-expanded`, `aria-hidden`, and `inert` before remeasurement. Dispose cancels the frame and disconnects the observer before removing nodes.

- [ ] **Step 6: Suppress the legacy native setup dialog**

Do not append `newBotSetup` to `document.body` in native mode. Keep `computerSetup` and `permissionSheet` owned as before. Update the native test to prove no live `codex-new-bot-setup` descendant exists under `body`, while the Grok native create RPC test from Task 1 remains authoritative.

- [ ] **Step 7: Verify Task 4 GREEN**

Run:

```bash
cd macos
node --test --test-name-pattern='Codex Advanced view|measured picker|native protocol mode|New Bot' \
  test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs
```

Expected: all selected structural, measurement, and native-dialog tests pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add macos/src/renderer/bot-runtime-ui.js \
  macos/test/bot-runtime-ui.test.cjs macos/test/renderer-integration.test.cjs
git commit -m "feat(macOS): add Codex advanced picker views"
```

---

### Task 5: Add Nested Flyouts, Focus Semantics, and Ordered Selection

**Files:**
- Modify: `macos/src/renderer/bot-runtime-ui.js`
- Test: `macos/test/bot-runtime-ui.test.cjs`

**Interfaces:**
- Consumes: Task 4's three Advanced row buttons and Task 3 projections.
- Produces: internal `renderAdvanced(snapshot, preferredIdentity?)`, `openAdvancedFlyout(kind)`, `closeAdvancedFlyout({ restoreFocus })`, and `submitSelectionIntent(selection)`.
- Produces: flyout widths Model 280px, Effort at least 180px, Speed 233px.

- [ ] **Step 1: Write failing flyout content and focus tests**

For each row, click and assert a titled `role="menu"` opens with the correct width, active `aria-checked` option, and checkmark. Assert Effort/Ultra secondary text and Speed/Fast `1.5x speed, more usage`. Assert Arrow keys move focus, Enter selects, Escape closes only the flyout and restores row focus, and a second Escape closes the parent and restores trigger focus.

- [ ] **Step 2: Write failing model-change and canonical collision tests**

Select a colliding CLIProxy model by its canonical row key. Assert the submitted request retains `provider: "cliproxy-anthropic"`. Select a different model and assert Effort and Speed rows are rebuilt from that model's advertised defaults before their flyouts can open; no stale option may be submitted.

- [ ] **Step 3: Write failing held-mutation race tests**

Hold the first `selectModel`, then choose a second value. Release responses in both orders. Assert requests preserve click order, only the latest intent repaints the active bot, a bot switch/deletion makes both completions inert, and disposal leaves no flyout or late DOM mutation.

Use exact desired tuples in assertions:

```js
assert.deepEqual(selected, [
  { botId: BOT_A, provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high", serviceTier: null },
  { botId: BOT_A, provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "max", serviceTier: null },
]);
```

- [ ] **Step 4: Run the interaction tests and verify RED**

Run:

```bash
cd macos
node --test --test-name-pattern='Advanced flyout|canonical collision|Advanced mutation' \
  test/bot-runtime-ui.test.cjs
```

Expected: no flyouts exist and old select change handlers cannot satisfy menu/focus/race assertions.

- [ ] **Step 5: Implement reusable flyout DOM and keyboard ownership**

Each flyout owns one frozen projection, title, menu options, selected checkmark, secondary text, and roving `tabIndex`. Parent rows use `aria-haspopup="menu"` and `aria-expanded`. Outside pointer closes parent and child; child Escape stops propagation so the first Escape returns to Advanced.

- [ ] **Step 6: Replace select handlers with canonical intent submission**

Use one per-bot latest-intent map shared by Advanced and Fast repaint fencing:

```js
const intent = Object.freeze({ sequence: ++selectionIntentSequence, botId, selection });
selectionIntents.set(botId, intent);
return controller.selectModel(
  selection.provider,
  selection.model,
  selection.effort,
  selection.serviceTier,
).then(() => {
  if (selectionIntents.get(botId) !== intent || lastSnapshot?.activeBotId !== botId) return;
  selectionIntents.delete(botId);
  render(controller.snapshot());
}).catch(() => {
  if (selectionIntents.get(botId) !== intent) return;
  selectionIntents.delete(botId);
  if (lastSnapshot?.activeBotId === botId) {
    return controller.selectBot(botId, true).catch(() => render(controller.snapshot()));
  }
});
```

Model choice first resolves its advertised default effort and speed, then sends one exact selection. Display values are never used as identity keys.

- [ ] **Step 7: Verify Task 5 GREEN**

Run:

```bash
cd macos
node --test test/model-controls.test.cjs test/reasoning-control.test.cjs \
  test/bot-runtime-ui.test.cjs
```

Expected: all pure, Power, flyout, focus, race, Fast, and Ultra tests pass.

- [ ] **Step 8: Commit Task 5**

```bash
git add macos/src/renderer/bot-runtime-ui.js macos/test/bot-runtime-ui.test.cjs
git commit -m "feat(macOS): wire Codex model picker flyouts"
```

---

### Task 6: Match Codex Picker CSS and Reject the Old Advanced Form

**Files:**
- Modify: `macos/src/renderer/codex-ui.css:769-950`
- Modify: `macos/test/renderer-integration.test.cjs:320-380`
- Modify: `macos/test/patch-app.test.cjs`
- Modify: `macos/test/installer-bundle.test.cjs`

**Interfaces:**
- Consumes: Tasks 2, 4, and 5 DOM classes/data attributes.
- Produces: reviewed 224px menu, 320ms entry, 300ms view/height transition, 200ms panel opacity, divider, rows, flyouts, focus states, and reduced-motion overrides.

- [ ] **Step 1: Write failing static CSS and source guards**

Replace tests that require `.codex-power-advanced-field select` or `grid-template-columns`. Assert exact selectors and values:

```js
assert.match(css, /\.codex-power-menu[^}]*overflow:\s*hidden/s);
assert.match(css, /\.codex-power-menu\.transitions-ready[^}]*height 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/s);
assert.match(css, /\.codex-power-view-track[^}]*transform 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/s);
assert.match(css, /\.codex-power-view-panel[^}]*opacity 200ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/s);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.doesNotMatch(botUi, /codex-power-(?:model|effort|speed)-select/);
assert.doesNotMatch(css, /codex-power-advanced-field\s+select/);
```

Assert no native-mode `composerHost.append(modelDock)` fallback remains and the dedicated host is packaged through the existing renderer source.

- [ ] **Step 2: Run static/package tests and verify RED**

Run:

```bash
cd macos
node --test --test-name-pattern='Power|Advanced|renderer assets' \
  test/renderer-integration.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs
```

Expected: old grid/select rules and missing Codex view selectors fail the new assertions.

- [ ] **Step 3: Implement the reviewed CSS values**

Use:

```css
.codex-power-popover { width: 224px; overflow: clip; }
.codex-power-menu { position: relative; overflow: hidden; }
.codex-power-menu.transitions-ready {
  transition: height 300ms cubic-bezier(.23, 1, .32, 1);
}
.codex-power-menu.transitions-ready .codex-power-view-track {
  transition: transform 300ms cubic-bezier(.23, 1, .32, 1);
}
.codex-power-view-panel {
  width: 100%;
  opacity: 1;
  transition: opacity 200ms cubic-bezier(.23, 1, .32, 1);
}
.codex-power-view-panel[aria-hidden="true"] { opacity: 0; pointer-events: none; }
```

Add the six-pixel-inset divider, 36/40px control measurements, right-aligned tertiary values, 12px chevrons, 280/180/233px flyouts, selected checkmarks, secondary copy, visible focus rings, and 320ms `.98` popover entry with 30ms delay. Remove old raw-select/grid rules. Disable all transitions/animations under reduced motion.

- [ ] **Step 4: Verify Task 6 GREEN**

Run:

```bash
cd macos
node --test test/renderer-integration.test.cjs test/patch-app.test.cjs \
  test/installer-bundle.test.cjs test/bot-runtime-ui.test.cjs
npm run check
git diff --check
```

Expected: all selected tests, 136-or-more source checks, and whitespace checks pass.

- [ ] **Step 5: Commit Task 6**

```bash
git add macos/src/renderer/codex-ui.css \
  macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs \
  macos/test/installer-bundle.test.cjs
git commit -m "style(macOS): match Codex composer model picker"
```

---

### Task 7: Full Regression, Exact Build, and Live Acceptance

**Files:**
- Verify: all files changed by Tasks 1-6
- Artifact output: `macos/dist/preflight-${picker_commit}-native-picker/`, where `picker_commit="$(git rev-parse --short HEAD)"`
- Reality report: `/private/tmp/openbot-native-picker-reality-${picker_commit}/reality_check.md`

**Interfaces:**
- Consumes: committed source from Tasks 1-6 and verified Grok source app.
- Produces: pushed GitHub commits, one exact-source DEVELOPMENT installer/DMG, one isolated generated OpenBot app, and live evidence against that generated app.

- [ ] **Step 1: Run focused behavioral suites**

```bash
cd macos
node --test test/bot-store.test.cjs test/bot-runtime-controller.test.cjs \
  test/openbot-native-coordinator.test.cjs test/model-controls.test.cjs \
  test/reasoning-control.test.cjs test/bot-runtime-ui.test.cjs \
  test/renderer-integration.test.cjs test/desktop-patch.test.cjs \
  test/patch-app.test.cjs test/installer-bundle.test.cjs
```

Expected: zero failures; only explicitly declared environment skips are allowed.

- [ ] **Step 2: Run the full macOS gates**

```bash
cd macos
npm run check
npm test
git diff --check
```

Expected: zero failures, all expected skip reasons printed, and no whitespace errors.

- [ ] **Step 3: Review the exact final diff and require a clean committed tree**

```bash
git status --short
git diff --stat origin/macos/codex-bot...HEAD
git log --oneline --decorate -8
```

Expected: all Task 1-6 changes are already captured by their scoped commits and `git status --short` is empty. If it is not empty, stop and identify the exact owning task; do not use `git add -A` or create an unreviewed catch-all commit.

- [ ] **Step 4: Push and prove GitHub branch equality**

```bash
git push origin macos/codex-bot
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/macos/codex-bot)"
git status --short --branch
```

Expected: local and remote hashes are identical and the worktree is clean.

- [ ] **Step 5: Build from the exact pushed commit**

Use the existing signed-provenance DEVELOPMENT build path with the verified pinned inputs already used by the approved preflight:

```bash
cd macos
picker_commit="$(git rev-parse --short HEAD)"
picker_output="$(pwd)/dist/preflight-${picker_commit}-native-picker"
swift build -c release --package-path installer
node scripts/build-installer-app.cjs \
  --sidecar /private/tmp/codex-bot-cliproxy-NLoKLL/cli-proxy-api \
  --sidecar-license /private/tmp/codex-bot-cliproxy-NLoKLL/LICENSE \
  --codex-archive /private/tmp/codex-bot-runtime-wyT8c1/codex-aarch64-apple-darwin.tar.gz \
  --codex-runtime /private/tmp/codex-bot-runtime-wyT8c1/codex-aarch64-apple-darwin \
  --codex-license /private/tmp/codex-bot-runtime-wyT8c1/LICENSE \
  --installer-binary "$(pwd)/installer/.build/arm64-apple-macosx/release/InstallCodexBot" \
  --signing-identity 'Developer ID Application: Harlin Sidwell (HKCH65M45F)' \
  --output "${picker_output}/installer"
node scripts/package-dmg.cjs \
  --installer-app "${picker_output}/installer/Install OpenBot DEVELOPMENT.app" \
  --output "${picker_output}/OpenBot-0.2.0-macos.1-DEVELOPMENT.dmg"
```

Expected: source verification, patch, contract audit, helper/root signing, mounted audit, and DMG verification all pass. Record the app path, DMG path, byte size, SHA-256, signer, team, and audit counts.

- [ ] **Step 6: Generate and launch an isolated OpenBot app**

Run the existing isolated installer transaction against the verified source into a new temporary or user-local destination; do not overwrite `/Applications/Grok Bot original 20260811.app` or an existing OpenBot install. Verify the source ASAR hash is unchanged before and after. Launch only the isolated generated OpenBot app and record its exact bundle/process paths.

- [ ] **Step 7: Perform live UI acceptance**

Prove all of the following in the running exact build:

1. `+` opens Grok's native New chat route and `Create new Bot` creates literal `New Bot` without the custom setup dialog.
2. The model trigger is inside the text box footer immediately before voice/send, with no separate row below the composer.
3. Compact Power shows Advanced and Fast in the reviewed layout.
4. Advanced slides rather than expanding a raw form and shows Model, Effort, Speed rows.
5. Each row opens the correct titled flyout, active checkmark, and secondary text.
6. Direct Codex and CLIProxy selections round-trip to the intended provider/model.
7. Two rapid Fast clicks finish Standard, not Fast.
8. Ultra enters only from pointer drag to maximum and retains the reviewed steady/burst behavior.
9. Reduced motion disables transitions without changing selection.

- [ ] **Step 8: Deliver exact evidence**

Report the pushed commit, reality report, source app, built installer/DMG, generated app, running executable, focused/full test counts, audit counts, and any remaining public-release/notarization gate separately. Do not call the product fixed if only source tests passed.

---

## Plan Self-Review Result

- Every spec requirement maps to Tasks 1-7.
- The plan adds no renderer script or package-list dependency.
- Canonical provider/model identity is defined once in `model-controls.js` and consumed by the DOM.
- New Bot completion is native-only; ordinary creation semantics remain unchanged.
- Source, artifact, installed app, and live-process acceptance are separate gates.
- No task contains an unresolved implementation placeholder.
