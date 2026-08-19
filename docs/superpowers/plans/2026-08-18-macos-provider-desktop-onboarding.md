# macOS Provider, Desktop, Onboarding, and Compact Power Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the preserved Grok 0.20 macOS shell all eight documented AI routes, a durable first-connection gate, truthful per-provider model routing, a live and retryable Free Local Desktop first frame, and a content-hugging simple Power panel.

**Architecture:** One platform-neutral descriptor catalog defines provider and model semantics; a macOS main-process controller owns authorization, connection receipts, sanitized catalogs, onboarding, and secret access. Existing model/runtime/native-coordinator paths consume canonical provider/model identities without fallback, while the preserved renderer receives narrow DTOs through preload. Free Local Desktop gains one exact manager-owned start document and a generation-scoped frame/status stream; the existing measured Power transition stays intact while the simple panel's forced spacer is removed.

**Tech Stack:** Node.js 22.13+, CommonJS, Electron main/preload/renderer boundaries, macOS Keychain through `/usr/bin/security`, bundled integrity-checked CLIProxyAPI 7.2.132, official Codex 0.147.0 app-server, `node:test`, Swift installer, Developer ID signing/notarization.

**Spec:** `docs/superpowers/specs/2026-08-18-macos-provider-desktop-onboarding-design.md`

## Global Constraints

- The source-of-truth UI is `/Applications/Grok Bot original 20260811.app`; preserve its `New` → recipient picker → `Create new Bot` → `Meet a future teammate` → template or `Create your own` flow.
- The acceptance app is the exact reviewed commit installed at `/Users/harlin/Applications/OpenBot.app`; source tests do not substitute for installed interaction proof.
- The eight routes are OpenAI Codex, Anthropic Claude, Google Antigravity, Moonshot Kimi, xAI, Google Vertex AI, OpenAI API key, and a literal-loopback OpenAI-compatible server.
- The local route accepts exactly `http://127.0.0.1:<port>` and normalizes it to `/v1`; `localhost`, IPv6 loopback, DNS aliases, redirects, and other hosts remain rejected.
- Provider connection, per-bot model selection, and per-bot Computer selection are separate authorities.
- Model identity is the exact pair `[providerId, modelId]`; display labels are never storage keys.
- General Settings always lists all eight routes; the composer lists models only from connected routes with an authoritative sanitized catalog.
- A disconnected or malformed route never falls back to Codex, Claude, another model, or another Computer.
- Computer controls remain in View Bot settings and remain absent from the Power popover.
- The compact model trigger stays inside the native composer action row immediately before send or voice.
- The simple Power panel contains the slider, a divider, and the 36-pixel Advanced/Fast footer with content-driven height; Advanced keeps its independently measured height.
- Opening OpenBot alone must not start login, read a Keychain secret, or trigger a password prompt. Keychain access is allowed only after explicit connect, disconnect, or inference actions.
- Renderer DTOs contain bounded plain data only: no tokens, keys, credential-bearing URLs, private paths, raw CLI output, accessors, proxies, cycles, or custom prototypes.
- Provider children, imports, captures, timers, subscriptions, and native creation remain fenced by disposal, bot identity, target generation, view generation, and sender frame after every await.
- Preserve exact Promise coalescing, including synchronous reentrancy, for duplicate provider connect/disconnect, frame select/retry, and disposal operations.
- Remote Computer remains truthfully unavailable unless its separately authorized provider exists; this plan does not implement or imitate it.
- Keep bundle identity `com.limonlimez.openbot`, product version `0.2.0-macos.1`, macOS minimum `13.0`, Node minimum `22.13.0`, and Apple Silicon packaging.
- Task 11 is development-candidate acceptance against the verified read-only Grok source app. It does not complete or claim the separate self-contained public-installer, payload-signing, notarization, or stapling gate.

## Locked Decisions and Public Contracts

The approved spec leaves canonical spelling and the built-in Desktop URI representation open. Lock them here so storage, IPC, tests, and worker ownership agree:

```js
const PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "anthropic-claude",
  "google-antigravity",
  "moonshot-kimi",
  "xai",
  "google-vertex-ai",
  "openai-api-key",
  "local-openai-compatible",
]);

const LEGACY_PROVIDER_IDS = Object.freeze({
  "cliproxy-anthropic": "anthropic-claude",
  codex: "openai-codex",
  claude: "anthropic-claude",
  antigravity: "google-antigravity",
  kimi: "moonshot-kimi",
  vertex: "google-vertex-ai",
  local: "local-openai-compatible",
});
```

The Windows implementation keeps its existing UI/action aliases through `windowsProviderId`; only persisted/shared identity uses `providerId`. macOS migrates `openai-codex` byte-stably and rewrites `cliproxy-anthropic` to `anthropic-claude` on the next atomic model-store mutation.

```js
// Renderer-to-main connect request union.
// No extra properties are accepted.
{ providerId: "openai-codex", authMode: "browser" | "device-code" }
{ providerId: "anthropic-claude" | "google-antigravity" | "moonshot-kimi" | "xai" }
{ providerId: "google-vertex-ai" } // main process opens the file picker
{ providerId: "openai-api-key", apiKey: string }
{ providerId: "local-openai-compatible", baseUrl: string, apiKey: string | null }

// Public connection DTO.
{
  providerId: string,
  label: string,
  loginKind: "account" | "oauth" | "device" | "service-account" | "api-key" | "local",
  state: "disconnected" | "connecting" | "connected" | "unavailable",
  generation: number,
  capabilities: { reasoning: boolean, fast: boolean },
  errorCode: string | null,
}

// Sanitized catalog DTO. `models` contains connected routes only.
{ generation: number, status: "ready" | "unavailable", models: ReadonlyArray<{
  provider: string, providerLabel: string, model: string, label: string,
  efforts: ReadonlyArray<string>, serviceTiers: ReadonlyArray<{ id: string, name: string }>,
  defaultReasoningEffort: string, defaultServiceTier: string | null,
  catalogGeneration: number, isDefault: boolean,
}> }

// Durable receipt contains no secret and is valid only for the same connection generation.
{ schemaVersion: 1, providerId: string, connectionGeneration: number, completedAt: string }
```

The exact built-in Local Desktop document is a manager-owned `data:text/html;base64,...` constant derived from fixed source bytes. The URL validator accepts only equality with that one constant or an existing validated public HTTPS URL. It does not create a general `data:` exception.

Provider startup uses only the sanitized durable connection/catalog generations written by the last successful explicit connection. It does not re-read Direct Codex auth or Keychain secrets merely to paint Settings/model UI. An explicit inference action revalidates the exact connection generation and current transport health before sending; a failed revalidation marks that route unavailable and never selects another provider.

```js
const LOCAL_DESKTOP_START_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"><title>OpenBot Free Local Desktop</title></head><body><main><h1>Free Local Desktop</h1><p>Ready for this bot.</p></main></body></html>";
const LOCAL_DESKTOP_START_URL = `data:text/html;base64,${Buffer.from(LOCAL_DESKTOP_START_HTML, "utf8").toString("base64")}`;

// Frame-status DTO; sender-frame identity stays main-process private.
{
  botId: string,
  targetId: string,
  targetGeneration: number,
  viewGeneration: number,
  state: "connecting" | "live" | "unavailable" | "retrying",
  code: null | "OPENBOT_LOCAL_CAPTURE_FAILED" | "OPENBOT_LOCAL_DESKTOP_STALE",
}
```

## File Map, Worker Ownership, and Dependency Order

| Worker | Exclusive writable ownership | Deliverable |
|---|---|---|
| Luna-max Catalog | `src/provider-descriptors.cjs`, `macos/src/provider-descriptors.cjs`, `src/codex-connection.cjs`, root provider tests | shared eight-route semantics and legacy aliases |
| Luna-max Provider | new macOS provider/keychain/state/local-client modules, `macos/src/desktop/cliproxy-manager.cjs`, their tests | six-method provider controller and explicit secret/auth flows |
| Luna-max Routing | `macos/src/desktop/runtime.cjs`, model store/router/transports/bridge config, native coordinator, their tests | canonical selection, exact transport routing, native creation gate |
| Luna-max Renderer | `macos/src/renderer/bot-runtime-ui.js`, `model-controls.js`, `reasoning-control.js` if needed, `codex-ui.css`, `macos/src/patch/renderer.cjs`, renderer tests | durable chooser/Settings UI, native-flow preservation, compact Power |
| Luna-max Desktop | Local Desktop manager/frame IPC/view/CSS and their tests | exact start document, awaited first frame, status/retry lifecycle |
| Luna-max Package | `macos/src/patch/desktop.cjs`, `macos/scripts/patch-app.cjs`, package/installer closure tests | exact preload facade and packaged source closure |

Task 1 is first. Tasks 2 and 6 may then run in parallel because they share no files. Task 3 consumes Task 1 and Task 2. Task 4 consumes Tasks 1–3. Task 5 is the second sequential change by the same Renderer worker. Task 7 consumes Tasks 2–6 and is the only owner of package/preload files. Reviewer Gates 8 and 9 run after their named clusters. Task 10 is the only combined-diff integrator. Task 11 starts only after Task 10 is green.

