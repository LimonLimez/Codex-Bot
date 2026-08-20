# Grok-native Provider Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eight simultaneously expanded provider rows with one Grok/Sand-style provider chooser that shows eight compact choices and exactly one progressively disclosed connection panel in first-run onboarding and General Settings.

**Architecture:** Keep the existing provider facade, atomic authority snapshot, operation fencing, receipt completion, and provider event logic unchanged. Refactor only the DOM projection inside `mount()` into two instances of the same internal provider-picker anatomy: a blocking first-connection dialog and a non-modal Settings section. Each instance owns ephemeral selection state and one rebuilt details panel; provider authority remains exclusively in `window.openbotProviders`.

**Tech Stack:** Node.js 22 CommonJS, renderer DOM APIs, CSS custom properties/media queries, `node:test`, the existing `createMountedUiHarness` fake DOM.

**Spec:** `docs/superpowers/specs/2026-08-20-macos-grok-provider-picker-animated-bot-identities-design.md` (approved; SHA-256 `e05ef2f3e044ad2fd0a215feb1721c326f702ef706b1f4185f67cba6c3497a18`)

## Global Constraints

- Preserve the native Grok New Bot route and the blocking provider-before-create gate.
- Preserve all eight providers in this exact order: OpenAI Codex, Anthropic Claude, Google Antigravity, Moonshot Kimi, xAI, Google Vertex AI, OpenAI API key, Local models.
- No Skip, Escape dismissal, backdrop dismissal, window-dismiss bypass, bot creation, provider-state persistence, or localStorage authority may be added.
- Do not change provider controller, provider state store, preload/RPC, runtime-provider, inference, conversation, Computer, automation, or remote-runtime files.
- Keep `readAuthoritySnapshot()` as the only native authority read used by the mounted picker.
- Keep connect -> atomic snapshot -> connected catalog -> durable onboarding receipt -> atomic reread ordering byte-for-behavior equivalent.
- Google Vertex AI remains visible and selectable, but its connection action is disabled with the exact reason `A secure JSON file picker is not available in this build.` until a reviewed bridge supplies `sourcePath`.
- Secret inputs clear before the provider facade call can settle; safe non-secret inputs stay on a failed selected panel.
- Use text in addition to color for selected, connected, connecting, unavailable, error, and retry states.
- Use 4, 8, 12, 16, and 20 pixel spacing; two columns with a 12-pixel gap at normal width; one column below 620 pixels.
- Animations must be disabled by `prefers-reduced-motion: reduce` without hiding state or focus.
- The user has selected subagent-driven execution. Do not ask again; dispatch the Luna-max tasks below sequentially within this lane.

## Ownership Lock and Parallel Execution

Provider implementation workers exclusively own:

- `macos/src/renderer/bot-runtime-ui.js`
- `macos/src/renderer/codex-ui.css`
- `macos/test/bot-runtime-ui.test.cjs`

The provider lane must not edit `macos/src/bots/bot-store.cjs`, `macos/src/desktop/openbot-native-coordinator.cjs`, `macos/src/patch/renderer.cjs`, packaging scripts, or renderer patch tests; those are reserved for the identity lane. CSS assertions belong in `macos/test/bot-runtime-ui.test.cjs` so the provider lane does not contend for `macos/test/renderer-integration.test.cjs`.

Tasks 1-3 are sequential because they share the same three files. They may run in parallel with all identity-plan tasks. Task 4 is an independent Luna-max review after Tasks 1-3. Final Sol integration waits for both plans.

## File Map

- Modify `macos/src/renderer/bot-runtime-ui.js`: provider descriptor presentation metadata, shared picker DOM factory, ephemeral selection, progressive disclosure, focus/keyboard handling, and projection of existing authority/operation state.
- Modify `macos/src/renderer/codex-ui.css`: fixture-safe Sand semantic aliases, compact two-column cards, one details panel, sticky modal header, narrow layout, focus, light/dark, and reduced-motion rules.
- Modify `macos/test/bot-runtime-ui.test.cjs`: semantic provider test helpers, DOM/state/action/race/accessibility regressions, and CSS source assertions.

---

### Task 1: Progressive-disclosure DOM and keyboard contract

**Assigned worker:** Fresh Luna-max implementation worker.

**Files:**
- Modify: `macos/test/bot-runtime-ui.test.cjs:4214-4618` and provider tests at `5396-8853`
- Modify: `macos/src/renderer/bot-runtime-ui.js:24-56, 3148-3229, 3248-3286, 3486-3744, 4406-4546, 4736-4739, 4881-4921`

**Interfaces:**
- Consumes: existing `PROVIDER_IDS`, `PROVIDER_LABELS`, `PROVIDER_LOGIN_KINDS`, `providerConnection(providerId)`, `providerAction(providerId, first)`, `disconnectProvider(providerId)`, and `updateConnectionPresentation(snapshot)`.
- Produces internal `providerSurfaces` with exact shape:

```js
{
  first: {
    key: "first",
    first: true,
    selectedProviderId: "openai-codex",
    list: HTMLElement,
    cards: Map<string, ProviderCard>,
    details: HTMLElement,
    loginPrompt: { prompt: HTMLElement, code: HTMLElement },
  },
  settings: {
    key: "settings",
    first: false,
    selectedProviderId: "openai-codex",
    list: HTMLElement,
    cards: Map<string, ProviderCard>,
    details: HTMLElement,
    loginPrompt: { prompt: HTMLElement, code: HTMLElement },
  },
}
```

