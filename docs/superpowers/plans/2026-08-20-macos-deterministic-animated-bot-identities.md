# Deterministic Animated Bot Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Grok's exact procedural Sand avatar registry with twelve recognizable animal, creature, and computer identities, and assign omitted shape/color defaults deterministically in the first durable BotStore commit.

**Architecture:** Add one shared CommonJS avatar catalog used by BotStore and the exact-hash-bound renderer patch. BotStore hashes the freshly minted durable bot ID with separate versioned salts, fills only omitted shape/color values, and persists them in the original create write. The native coordinator forwards explicit stock `avatarShape`/`avatarColor` fields without inventing `blob`/`blue`; the patched stock Sand renderer remains the only animation engine and Character picker.

**Tech Stack:** Node.js 22 CommonJS, SHA-256 from `node:crypto`, existing BotStore atomic JSON persistence, exact unique source anchors, minified Grok 0.20 renderer geometry helpers, `node:test`, Swift installer package tests.

**Spec:** `docs/superpowers/specs/2026-08-20-macos-grok-provider-picker-animated-bot-identities-design.md` (approved; SHA-256 `e05ef2f3e044ad2fd0a215feb1721c326f702ef706b1f4185f67cba6c3497a18`)

## Global Constraints

- Keep the native Grok New Bot and Character editor flows; do not add a pet system, parallel setup flow, preload method, native RPC, animation DTO, asset store, raster/SVG download, generated frames, provider call, or schema bump.
- Keep all eight visible stock shapes in order: `blob`, `pebble`, `squircle`, `tablet`, `wedge`, `hex`, `cloud`, `teardrop`.
- Append exactly: `cat`, `dog`, `wolf`, `bunny`, `fox`, `bear`, `owl`, `jelly`, `terminal`, `robot`, `microchip`, `drone`.
- Use the existing eleven colors: `black`, `brown`, `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `violet`, `magenta`, `gray`.
- Explicit shape/color values win independently; only omitted fields are derived.
- Same bot ID and catalog version must return the same defaults. Shape and color use separate fixed versioned salts.
- Derived values must be present in the same first durable create commit before the existing provider commit fence writes.
- Existing records load byte-for-value without reassignment or migration; later Character edits update the existing fields and `avatarVersion` through the existing coordinator path.
- Exact renderer patch anchors must occur once, fail closed on drift/ambiguity, and reverse exactly to the pinned stock source segments.
- The shared Sand renderer owns idle, thinking, working, sending, orbit, spin, morph, theme, face, lifecycle, and Reduced Motion behavior.
- The user has selected subagent-driven execution. Do not ask again; dispatch the Luna-max tasks below sequentially within this lane.

## Ownership Lock and Parallel Execution

Identity implementation workers exclusively own:

- Create `macos/src/bots/avatar-catalog.cjs`
- Create `macos/test/avatar-catalog.test.cjs`
- Modify `macos/src/bots/bot-store.cjs`
- Modify `macos/test/bot-store.test.cjs`
- Modify `macos/src/desktop/openbot-native-coordinator.cjs`
- Modify `macos/test/openbot-native-coordinator.test.cjs`
- Modify `macos/src/patch/renderer.cjs`
- Modify `macos/src/patch/desktop.cjs`
- Modify `macos/scripts/patch-app.cjs`
- Modify `macos/scripts/build-installer-app.cjs` only if its exported source list test requires an explicit expectation update; source inclusion should flow through `DESKTOP_FILES`
- Modify `macos/test/renderer-integration.test.cjs`
- Modify `macos/test/patch-app.test.cjs`
- Modify `macos/test/installer-bundle.test.cjs`

The identity lane must not edit `macos/src/renderer/bot-runtime-ui.js`, `macos/src/renderer/codex-ui.css`, or `macos/test/bot-runtime-ui.test.cjs`; those are reserved for the provider lane. Tasks 1-5 are sequential inside this lane, but the entire lane may run in parallel with the provider plan. The unavoidable shared sequencing is only final Sol integration after both lanes.

## File Map

- Create `macos/src/bots/avatar-catalog.cjs`: canonical visible catalog/palette and deterministic default function with no patch-time dependency.
- Modify `macos/src/bots/bot-store.cjs`: preserve missing shape/color through input normalization, mint ID, derive omissions, and write the completed appearance in the original create mutation.
- Modify `macos/src/desktop/openbot-native-coordinator.cjs`: forward only explicit shape/color creation arguments; preserve roster/update DTOs.
- Modify `macos/src/patch/renderer.cjs`: apply the avatar catalog patch inside the existing pinned renderer hash boundary.
- Modify packaging lists/tests: stage the new shared runtime module and approve exactly one additional mutation.
- Add/modify focused tests listed above.

---

### Task 1: Canonical catalog and deterministic identity primitive

**Assigned worker:** Fresh Luna-max implementation worker.

**Files:**
- Create: `macos/src/bots/avatar-catalog.cjs`
- Create: `macos/test/avatar-catalog.test.cjs`

**Interfaces:**
- Produces `STOCK_VISIBLE_AVATAR_SHAPES: readonly string[]`.
- Produces `ADDED_AVATAR_SHAPES: readonly string[]`.
- Produces `VISIBLE_AVATAR_SHAPES: readonly string[]`.
- Produces `AVATAR_COLORS: readonly string[]`.
- Produces `AVATAR_CATALOG_VERSION = 1`.
- Produces `defaultAvatarIdentity(botId: string): Readonly<{ shape: string, color: string }>`.
- Must not import `macos/src/patch/anchors.cjs`; the installed BotStore runtime receives only the catalog/hash module.

- [ ] **Step 1: Write the failing catalog/default tests**

Create `macos/test/avatar-catalog.test.cjs`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ADDED_AVATAR_SHAPES,
  AVATAR_CATALOG_VERSION,
  AVATAR_COLORS,
  STOCK_VISIBLE_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
  defaultAvatarIdentity,
} = require("../src/bots/avatar-catalog.cjs");

const IDS = Object.freeze([
  "bot-11111111-1111-4111-8111-111111111111",
  "bot-22222222-2222-4222-8222-222222222222",
  "bot-33333333-3333-4333-8333-333333333333",
  "bot-44444444-4444-4444-8444-444444444444",
  "bot-55555555-5555-4555-8555-555555555555",
  "bot-66666666-6666-4666-8666-666666666666",
]);

test("avatar catalog is safe unique ordered and complete", () => {
  assert.equal(AVATAR_CATALOG_VERSION, 1);
  assert.deepEqual(STOCK_VISIBLE_AVATAR_SHAPES, [
    "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
  ]);
  assert.deepEqual(ADDED_AVATAR_SHAPES, [
    "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
    "terminal", "robot", "microchip", "drone",
  ]);
  assert.deepEqual(VISIBLE_AVATAR_SHAPES, [...STOCK_VISIBLE_AVATAR_SHAPES, ...ADDED_AVATAR_SHAPES]);
  assert.deepEqual(AVATAR_COLORS, [
    "black", "brown", "red", "orange", "yellow", "green",
    "cyan", "blue", "violet", "magenta", "gray",
  ]);
  assert.equal(new Set(VISIBLE_AVATAR_SHAPES).size, VISIBLE_AVATAR_SHAPES.length);
  for (const value of [...VISIBLE_AVATAR_SHAPES, ...AVATAR_COLORS]) {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  }
  assert.equal(Object.isFrozen(VISIBLE_AVATAR_SHAPES), true);
});

test("default avatar identity is deterministic separated and varied", () => {
  for (const id of IDS) assert.deepEqual(defaultAvatarIdentity(id), defaultAvatarIdentity(id));
  const identities = IDS.map(defaultAvatarIdentity);
  assert.ok(new Set(identities.map(({ shape }) => shape)).size >= 3);
  assert.ok(new Set(identities.map(({ color }) => color)).size >= 3);
  for (const identity of identities) {
    assert.ok(VISIBLE_AVATAR_SHAPES.includes(identity.shape));
    assert.ok(AVATAR_COLORS.includes(identity.color));
    assert.equal(Object.isFrozen(identity), true);
  }
  assert.throws(() => defaultAvatarIdentity("not-a-bot"), /bot ID/i);
});
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
cd /Users/harlin/Documents/Codex/2026-05-01/Codex-Bot-macOS
node --test macos/test/avatar-catalog.test.cjs
```