---

### Task 1: Extract the Shared Eight-Route Descriptor Catalog

**Owner:** Luna-max Catalog worker

**Files:**
- Create: `src/provider-descriptors.cjs`
- Create: `macos/src/provider-descriptors.cjs`
- Create: `tests/provider-descriptors.test.cjs`
- Modify: `src/codex-connection.cjs:17-230` (`MODEL_CATALOG`, `CLIPROXY_PROVIDERS`, `LOCAL_PROVIDER`, provider lookup)
- Modify: `tests/provider-selection.test.cjs:76-153`
- Modify: `tests/local-model-provider.test.cjs:60-205`

**Interfaces:**
- Produces: `PROVIDER_IDS`, `PROVIDER_DESCRIPTORS`, `canonicalProviderId(value)`, `providerDescriptor(value)`, `tryProviderDescriptor(value)`, `providerModelIdentity(providerId, modelId)`.
- Produces descriptor shape `{ providerId, windowsProviderId, label, description, loginKind, loginFlag, authType, authFilePattern, defaultModel, reasoningEfforts, fastModeSupported, models }`.
- `macos/src/provider-descriptors.cjs` is a source-tree adapter only: `module.exports = require("../../src/provider-descriptors.cjs")`. Packaging copies the authoritative root file to `dist/codex/provider-descriptors.cjs`, where macOS `require("../provider-descriptors.cjs")` resolves without the adapter.

- [ ] **Step 1: Write the shared-catalog RED test**

```js
test("shared descriptors expose the exact eight-route semantic matrix", () => {
  assert.deepEqual(PROVIDER_DESCRIPTORS.map(({ providerId }) => providerId), PROVIDER_IDS);
  assert.deepEqual(PROVIDER_DESCRIPTORS.map(({ loginKind }) => loginKind), [
    "account", "oauth", "oauth", "device", "device", "service-account", "api-key", "local",
  ]);
  assert.equal(new Set(PROVIDER_IDS).size, 8);
  assert.equal(providerDescriptor("anthropic-claude").loginFlag, "-claude-login");
  assert.equal(providerDescriptor("google-antigravity").loginFlag, "-antigravity-login");
  assert.equal(providerDescriptor("moonshot-kimi").loginFlag, "-kimi-login");
  assert.equal(providerDescriptor("xai").loginFlag, "-xai-login");
  assert.equal(providerDescriptor("google-vertex-ai").loginFlag, "-vertex-import");
  assert.equal(canonicalProviderId("cliproxy-anthropic"), "anthropic-claude");
  assert.equal(providerModelIdentity("openai-codex", "shared-name"), '["openai-codex","shared-name"]');
  assert.equal(providerModelIdentity("anthropic-claude", "shared-name"), '["anthropic-claude","shared-name"]');
});
```

- [ ] **Step 2: Run the focused RED**

Run: `node --test tests/provider-descriptors.test.cjs`

Expected: FAIL with `Cannot find module '../src/provider-descriptors.cjs'`.

- [ ] **Step 3: Move semantic constants into the shared module**

```js
function canonicalProviderId(value) {
  if (typeof value !== "string") throw new TypeError("Provider ID is invalid.");
  const providerId = LEGACY_PROVIDER_IDS[value] ?? value;
  if (!PROVIDER_BY_ID.has(providerId)) throw new TypeError("Provider ID is invalid.");
  return providerId;
}

function providerModelIdentity(providerId, modelId) {
  const canonical = canonicalProviderId(providerId);
  if (typeof modelId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(modelId)) {
    throw new TypeError("Model ID is invalid.");
  }
  return JSON.stringify([canonical, modelId]);
}
```

Freeze every nested descriptor/model/effort array. Copy the exact existing model labels, login flags, auth types, auth-file patterns, reasoning lists, and Fast flags from `src/codex-connection.cjs:17-226`; add explicit OpenAI API-key and local descriptors. Do not move DPAPI, PowerShell, credential paths, or platform process code.

- [ ] **Step 4: Adapt Windows lookup without changing its credential implementation**

Replace the duplicated matrix in `src/codex-connection.cjs` with imports and a `windowsProviderId` lookup. Preserve current public actions (`codex`, `claude`, `antigravity`, `kimi`, `xai`, `vertex`, `local`, `openai-api-key`) and the current Windows state migration while persisting canonical `providerId` on the next write.

- [ ] **Step 5: Run focused GREEN tests**

Run: `node --test tests/provider-descriptors.test.cjs tests/provider-selection.test.cjs tests/local-model-provider.test.cjs tests/model-preferences.test.cjs`

Expected: PASS; provider UI aliases remain compatible and the shared semantic matrix is exact.

- [ ] **Step 6: Commit**

```bash
git add src/provider-descriptors.cjs macos/src/provider-descriptors.cjs src/codex-connection.cjs \
  tests/provider-descriptors.test.cjs tests/provider-selection.test.cjs \
  tests/local-model-provider.test.cjs tests/model-preferences.test.cjs
git commit -m "refactor: share provider descriptors"
```

---

### Task 2: Build the macOS Provider Authority, Keychain Boundary, and Explicit Connect Flows

**Owner:** Luna-max Provider worker

**Files:**
- Create: `macos/src/desktop/keychain-secret-store.cjs`
- Create: `macos/src/desktop/provider-state-store.cjs`
- Create: `macos/src/desktop/openai-compatible-provider.cjs`
- Create: `macos/src/desktop/provider-controller.cjs`
- Create: `macos/test/keychain-secret-store.test.cjs`
- Create: `macos/test/provider-state-store.test.cjs`
- Create: `macos/test/openai-compatible-provider.test.cjs`
- Create: `macos/test/provider-controller.test.cjs`
- Modify: `macos/src/desktop/cliproxy-manager.cjs:10-14,122-357`
- Modify: `macos/test/cliproxy-manager.test.cjs:27-180`

**Interfaces:**
- Consumes Task 1: `providerDescriptor(providerId)` and canonical IDs.
- Produces exact public class methods: `listConnections()`, `connect(request)`, `disconnect(providerId)`, `catalog()`, `readOnboarding()`, `completeOnboarding(providerId)`.
- Produces events: `connections-changed` with frozen connection array and `catalog-changed` with frozen catalog DTO.
- Produces private `ProviderStateStore` methods `read()`, `commitConnection(value)`, `removeConnection(providerId)`, `writeOnboarding(receipt)`, `clearOnboardingFor(providerId)`.
- Produces `KeychainSecretStore({ service: "com.limonlimez.openbot.providers", spawn })` with `set(account, secret)`, `read(account)`, `delete(account)`; no list/read call occurs during construction or startup.
- Produces `OpenAICompatibleProvider.discover({ providerId, baseUrl, apiKey, signal })` and `.streamConfiguration(providerId)`; secret material remains non-enumerable. `openai-api-key` always uses `https://api.openai.com/v1`; `local-openai-compatible` requires the submitted literal-loopback `/v1` base URL.
- Extends CLIProxy manager with `connectProvider(providerId)`, `importVertex(sourcePath)`, `disconnectProvider(providerId)`, `listModels(providerId)`, `connectionStatus(providerId)`, and existing `start()/stop()`.

- [ ] **Step 1: Write Keychain and durable-state RED tests**

```js
test("startup state never invokes Keychain and explicit actions use one stable service", async () => {
  const calls = [];
  const secrets = new KeychainSecretStore({
    service: "com.limonlimez.openbot.providers",
    spawn: (...args) => fakeSecurityChild(calls, args),
  });
  assert.deepEqual(calls, []);
  await secrets.set("openai-api-key", "sk-private");
  assert.deepEqual(calls[0][1].slice(0, 4), ["add-generic-password", "-U", "-s", "com.limonlimez.openbot.providers"]);
  assert.doesNotMatch(JSON.stringify(calls), /sk-private/);
});

test("onboarding receipt is tied to an authoritative connection generation", async () => {
  await store.commitConnection({ providerId: "openai-codex", generation: 7, state: "connected", models: [model()] });
  await store.writeOnboarding({ schemaVersion: 1, providerId: "openai-codex", connectionGeneration: 7, completedAt: NOW });
  assert.equal((await store.read()).onboarding.connectionGeneration, 7);
  await store.removeConnection("openai-codex");
  assert.equal((await store.read()).onboarding, null);
});
```

- [ ] **Step 2: Run storage RED**

Run: `cd macos && node --test test/keychain-secret-store.test.cjs test/provider-state-store.test.cjs`

Expected: FAIL with module-not-found for both new modules.

- [ ] **Step 3: Implement atomic sanitized state and explicit-only Keychain commands**