- `ProviderCard` is `{ item, button, mark, title, description, state, providerId }`.
- The currently disclosed detail object is stored as `surface.detail` and is `{ panel, heading, status, error, form, inputs, action, disconnect, providerId, first }`.
- `selectProvider(surface, providerId, { moveFocus = false } = {})` changes only ephemeral renderer state, rebuilds exactly one detail panel, updates every card's `aria-pressed`, and never calls the provider facade.

- [ ] **Step 1: Add semantic test helpers before changing production DOM**

Add these helpers immediately after `createMountedUiHarness`:

```js
function providerSurface(harness, first = true) {
  return harness.findPanel(first ? "codex-first-provider-picker" : "codex-settings-provider-picker");
}

function providerCard(harness, providerId, first = true) {
  return harness.findAllPanel("codex-provider-choice-button").find((node) => (
    node.dataset.providerId === providerId
      && node.dataset.surface === (first ? "first" : "settings")
  ));
}

function providerDetail(harness, first = true) {
  const surface = providerSurface(harness, first);
  return harness.findAllPanel("codex-provider-details").find((node) => node.parentElement === surface);
}

function providerActionButton(harness, first = true) {
  return providerControl(harness, "codex-provider-connect", first);
}

function providerControl(harness, className, first = true) {
  const visit = (node) => {
    if (node.className.split(/\s+/).includes(className)) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(providerDetail(harness, first));
}

function providerText(harness, first = true) {
  const values = [];
  const visit = (node) => {
    if (node.textContent) values.push(node.textContent);
    for (const child of node.children) visit(child);
  };
  visit(providerDetail(harness, first));
  return values.join(" ");
}

function clickProviderCard(harness, providerId, first = true) {
  const card = providerCard(harness, providerId, first);
  card.listeners.get("click")();
  return card;
}
```

The existing `MountElement.append()` and `replaceChildren()` already set `child.parentElement = this`; retain that behavior and do not infer provider controls by child index.

Add this complete native provider harness factory after the semantic helpers:

```js
function connectedNativeProviderHarness({
  providerFacade: providerOverride = null,
  onboarding = null,
  connections = eightConnections(),
  providerModels = [],
} = {}) {
  const catalogGeneration = connections.reduce(
    (generation, entry) => Math.max(generation, entry.generation),
    0,
  );
  const providerCatalogValue = providerModels.length > 0
    ? providerCatalog(providerModels, catalogGeneration)
    : providerCatalog([], catalogGeneration, "unavailable");
  const catalog = Object.freeze({
    generation: 1,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
    })]),
  });
  return createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 1,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    providerFacade: providerOverride ?? providerFacade({
      connections,
      catalog: providerCatalogValue,
      onboarding,
    }),
  });
}
```

Extend `createMountedUiHarness` with `focusBeforeMount = false`. Immediately before `mount({ windowRef, documentRef })`, create the optional native-shell focus anchor and return it on the harness:

```js
const focusAnchor = focusBeforeMount ? documentRef.createElement("button") : null;
if (focusAnchor) {
  focusAnchor.className = "provider-return-focus-anchor";
  documentRef.body.append(focusAnchor);
  focusAnchor.focus();
}
const mounted = mount({ windowRef, documentRef });
```

Add `focusAnchor,` adjacent to the existing `documentRef,` property in the object returned by `createMountedUiHarness`.

- [ ] **Step 2: Write the failing structure/selection/accessibility tests**

Replace the old expanded-row assertions with these exact expectations:

```js
test("provider picker shows eight canonical buttons and exactly one disclosed panel per surface", async (context) => {
  const harness = connectedNativeProviderHarness({ onboarding: null });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  for (const [first, surfaceName] of [[true, "first"], [false, "settings"]]) {
    const cards = harness.findAllPanel("codex-provider-choice-button")
      .filter((node) => node.dataset.surface === surfaceName);
    assert.deepEqual(cards.map((node) => node.dataset.providerId), PROVIDER_IDS);
    assert.equal(cards.filter((node) => node.attributes["aria-pressed"] === "true").length, 1);
    assert.equal(cards[0].dataset.providerId, "openai-codex");
    assert.equal(cards[0].attributes["aria-pressed"], "true");
    assert.equal(cards[0].attributes["aria-controls"], `codex-${surfaceName}-provider-details`);
    assert.equal(providerSurface(harness, first).children
      .filter((node) => node.className.includes("codex-provider-details")).length, 1);
    assert.equal(providerDetail(harness, first).dataset.providerId, "openai-codex");
  }
  assert.equal(harness.findPanel("codex-first-connection-skip"), null);
});

test("provider selection is ephemeral and keyboard navigation follows canonical order", async (context) => {
  const facade = providerFacade();
  let connectCalls = 0;
  facade.connect = async () => { connectCalls += 1; };
  const harness = connectedNativeProviderHarness({ providerFacade: facade, onboarding: null });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const first = providerCard(harness, "openai-codex");
  const event = {
    key: "ArrowRight",
    preventDefaultCalled: false,
    preventDefault() { this.preventDefaultCalled = true; },
  };
  first.listeners.get("keydown")(event);
  assert.equal(event.preventDefaultCalled, true);
  assert.equal(providerCard(harness, "anthropic-claude").attributes["aria-pressed"], "true");
  assert.equal(providerDetail(harness).dataset.providerId, "anthropic-claude");
  assert.equal(harness.documentRef.activeElement, providerCard(harness, "anthropic-claude"));
  assert.equal(connectCalls, 0);
});
```

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
cd /Users/harlin/Documents/Codex/2026-05-01/Codex-Bot-macOS
node --test --test-name-pattern='provider picker shows|provider selection is ephemeral' macos/test/bot-runtime-ui.test.cjs
```

Expected: FAIL because `codex-provider-choice-button`, `codex-first-provider-picker`, and `codex-settings-provider-picker` do not exist and every provider form is still expanded.

- [ ] **Step 4: Add exact presentation metadata**

Directly after `PROVIDER_LABELS`, add:

```js
const PROVIDER_PRESENTATION = Object.freeze({
  "openai-codex": Object.freeze({ mark: "O", description: "Use your OpenAI Codex account.", recommended: true }),
  "anthropic-claude": Object.freeze({ mark: "A", description: "Connect your Anthropic account." }),
  "google-antigravity": Object.freeze({ mark: "G", description: "Connect Google Antigravity." }),
  "moonshot-kimi": Object.freeze({ mark: "K", description: "Sign in with a device code." }),
  xai: Object.freeze({ mark: "x", description: "Connect xAI with a device flow." }),
  "google-vertex-ai": Object.freeze({ mark: "V", description: "Use a Google Cloud service account." }),
  "openai-api-key": Object.freeze({ mark: "AI", description: "Use an OpenAI API key." }),
  "local-openai-compatible": Object.freeze({ mark: "{}", description: "Use an OpenAI-compatible local server." }),
});
const VERTEX_UNAVAILABLE_COPY = "A secure JSON file picker is not available in this build.";
```

- [ ] **Step 5: Replace expanded provider rows with a shared surface factory**

Create `makeProviderSurface({ first })` inside `mount()` before provider state variables. It must create:

```js
function makeProviderSurface({ first }) {
  const key = first ? "first" : "settings";
  const root = element(documentRef, "section", `codex-provider-picker codex-${key}-provider-picker`);
  const list = element(documentRef, "ul", "codex-provider-choice-list");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", first ? "Choose your first AI connection" : "AI connections");
  const details = element(documentRef, "div", "codex-provider-details");
  details.id = `codex-${key}-provider-details`;
  details.setAttribute("role", "region");
  const surface = {
    key,
    first,
    selectedProviderId: "openai-codex",
    root,
    list,
    cards: new Map(),
    details,
    detail: null,
    loginPrompt: makeLoginPrompt(),
  };
  for (const providerId of PROVIDER_IDS) {
    const presentation = PROVIDER_PRESENTATION[providerId];
    const item = element(documentRef, "li", "codex-provider-choice");
    const button = element(documentRef, "button", "codex-provider-choice-button");
    button.type = "button";
    button.dataset.providerId = providerId;
    button.dataset.surface = key;
    button.setAttribute("aria-pressed", String(providerId === surface.selectedProviderId));
    button.setAttribute("aria-controls", details.id);
    const mark = element(documentRef, "span", "codex-provider-choice-mark", presentation.mark);
    mark.setAttribute("aria-hidden", "true");
    const copy = element(documentRef, "span", "codex-provider-choice-copy");
    const title = element(documentRef, "strong", "codex-provider-choice-label", PROVIDER_LABELS[providerId]);
    const description = element(documentRef, "span", "codex-provider-choice-description", presentation.description);
    const state = element(documentRef, "span", "codex-provider-choice-state", "Not connected");
    state.id = `codex-${key}-${providerId}-state`;
    button.setAttribute("aria-describedby", state.id);
    copy.append(title, description, state);
    if (presentation.recommended) {
      copy.append(element(documentRef, "span", "codex-provider-recommended", "Recommended"));
    }
    button.append(mark, copy);
    item.append(button);
    list.append(item);
    surface.cards.set(providerId, { item, button, mark, title, description, state, providerId });
  }
  root.append(list, details);
  return surface;
}
```

Instantiate `providerSurfaces.first` and `.settings`. Replace the dialog's direct title/copy/choices layout with this exact header/scroll structure, then append the Settings surface below `connectionsCopy`:

```js
const firstConnectionHeader = element(documentRef, "header", "codex-provider-picker-header");
firstConnectionHeader.append(firstConnectionTitle, firstConnectionCopy);
const firstConnectionScroll = element(documentRef, "div", "codex-provider-picker-scroll");
const providerSurfaces = Object.freeze({
  first: makeProviderSurface({ first: true }),
  settings: makeProviderSurface({ first: false }),
});
firstConnectionScroll.append(
  providerSurfaces.first.root,
  firstConnectionError,
  firstConnectionStatus,
  firstConnectionRetry,
);
firstConnectionSetup.replaceChildren(firstConnectionHeader, firstConnectionScroll);
connectionsSettings.replaceChildren(
  connectionsTitle,
  connectionsCopy,
  connectionsStatus,
  connectionsRetry,
  providerSurfaces.settings.root,
);
```

Delete `firstConnectionChoices`, `connectionsActions`, `connectionsList`, `createProviderRow()`, `providerRows`, `firstProviderRows`, the two outer login prompts, and both loops that append eight expanded rows. Each surface's selected detail owns its own login prompt.

- [ ] **Step 6: Implement selection and roving keyboard focus**

Implement `selectProvider()` and attach each button's click/keydown listeners:

```js
function selectProvider(surface, providerId, { moveFocus = false } = {}) {
  if (!surface.cards.has(providerId)) return;
  surface.selectedProviderId = providerId;
  for (const [candidateId, card] of surface.cards) {
    const selected = candidateId === providerId;
    card.button.setAttribute("aria-pressed", String(selected));
    card.button.tabIndex = selected ? 0 : -1;
  }
  renderProviderSurface(surface);
  if (moveFocus) surface.detail?.firstControl?.focus?.();
}