Expected: FAIL with `Cannot find module '../src/bots/avatar-catalog.cjs'`.

- [ ] **Step 3: Implement the catalog and versioned hash**

Create the module with this exact deterministic core:

```js
"use strict";

const { createHash } = require("node:crypto");
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AVATAR_CATALOG_VERSION = 1;
const SHAPE_SALT = `openbot-avatar-shape-v${AVATAR_CATALOG_VERSION}`;
const COLOR_SALT = `openbot-avatar-color-v${AVATAR_CATALOG_VERSION}`;
const STOCK_VISIBLE_AVATAR_SHAPES = Object.freeze([
  "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
]);
const ADDED_AVATAR_SHAPES = Object.freeze([
  "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
  "terminal", "robot", "microchip", "drone",
]);
const VISIBLE_AVATAR_SHAPES = Object.freeze([
  ...STOCK_VISIBLE_AVATAR_SHAPES,
  ...ADDED_AVATAR_SHAPES,
]);
const AVATAR_COLORS = Object.freeze([
  "black", "brown", "red", "orange", "yellow", "green",
  "cyan", "blue", "violet", "magenta", "gray",
]);

function catalogIndex(botId, salt, length) {
  if (typeof botId !== "string" || !BOT_ID_PATTERN.test(botId)) {
    throw new TypeError("Avatar defaults require a canonical bot ID.");
  }
  const digest = createHash("sha256").update(salt).update("\0").update(botId).digest();
  return digest.readUInt32BE(0) % length;
}

function defaultAvatarIdentity(botId) {
  return Object.freeze({
    shape: VISIBLE_AVATAR_SHAPES[catalogIndex(botId, SHAPE_SALT, VISIBLE_AVATAR_SHAPES.length)],
    color: AVATAR_COLORS[catalogIndex(botId, COLOR_SALT, AVATAR_COLORS.length)],
  });
}
```

Export exactly:

```js
module.exports = {
  ADDED_AVATAR_SHAPES,
  AVATAR_CATALOG_VERSION,
  AVATAR_COLORS,
  STOCK_VISIBLE_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
  defaultAvatarIdentity,
};
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command.

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the deterministic catalog**

```bash
git add macos/src/bots/avatar-catalog.cjs macos/test/avatar-catalog.test.cjs
git commit -m "feat(macOS): define deterministic avatar catalog"
```

---

### Task 2: Persist omitted defaults in the first BotStore commit

**Assigned worker:** Fresh Luna-max implementation worker after Task 1 review.

**Files:**
- Modify: `macos/src/bots/bot-store.cjs:3-6, 121-127, 292-313, 393-430, 1753-1774, module.exports`
- Modify: `macos/test/bot-store.test.cjs:10, 58-90, 230-279, 447-609, 1888-1995`

**Interfaces:**
- Consumes `defaultAvatarIdentity(botId)` from Task 1.
- `normalizeCreateInput()` now returns a partial normalized `appearance`; it does not choose shape/color.
- Produces internal `completeCreateAppearance(botId, partialAppearance)` returning all five durable appearance fields.
- `BotStore.create(input?, options?)` public signature and return type are unchanged.

- [ ] **Step 1: Update the expected-bot helper and add RED creation tests**

Import `defaultAvatarIdentity` and change `expectedBot()`:

```js
const { BotStore } = require("../src/bots/bot-store.cjs");
const { defaultAvatarIdentity } = require("../src/bots/avatar-catalog.cjs");

function expectedBot(overrides = {}) {
  const botId = overrides.botId ?? `bot-${BOT_A_UUID}`;
  const defaults = defaultAvatarIdentity(botId);
  const base = {
    schemaVersion: 3,
    botId,
    name: "New Bot",
    appearance: {
      ...defaults,
      image: null,
      title: "",
      description: "",
    },
    notifications: true,
    createdAt: NOW,
    updatedAt: NOW,
    conversations: [],
    runtime: {
      provider: null,
      remoteRuntimeId: null,
      state: "unprovisioned",
      lastConfirmedAt: null,
      lastErrorCode: null,
    },
    computer: expectedComputer(),
    setupStage: "profile-model",
  };
  return {
    ...base,
    ...overrides,
    botId,
    appearance: { ...base.appearance, ...(overrides.appearance || {}) },
    runtime: { ...base.runtime, ...(overrides.runtime || {}) },
    computer: { ...base.computer, ...(overrides.computer || {}) },
  };
}
```

Add:

```js
test("create derives only omitted appearance fields in the first durable write", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const automatic = await store.create({ appearance: { description: "Automatic" } });
  assert.deepEqual(
    { shape: automatic.appearance.shape, color: automatic.appearance.color },
    defaultAvatarIdentity(automatic.botId),
  );
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8")).bots[0];
  assert.deepEqual(persisted.appearance, automatic.appearance);

  const explicitShape = await store.create({ appearance: { shape: "cat" } });
  assert.equal(explicitShape.appearance.shape, "cat");
  assert.equal(explicitShape.appearance.color, defaultAvatarIdentity(explicitShape.botId).color);

  const explicitColor = await store.create({ appearance: { color: "violet" } });
  assert.equal(explicitColor.appearance.shape, defaultAvatarIdentity(explicitColor.botId).shape);
  assert.equal(explicitColor.appearance.color, "violet");
});