Use the `ModelSelectionStore` atomic pattern: real file, private `0700` directory, exclusive `0600` temporary file, fsync, rename, exact schema, serialized queue. Keychain arguments are fixed and secrets enter `/usr/bin/security` through stdin, never argv or returned DTOs. `/usr/bin/security` documents that a final `-w` with no value prompts for password data; the adapter pipes the secret to that prompt and caps stderr:

```js
const child = this.#spawn("/usr/bin/security", [
  "add-generic-password", "-U", "-s", this.#service, "-a", account, "-w",
], { stdio: ["pipe", "ignore", "pipe"] });
child.stdin.end(secret, "utf8");
await settledSecurityChild(child, { timeoutMs: 10_000, maxStderrBytes: 16 * 1024 });
```

Reject accessors, proxies, extra fields, NUL/newline values, secrets above 16 KiB, and non-canonical provider accounts.

- [ ] **Step 4: Write local discovery RED tests**

```js
test("local discovery accepts only literal loopback and one bounded non-redirecting model response", async () => {
  const catalog = await provider.discover({
    providerId: "local-openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null,
  });
  assert.deepEqual(catalog.models.map(({ model }) => model), ["local-model"]);
  for (const baseUrl of [
    "http://localhost:11434/v1", "http://192.168.1.2/v1", "https://127.0.0.1/v1",
    "http://user:pass@127.0.0.1:11434/v1", "http://[::1]:11434/v1",
  ]) await assert.rejects(provider.discover({ providerId: "local-openai-compatible", baseUrl, apiKey: null }), /invalid|loopback/i);
  await assert.rejects(redirecting.discover({
    providerId: "local-openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null,
  }), /redirect/i);
});
```

Use `http.request` with `method: "GET"`, path `/v1/models`, `timeout: 5_000`, `maxBytes: 1_048_576`, `redirects: 0`, `Connection: close`, and literal `127.0.0.1` only. Reject IPv6, DNS names, duplicate/invalid IDs, and more than 200 models.

- [ ] **Step 5: Run local discovery RED**

Run: `cd macos && node --test test/openai-compatible-provider.test.cjs`

Expected: FAIL with module-not-found. The finished test also verifies OpenAI API-key discovery uses only `https://api.openai.com/v1/models`, rejects redirects, and commits no Keychain item before a successful bounded response.

- [ ] **Step 6: Expand CLIProxy commands, readiness, Vertex import, and disconnect**

```js
const CLIPROXY_PROVIDER_IDS = Object.freeze([
  "anthropic-claude", "google-antigravity", "moonshot-kimi", "xai", "google-vertex-ai",
]);

connectProvider(providerId) {
  const descriptor = providerDescriptor(providerId);
  if (!CLIPROXY_PROVIDER_IDS.includes(descriptor.providerId) || descriptor.loginKind === "service-account") {
    return Promise.reject(new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID"));
  }
  return this.#coalescedProviderOperation(providerId, () => this.#runLogin(descriptor.loginFlag));
}
```

Before each login/import, snapshot matching auth files; after child exit 0, wait at most 10 seconds for one new or changed exact matching regular file in the private auth directory. Vertex copies the chosen regular JSON file to a new `0600` file under the private run directory, calls `-vertex-import <temporary> -config <config>`, and removes the exact temporary in `finally` after child settlement. `disconnectProvider()` removes only auth files matching that descriptor after real-file/no-symlink validation. Process stderr is capped and passed only through fixed public error codes.

- [ ] **Step 7: Write provider-controller RED tests**

```js
test("controller lists eight routes but catalogs only authoritative connected providers", async () => {
  assert.deepEqual((await controller.listConnections()).map(({ providerId }) => providerId), PROVIDER_IDS);
  assert.deepEqual((await controller.catalog()).models, []);
  await controller.connect({ providerId: "anthropic-claude" });
  assert.equal((await controller.catalog()).models.every((model) => model.provider === "anthropic-claude"), true);
  assert.doesNotMatch(JSON.stringify(await controller.listConnections()), /token|key|Users|stderr|auth.*json/i);
});

test("cancelled connection cannot complete onboarding", async () => {
  await assert.rejects(controller.connect({ providerId: "moonshot-kimi" }), /cancelled|unavailable/i);
  await assert.rejects(controller.completeOnboarding("moonshot-kimi"), /ready|connected/i);
  assert.equal(await controller.readOnboarding(), null);
});
```

- [ ] **Step 8: Run provider-controller RED**

Run: `cd macos && node --test test/provider-controller.test.cjs test/cliproxy-manager.test.cjs`

Expected: FAIL because `provider-controller.cjs` does not exist and the current manager rejects the expanded descriptors.

- [ ] **Step 9: Implement the six-method provider controller**

`connect()` is descriptor-first and one-flight per provider. Direct Codex starts/refreshes `CodexAccountController` only inside this explicit method. Hosted routes require exact auth-file readiness plus a bounded sanitized model list. API-key and local routes verify `/v1/models` before committing encrypted secret/reference metadata. `completeOnboarding()` re-reads the committed connection and catalog generation immediately before atomic receipt write. Failures preserve the prior good connection, publish a stable error code, and never create a receipt.

- [ ] **Step 10: Run provider GREEN tests**

Run: `cd macos && node --test test/keychain-secret-store.test.cjs test/provider-state-store.test.cjs test/openai-compatible-provider.test.cjs test/provider-controller.test.cjs test/cliproxy-manager.test.cjs test/codex-account-controller.test.cjs`

Expected: PASS, including timeout/cancellation, Vertex cleanup, hostile DTO, reentrancy, and no-startup-Keychain assertions.

- [ ] **Step 11: Commit**

```bash
git add macos/src/desktop/keychain-secret-store.cjs macos/src/desktop/provider-state-store.cjs \
  macos/src/desktop/openai-compatible-provider.cjs macos/src/desktop/provider-controller.cjs \
  macos/src/desktop/cliproxy-manager.cjs macos/test/keychain-secret-store.test.cjs \
  macos/test/provider-state-store.test.cjs macos/test/openai-compatible-provider.test.cjs \
  macos/test/provider-controller.test.cjs macos/test/cliproxy-manager.test.cjs
git commit -m "feat(mac): add provider connection authority"
```

---

### Task 3: Route Canonical Models and Gate Native Creation in Main Process

**Owner:** Luna-max Routing worker

**Files:**
- Create: `macos/src/desktop/openai-compatible-inference-transport.cjs`
- Create: `macos/test/openai-compatible-inference-transport.test.cjs`
- Modify: `macos/src/desktop/model-selection-store.cjs:8-165`
- Modify: `macos/src/desktop/inference-provider-router.cjs:5-267`
- Modify: `macos/src/desktop/cliproxy-inference-transport.cjs:23-114`
- Modify: `macos/src/bridge/runtime-config.cjs:7-207,338-400`
- Modify: `macos/src/bridge/inference-socket-client.cjs:42-79`
- Modify: `macos/src/desktop/openbot-native-coordinator.cjs:848-940,1100-1120,1594-1625`
- Modify: `macos/src/desktop/runtime.cjs:41-80,397-507,614-1002,1161-1438,1579-1925,2056-2080`
- Modify: `macos/test/model-selection-store.test.cjs`
- Modify: `macos/test/inference-provider-router.test.cjs`
- Modify: `macos/test/cliproxy-inference-transport.test.cjs`
- Modify: `macos/test/bridge-runtime-config.test.cjs`
- Modify: `macos/test/openbot-native-coordinator.test.cjs`
- Modify: `macos/test/desktop-runtime.test.cjs`
- Modify: `macos/test/standalone-desktop-wiring.test.cjs`

**Interfaces:**
- Consumes Task 2 `ProviderController` six-method contract and private state/keychain/local dependencies.
- Produces `InferenceProviderRouter({ readSelection, transportForProvider, descriptorForProvider })`.
- Produces `OpenAICompatibleInferenceTransport({ providerId, resolveConnection, ClientClass })` where `resolveConnection()` is called only by `stream()` and returns non-enumerable `{ endpoint, credential }`.
- Produces `ModelSelectionStore.readStatus(botId)` returning `{ state: "missing" }`, `{ state: "selected", selection }`, or `{ state: "unavailable", botId, generation }`; existing `read(botId)` remains valid-selection-or-null compatibility. A schema-2 `unavailableSelections` map quarantines malformed legacy entries without making them usable.
- Extends `OpenBotNativeCoordinator` constructor with `canCreateAgent: async () => boolean`.
- Runtime IPC adds `openbot-provider:list`, `:connect`, `:disconnect`, `:catalog`, `:onboarding-read`, `:onboarding-complete` and provider/catalog change channels.
- `codex-bot:create` and native `createAgent` both require a currently valid onboarding receipt before any store mutation.

- [ ] **Step 1: Write selection migration and no-fallback RED tests**