function moveProviderChoice(surface, currentId, key) {
  const current = PROVIDER_IDS.indexOf(currentId);
  const columns = windowRef.innerWidth < 620 ? 1 : 2;
  const delta = key === "ArrowRight" ? 1
    : key === "ArrowLeft" ? -1
      : key === "ArrowDown" ? columns : key === "ArrowUp" ? -columns : 0;
  const target = key === "Home" ? 0 : key === "End" ? PROVIDER_IDS.length - 1
    : Math.max(0, Math.min(PROVIDER_IDS.length - 1, current + delta));
  selectProvider(surface, PROVIDER_IDS[target]);
  surface.cards.get(PROVIDER_IDS[target])?.button.focus?.();
}
```

Attach these listeners while constructing each card:

```js
button.addEventListener("click", () => {
  selectProvider(surface, providerId, { moveFocus: true });
});
button.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault?.();
  moveProviderChoice(surface, providerId, event.key);
});
```

Enter and Space retain native button activation. OpenAI Codex starts selected on both surfaces.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run the command from Step 3.

Expected: PASS for both new tests; there are 16 provider buttons total, two selected buttons total, and exactly one detail region per surface.

- [ ] **Step 8: Commit the DOM contract**

```bash
git add macos/src/renderer/bot-runtime-ui.js macos/test/bot-runtime-ui.test.cjs
git commit -m "refactor(macOS): disclose one provider connection panel"
```

---

### Task 2: Project existing authority and operation state into the selected panel

**Assigned worker:** Fresh Luna-max implementation worker after Task 1 review.

**Files:**
- Modify: `macos/test/bot-runtime-ui.test.cjs` provider test blocks at current post-Task-1 locations
- Modify: `macos/src/renderer/bot-runtime-ui.js` provider rendering/action functions created or retained by Task 1

**Interfaces:**
- Consumes: `providerSurfaces`, `providerConnections`, `providerCatalog`, `providerOnboarding`, `providerPending`, `providerOperations`, `providerReceiptRetry`, `providerAuthorityRetryable`, `providerFacadeInvalid`, and all existing authority refresh functions.
- Produces: `buildProviderDetails(surface, connection)`, `renderProviderCard(surface, card, connection)`, and `renderProviderSurface(surface)`.
- `providerAction(providerId, first)` and `disconnectProvider(providerId)` retain their external signatures and ordering. Their `entry` is now `providerSurfaces[first ? "first" : "settings"].detail`.

- [ ] **Step 1: Rewrite route tests to semantic helpers and add RED state tests**

Update every provider-specific test from line 4214 onward to use `providerCard()`, `providerDetail()`, `providerActionButton()`, and class lookups rather than `.children[2].children[0]`. Preserve every existing race/receipt assertion. Then add:

```js
test("Vertex is selectable but truthfully unavailable without calling connect", async (context) => {
  const requests = [];
  const harness = connectedNativeProviderHarness({
    onboarding: null,
    providerFacade: providerFacade({ connect: (request) => requests.push(request) }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  clickProviderCard(harness, "google-vertex-ai");
  const detail = providerDetail(harness);
  const action = providerActionButton(harness);
  assert.equal(detail.dataset.providerId, "google-vertex-ai");
  assert.match(providerText(harness), /secure JSON file picker is not available/i);
  assert.equal(action.disabled, true);
  action.listeners.get("click")();
  assert.deepEqual(requests, []);
});

test("a failed selected route keeps safe values clears secrets and restores action focus", async (context) => {
  const facade = providerFacade({
    connect() {
      const error = new Error("private sk-secret /Users/person");
      error.code = "OPENBOT_PROVIDER_INVALID";
      return Promise.reject(error);
    },
  });
  const harness = connectedNativeProviderHarness({ onboarding: null, providerFacade: facade });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "local-openai-compatible");
  const detail = providerDetail(harness);
  const baseUrl = providerControl(harness, "codex-provider-base-url");
  const secret = providerControl(harness, "codex-provider-api-key");
  baseUrl.value = "http://127.0.0.1:11434/v1";
  secret.value = "local-secret";
  const action = providerActionButton(harness);
  action.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(baseUrl.value, "http://127.0.0.1:11434/v1");
  assert.equal(secret.value, "");
  assert.equal(harness.documentRef.activeElement, action);
  assert.doesNotMatch(providerText(harness), /sk-secret|Users\/person|local-secret/);
});

test("first provider dialog rejects cancel Escape backdrop and close dismissal", async (context) => {
  const harness = connectedNativeProviderHarness({ onboarding: null });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = harness.findPanel("codex-first-connection-setup");
  const event = (key = null, target = null) => ({
    key,
    target,
    prevented: false,
    preventDefault() { this.prevented = true; },
  });
  const cancel = event();
  dialog.listeners.get("cancel")(cancel);
  assert.equal(cancel.prevented, true);
  const escape = event("Escape");
  dialog.listeners.get("keydown")(escape);
  assert.equal(escape.prevented, true);
  const backdrop = event(null, dialog);
  dialog.listeners.get("pointerdown")(backdrop);
  assert.equal(backdrop.prevented, true);
  dialog.close();
  dialog.listeners.get("close")();
  assert.equal(dialog.open, true);
  assert.equal(harness.findPanel("codex-first-connection-skip"), null);
});
```

Change the two existing successful Vertex onboarding tests to use `moonshot-kimi` with a catalog model for that provider. Keep a separate Vertex no-call test above.
In `successful onboarding restores the active bot and never creates one`, pass `focusBeforeMount: true` to `createMountedUiHarness` and add `assert.equal(harness.documentRef.activeElement, harness.focusAnchor)` after the authoritative receipt closes the dialog.

- [ ] **Step 2: Run the state tests and verify RED**

```bash
node --test --test-name-pattern='Vertex is selectable|failed selected route|rejects cancel Escape' macos/test/bot-runtime-ui.test.cjs
```

Expected: FAIL because the current selected panel is not rebuilt from authority state and Vertex still produces `{ providerId: "google-vertex-ai" }`.

- [ ] **Step 3: Build exactly one selected details panel**

`buildProviderDetails(surface, connection)` must reuse `surface.details` as the one panel, clear its children, and use this exact control construction:

```js
function buildProviderDetails(surface, connection) {
  const providerId = connection.providerId;
  const label = connection.label;
  const kind = connection.loginKind;
  const panel = surface.details;
  panel.dataset.providerId = providerId;
  const heading = element(documentRef, "h3", "codex-provider-details-title", label);
  heading.id = `codex-${surface.key}-${providerId}-details-title`;
  panel.setAttribute("aria-labelledby", heading.id);
  const status = element(documentRef, "p", "codex-provider-details-status", "Not connected");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = element(documentRef, "p", "codex-provider-connection-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const form = element(documentRef, "div", "codex-provider-connection-form");
  const inputs = Object.create(null);
  if (kind === "account") {
    const mode = element(documentRef, "select", "codex-provider-auth-mode");
    mode.setAttribute("aria-label", `${label} sign-in method`);
    for (const [value, text] of [["browser", "Browser"], ["device-code", "Device"]]) {
      const option = element(documentRef, "option", "", text);
      option.value = value;
      mode.append(option);
    }
    inputs.authMode = mode;
    form.append(mode);
  } else if (kind === "api-key") {
    const apiKey = element(documentRef, "input", "codex-provider-api-key");
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.placeholder = "API key";
    apiKey.setAttribute("aria-label", `${label} API key`);
    inputs.apiKey = apiKey;
    form.append(apiKey);
  } else if (kind === "local") {
    const baseUrl = element(documentRef, "input", "codex-provider-base-url");
    baseUrl.type = "url";
    baseUrl.value = "http://127.0.0.1:11434/v1";
    baseUrl.setAttribute("aria-label", `${label} base URL`);
    const apiKey = element(documentRef, "input", "codex-provider-api-key");
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.placeholder = "Optional API key";
    apiKey.setAttribute("aria-label", `${label} API key`);
    inputs.baseUrl = baseUrl;
    inputs.apiKey = apiKey;
    form.append(baseUrl, apiKey);
  }
  if (providerId === "google-vertex-ai") {
    form.append(element(documentRef, "p", "codex-provider-unavailable-copy", VERTEX_UNAVAILABLE_COPY));
  }
  const action = element(documentRef, "button", "codex-provider-connect", `Connect ${label}`);
  action.type = "button";
  action.dataset.providerId = providerId;
  action.addEventListener("click", () => { void providerAction(providerId, surface.first); });
  const disconnect = element(documentRef, "button", "codex-provider-disconnect", `Disconnect ${label}`);
  disconnect.type = "button";
  disconnect.dataset.providerId = providerId;
  disconnect.hidden = surface.first;
  disconnect.addEventListener("click", () => { void disconnectProvider(providerId); });
  const actions = element(documentRef, "div", "codex-provider-connection-actions");
  actions.append(action, disconnect);
  panel.replaceChildren(heading, status, error, form, actions, surface.loginPrompt.prompt);
  return {
    panel,
    heading,
    status,
    error,
    form,
    inputs,
    action,
    disconnect,
    firstControl: inputs.authMode ?? inputs.baseUrl ?? inputs.apiKey ?? action,
    providerId,
    first: surface.first,
  };
}
```

Retain the panel's existing `id = codex-${surface.key}-provider-details` and `role="region"`. `updateProviderDetails()` sets its `aria-busy` from the selected provider operation. Do not create a nested second `.codex-provider-details` element. The default action text names the route:

- OpenAI Codex: `Connect OpenAI Codex`
- Anthropic Claude: `Connect Anthropic Claude`
- Google Antigravity: `Connect Google Antigravity`
- Moonshot Kimi: `Connect Moonshot Kimi`
- xAI: `Connect xAI`
- Google Vertex AI: `Connect Google Vertex AI` (disabled)
- OpenAI API key: `Connect OpenAI API key`
- Local models: `Connect Local models`

Preserve `Finish setup` and `Continue with ${connection.label}` for the two existing onboarding recovery states. Settings supplies `Disconnect ${connection.label}` only for the selected connected provider.

For Vertex, append `VERTEX_UNAVAILABLE_COPY`, set `action.disabled = true`, and remove the `google-vertex-ai` branch from `requestForProvider()` so a future accidental action cannot send an incomplete request.

- [ ] **Step 4: Project card state and selected detail state without changing authority**

Replace `updateProviderRow()`/`renderProviderRows()` with:

```js
function renderProviderCard(surface, card, connection) {
  const operation = providerOperations.get(connection.providerId);
  const pending = providerPending.has(connection.providerId);
  const stateText = operation?.kind === "disconnect" ? "Disconnecting…"
    : pending ? "Connecting…"
      : connection.state === "connected" ? "Connected"
        : connection.state === "connecting" ? "Connecting…"
          : connection.providerId === "google-vertex-ai" ? "Unavailable"
            : connection.state === "unavailable" ? "Retry available" : "Not connected";
  card.state.textContent = stateText;
  card.state.dataset.state = connection.state;
  card.button.dataset.state = connection.state;
  card.title.textContent = connection.label;
}

function renderProviderSurface(surface) {
  for (const providerId of PROVIDER_IDS) {
    renderProviderCard(surface, surface.cards.get(providerId), providerConnection(providerId));
  }
  const connection = providerConnection(surface.selectedProviderId);
  const previous = surface.detail;
  if (!previous || previous.providerId !== connection.providerId) {
    surface.detail = buildProviderDetails(surface, connection);
  }
  updateProviderDetails(surface, surface.detail, connection);
}
```

Use this exact selected-detail projection:

```js
function updateProviderDetails(surface, entry, connection) {
  const pending = providerPending.has(connection.providerId);
  const operation = providerOperations.get(connection.providerId);
  const disconnecting = pending && operation?.kind === "disconnect";
  const connected = connection.state === "connected";
  const externallyConnecting = connection.state === "connecting";
  const disconnectPending = connection.providerId === "openai-codex"
    && connection.state === "unavailable"
    && connection.errorCode === "OPENBOT_PROVIDER_DISCONNECT_PENDING";
  const receiptRetry = surface.first && providerReceiptRetry.has(connection.providerId);
  const legacyConfirmation = surface.first && connected && !receiptRetry
    && providerOnboarding === null
    && providerCatalog.models.some((model) => model.provider === connection.providerId);
  const vertexUnavailable = connection.providerId === "google-vertex-ai";
  const stateText = disconnecting ? "Disconnecting…" : pending ? "Connecting…"
    : connected ? "Connected"
      : externallyConnecting ? "Connecting…"
        : vertexUnavailable ? "Unavailable"
          : connection.state === "unavailable" ? "Retry available" : "Not connected";
  entry.status.textContent = stateText;
  entry.status.dataset.state = connection.state;
  entry.panel.setAttribute("aria-busy", String(pending));
  entry.action.disabled = providerFacadeInvalid || pending || vertexUnavailable
    || disconnectPending || externallyConnecting
    || (surface.first && providerAuthorityRetryable)
    || (connected && !receiptRetry && !legacyConfirmation);
  entry.disconnect.disabled = pending;
  entry.disconnect.hidden = surface.first || (!connected && !disconnectPending);
  entry.disconnect.textContent = disconnectPending
    ? `Retry disconnect ${connection.label}` : `Disconnect ${connection.label}`;
  if (!pending && connection.state === "unavailable" && connection.errorCode && !vertexUnavailable) {
    entry.error.textContent = providerErrorCopy(connection.providerId, { code: connection.errorCode });
    entry.error.hidden = false;
  }
  entry.action.textContent = receiptRetry ? "Finish setup"
    : legacyConfirmation ? `Continue with ${connection.label}`
      : connected ? "Connected"
        : connection.state === "unavailable" && !vertexUnavailable ? `Retry ${connection.label}`
          : `Connect ${connection.label}`;
  const lockSelection = pending && surface.selectedProviderId === connection.providerId;
  for (const card of surface.cards.values()) card.button.disabled = lockSelection;
}
```

At the start of `providerAction()`, replace the old row-map lookup with:

```js
const surface = first ? providerSurfaces.first : providerSurfaces.settings;
const entry = surface.detail;
if (!entry || entry.providerId !== providerId
  || surface.selectedProviderId !== providerId
  || entry.action.disabled
  || typeof providerFacade.connect !== "function") return;
```

Keep the remaining receipt/authority ordering unchanged.

- [ ] **Step 5: Move device code into each selected detail and preserve operation fencing**

Replace `renderProviderLoginPrompt()` with:

```js
function renderProviderLoginPrompt() {
  const operation = providerLoginPrompt?.operation;
  const operationVisible = Boolean(
    providerLoginPrompt
    && operation
    && providerOperations.get("openai-codex") === operation
    && !mountDisposed,
  );
  for (const surface of Object.values(providerSurfaces)) {
    const visible = operationVisible && surface.selectedProviderId === "openai-codex";
    surface.loginPrompt.code.textContent = visible ? providerLoginPrompt.prompt.userCode : "";
    surface.loginPrompt.prompt.hidden = !visible;
  }
}
```

It must not clone the code into hidden provider forms because no hidden forms exist.

While an operation is pending, set `detail.panel aria-busy="true"`, disable the selected action and disconnect, and disable that surface's other choice buttons so the selected route remains stable. Do not disable the other surface's projection or prevent the existing provider-operation map from fencing concurrent provider IDs.

- [ ] **Step 6: Restore focus after success and prevent every modal dismissal path**

Track `providerGateReturnFocus` when the first dialog transitions closed -> open. On open, focus the selected OpenAI card. On successful authoritative receipt closure, close the dialog and focus `providerGateReturnFocus` if it is still connected; otherwise focus the first focusable native shell element.

Keep the existing `cancel` and Escape handlers. Add:

```js
firstConnectionSetup.addEventListener("pointerdown", (event) => {
  if (event.target === firstConnectionSetup) event.preventDefault?.();
});
firstConnectionSetup.addEventListener("close", () => {
  if (providerOnboarding === null && !mountDisposed) {
    setDialogOpen(firstConnectionSetup, true);
  }
});
```

No `form method="dialog"`, close button, or Skip control is allowed.

- [ ] **Step 7: Run focused state and race suites**

```bash
node --test --test-name-pattern='provider|onboarding|connection|authority|receipt|Vertex|Direct Codex' macos/test/bot-runtime-ui.test.cjs
```

Expected: all matching tests PASS, including the existing lower-generation, mixed snapshot, post-commit receipt, event storm, cancellation, disposal, and concurrent operation regressions.

- [ ] **Step 8: Commit the authority projection**

```bash
git add macos/src/renderer/bot-runtime-ui.js macos/test/bot-runtime-ui.test.cjs
git commit -m "feat(macOS): project provider authority into Sand picker"
```

---

### Task 3: Sand-compatible styling, responsive structure, and motion/accessibility proof

**Assigned worker:** Fresh Luna-max implementation worker after Task 2 review.

**Files:**
- Modify: `macos/src/renderer/codex-ui.css:1-42, 159-309, 458-545, 1398-1435`
- Modify: `macos/test/bot-runtime-ui.test.cjs`

**Interfaces:**
- Consumes the Task 1/2 classes: `.codex-provider-picker`, `.codex-provider-choice-list`, `.codex-provider-choice`, `.codex-provider-choice-button`, `.codex-provider-choice-mark`, `.codex-provider-choice-copy`, `.codex-provider-choice-label`, `.codex-provider-choice-description`, `.codex-provider-choice-state`, `.codex-provider-recommended`, `.codex-provider-details`, `.codex-provider-connection-form`, and `.codex-provider-connection-actions`.
- Produces no JavaScript API and no new asset.

- [ ] **Step 1: Add failing CSS contract tests**

Read the CSS in `macos/test/bot-runtime-ui.test.cjs` using:

```js
const fs = require("node:fs");
const cssPath = path.join(__dirname, "..", "src", "renderer", "codex-ui.css");
```

Add:

```js
test("provider picker uses Sand aliases two-column cards narrow reflow and reduced motion", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  for (const token of [
    "--codex-sand-text-primary", "--codex-sand-text-secondary",
    "--codex-sand-fill-secondary", "--codex-sand-fill-secondary-hover",
    "--codex-sand-border-subtle", "--codex-sand-border-default", "--codex-sand-border-focus",
  ]) assert.match(css, new RegExp(token));
  assert.match(css, /\.codex-provider-choice-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*gap:\s*12px/s);
  assert.match(css, /@media\s*\(max-width:\s*619px\)[\s\S]*\.codex-provider-choice-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.codex-provider-choice-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--codex-sand-border-focus\)/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-provider-choice-button[^}]*transition:\s*none/s);
  assert.doesNotMatch(css, /\.codex-provider-(?:choice|details)[^}]*box-shadow:\s*0 0 [^;}]*(?:blue|purple|#2383ff)/is);
});
```

- [ ] **Step 2: Run CSS test and verify RED**

```bash
node --test --test-name-pattern='provider picker uses Sand aliases' macos/test/bot-runtime-ui.test.cjs
```

Expected: FAIL because the semantic aliases and responsive card rules do not exist.

- [ ] **Step 3: Add fixture-safe Sand aliases**

Append these variables to both the dark `:root` block and the existing explicit light/media-light blocks using the same declarations (the upstream Sand variables resolve first in the real app; the `--codex-*` values are fixture fallbacks):

```css
--codex-sand-text-primary: var(--sand-text-primary, var(--codex-text));
--codex-sand-text-secondary: var(--sand-text-secondary, var(--codex-muted));
--codex-sand-text-tertiary: var(--sand-text-tertiary, var(--codex-field));
--codex-sand-fill-secondary: var(--sand-bg-secondary, var(--codex-input));
--codex-sand-fill-secondary-hover: var(--sand-bg-secondary-hover, var(--codex-input-hover));
--codex-sand-border-subtle: var(--sand-border-subtle, color-mix(in srgb, var(--codex-border) 72%, transparent));
--codex-sand-border-default: var(--sand-border-default, var(--codex-border));
--codex-sand-border-focus: var(--sand-border-focus, var(--codex-blue));
```

- [ ] **Step 4: Replace row styling with exact compact anatomy**

Use this structure as the implementation baseline:

```css
.codex-provider-picker { display: grid; gap: 16px; min-width: 0; }
.codex-provider-choice-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.codex-provider-choice { min-width: 0; }
.codex-provider-choice-button {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 12px;
  width: 100%;
  min-height: 76px;
  padding: 12px;
  color: var(--codex-sand-text-primary);
  text-align: left;
  border: 1px solid var(--codex-sand-border-subtle);
  border-radius: 10px;
  background: var(--codex-sand-fill-secondary);
  transition: background-color 120ms ease, border-color 120ms ease;
}
.codex-provider-choice-button:hover { background: var(--codex-sand-fill-secondary-hover); }
.codex-provider-choice-button[aria-pressed="true"] {
  border-color: var(--codex-sand-border-default);
  box-shadow: inset 0 0 0 1px var(--codex-sand-border-default);
}
.codex-provider-choice-button:focus-visible {
  outline: 2px solid var(--codex-sand-border-focus);
  outline-offset: 2px;
}
.codex-provider-choice-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  color: var(--codex-sand-text-secondary);
  border: 1px solid var(--codex-sand-border-subtle);
  border-radius: 9px;
  font: 650 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.codex-provider-choice-copy { display: grid; gap: 4px; min-width: 0; }