test("existing appearance survives load restart edit and deletion without reassignment", async (t) => {
  const { filePath } = await temporaryStore(t);
  const existing = expectedBot({ appearance: { shape: "gem", color: "blue" } });
  await writeDocument(filePath, validV5StoreDocument([existing]));
  const restarted = new BotStore({ filePath, now: () => NOW });
  assert.deepEqual((await restarted.read(existing.botId)).appearance, existing.appearance);
  const edited = await restarted.updateProfile(existing.botId, { appearance: { shape: "wolf" } });
  assert.equal(edited.appearance.shape, "wolf");
  assert.equal(edited.appearance.color, "blue");
  await restarted.deleteBots([existing.botId]);
  assert.equal(await restarted.read(existing.botId), null);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

```bash
node --test --test-name-pattern='create derives only omitted|existing appearance survives' macos/test/bot-store.test.cjs
```

Expected: FAIL because omitted values still normalize immediately to `blob`/`red`.

- [ ] **Step 3: Preserve omission through normalization**

Import `defaultAvatarIdentity`. Change `normalizeCreateAppearance()` to call `normalizeAppearance(selected, { partial: true })`. Change undefined/no-appearance paths in `normalizeCreateInput()` to return `{}` rather than `{ ...DEFAULT_APPEARANCE }`. Keep `DEFAULT_APPEARANCE` unchanged for loaded legacy compatibility and non-create normalization.

Add:

```js
function completeCreateAppearance(botId, partial) {
  const defaults = defaultAvatarIdentity(botId);
  return {
    shape: hasOwn(partial, "shape") ? partial.shape : defaults.shape,
    color: hasOwn(partial, "color") ? partial.color : defaults.color,
    image: hasOwn(partial, "image") ? partial.image : null,
    title: hasOwn(partial, "title") ? partial.title : "",
    description: hasOwn(partial, "description") ? partial.description : "",
  };
}
```

- [ ] **Step 4: Derive after ID minting and before the original push/commit**

In `create()` rename normalized `appearance` to `partialAppearance`. Inside the existing `#mutate` callback:

```js
const botId = `bot-${safeUUID(this.#randomUUID)}`;
const appearance = completeCreateAppearance(botId, partialAppearance);
const record = {
  schemaVersion: SCHEMA_VERSION,
  botId,
  name: "New Bot",
  appearance,
  // existing fields unchanged
};
next.bots.push(record);
return record.botId;
```

Do not add a second mutation or post-create update. Leave the existing `commitFence` passed to `#mutate`; it still executes immediately before the sole durable write.

- [ ] **Step 5: Run focused and full BotStore tests**

```bash
node --test --test-name-pattern='create derives only omitted|existing appearance survives|provider authority fences|create stores|serializes overlapping creates|deleteBots' macos/test/bot-store.test.cjs
node --test macos/test/bot-store.test.cjs
```

Expected: all tests PASS. Update only fixed `blob`/`red` expectations that represented omitted create defaults; explicit legacy fixtures remain unchanged.

- [ ] **Step 6: Commit first-write persistence**

```bash
git add macos/src/bots/bot-store.cjs macos/test/bot-store.test.cjs
git commit -m "feat(macOS): persist deterministic bot appearance on create"
```

---

### Task 3: Stop native creation from forcing blob/blue and prove round trips

**Assigned worker:** Fresh Luna-max implementation worker after Task 2 review.

**Files:**
- Modify: `macos/src/desktop/openbot-native-coordinator.cjs:715-721, 790-829, 1600-1643, 1645-1685`
- Modify: `macos/test/openbot-native-coordinator.test.cjs:107-176, 645-767`

**Interfaces:**
- Consumes the existing stock request fields `avatarShape?: string` and `avatarColor?: string`.
- Produces `createInput.appearance` containing `title` and `description`, plus shape/color only when they are own fields on the stock request.
- Roster DTO remains `{ avatarShape, avatarColor, avatarVersion, ... }`; no new field is added.

- [ ] **Step 1: Add RED omission and catalog round-trip tests**

Import `ADDED_AVATAR_SHAPES` and add:

```js
test("native create forwards explicit appearance only and leaves omitted defaults to BotStore", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    canCreateAgent: async () => true,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const reply = await request(port, "create-derived-avatar", "createAgent", {
    name: "Derived", description: "No explicit character.",
  });
  assert.equal(reply.outcome.status, "ok");
  assert.deepEqual(bots.calls.find(([name]) => name === "createBot")[1], {
    appearance: { title: "", description: "No explicit character." },
    notifications: true,
    setupStage: "complete",
  });
});

test("every added shape round-trips through native create roster avatar and Character edit", async (t) => {
  for (const shape of ADDED_AVATAR_SHAPES) {
    await t.test(shape, async () => {
      const bots = new BotControllerHarness();
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: bots,
        conversationController: new ConversationHarness(),
        canCreateAgent: async () => true,
      });
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      const created = await request(port, `create-${shape}`, "createAgent", {
        name: shape, description: "catalog", avatarShape: shape, avatarColor: "cyan",
      });
      assert.equal(created.outcome.value.agent.avatarShape, shape);
      assert.equal(created.outcome.value.agent.avatarColor, "cyan");
      const edited = await request(port, `edit-${shape}`, "updateAgent", {
        id: created.outcome.value.agent.id,
        profile: { avatarShape: shape, avatarColor: "violet" },
      });
      assert.equal(edited.outcome.value.avatarShape, shape);
      assert.equal(edited.outcome.value.avatarColor, "violet");
      assert.equal(edited.outcome.value.avatarVersion, "2026-08-16T12:03:00.000Z");
      coordinator.dispose();
    });
  }
});
```

Adjust `BotControllerHarness.createBot()` so omitted test fields receive deterministic stand-in values only in the harness response, while the recorded input remains exact. The test is about coordinator forwarding, not reimplementing BotStore.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --test --test-name-pattern='forwards explicit appearance only|every added shape round-trips' macos/test/openbot-native-coordinator.test.cjs
```

Expected: omission test FAIL because the coordinator records `shape: "blob", color: "blue"`.

- [ ] **Step 3: Forward only own explicit fields**

Replace the creation appearance block with:

```js
const appearance = { title: "", description };
if (Object.hasOwn(args, "avatarShape")) appearance.shape = appearanceId(args.avatarShape);
if (Object.hasOwn(args, "avatarColor")) appearance.color = appearanceId(args.avatarColor);
```

Do not alter the provider authority read, commit fence, create/rename ordering, active-agent selection, or published DTO. `updateAgent()` already forwards explicit fields only; retain it and prove it with the catalog test.

- [ ] **Step 4: Run coordinator/provider-gate tests**

```bash
node --test --test-name-pattern='native roster requests|native create requires|construction without a provider gate|forwards explicit|every added shape' macos/test/openbot-native-coordinator.test.cjs
node --test macos/test/openbot-native-coordinator.test.cjs macos/test/desktop-runtime.test.cjs
```

Expected: all tests PASS; the provider gate still runs before `createBot`.

- [ ] **Step 5: Commit native forwarding**

```bash
git add macos/src/desktop/openbot-native-coordinator.cjs macos/test/openbot-native-coordinator.test.cjs
git commit -m "fix(macOS): let BotStore own native avatar defaults"
```

---

### Task 4: Extend the exact Grok Sand geometry and visible Character registry

**Assigned worker:** Fresh Luna-max implementation worker after Task 3 review.

**Files:**
- Modify: `macos/src/patch/renderer.cjs:6, 84-173`
- Modify: `macos/test/renderer-integration.test.cjs:32-80, 113-317, 339-372`
- Modify: `macos/test/patch-app.test.cjs:15-35, 63-118`

**Interfaces:**
- Consumes pinned vendor renderer SHA-256 `097b53e7c7e481022b393228b65104b3cd548881281b6adf0cb255a4b3e5b038` and existing `replaceUnique`.
- `renderer.cjs` imports only `ADDED_AVATAR_SHAPES` and `VISIBLE_AVATAR_SHAPES` from the runtime-safe catalog module.
- Exported `patchAvatarCatalogSource(source)` replaces exactly two anchors: the `Fo` geometry registry region and `Pq` visible picker/default registry.
- Exported `reverseAvatarCatalogSource(source)` applies the inverse two replacements and returns the exact input stock segments.
- `patchVendorRendererSource()` calls `patchAvatarCatalogSource()` only after its existing SHA-256 check and before returning.

- [ ] **Step 1: Add exact stock anchors and RED reversible-patch tests**

In `renderer.cjs`, import the catalog arrays and define:

```js
const {
  ADDED_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
} = require("../bots/avatar-catalog.cjs");
const VENDOR_VISIBLE_SHAPES = 'const Pq=["blob","pebble","squircle","tablet","wedge","hex","cloud","teardrop"]';
const OPENBOT_VISIBLE_SHAPES = `const Pq=${JSON.stringify(VISIBLE_AVATAR_SHAPES)}`;
const VENDOR_GEOMETRY_TAIL = 'teardrop:qo("Teardrop",wBt(88,ze-114,ze+26,18)),leaf:qo("Leaf",vBt(88,113,1.5))};Fo.wedge.face.leftDX=-6;const Jst=Object.keys(Fo)';
```

Export these constants plus the patch/reverse functions. In `renderer-integration.test.cjs`, import the exact test dependencies and add:

```js
const { ADDED_AVATAR_SHAPES } = require("../src/bots/avatar-catalog.cjs");
const {
  OPENBOT_VISIBLE_SHAPES,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarCatalogSource,
  reverseAvatarCatalogSource,
} = require(patchPath);
```

```js
test("avatar patch adds every geometry and visible choice and reverses exactly", () => {
  const stockFallback = 'function Jee(n){return Jst.find(t=>t===n.avatarShape)??I4e(n.id)}';
  const source = `before;${VENDOR_GEOMETRY_TAIL};middle;${VENDOR_VISIBLE_SHAPES};${stockFallback};after`;
  const patched = patchAvatarCatalogSource(source);
  for (const shape of ADDED_AVATAR_SHAPES) {
    assert.match(patched, new RegExp(`${shape}:qo\\(`));
  }
  assert.match(patched, new RegExp(OPENBOT_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((patched.match(/function Jee\(n\)/g) ?? []).length, 1);
  assert.match(patched, new RegExp(stockFallback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(reverseAvatarCatalogSource(patched), source);
  assert.throws(() => patchAvatarCatalogSource(source + VENDOR_VISIBLE_SHAPES), /ambiguous/i);
  assert.throws(() => patchAvatarCatalogSource("missing"), /not found/i);
});
```

- [ ] **Step 2: Run the patch test and verify RED**

```bash
node --test --test-name-pattern='avatar patch adds every geometry' macos/test/renderer-integration.test.cjs
```

Expected: FAIL because the anchor/replacement functions are not implemented.

- [ ] **Step 3: Add all twelve code-native geometry entries**

Define `OPENBOT_ADDED_GEOMETRIES` with the exact string below. These entries use only Grok's existing `qo`, `Ost`, `dBt`, and `ze` helpers and remain within the stock 259-unit view box:

```js
const OPENBOT_ADDED_GEOMETRIES = `
cat:qo("Cat",Ost([[ze-96,ze+72],[ze-94,ze-42],[ze-72,ze-104],[ze-38,ze-78],[ze,ze-92],[ze+38,ze-78],[ze+72,ze-104],[ze+94,ze-42],[ze+96,ze+72],[ze+58,ze+104],[ze-58,ze+104]],[18,10,8,18,22,18,8,10,18,24,24])),
dog:qo("Dog",Ost([[ze-100,ze-70],[ze-66,ze-92],[ze-46,ze-62],[ze,ze-82],[ze+46,ze-62],[ze+66,ze-92],[ze+100,ze-70],[ze+88,ze+70],[ze+52,ze+104],[ze-52,ze+104],[ze-88,ze+70]],[16,20,18,24,18,20,16,26,24,24,26])),
wolf:qo("Wolf",Ost([[ze-104,ze+52],[ze-88,ze-54],[ze-54,ze-112],[ze-24,ze-72],[ze,ze-98],[ze+24,ze-72],[ze+54,ze-112],[ze+88,ze-54],[ze+104,ze+52],[ze+66,ze+98],[ze+28,ze+82],[ze,ze+112],[ze-28,ze+82],[ze-66,ze+98]],[12,10,6,12,10,12,6,10,12,18,12,8,12,18])),
bunny:qo("Bunny",Ost([[ze-78,ze+96],[ze-72,ze-22],[ze-58,ze-112],[ze-28,ze-108],[ze-16,ze-42],[ze+16,ze-42],[ze+28,ze-108],[ze+58,ze-112],[ze+72,ze-22],[ze+78,ze+96],[ze+42,ze+112],[ze-42,ze+112]],[22,14,12,12,18,18,12,12,14,22,20,20])),
fox:qo("Fox",Ost([[ze-102,ze+56],[ze-88,ze-54],[ze-50,ze-108],[ze-30,ze-64],[ze,ze-88],[ze+30,ze-64],[ze+50,ze-108],[ze+88,ze-54],[ze+102,ze+56],[ze+48,ze+88],[ze,ze+114],[ze-48,ze+88]],[12,8,6,14,18,14,6,8,12,16,8,16])),
bear:qo("Bear",dBt([[ze-70,ze-66,40],[ze+70,ze-66,40],[ze,ze+12,104],[ze,ze+78,72]])),
owl:qo("Owl",Ost([[ze-92,ze+88],[ze-90,ze-42],[ze-62,ze-98],[ze-24,ze-72],[ze,ze-108],[ze+24,ze-72],[ze+62,ze-98],[ze+90,ze-42],[ze+92,ze+88],[ze+44,ze+108],[ze,ze+84],[ze-44,ze+108]],[18,14,8,16,8,16,8,14,18,16,12,16])),
jelly:qo("Jelly",Ost([[ze-98,ze+54],[ze-92,ze-26],[ze-62,ze-82],[ze,ze-108],[ze+62,ze-82],[ze+92,ze-26],[ze+98,ze+54],[ze+76,ze+98],[ze+38,ze+72],[ze,ze+106],[ze-38,ze+72],[ze-76,ze+98]],[18,18,24,28,24,18,18,16,12,12,12,16])),
terminal:qo("Terminal",Ost([[ze-104,ze-82],[ze+104,ze-82],[ze+104,ze+58],[ze+42,ze+58],[ze+58,ze+98],[ze+78,ze+98],[ze+78,ze+112],[ze-78,ze+112],[ze-78,ze+98],[ze-58,ze+98],[ze-42,ze+58],[ze-104,ze+58]],[14,14,14,10,8,6,6,6,6,8,10,14])),
robot:qo("Robot",Ost([[ze-76,ze-96],[ze-18,ze-96],[ze-10,ze-116],[ze+10,ze-116],[ze+18,ze-96],[ze+76,ze-96],[ze+76,ze-72],[ze+104,ze-72],[ze+104,ze+78],[ze+76,ze+78],[ze+76,ze+104],[ze-76,ze+104],[ze-76,ze+78],[ze-104,ze+78],[ze-104,ze-72],[ze-76,ze-72]],[12,8,6,6,8,12,8,10,12,8,12,12,8,12,10,8])),
microchip:qo("Microchip",Ost([[ze-62,ze-108],[ze-38,ze-108],[ze-38,ze-88],[ze-12,ze-88],[ze-12,ze-108],[ze+12,ze-108],[ze+12,ze-88],[ze+38,ze-88],[ze+38,ze-108],[ze+62,ze-108],[ze+62,ze-84],[ze+88,ze-84],[ze+88,ze-58],[ze+108,ze-58],[ze+108,ze-32],[ze+88,ze-32],[ze+88,ze+32],[ze+108,ze+32],[ze+108,ze+58],[ze+88,ze+58],[ze+88,ze+84],[ze+62,ze+84],[ze+62,ze+108],[ze+38,ze+108],[ze+38,ze+88],[ze+12,ze+88],[ze+12,ze+108],[ze-12,ze+108],[ze-12,ze+88],[ze-38,ze+88],[ze-38,ze+108],[ze-62,ze+108],[ze-62,ze+84],[ze-88,ze+84],[ze-88,ze+58],[ze-108,ze+58],[ze-108,ze+32],[ze-88,ze+32],[ze-88,ze-32],[ze-108,ze-32],[ze-108,ze-58],[ze-88,ze-58],[ze-88,ze-84],[ze-62,ze-84]],6)),
drone:qo("Drone",Ost([[ze-112,ze-72],[ze-58,ze-72],[ze-42,ze-34],[ze-24,ze-22],[ze-18,ze-48],[ze+18,ze-48],[ze+24,ze-22],[ze+42,ze-34],[ze+58,ze-72],[ze+112,ze-72],[ze+112,ze-42],[ze+70,ze-42],[ze+54,ze-8],[ze+90,ze+42],[ze+90,ze+72],[ze+42,ze+72],[ze+18,ze+38],[ze-18,ze+38],[ze-42,ze+72],[ze-90,ze+72],[ze-90,ze+42],[ze-54,ze-8],[ze-70,ze-42],[ze-112,ze-42]],8))`;

const OPENBOT_GEOMETRY_TAIL = VENDOR_GEOMETRY_TAIL.replace(
  'leaf:qo("Leaf",vBt(88,113,1.5))};',
  `leaf:qo("Leaf",vBt(88,113,1.5)),${OPENBOT_ADDED_GEOMETRIES}};`,
);
```

Implement patch/reverse in `renderer.cjs`:

```js
function patchAvatarCatalogSource(source) {
  let patched = replaceUnique(
    source,
    VENDOR_GEOMETRY_TAIL,
    OPENBOT_GEOMETRY_TAIL,
    "Grok avatar geometry registry",
  );
  patched = replaceUnique(
    patched,
    VENDOR_VISIBLE_SHAPES,
    OPENBOT_VISIBLE_SHAPES,
    "Grok visible avatar registry",
  );
  return patched;
}

function reverseAvatarCatalogSource(source) {
  let reversed = replaceUnique(
    source,
    OPENBOT_VISIBLE_SHAPES,
    VENDOR_VISIBLE_SHAPES,
    "OpenBot visible avatar registry",
  );
  reversed = replaceUnique(
    reversed,
    OPENBOT_GEOMETRY_TAIL,
    VENDOR_GEOMETRY_TAIL,
    "OpenBot avatar geometry registry",
  );
  return reversed;
}
```

Geometry-first patching and visible-first reversal guarantee that a partially matching source cannot silently ship.

- [ ] **Step 4: Wire the avatar patch into the existing hash-bound renderer patch**

After the SHA-256 validation and before the first existing renderer replacement:

```js
let patched = patchAvatarCatalogSource(source);
patched = replaceUnique(
  patched,
  VENDOR_NATIVE_SHELL_GATE,
  OPENBOT_NATIVE_SHELL_GATE,
  "Grok native shell onboarding child",
);
```

Change the later `let patched =` declaration accordingly. Do not loosen or recalculate the production vendor hash.

Replace the final export object with the existing exports plus the avatar patch contract:

```js
module.exports = {
  ASSETS,
  OPENBOT_GEOMETRY_TAIL,
  OPENBOT_VISIBLE_SHAPES,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_RENDERER_ASSET,
  VENDOR_RENDERER_ASSET_SHA256,
  VENDOR_SETTINGS_ASSET,
  VENDOR_SETTINGS_ASSET_SHA256,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarCatalogSource,
  patchRenderer,
  patchRendererIndexSource,
  patchVendorRendererSource,
  patchVendorSettingsSource,
  reverseAvatarCatalogSource,
};
```

- [ ] **Step 5: Extend synthetic renderer fixtures and unique-anchor tests**

In both `renderer-integration.test.cjs` and `patch-app.test.cjs`, import the exported stock anchor constants from `renderer.cjs` and include `VENDOR_GEOMETRY_TAIL` and `VENDOR_VISIBLE_SHAPES` once in `SYNTHETIC_VENDOR_RENDERER`. Add both to `requiredAnchors` missing/ambiguous loops. Assert the patched synthetic asset contains every `${shape}:qo(` and the 20-item `Pq`, and `reverseAvatarCatalogSource()` restores the two exact synthetic stock segments.

- [ ] **Step 6: Run focused patch tests**

```bash
node --test macos/test/avatar-catalog.test.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs
```

Expected: all tests PASS; missing/ambiguous geometry or visible-list anchors fail closed; applying the avatar inverse restores exact stock segments.

- [ ] **Step 7: Commit the exact renderer extension**

```bash
git add macos/src/patch/renderer.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs
git commit -m "feat(macOS): extend Grok Sand avatar registry"
```

---

### Task 5: Package closure and exact staged module proof

**Assigned worker:** Fresh Luna-max implementation worker after Task 4 review.

**Files:**
- Modify: `macos/src/patch/desktop.cjs:8-65`
- Modify: `macos/scripts/patch-app.cjs:19-88`
- Modify: `macos/test/patch-app.test.cjs:135-350`
- Modify: `macos/test/installer-bundle.test.cjs:176-230`
- Modify: `macos/scripts/build-installer-app.cjs` only if the staged list does not already include the file through `DESKTOP_FILES`

**Interfaces:**
- Consumes `bots/avatar-catalog.cjs` from Tasks 1/4.
- Produces an installed ASAR containing `dist/codex/bots/avatar-catalog.cjs` byte-equal to source.
- No release/notarization claim is introduced.

- [ ] **Step 1: Add RED staging and mutation expectations**

Add `bots/avatar-catalog.cjs` immediately before `bots/bot-store.cjs` in expected sorted source file lists. Add `dist/codex/bots/avatar-catalog.cjs` immediately before `dist/codex/bots/bot-store.cjs` in the allowed mutation and expected receipt lists. In the patch test, assert byte equality between source and extracted staged module.

- [ ] **Step 2: Run package tests and verify RED**

```bash
node --test macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs
```

Expected: FAIL because `DESKTOP_FILES` and `ALLOWED_MUTATIONS` do not include the new module.

- [ ] **Step 3: Stage the module through the exact existing closure**

Add `"bots/avatar-catalog.cjs"` to `DESKTOP_FILES` in `macos/src/patch/desktop.cjs`. Add `"dist/codex/bots/avatar-catalog.cjs"` to `ALLOWED_MUTATIONS` in `macos/scripts/patch-app.cjs`. `PATCHER_SOURCE_FILES` in `build-installer-app.cjs` should pick it up automatically from `DESKTOP_FILES`; do not add a duplicate manual entry.

- [ ] **Step 4: Run closure, source, and installer tests**

```bash
node --test macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs macos/test/renderer-integration.test.cjs
npm --prefix macos run check
swift test --package-path macos/installer
git diff --check
```

Expected: all commands PASS, and the patch receipt contains exactly one new allowed path.

- [ ] **Step 5: Commit package closure**

```bash
git add macos/src/patch/desktop.cjs macos/scripts/patch-app.cjs macos/scripts/build-installer-app.cjs macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs
git commit -m "build(macOS): package shared avatar catalog"
```

If `build-installer-app.cjs` is byte-unchanged because the list flows through `DESKTOP_FILES`, omit it from `git add`.

---

### Task 6: Luna-max identity review gate

**Assigned worker:** Independent Luna-max test/review worker. Read the actual diff and exact patched source, not summaries.

**Files:**
- Review only: all identity-owned files
- Modify only when the parent assigns a concrete review finding to a fresh implementation worker

**Interfaces:**
- Consumes Tasks 1-5 commits.
- Produces an APPROVE/REVISE report with file/line findings, exact commands, catalog IDs, source hashes, and test totals.

- [ ] **Step 1: Inspect diff and ownership**

```bash
git diff f56a014..HEAD -- macos/src/bots macos/src/desktop/openbot-native-coordinator.cjs macos/src/patch macos/scripts macos/test/avatar-catalog.test.cjs macos/test/bot-store.test.cjs macos/test/openbot-native-coordinator.test.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs
git diff --check f56a014..HEAD
```

Reject any edit to provider-owned UI/CSS/test files.

- [ ] **Step 2: Audit persistence and registry invariants**

Confirm from code/tests that missingness survives normalization; ID is minted before derivation; shape/color salts are distinct and versioned; explicit fields win independently; the completed appearance is in the sole first mutation; existing loads do not reassign; native creation does not force values; all twelve values round-trip; stock eight remain first; the exact vendor hash is unchanged; both avatar anchors are unique/reversible; and packaging stages the catalog.

- [ ] **Step 3: Run focused and adjacent tests**

```bash
node --test macos/test/avatar-catalog.test.cjs macos/test/bot-store.test.cjs macos/test/openbot-native-coordinator.test.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs macos/test/desktop-runtime.test.cjs
npm --prefix macos run check
git diff --check
```

Expected: all tests PASS, source check passes, diff check is empty.

- [ ] **Step 4: Review geometry numerically before visual integration**

Inspect every new `Ost`/`dBt` coordinate for bounds within `ze ± 116`, unique silhouette points, closed paths, and different dog/wolf, terminal/robot/microchip/drone outlines. Reject a duplicated base geometry with decorative-only changes. Confirm no external URL, raster, image generation, or new animation loop exists.

- [ ] **Step 5: Report the review gate**

APPROVE only with zero Critical/Important findings. Otherwise include each issue's exact shape, source segment, test gap, and correction needed.

---

## Plan Self-review Record

- Spec coverage: Tasks 1-2 cover the safe full catalog, separate salted deterministic defaults, explicit precedence, first-write persistence, restart/load/edit/delete behavior, no migration, and unchanged provider commit fence. Task 3 covers native creation omission, provider-before-create, roster/avatar/Character round trips, and `avatarVersion`. Task 4 covers the exact Sand geometry/visible picker, stock order, old-renderer fallback preservation, exact unique/reversible anchors, and unchanged shared motion engine. Task 5 covers package closure. Task 6 and final integration cover full source/package/install and demanding size/theme/motion/Reduced Motion/A-B visual review.
- Placeholder scan: no TBD, TODO, deferred implementation phrase, unnamed geometry, or unspecified test remains. All twelve registry entries, constants, function signatures, RED/GREEN commands, commit commands, and review commands are explicit.
- Type consistency: `VISIBLE_AVATAR_SHAPES` and `AVATAR_COLORS` are the sole deterministic input arrays; `defaultAvatarIdentity()` always returns `{ shape, color }`; `partialAppearance` remains partial until `completeCreateAppearance()` returns all five existing fields; coordinator DTO names remain `avatarShape`, `avatarColor`, and `avatarVersion`; renderer patch/reverse constants and exports use the same names in tests and package code.
- Runtime dependency check: `bots/avatar-catalog.cjs` imports only `node:crypto`; patch-only `replaceUnique` remains in `patch/renderer.cjs`, so the installed BotStore never requires an unstaged patch module.
- Ownership check: identity tasks do not touch the three provider-owned files. The only cross-plan gate is final Sol integration after both independent reviews.

---

## Final Sol Integration and Installed Visual Acceptance

The final Sol-high/xhigh integrator starts only after both plan reviews approve. It inspects the combined diff, resolves conflicts, reruns all tests, builds/packages/installs from the final source commit, and inspects the exact running installed app.

Required combined commands:

```bash
node --test macos/test/avatar-catalog.test.cjs macos/test/bot-store.test.cjs macos/test/openbot-native-coordinator.test.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs macos/test/installer-bundle.test.cjs macos/test/bot-runtime-ui.test.cjs macos/test/provider-controller.test.cjs
npm --prefix macos test
npm --prefix macos run check
swift test --package-path macos/installer
git diff --check
```

Installed visual/motion acceptance must capture every added identity at 16, 22, 28, 36, 64, 72, and 96 pixels on light and dark backgrounds in native New Bot/Character, sidebar, chat, and Character editor surfaces. Record idle and working for every identity, and all runtime states for at least `blob` (abstract), `cat` (animal), `jelly` (creature), and `robot` (computer). Record at least two full loops and Reduced Motion stills for all twelve.

The Sol integrator and an independent blind reviewer compare against `/Applications/Grok Bot original 20260811.app` and inspect full frames plus crops for:

- family recognition at 16px and exact identity recognition at 36px;
- materially different dog and wolf muzzle/ear/cheek silhouettes;
- materially different terminal, robot, microchip, and drone machine silhouettes;
- face stability, appendage clipping, baseline/optical-center drift, contour seams, flicker, and loop closure;
- light/dark fills/outlines and Reduced Motion with no spin, travel, orbit, or morph;
- stock New Bot and later Character edits using the same registry and updating `avatarVersion`.

Technical tests do not clear this visual gate. Any unclear silhouette or bad motion returns to a fresh Luna-max geometry implementation worker, then repeats Luna review and Sol installed acceptance.

The final handoff records source commit, pushed branch, test outputs, package hashes, installed ASAR hash, running executable, screenshots, recordings, independent review, and unchanged remote-provider/notarization/self-contained-installer boundaries.