```js
test("legacy two-provider selections migrate to canonical shared provider IDs", async (t) => {
  await fs.writeFile(filePath, legacyRegistry({ provider: "cliproxy-anthropic", model: "claude-fable-5" }));
  assert.equal((await store.read(BOT_A)).provider, "anthropic-claude");
  await store.writeNext({ ...selection(), provider: "anthropic-claude" });
  assert.match(await fs.readFile(filePath, "utf8"), /"provider": "anthropic-claude"/);
});

test("malformed stored providers become unavailable and require an explicit choice", async (t) => {
  await fs.writeFile(filePath, legacyRegistry({ provider: "display label", model: "gpt-5.6-sol" }));
  assert.deepEqual(await store.readStatus(BOT_A), { state: "unavailable", botId: BOT_A, generation: 1 });
  assert.equal(await store.read(BOT_A), null);
  assert.equal((await store.readStatus(BOT_A)).state, "unavailable");
});

test("an unavailable catalog never invents a provider or rewrites the stored tuple", async () => {
  const current = await currentModelSelection(BOT_A);
  assert.deepEqual(current, storedSelection);
  await assert.rejects(defaultModelSelection(BOT_B, unavailableCatalog), /catalog|provider/i);
});
```

- [ ] **Step 2: Run selection RED**

Run: `cd macos && node --test --test-name-pattern='legacy two-provider|unavailable catalog never' test/model-selection-store.test.cjs test/desktop-runtime.test.cjs`

Expected: FAIL because the store/router still allow only `openai-codex` and `cliproxy-anthropic`, and `defaultModelSelection()` currently falls back to Claude Fable.

- [ ] **Step 3: Replace allowlists with descriptor validation and atomic migration**

```js
const provider = canonicalProviderId(selection.provider);
const descriptor = providerDescriptor(provider);
if (!descriptor.models.some(({ id }) => id === selection.model) && provider !== "local-openai-compatible") {
  throw new Error("Model selection is invalid.");
}
```

Dynamic Direct/local/API catalogs are validated against the exact current provider catalog rather than static membership. During schema-1 migration, a malformed provider/model entry moves to `unavailableSelections[botId] = { generation, updatedAt }`; `currentModelSelection()` returns `null` for that state and does not call `defaultModelSelection()`. An explicit valid `writeNext()` clears that bot's unavailable marker. A new bot cannot receive a default until `providerController.catalog()` has at least one connected model.

- [ ] **Step 4: Write exact-transport RED tests**

```js
test("every canonical provider selects only its declared transport", async () => {
  for (const provider of PROVIDER_IDS) {
    const result = await routerFor(provider).stream(request(provider));
    await consume(result.fullStream);
    assert.deepEqual(calls.map(({ providerId }) => providerId), [provider]);
  }
});

test("disconnected selection fails before transport construction", async () => {
  await assert.rejects(router.stream(request("moonshot-kimi")), { code: "CODEX_INFERENCE_PROVIDER_UNAVAILABLE" });
  assert.deepEqual(transportCalls, []);
});
```

- [ ] **Step 5: Run routing RED**

Run: `cd macos && node --test test/inference-provider-router.test.cjs test/cliproxy-inference-transport.test.cjs test/openai-compatible-inference-transport.test.cjs test/bridge-runtime-config.test.cjs`

Expected: FAIL because the new transport is absent and current routing is a two-branch Codex/Anthropic allowlist.

- [ ] **Step 6: Implement transport factory routing and capability omission**

```js
const selectedTransport = await this.#transportForProvider(selected.provider);
const descriptor = this.#descriptorForProvider(selected.provider);
const upstreamSelection = Object.freeze({
  botId: selected.botId,
  generation: selected.generation,
  provider: selected.provider,
  model: selected.model,
  ...(descriptor.reasoningEfforts.includes(selected.reasoningEffort)
    ? { reasoningEffort: descriptor.reasoningMap?.[selected.reasoningEffort] ?? selected.reasoningEffort }
    : {}),
  ...(selected.serviceTier !== null && descriptor.fastModeSupported
    ? { serviceTier: selected.serviceTier }
    : {}),
});
```

Only the Anthropic descriptor maps `ultra-code` to upstream `max`. Direct Codex uses `CodexDirectInferenceTransport`; the four hosted/Vertex routes use provider-scoped CLIProxy transport instances; API-key/local use `OpenAICompatibleInferenceTransport`. The transport factory calls `providerController.catalog()` immediately before construction and rejects disconnected generations. Keep `workspaceId` private to Direct Codex.

- [ ] **Step 7: Write main-process onboarding/native-create RED tests**

```js
test("missing onboarding receipt blocks both IPC and native creation before mutation", async () => {
  await assert.rejects(invoke("codex-bot:create"), /operation failed/i);
  const reply = await request(port, "create-blocked", "createAgent", profileArgs());
  assert.equal(reply.outcome.status, "failed");
  assert.deepEqual(botController.calls.filter(([name]) => name === "createBot"), []);
});

test("matching receipt permits native create without changing the Grok request shape", async () => {
  providerController.readOnboarding.mock.mockImplementation(async () => receipt("openai-codex", 4));
  const reply = await request(port, "create-ready", "createAgent", profileArgs());
  assert.equal(reply.outcome.status, "ok");
  assert.equal(botController.calls.filter(([name]) => name === "createBot").length, 1);
});
```

- [ ] **Step 8: Run onboarding gate RED**

Run: `cd macos && node --test --test-name-pattern='missing onboarding receipt|matching receipt permits' test/openbot-native-coordinator.test.cjs test/desktop-runtime.test.cjs`

Expected: FAIL because neither `codex-bot:create` nor `OpenBotNativeCoordinator.#createAgent()` checks provider onboarding.

- [ ] **Step 9: Wire the controller without eager startup secret access**

Remove `void accountController.start()` from launch. Construct provider state without invoking Codex, CLIProxy, Keychain, local discovery, or login. Provider IPC uses exact object validation and main-window/sender-frame checks. `nativeAvailableModels()` projects only `await providerController.catalog()` entries, prefixes every native model ID with `${providerId}--` when the raw model name collides, and decodes that exact identity on selection. `canCreateAgent()` re-reads receipt and matching connection generation immediately before the coordinator calls `createBot()`.

- [ ] **Step 10: Run routing/runtime GREEN tests**

Run: `cd macos && node --test test/model-selection-store.test.cjs test/inference-provider-router.test.cjs test/cliproxy-inference-transport.test.cjs test/openai-compatible-inference-transport.test.cjs test/bridge-runtime-config.test.cjs test/inference-bridge-socket.test.cjs test/openbot-native-coordinator.test.cjs test/openbot-native-coordinator-ipc.test.cjs test/desktop-runtime.test.cjs test/standalone-desktop-wiring.test.cjs`

Expected: PASS; no fallback, disconnected projection, secret startup, or ungated create remains.

- [ ] **Step 11: Commit**

```bash
git add macos/src/desktop/openai-compatible-inference-transport.cjs \
  macos/src/desktop/model-selection-store.cjs macos/src/desktop/inference-provider-router.cjs \
  macos/src/desktop/cliproxy-inference-transport.cjs macos/src/bridge/runtime-config.cjs \
  macos/src/bridge/inference-socket-client.cjs macos/src/desktop/openbot-native-coordinator.cjs \
  macos/src/desktop/runtime.cjs macos/test/model-selection-store.test.cjs \
  macos/test/inference-provider-router.test.cjs macos/test/cliproxy-inference-transport.test.cjs \
  macos/test/openai-compatible-inference-transport.test.cjs macos/test/bridge-runtime-config.test.cjs \
  macos/test/openbot-native-coordinator.test.cjs macos/test/desktop-runtime.test.cjs \
  macos/test/standalone-desktop-wiring.test.cjs
git commit -m "feat(mac): route canonical provider models"
```

---

### Task 4: Replace Renderer-Local Onboarding With the Main Provider Facade

**Owner:** Luna-max Renderer worker (same worker also owns Task 5)

**Files:**
- Modify: `macos/src/renderer/bot-runtime-ui.js:19-57,467-576,1745-1759,2420-3170,3430-3716,3823-4037`
- Modify: `macos/src/renderer/model-controls.js:216-377`
- Modify: `macos/src/renderer/codex-ui.css:161-467`
- Modify: `macos/src/patch/renderer.cjs:51-70,84-192`
- Modify: `macos/test/bot-runtime-ui.test.cjs:3489-4173,4175-4900`
- Modify: `macos/test/model-controls.test.cjs:273-406`
- Modify: `macos/test/renderer-integration.test.cjs:195-255,391-510`

**Interfaces:**
- Consumes Task 3 preload-facing facade contract `openbotProviders.list/connect/disconnect/catalog/readOnboarding/completeOnboarding/onConnectionsChanged/onCatalogChanged`.
- Produces no renderer storage receipt and never reads/writes `openbot.first-connection.v1`.
- First chooser and General Settings render from the same eight connection DTOs.
- Native mode never appends `codex-new-bot-setup`; native create remains the pinned `W.openPicker()` route after main authorization.

- [ ] **Step 1: Replace the old empty-roster test with durable legacy-profile RED coverage**