.codex-provider-choice-label { font-size: 13px; line-height: 16px; }
.codex-provider-choice-description,
.codex-provider-choice-state { color: var(--codex-sand-text-secondary); font-size: 11px; line-height: 14px; }
.codex-provider-recommended { color: var(--codex-blue-strong); font-size: 10px; line-height: 12px; }
.codex-provider-details {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--codex-sand-border-subtle);
  border-radius: 12px;
  background: var(--codex-sand-fill-secondary);
}
```

The first dialog width is `min(720px, calc(100vw - 32px))`. Wrap title/copy in `.codex-provider-picker-header` with `position: sticky; top: 0; z-index: 1; padding-bottom: 12px; background: var(--codex-advanced)`. Put the picker, global error/status, and retry inside `.codex-provider-picker-scroll` with `overflow: auto; overscroll-behavior: contain` so the header stays fixed.

At `@media (max-width: 619px)`, set the dialog width to `calc(100vw - 24px)`, the list to `grid-template-columns: minmax(0, 1fr)`, card minimum height to 68px, and details padding to 12px. No horizontal scrolling.

- [ ] **Step 5: Add reduced-motion and state-text rules**

Inside the existing reduced-motion media block add:

```css
.codex-provider-choice-button,
.codex-provider-details { transition: none !important; animation: none !important; }
```

State selectors may change borders/text but must not hide `.codex-provider-choice-state`. Pending progress uses `aria-busy` and visible `Connecting…`; no spinner is required.

- [ ] **Step 6: Run provider and full renderer UI tests**

```bash
node --test --test-name-pattern='provider picker uses Sand aliases|provider|onboarding|connection|authority|receipt|Vertex' macos/test/bot-runtime-ui.test.cjs
node --test macos/test/bot-runtime-ui.test.cjs
```

Expected: both commands PASS.

- [ ] **Step 7: Commit the Sand presentation**

```bash
git add macos/src/renderer/codex-ui.css macos/test/bot-runtime-ui.test.cjs
git commit -m "style(macOS): fit provider setup to Grok Sand UI"
```

---

### Task 4: Luna-max provider review gate

**Assigned worker:** Independent Luna-max test/review worker. Read the actual diff, not the implementation summary.

**Files:**
- Review only: the three provider-owned files
- Modify only if the parent explicitly assigns a concrete finding back to a fresh implementation worker

**Interfaces:**
- Consumes commits from Tasks 1-3.
- Produces an APPROVE/REVISE report with exact file/line evidence and test output.

- [ ] **Step 1: Inspect ownership and diff**

```bash
git diff f56a014..HEAD -- macos/src/renderer/bot-runtime-ui.js macos/src/renderer/codex-ui.css macos/test/bot-runtime-ui.test.cjs
git diff --check f56a014..HEAD
```

Reject any provider/runtime/controller/preload/Computer/conversation file change in this lane.

- [ ] **Step 2: Audit the state machine invariants**

Confirm from source that card selection has no facade call; Vertex cannot call `connect`; successful onboarding requires exact returned-vs-reread receipt equality; post-commit snapshot failure does not create `Finish setup`; late stale events cannot reopen the gate; API secrets clear; no localStorage or bot creation was added; and modal `cancel`, Escape, backdrop, and close paths remain blocked.

- [ ] **Step 3: Run focused and adjacent tests**

```bash
node --test macos/test/bot-runtime-ui.test.cjs macos/test/provider-controller.test.cjs macos/test/provider-state-store.test.cjs macos/test/desktop-runtime.test.cjs
npm --prefix macos run check
git diff --check
```

Expected: all tests PASS, source check passes, diff check is empty.

- [ ] **Step 4: Report the review gate**

APPROVE only if the implementation has eight canonical cards, one selected/detail panel per surface, truthful Vertex, full keyboard/focus semantics, preserved race/receipt tests, responsive/reduced-motion CSS, and no ownership leak. Otherwise report each Important/Critical finding with a reproducing command and exact line.

---

## Plan Self-review Record

- Spec coverage: Task 1 covers canonical order, compact cards, progressive disclosure, keyboard selection, initial selection, and native-flow preservation. Task 2 covers every provider state, truthful Vertex, secret handling, modal blocking, focus restoration, authoritative receipt ordering, stale/race behavior, Settings reuse, and no bot creation. Task 3 covers Sand tokens, spacing, wide/narrow, light/dark, focus visibility, and Reduced Motion. Task 4 and final integration cover source, package, install, live UI, A/B, and release-boundary review.
- Placeholder scan: no TBD, TODO, deferred implementation phrase, unnamed validation step, or unspecified test remains. Every product-code step includes exact names/content; every RED/GREEN step names an exact command and expected result.
- Type consistency: both surfaces use `selectedProviderId`, `cards`, `details`, `detail`, and `loginPrompt`; cards use the same seven fields in construction/rendering; the disclosed detail object consistently uses `panel`, `heading`, `status`, `error`, `form`, `inputs`, `action`, `disconnect`, `firstControl`, `providerId`, and `first`; existing facade and action signatures stay unchanged.
- Ownership check: provider tasks touch only the three locked provider files, and provider CSS tests remain out of the identity-owned renderer patch test.

---

## Final Sol Integration and Installed Visual Acceptance

The final Sol-high/xhigh integrator runs only after this plan and the animated-identity plan both pass their Luna reviews. The integrator owns conflict resolution, full-suite reruns, build/package/install, and visual acceptance; implementation workers do not build or install.

Required source/package commands:

```bash
node --test macos/test/bot-runtime-ui.test.cjs macos/test/provider-controller.test.cjs macos/test/provider-state-store.test.cjs macos/test/renderer-integration.test.cjs macos/test/patch-app.test.cjs
npm --prefix macos test
npm --prefix macos run check
swift test --package-path macos/installer
git diff --check
```

After building from the final commit, replace the canonical installed app, prove its ASAR hash matches the build, launch that exact executable, and record:

- wide (at least 720px) and narrow (at most 619px) first-provider dialog;
- light and dark appearance;
- pointer selection and visible keyboard focus;
- selected, connecting, connected, unavailable Vertex, transient error, retry, device-code, and stale-authority states;
- absence of Skip/dismissal and absence of bot creation on onboarding completion;
- Settings reuse of the same card/detail anatomy;
- two complete reduced-motion checks with transitions disabled;
- independent blind A/B review against `/Applications/Grok Bot original 20260811.app` for typography, spacing, surfaces, focus, buttons, and visual fit.

The integrator records the final source commit, pushed branch, test outputs, package hashes, installed ASAR hash, running executable, screenshots, recordings, review result, and unchanged external remote-provider/notarization boundaries.