```js
test("existing bots without a durable receipt still open the eight-route gate", async (context) => {
  const harness = createMountedUiHarness({
    nativeProtocol: true,
    botsFacade: { async list() { return [bot(BOT_A)]; }, onChanged() { return () => {}; } },
    providerFacade: providerFacade({ onboarding: null, connections: eightConnections() }),
  });
  context.after(() => harness.mounted.dispose());
  await tick();
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
  assert.deepEqual(harness.findAll("codex-first-connection-choice").map((node) => node.dataset.providerId), PROVIDER_IDS);
  assert.equal(harness.findPanel("codex-first-connection-skip"), null);
});
```

- [ ] **Step 2: Run onboarding RED**

Run: `cd macos && node --test --test-name-pattern='existing bots without a durable receipt' test/bot-runtime-ui.test.cjs`

Expected: FAIL because the current gate opens only for `snapshot.bots.length === 0`, exposes two routes, and reads localStorage.

- [ ] **Step 3: Render one reusable provider list and explicit request forms**

```js
function providerAction(connection, first) {
  const descriptor = connectionById.get(connection.providerId);
  if (!descriptor || connectionPending.has(descriptor.providerId)) return;
  const request = requestForProvider(descriptor.providerId, providerInputs);
  return connectAndRefresh(request).then(async (connected) => {
    if (first) await windowRef.openbotProviders.completeOnboarding(connected.providerId);
  });
}
```

Render all eight labels and sanitized states. Direct Codex exposes browser/device actions; Vertex sends only `{ providerId }` so the main process owns the picker; API/local inputs clear secret fields immediately after submission. Settings exposes disconnect for connected routes. Cancellation/failure keeps the chooser open with provider-specific stable copy and focus returned to the same route.

- [ ] **Step 4: Keep the chooser modal and main gate aligned**

On mount, await `list()`, `catalog()`, and `readOnboarding()` independently of bot count. Until a valid receipt arrives, keep the modal open, set the injected product surfaces inert, and leave the main-process native/IPC gate authoritative. After completion restore the previously active bot if still present; otherwise let the preserved native empty state render. Do not call `controller.createBot()` from onboarding.

- [ ] **Step 5: Generalize model controls and collision labels**

Remove `OPTIONAL_MODEL_CATALOG` and the hard-coded `openai-codex`/`cliproxy-anthropic` branches. `normalizeModelCatalog()` accepts only the provider controller DTO. In `buildAdvancedOptions()`, use `entry.providerLabel` only when visible labels collide:

```js
const providerLabel = labelCounts.get(label) > 1 ? entry.providerLabel : null;
return Object.freeze({
  key: JSON.stringify([entry.provider, entry.model]),
  provider: entry.provider,
  model: entry.model,
  label,
  providerLabel,
});
```

- [ ] **Step 6: Preserve the native route and add static regression assertions**

`macos/src/patch/renderer.cjs` must keep the exact pinned composer host, `create-new` recipient mapping, `W.openPicker()` call, View Bot host, and General Settings host. Do not add an OpenBot form inside the vendor picker. Add assertions that native mode has no `codex-new-bot-setup`, the Power subtree contains no Computer nodes, and the existing native create patch bytes remain exact.

- [ ] **Step 7: Run renderer GREEN tests**

Run: `cd macos && node --test test/model-controls.test.cjs test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs test/grok-contract-parity.test.cjs`

Expected: PASS for eight routes, legacy-profile gate, cancellation, Settings add/disconnect, same-name identity, native picker preservation, View Bot placement, and no localStorage authority.

- [ ] **Step 8: Commit**

```bash
git add macos/src/renderer/bot-runtime-ui.js macos/src/renderer/model-controls.js \
  macos/src/renderer/codex-ui.css macos/src/patch/renderer.cjs \
  macos/test/bot-runtime-ui.test.cjs macos/test/model-controls.test.cjs \
  macos/test/renderer-integration.test.cjs
git commit -m "feat(mac): gate native bots on provider onboarding"
```

---

### Task 5: Make the Simple Power View Hug Its Content

**Owner:** Luna-max Renderer worker from Task 4

**Files:**
- Modify: `macos/src/renderer/codex-ui.css:681-770,1299-1357`
- Modify: `macos/src/renderer/bot-runtime-ui.js:2689-2975,3838-3955`
- Modify: `macos/test/bot-runtime-ui.test.cjs:4294-4450,5713-5904`
- Modify: `macos/test/renderer-integration.test.cjs:391-493`

**Interfaces:**
- Consumes existing `measurePickerViews()` and `setAdvancedView(expanded)`.
- Produces compact simple geometry: slider shell `32px` + vertical insets `8px + 8px` = `48px`; shared footer remains `36px`; simple menu height is `84px`.
- Advanced height remains measured, not hard-coded into the simple state.

- [ ] **Step 1: Change the encoded-defect tests to RED compact expectations**

```js
test("measured picker uses compact simple content and independent Advanced height", async (context) => {
  const harness = createMountedUiHarness({
    nativeProtocol: true,
    viewMetrics: Object.freeze({
      "codex-power-view-simple": 48,
      "codex-power-view-advanced": 132,
      "codex-power-view-controls": 36,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await tick();
  const menu = harness.find("codex-power-menu");
  assert.equal(menu.style.getPropertyValue("--simple-view-height"), "48px");
  assert.equal(menu.style.height, "84px");
  harness.find("codex-power-advanced-toggle").listeners.get("click")();
  assert.equal(menu.style.height, "168px");
});
```

Static CSS assertions must reject `min-height: 121px` and any 55-pixel simple-panel padding.

- [ ] **Step 2: Run Power RED**

Run: `cd macos && node --test --test-name-pattern='compact simple content|approved CSS' test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs`

Expected: FAIL because `.codex-power-view-simple` still has `min-height: 121px` and `padding: 14px 6px 55px`.

- [ ] **Step 3: Remove only the Advanced-derived spacer**

```css
.codex-power-view-simple {
  display: flex;
  align-items: flex-start;
  padding: 8px 6px;
}
```

Keep `.codex-power-view-controls { height: 36px; }`, the divider, fixed popover width, track, ResizeObservers, viewport clamping, and separate Advanced panel measurement.

- [ ] **Step 4: Add rapid-toggle and reduced-motion final-state tests**

Click Advanced/simple/Advanced/simple without awaiting animation. Assert final `data-view="simple"`, correct ARIA/inert values, `84px`, stable anchor coordinates, and focus restoration. In reduced motion, assert the same final geometry and no spatial transition CSS while keyboard/Home/End/arrows/wheel/Fast/Ultra behavior stays covered by existing tests.

- [ ] **Step 5: Run Power GREEN tests**

Run: `cd macos && node --test test/reasoning-control.test.cjs test/model-controls.test.cjs test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs`

Expected: PASS; simple height is 84px total, Advanced remains 168px in the fixture, and all interaction/focus tests remain green.

- [ ] **Step 6: Commit**

```bash
git add macos/src/renderer/codex-ui.css macos/src/renderer/bot-runtime-ui.js \
  macos/test/bot-runtime-ui.test.cjs macos/test/renderer-integration.test.cjs
git commit -m "fix(mac): compact the simple Power panel"
```

---

### Task 6: Load a Safe Local Desktop Document and Publish Awaited Frame Status With Retry

**Owner:** Luna-max Desktop worker

**Files:**
- Modify: `macos/src/local/local-desktop-manager.cjs:11-69,338-368,399-640,907-1057`
- Modify: `macos/src/desktop/local-desktop-frame-ipc.cjs:5-338`
- Modify: `macos/src/renderer/openbot-local-desktop-view.js:8-175`
- Modify: `macos/src/renderer/openbot-local-desktop-view.css`
- Modify: `macos/test/local-desktop-manager.test.cjs:264-360,585-1008`
- Modify: `macos/test/local-desktop-frame-ipc.test.cjs:131-446`
- Modify: `macos/test/openbot-local-desktop-view.test.cjs:98-204`

**Interfaces:**
- Produces exports `LOCAL_DESKTOP_START_HTML`, `LOCAL_DESKTOP_START_URL`, `safeDisplayUrl(value)` from the manager for exact test identity.
- Frame IPC channels become `{ select, retry, clear }`; events become `{ frame, status }`.
- Preload-facing methods expected by Task 7: `select(value)`, `retry(value)`, `clear(value)`, `onFrame(callback)`, `onStatus(callback)`.
- `select/retry` resolve only after one capture attempt with the public status DTO defined above.

- [ ] **Step 1: Write the safe-start-document RED test**

```js
test("open loads and captures the exact CSP start document before reporting ready", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  assert.deepEqual(windows[0].webContents.urls, [LOCAL_DESKTOP_START_URL]);
  assert.match(Buffer.from(LOCAL_DESKTOP_START_URL.split(",")[1], "base64").toString("utf8"),
    /default-src 'none'; base-uri 'none'; form-action 'none'/);
  const frame = await manager.captureDisplayFrame(identity(session));
  assert.equal(frame.bytes.byteLength > 0, true);
});
```

Add a fixture assertion that an untouched `about:blank` window fails with public code `OPENBOT_LOCAL_CAPTURE_FAILED` before the implementation loads the start document.

- [ ] **Step 2: Run manager RED**

Run: `cd macos && node --test --test-name-pattern='exact CSP start document|about:blank' test/local-desktop-manager.test.cjs`

Expected: FAIL because `open()` currently never calls `loadURL()` and capture rejects `about:blank`.

- [ ] **Step 3: Load exact bytes before entry publication**

After `#secureSession()` and `#secureWindow()`, call `await window.webContents.loadURL(LOCAL_DESKTOP_START_URL)`, recheck bot/deletion/generation currentness, and assert `webContents.getURL() === LOCAL_DESKTOP_START_URL`. Only then create the helper and insert the entry into `#entries`. `navigate()` continues to accept public HTTPS only; `#captureCurrentImage()` accepts `safeDisplayUrl(currentUrl)`, which returns the exact built-in URL or delegates to `safeHttpsUrl()`.

- [ ] **Step 4: Write awaited-select/status/retry RED tests**

```js
test("selection awaits first capture and reports sanitized unavailable status", async () => {
  const held = deferred();
  const value = fixture({ captureDisplayFrame: () => held.promise });
  const pending = select(ipcEvent(value.first.sender), { botId: BOT_A, viewGeneration: 1 });
  assert.equal(await Promise.race([pending.then(() => "settled"), tick().then(() => "pending")]), "pending");
  held.reject(Object.assign(new Error("/Users/private token=secret"), { code: "OPENBOT_LOCAL_CAPTURE_FAILED" }));
  assert.deepEqual(await pending, status(BOT_A, LOCAL_A, 1, 1, "unavailable", "OPENBOT_LOCAL_CAPTURE_FAILED"));
  assert.doesNotMatch(JSON.stringify(value.first.sent), /Users|token|secret/);
});

test("retry invalidates the old timer and cannot publish its late frame", async () => {
  const first = deferred();
  const selected = select(view, { botId: BOT_A, viewGeneration: 1 });
  const retried = retry(view, { botId: BOT_A, viewGeneration: 2 });
  first.resolve(frame(BOT_A, LOCAL_A, 1, "stale", 1));
  await Promise.allSettled([selected, retried]);
  assert.equal(sentFrames.some(({ value }) => value.viewGeneration === 1), false);
});
```

- [ ] **Step 5: Run frame RED**

Run: `cd macos && node --test --test-name-pattern='awaits first capture|retry invalidates' test/local-desktop-frame-ipc.test.cjs test/openbot-local-desktop-view.test.cjs`

Expected: FAIL because select returns before capture, errors disappear in `catch {}`, and retry/status APIs do not exist.

- [ ] **Step 6: Implement one-flight capture and bounded status publication**

`capture(subscription)` returns a status. On select publish `connecting`, await one capture, then arm the 1000ms timer only after `live`. On retry invalidate the prior subscription synchronously, publish `retrying`, re-read/open/re-read/capture/re-read the exact Computer identity, and arm a new timer only after `live`. On capture error map only the two allowed stable codes, publish `unavailable`, clear its timer, and retain no raw error. Duplicate same-generation requests share the exact Promise; older/conflicting generations fail closed.

- [ ] **Step 7: Add renderer retry and stale-decode fencing**

Add a retry button inside the Local Desktop header. Validate status DTOs with the same strict own-data rules as frames. Map state to the four approved labels. Retry increments `viewGeneration`, clears canvas/decode state before IPC, disables itself while pending, and becomes available only for `unavailable`. Bot switch, Computer event, host removal, and `dispose()` increment generation and clear both subscriptions.

- [ ] **Step 8: Run Desktop GREEN tests**

Run: `cd macos && node --test test/local-desktop-manager.test.cjs test/local-desktop-frame-ipc.test.cjs test/openbot-local-desktop-view.test.cjs test/local-computer-boundary.test.cjs test/computer-target-router.test.cjs test/free-local-desktop-live.test.cjs`

Expected: PASS for safe initial frame, HTTPS navigation, exact internal-document rejection, status/retry, two-bot partition/frame isolation, and all deletion/disposal fences. `free-local-desktop-live.test.cjs` may report its declared external live gate as blocked; it must not report a false pass.

- [ ] **Step 9: Commit**

```bash
git add macos/src/local/local-desktop-manager.cjs macos/src/desktop/local-desktop-frame-ipc.cjs \
  macos/src/renderer/openbot-local-desktop-view.js macos/src/renderer/openbot-local-desktop-view.css \
  macos/test/local-desktop-manager.test.cjs macos/test/local-desktop-frame-ipc.test.cjs \
  macos/test/openbot-local-desktop-view.test.cjs
git commit -m "fix(mac): publish the first local desktop frame"
```

---

### Task 7: Stage the Shared Provider, New Runtime Modules, and Narrow Preload Facades

**Owner:** Luna-max Package worker

**Files:**
- Modify: `macos/src/patch/desktop.cjs:7-74,97-101,146-204`
- Modify: `macos/scripts/patch-app.cjs:16-79`
- Modify: `macos/test/desktop-patch.test.cjs:92-141`
- Modify: `macos/test/patch-app.test.cjs:132-330`
- Modify: `macos/test/installer-bundle.test.cjs:176-330`
- Modify: `macos/test/release-package.test.cjs` only if the exact reviewed-source allowlist needs the new modules

**Interfaces:**
- Consumes all source files and IPC channel names from Tasks 1–6.
- Produces `window.openbotProviders` and the extended `window.openbotLocalDesktop`; preserves `codexBots`, `codexRuntime`, `codexAccount`, and `openbotComputer` compatibility facades.
- Copies authoritative `src/provider-descriptors.cjs` to `dist/codex/provider-descriptors.cjs` and every new macOS module to its exact `dist/codex/desktop/...` path.

- [ ] **Step 1: Write package-closure/preload RED assertions**

```js
assert.match(preload, /exposeInMainWorld\("openbotProviders"/);
for (const method of [
  "list", "connect", "disconnect", "catalog", "readOnboarding", "completeOnboarding",
  "onConnectionsChanged", "onCatalogChanged",
]) assert.match(preload, new RegExp(`${method}:`));
for (const method of ["select", "retry", "clear", "onFrame", "onStatus"]) {
  assert.match(preload, new RegExp(`${method}:`));
}
for (const relative of [
  "provider-descriptors.cjs",
  "desktop/provider-controller.cjs",
  "desktop/provider-state-store.cjs",
  "desktop/keychain-secret-store.cjs",
  "desktop/openai-compatible-provider.cjs",
  "desktop/openai-compatible-inference-transport.cjs",
]) assert.equal(fs.lstatSync(path.join(extracted, "dist", "codex", relative)).isFile(), true);
```

- [ ] **Step 2: Run packaging RED**

Run: `cd macos && node --test test/desktop-patch.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs test/standalone-desktop-wiring.test.cjs`

Expected: FAIL because the new modules/facades are not in `DESKTOP_FILES`, mutation allowlists, or preload bytes.

- [ ] **Step 3: Add exact copy sources and facades**

Refactor the single giant preload string only enough to keep three frozen facade constants readable. Provider methods invoke only `openbot-provider:*` channels. Local frame status uses `openbot-local-frame:status`; retry uses `openbot-local-frame:retry`. Every listener validates callback type and returns an exact remover. Do not expose Keychain, CLIProxy, paths, command arguments, endpoints, or raw account controller objects.

In `patchDesktop()`, copy the authoritative shared catalog from `path.resolve(sourceRoot, "..", "..", "src", "provider-descriptors.cjs")` to `dist/codex/provider-descriptors.cjs` after real-file/no-symlink validation; do not copy the source-tree adapter.

- [ ] **Step 4: Update exact mutation/provenance expectations**

Add every new `dist/codex` member in sorted order to `patch-app.test.cjs` and installer closure assertions. Assert staged shared descriptor SHA-256 equals root source bytes. Keep pinned vendor assets, stock/unpacked bytes, release privacy scan, and signed-member provenance behavior unchanged.

- [ ] **Step 5: Run package GREEN tests**

Run: `cd macos && node --test test/desktop-patch.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs test/standalone-desktop-wiring.test.cjs test/release-package.test.cjs test/openbot-brand.test.cjs`

Expected: PASS with one provider facade, one frame/status facade, exact new source members, and no personal/secret bytes.

- [ ] **Step 6: Commit**

```bash
git add macos/src/patch/desktop.cjs macos/scripts/patch-app.cjs \
  macos/test/desktop-patch.test.cjs macos/test/patch-app.test.cjs \
  macos/test/installer-bundle.test.cjs macos/test/release-package.test.cjs
git commit -m "build(mac): stage provider and desktop facades"
```

---

### Task 8: Mandatory Luna-max Provider and Security Reviewer Gate

**Owner:** Fresh Luna-max reviewer; read the actual Task 1–4 and Task 7 diffs, not worker summaries

**Files:**
- Read-only review: all files owned by Catalog, Provider, Routing, Renderer onboarding, and Package workers

**Interfaces:**
- Produces a gate result with exact findings by file/line and command evidence.
- Rejects the cluster if any provider can appear usable before authoritative connection/catalog success, any secret is touched at launch, any route falls back, or native creation can mutate before receipt validation.

- [ ] **Step 1: Read the combined provider diff and trace all eight routes end to end**

Run: `git diff 91ecf2215380348622a6e04a65940193bdef4a9b -- src/provider-descriptors.cjs src/codex-connection.cjs macos/src macos/test macos/scripts/patch-app.cjs`

Trace descriptor → connect flow → state commit → catalog → selection store → native projection → inference transport → disconnect for each ID.

- [ ] **Step 2: Run the focused provider/security suite**

Run: `node --test tests/provider-descriptors.test.cjs tests/provider-selection.test.cjs tests/local-model-provider.test.cjs && cd macos && node --test test/keychain-secret-store.test.cjs test/provider-state-store.test.cjs test/openai-compatible-provider.test.cjs test/provider-controller.test.cjs test/cliproxy-manager.test.cjs test/model-selection-store.test.cjs test/inference-provider-router.test.cjs test/openai-compatible-inference-transport.test.cjs test/bridge-runtime-config.test.cjs test/openbot-native-coordinator.test.cjs test/desktop-runtime.test.cjs test/bot-runtime-ui.test.cjs`

Expected: PASS with no undeclared skips.

- [ ] **Step 3: Report gate outcome**

Required checks: exact eight-route matrix; fixed login flags; Vertex private temporary cleanup; loopback/redirect/size rules; Keychain only after explicit action; sanitized DTOs; generation/disposal/reentrancy; no eager Codex start; no disconnected model projection; no fallback; durable receipt; legacy bots gated; native creation blocked before mutation; Settings add/disconnect; same-name model identities. Any finding returns to its exclusive owner before Task 10.

---

### Task 9: Mandatory Luna-max Desktop, Native Placement, Power, and Package Reviewer Gate

**Owner:** Fresh Luna-max reviewer; read the actual Task 4–7 diffs and pinned vendor transforms

**Files:**
- Read-only review: Local Desktop, renderer, pinned renderer patch, preload/package closure, and associated tests

**Interfaces:**
- Produces a gate result with exact findings by file/line and command evidence.
- Rejects the cluster if the built-in document broadens navigation, first capture is not awaited, status leaks diagnostics, stale frames can publish, native Grok creation changes, Computer enters Power, or simple height still includes Advanced space.

- [ ] **Step 1: Read the combined visual/runtime/package diff**

Run: `git diff 91ecf2215380348622a6e04a65940193bdef4a9b -- macos/src/local/local-desktop-manager.cjs macos/src/desktop/local-desktop-frame-ipc.cjs macos/src/renderer macos/src/patch macos/scripts/patch-app.cjs macos/test`

- [ ] **Step 2: Run focused Desktop/native/Power/package tests**

Run: `cd macos && node --test test/local-desktop-manager.test.cjs test/local-desktop-frame-ipc.test.cjs test/openbot-local-desktop-view.test.cjs test/local-computer-boundary.test.cjs test/computer-target-router.test.cjs test/reasoning-control.test.cjs test/model-controls.test.cjs test/bot-runtime-ui.test.cjs test/renderer-integration.test.cjs test/grok-contract-parity.test.cjs test/desktop-patch.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs test/release-package.test.cjs`

Expected: PASS with the external live verifier truthfully blocked unless configured.

- [ ] **Step 3: Report gate outcome**

Required checks: exact start-document identity; CSP/no network resources; HTTPS validator unchanged for public navigation; initial capture awaited; status/retry bounded; bot/target/view/sender fences; timer cleanup; two-bot isolation; native teammate route byte-preserved; legacy setup absent; View Bot owns Computer; composer trigger placement; simple `48 + 36 = 84px`; Advanced independent; rapid toggle/reduced motion/focus; exact packaged closure. Any finding returns to its exclusive owner before Task 10.

---

### Task 10: Final Sol-xhigh Combined-Diff Integration and Verification Gate

**Owner:** One Sol-xhigh integrator; no worker summary is accepted as evidence

**Files:**
- Review and integrate: the actual complete diff from `91ecf2215380348622a6e04a65940193bdef4a9b`
- Modify only the original owning worker's files for verified integration defects; preserve the ownership table in the review record

**Interfaces:**
- Consumes passed Luna-max Gates 8 and 9.
- Produces one exact commit whose source, root suite, macOS suite, source check, package closure, and signature prerequisites agree.

- [ ] **Step 1: Read the full combined diff and recheck interface names**

```bash
git diff 91ecf2215380348622a6e04a65940193bdef4a9b --check
git diff --stat 91ecf2215380348622a6e04a65940193bdef4a9b
git diff 91ecf2215380348622a6e04a65940193bdef4a9b -- . ':(exclude)docs/superpowers/plans/2026-08-18-macos-provider-desktop-onboarding.md'
```

Verify every interface in this plan against actual exports/callers: canonical IDs, connection/catalog DTO fields, six provider methods, onboarding receipt, transport factory, native create gate, frame channel/status fields, preload methods, and Power geometry. Search for stale two-provider/localStorage/fallback patterns:

```bash
rg -n 'cliproxy-anthropic|openbot\.first-connection\.v1|OPTIONAL_MODEL_CATALOG|new Set\(\["openai-codex"|defaultModelSelection' macos/src src
```

Expected: legacy IDs appear only in explicit migration fixtures/maps; renderer localStorage and static optional catalogs are absent; default selection requires a ready connected catalog.

- [ ] **Step 2: Run root and macOS suites from the combined tree**

```bash
npm test
npm run check
npm --prefix macos test
npm --prefix macos run check
git diff --check
```

Expected: all tests/checks pass. Existing declared platform/live skips remain accurately named; no new unexplained skip or timeout is accepted.

- [ ] **Step 3: Run package/source verification without installing or launching**

```bash
cd macos
node --test test/desktop-patch.test.cjs test/patch-app.test.cjs test/installer-bundle.test.cjs test/release-package.test.cjs
node scripts/check-sources.cjs
cd ..
git status --short --branch
```

Expected: exact staged closure and privacy/provenance tests pass; worktree contains only intended implementation/plan changes before the integration commit.

- [ ] **Step 4: Commit the reviewed integration**

```bash
git add src macos/src macos/scripts macos/test tests
git commit -m "feat(mac): complete provider desktop onboarding"
```

Do not include generated apps, ASARs, DMGs, screenshots, recordings, profiles, logs, credentials, or artifacts in the commit.

---

### Task 11: Build, Replace, and Verify the Exact Installed Development Candidate

**Owner:** Sol-xhigh integrator plus a user-authorized visual acceptance operator

**Files:**
- Generated outside Git: `/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-provider-desktop/`
- Install target: `/Users/harlin/Applications/OpenBot.app`
- Sanitized evidence outside Git: `/Users/harlin/Library/Caches/OpenBot/evidence/0.2.0-macos.1-provider-desktop/`

**Interfaces:**
- Consumes the exact Task 10 commit and current pinned release inputs.
- Produces source/package/signature/install/process/UI acceptance tied to one commit and one installed bundle hash.
- This task is sequential and cannot start from a dirty post-review tree.
- Produces no public-release claim; the self-contained public installer and Apple notarization/stapling workflow remain a separate required release plan.

- [ ] **Step 1: Record commit and prove stale process/copy inventory before mutation**

```bash
OPENBOT_ACCEPTANCE_COMMIT="$(git rev-parse HEAD)"
test -z "$(git status --porcelain=v1)"
pgrep -alf '/OpenBot\.app/|OpenBot Helper' || true
find /Applications /Users/harlin/Applications -maxdepth 4 -type d -name 'OpenBot.app' -print
```

Expected before cleanup: every copy/process is explicitly enumerated. Do not terminate or trash anything whose resolved bundle path is not one of the enumerated OpenBot candidates.

- [ ] **Step 2: Build the signed development installer from exact pinned inputs**

```bash
OPENBOT_RELEASE_INPUTS=/Users/harlin/Library/Caches/OpenBot/release-inputs/0.2.0-macos.1
OPENBOT_BUILD_ROOT=/Users/harlin/Library/Caches/OpenBot/builds/0.2.0-macos.1-provider-desktop
OPENBOT_INSTALLER_ROOT="$OPENBOT_BUILD_ROOT/installer"
OPENBOT_INSTALLER_APP="$OPENBOT_INSTALLER_ROOT/Install OpenBot DEVELOPMENT.app"
OPENBOT_DMG="$OPENBOT_BUILD_ROOT/OpenBot-0.2.0-macos.1-DEVELOPMENT.dmg"
OPENBOT_SIGNING_IDENTITY='Developer ID Application: Harlin Sidwell (HKCH65M45F)'
node macos/scripts/build-installer-app.cjs \
  --output "$OPENBOT_INSTALLER_ROOT" \
  --sidecar "$OPENBOT_RELEASE_INPUTS/cli-proxy-api" \
  --sidecar-license "$OPENBOT_RELEASE_INPUTS/CLIProxyAPI-LICENSE" \
  --codex-archive "$OPENBOT_RELEASE_INPUTS/codex-aarch64-apple-darwin.tar.gz" \
  --codex-runtime "$OPENBOT_RELEASE_INPUTS/codex-aarch64-apple-darwin" \
  --codex-license "$OPENBOT_RELEASE_INPUTS/CODEX-LICENSE" \
  --signing-identity "$OPENBOT_SIGNING_IDENTITY"
node macos/scripts/package-dmg.cjs \
  --installer-app "$OPENBOT_INSTALLER_APP" \
  --output "$OPENBOT_DMG" \
  --signing-identity "$OPENBOT_SIGNING_IDENTITY"
```

Expected: exact pinned input, Developer ID, provenance, source closure, and privacy checks succeed. If any named release input is missing or mismatched, acceptance is blocked rather than substituted.

- [ ] **Step 3: Audit package identity before install**

```bash
node macos/scripts/audit-release.cjs --dmg "$OPENBOT_DMG" --expected-app 'Install OpenBot DEVELOPMENT.app'
/usr/bin/codesign --verify --deep --strict --verbose=4 "$OPENBOT_INSTALLER_APP"
/usr/bin/hdiutil verify "$OPENBOT_DMG"
shasum -a 256 "$OPENBOT_DMG"
```

Expected: privacy/provenance/signature/DMG checks pass and the hash is recorded with `OPENBOT_ACCEPTANCE_COMMIT`.

- [ ] **Step 4: Quit exact stale OpenBot processes, unregister stale bundles, and replace the canonical user install**

Use bundle-resolved process inspection first. Quit only processes whose executable resolves inside an enumerated `OpenBot.app`. Move stale OpenBot bundles to Trash through Finder so they remain recoverable, unregister their exact paths with Launch Services, run the installer UI against `/Applications/Grok Bot original 20260811.app`, and choose `/Users/harlin/Applications` as destination. Verify the resulting target is exactly `/Users/harlin/Applications/OpenBot.app` before launch.

```bash
/usr/bin/osascript -e 'tell application id "com.limonlimez.openbot" to quit' || true
for OPENBOT_QUIT_ATTEMPT in $(/usr/bin/seq 1 30); do
  /usr/bin/pgrep -f '/Users/harlin/Applications/OpenBot.app/Contents/' >/dev/null || break
  /bin/sleep 1
done
test -z "$(/usr/bin/pgrep -f '/Users/harlin/Applications/OpenBot.app/Contents/' || true)"
OPENBOT_LSREGISTER='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if test -d /Users/harlin/Applications/OpenBot.app; then
  "$OPENBOT_LSREGISTER" -u /Users/harlin/Applications/OpenBot.app
  /usr/bin/osascript -e 'tell application "Finder" to delete POSIX file "/Users/harlin/Applications/OpenBot.app"'
fi
/usr/bin/open "$OPENBOT_INSTALLER_APP"
```

Wait for the installer to report success, then run `test -d /Users/harlin/Applications/OpenBot.app`. For every additional path from Step 1, repeat the same `lsregister -u <exact-reviewed-path>` and Finder Trash operation one path at a time; do not use a glob or recursive deletion.

Expected: one canonical bundle, no stale OpenBot process, and no modification to the Grok reference app. Record every removed path and its Trash destination.

- [ ] **Step 5: Prove signature, bundle, ASAR, and process identity**

```bash
OPENBOT_APP=/Users/harlin/Applications/OpenBot.app
/usr/bin/codesign --verify --deep --strict --verbose=4 "$OPENBOT_APP"
/usr/bin/codesign -d --verbose=4 "$OPENBOT_APP" 2>&1 | rg 'Identifier=|TeamIdentifier=|Runtime Version'
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$OPENBOT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$OPENBOT_APP/Contents/Info.plist"
shasum -a 256 "$OPENBOT_APP/Contents/Resources/app.asar"
```

Expected: identifier `com.limonlimez.openbot`, version `0.2.0-macos.1`, valid Developer ID/hardened runtime, and recorded ASAR hash. After launch, the observed PID executable must resolve inside this exact bundle.

- [ ] **Step 6: Run the installed interaction matrix**

Use the `project-reality-check`, `analyze-and-review`, and `visual-evidence-recorder` skills. Verify all ten spec outcomes against the installed process:

Create an isolated acceptance app-data root under the exact OS temporary directory, then preseed one sanitized bot with the product `BotStore` and intentionally omit provider state/receipt. This exercises the legacy-bots gate without reading or altering the user's personal OpenBot profile:

```bash
OPENBOT_TEMP_ROOT="$(node -p 'require("node:os").tmpdir()')"
OPENBOT_ACCEPTANCE_ROOT="$(/usr/bin/mktemp -d "$OPENBOT_TEMP_ROOT/openbot-provider-desktop.XXXXXX")"
/bin/chmod 700 "$OPENBOT_ACCEPTANCE_ROOT"
OPENBOT_ACCEPTANCE_STORE="$OPENBOT_ACCEPTANCE_ROOT/OpenBot/codex-bot/bots.v1.json"
node -e 'const { BotStore } = require("./macos/src/bots/bot-store.cjs"); new BotStore({ filePath: process.argv[1] }).create({ setupStage: "complete" }).then(() => {}, (error) => { console.error(error.message); process.exitCode = 1; });' "$OPENBOT_ACCEPTANCE_STORE"
/Users/harlin/Applications/OpenBot.app/Contents/MacOS/OpenBot \
  "--openbot-acceptance-app-data=$OPENBOT_ACCEPTANCE_ROOT" >/dev/null 2>&1 &
```

Confirm the running executable resolves inside `/Users/harlin/Applications/OpenBot.app` and its command line contains the one exact acceptance flag before interacting.

1. launch causes no app-initiated password prompt and starts no provider login;
2. a preserved legacy profile with bots and no receipt opens the full eight-route chooser and blocks native creation;
3. Direct Codex, one non-Anthropic CLIProxy route, and one API-key or local route each complete real catalog plus bounded inference when the required user authorization is available;
4. General Settings lists all eight routes and can add/disconnect a second route;
5. same-named connected models remain provider-distinct in the composer picker;
6. `New` reaches the stock teammate picker and native profile form after onboarding, while no legacy setup dialog appears;
7. View Bot shows the immediate built-in Free Local Desktop frame, public HTTPS navigation, a forced sanitized unavailable state, and successful retry;
8. simple Power has no unused band and Advanced expands from the anchored compact geometry;
9. Computer status/Change/permissions/Desktop remain in View Bot and absent from Power;
10. one canonical bundle/process remains and stale copies/processes are absent.

If non-Direct provider authorization is unavailable, mark only that authorization-dependent row blocked; do not claim provider completion or substitute another route.

- [ ] **Step 7: Capture required visual evidence**

Store a full screenshot and focused crop for compact Power, Advanced, AI Connections, first-connection onboarding, native New Bot, and live Desktop. Record one short transition/Ultra video. Review representative frames for start, midpoint, end, rapid toggle, reduced motion, and Ultra entry; label this sampled coverage unless every frame is actually inspected.

- [ ] **Step 8: Final acceptance report and cleanup**

Record commit, DMG hash, bundle/ASAR hashes, signature identity, PID/executable, provider routes exercised, blocked authorization rows, screenshot/video paths, and pass/fail for all ten outcomes. Remove only disposable test credentials and verifier state created during this task through the app's disconnect/reset flows; preserve the canonical installed app and user data unless the user explicitly requests removal.

## Self-Review Results

- Spec coverage: all goals, non-goals, layout rules, shared descriptors, six provider methods, eight auth routes, exact routing, legacy-profile onboarding, Settings management, Free Local Desktop start/frame/status/retry, native New/View placement, migration, security, tests, package, and installed acceptance map to Tasks 1–11.
- Concrete-content audit: every implementation step names exact files, commands, expected failures/passes, interfaces, and representative code/assertions; no deferred behavior is left to an implementer.
- Type consistency: canonical IDs, connection/catalog/receipt DTOs, provider facade methods, frame states/codes, and model identity keys use one spelling throughout.
- Ownership audit: only the Renderer worker repeats ownership across Tasks 4 and 5; all concurrent workers have disjoint files. Package/preload ownership is sequential after behavior APIs settle.
- Test sequencing: each behavior begins with focused RED, proceeds to focused GREEN, receives two independent Luna-max cluster gates, then a Sol-xhigh full-diff/source/package gate, then installed acceptance.
- Remaining external blockers: real non-Direct provider authorization, API/local credentials, signing inputs, and user-visible password-prompt observation cannot be manufactured. Task 11 records those rows as blocked when unavailable while preserving every source/package result separately.
