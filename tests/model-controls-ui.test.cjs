"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");

test("settings expose honest persisted workspace defaults and private computer mode", () => {
  const ui = read("src/renderer/codex-ui.js");
  assert.match(ui, /Default response/);
  assert.match(ui, /data-codex-default-model/);
  assert.match(ui, /data-codex-default-reasoning/);
  assert.match(ui, /data-codex-default-fast/);
  assert.match(ui, /premium per-token pricing/);
  assert.match(ui, /scope: "default"/);
  assert.match(ui, /Computer mode/);
  assert.match(ui, /Private browser/);
  assert.match(ui, /This is not a free or Codex-only computer/);
  assert.match(
    ui,
    /zero vendor-model activity, zero telemetry, and zero charges cannot be guaranteed/i,
  );
  assert.doesNotMatch(
    ui,
    /Working local settings|Vendor automatic updates|Elon-Only Settings/,
  );
});

test("connection settings render the full CLIProxy provider list and stepped reasoning sliders", () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__providerUi = (() => {
  const providers = [
    ["codex", "OpenAI Codex", "device", true],
    ["claude", "Anthropic Claude", "oauth", false],
    ["antigravity", "Google Antigravity", "oauth", false],
    ["kimi", "Moonshot Kimi", "device", false],
    ["xai", "xAI", "device", false],
    ["vertex", "Google Vertex AI", "service-account", false],
  ].map(([id, label, loginKind, signedIn]) => ({
    id,
    label,
    loginKind,
    signedIn,
    description: label + " connection",
  }));
  const status = {
    connection: {
      mode: "cliproxy-oauth",
      route: "cliproxyapi-codex-oauth",
      provider: "codex",
      providerLabel: "OpenAI Codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
      fastMode: false,
    },
    account: {
      signedIn: true,
      provider: "codex",
      providerLabel: "OpenAI Codex",
      name: "Provider User",
      email: "person@example.test",
      plan: "plus",
    },
    providers,
    usage: { availability: { state: "ready" } },
    officialComputer: { mode: "private", state: "signed-in", connected: true, permissions: {} },
    preferences: {
      catalog: {
        models: [{ id: "gpt-5.6-terra", label: "5.6 Terra", description: "" }],
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        fastMode: { supported: true, default: false },
      },
      defaults: { model: "gpt-5.6-terra", reasoningEffort: "xhigh", fastMode: false },
      effective: { model: "gpt-5.6-terra", reasoningEffort: "xhigh", fastMode: false },
      override: null,
    },
  };
  return {
    settings: connectionPanelHtml(status),
    picker: modelPickerHtml(status),
  };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
    }),
  );
  const result = context.__providerUi;
  for (const provider of [
    "OpenAI Codex",
    "Anthropic Claude",
    "Google Antigravity",
    "Moonshot Kimi",
    "xAI",
    "Google Vertex AI",
  ])
    assert.match(result.settings, new RegExp(provider));
  assert.match(result.settings, /<select[^>]+data-codex-provider/);
  assert.match(result.settings, /data-codex-provider-connect/);
  assert.match(result.settings, /data-codex-vertex-form/);
  assert.match(
    result.settings,
    /type="file" accept="application\/json,\.json"/,
  );
  for (const rendered of [result.settings, result.picker]) {
    assert.match(rendered, /type="range"/);
    assert.match(
      rendered,
      /data-reasoning-values="none\|low\|medium\|high\|xhigh\|max"/,
    );
    assert.match(rendered, /aria-valuetext="Extra high"/);
    assert.match(rendered, /--codex-slider-progress:80%/);
  }
  assert.match(ui, /::-webkit-slider-thumb/);
  assert.match(ui, /\.codex-reasoning-stops>span\.is-active/);
});

test("first-run onboarding presents provider logos, computer choice, and a remembered completion", () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__onboardingUi = (() => {
  const providers = [
    ["codex", "OpenAI Codex", "device"],
    ["claude", "Anthropic Claude", "oauth"],
    ["antigravity", "Google Antigravity", "oauth"],
    ["kimi", "Moonshot Kimi", "device"],
    ["xai", "xAI", "device"],
    ["vertex", "Google Vertex AI", "service-account"],
  ].map(([id, label, loginKind]) => ({ id, label, loginKind, description: label + " account", signedIn: id === "codex" }));
  const status = {
    connection: { mode: "cliproxy-oauth", route: "cliproxyapi-codex-oauth", provider: "codex", providerLabel: "OpenAI Codex" },
    account: { signedIn: true, provider: "codex", name: "Leon Miller", email: "leon@example.test" },
    providers,
    officialComputer: { mode: "private", state: "signed-in", connected: true, ready: false, permissions: {} },
  };
  return {
    providers: onboardingProviderStepHtml(status),
    computer: onboardingComputerStepHtml(status),
    complete: onboardingCompleteStepHtml(status),
  };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
    }),
  );
  const rendered = context.__onboardingUi;
  assert.match(rendered.providers, /Sign in to providers/);
  for (const provider of [
    "OpenAI Codex",
    "Anthropic Claude",
    "Google Antigravity",
    "Moonshot Kimi",
    "xAI",
    "Google Vertex AI",
  ])
    assert.match(rendered.providers, new RegExp(provider));
  assert.equal(
    (rendered.providers.match(/data-codex-onboarding-provider=/g) || []).length,
    6,
  );
  assert.equal((rendered.providers.match(/<img/g) || []).length, 5);
  assert.equal((rendered.providers.match(/<svg/g) || []).length, 1);
  assert.match(rendered.computer, /Choose where employees browse/);
  assert.match(rendered.computer, /Private browser/);
  assert.match(rendered.computer, /Vendor cloud computer/);
  assert.match(rendered.computer, /cursor\.com/);
  assert.match(rendered.computer, /data-codex-computer-official/);
  assert.match(rendered.complete, /You’re all set/);
  assert.match(rendered.complete, /Leon Miller/);
  assert.match(rendered.complete, /Enter Open Bot/);
  assert.match(ui, /open-bot\.onboarding\.v1\.complete/);
  assert.match(ui, /rememberOnboardingCompleted\(\)/);
  assert.match(
    ui,
    /\.codex-vertex-form\[hidden\],\.codex-key-form\[hidden\] \{ display:none !important; \}/,
  );
  assert.doesNotMatch(read("scripts/patch-app.cjs"), /Codex Bot User/);
});

test("first-run onboarding never calls an unsigned provider ready merely because its route is selected", () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__disconnectedOnboarding = onboardingProviderStepHtml({
  connection: {
    mode: "cliproxy-oauth",
    route: "cliproxyapi-codex-oauth",
    provider: "codex",
    providerLabel: "OpenAI Codex",
  },
  account: { signedIn: false, provider: "codex" },
  providers: [{
    id: "codex",
    label: "OpenAI Codex",
    description: "Use a ChatGPT account with Codex access.",
    loginKind: "device",
    signedIn: false,
  }],
  officialComputer: { mode: "private", connected: false, permissions: {} },
});`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
    }),
  );
  const rendered = context.__disconnectedOnboarding;
  assert.match(
    rendered,
    /class="codex-provider-tile"[^>]*aria-pressed="false"/,
  );
  assert.match(rendered, /<small>Sign in<\/small>/);
  assert.match(rendered, />Connect OpenAI Codex<\/button>/);
  assert.match(rendered, /data-codex-onboarding-next="computer" disabled/);
  assert.doesNotMatch(rendered, /Ready to use|is-active/);
});

test("provider sign-in keeps the working route live and a completed switch refreshes every picker catalog", () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__providerTransitionUi = (() => {
  const providers = [
    { id: "codex", label: "OpenAI Codex", description: "Codex", loginKind: "device", signedIn: true, credentialRevision: 1 },
    { id: "claude", label: "Anthropic Claude", description: "Claude", loginKind: "oauth", signedIn: false, credentialRevision: null },
  ];
  const codex = {
    connection: { mode: "cliproxy-oauth", route: "cliproxyapi-codex-oauth", provider: "codex", providerLabel: "OpenAI Codex", model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
    account: { signedIn: true, provider: "codex", name: "Codex User" },
    providers,
    usage: { availability: { state: "ready" } },
    officialComputer: { mode: "private", state: "signed-in", connected: true, permissions: {} },
    preferences: {
      catalog: { models: [{ id: "gpt-5.6-terra", label: "5.6 Terra", description: "" }], reasoningEfforts: ["low", "high"], fastMode: { supported: true } },
      defaults: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      effective: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      override: null,
    },
  };
  const claude = {
    ...codex,
    connection: { mode: "cliproxy-oauth", route: "cliproxyapi-claude-oauth", provider: "claude", providerLabel: "Anthropic Claude", model: "claude-sonnet-5", reasoningEffort: "medium", fastMode: false },
    account: { signedIn: true, provider: "claude", name: "Claude User" },
    providers: providers.map((provider) => provider.id === "claude" ? { ...provider, signedIn: true, credentialRevision: 2 } : provider),
    preferences: {
      catalog: {
        models: [
          { id: "claude-opus-5", label: "Claude Opus 5", description: "" },
          { id: "claude-sonnet-5", label: "Claude Sonnet 5", description: "" },
        ],
        reasoningEfforts: ["none", "medium", "max"],
        fastMode: { supported: false },
      },
      defaults: { model: "claude-sonnet-5", reasoningEffort: "medium", fastMode: false },
      effective: { model: "claude-sonnet-5", reasoningEffort: "medium", fastMode: false },
      override: null,
    },
  };
  lastStatus = codex;
  pendingOAuthDevice = {
    provider: "claude",
    providerLabel: "Anthropic Claude",
    url: "https://claude.ai/oauth/authorize?test=1",
    message: "Finish sign-in.",
    previousCredentialRevision: null,
    deadlineAt: Date.now() + 60_000,
  };
  agentStatusCache.set("employee-1", codex);
  const pendingHtml = connectionPanelHtml(codex);
  pendingOAuthDevice = null;
  acceptAuthoritativeStatus(claude);
  return {
    pendingHtml,
    cacheSize: agentStatusCache.size,
    settingsHtml: connectionPanelHtml(lastStatus),
    pickerHtml: modelPickerHtml(lastStatus),
  };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
    }),
  );

  const result = context.__providerTransitionUi;
  assert.match(result.pendingHtml, /cliproxyapi-codex-oauth/);
  assert.match(
    result.pendingHtml,
    /value="claude"[^>]+selected[^>]*>Anthropic Claude/,
  );
  assert.equal(result.cacheSize, 0);
  for (const rendered of [result.settingsHtml, result.pickerHtml]) {
    assert.match(rendered, /claude-sonnet-5/);
    assert.doesNotMatch(rendered, /gpt-5\.6-terra/);
    assert.match(rendered, /data-reasoning-values="none\|medium\|max"/);
  }
  assert.match(result.pickerHtml, /Claude Opus 5/);
  assert.match(result.pickerHtml, /Claude Sonnet 5/);
  assert.match(ui, /Cancel sign-in/);
  assert.match(ui, /cancel-provider-login/);
  assert.match(ui, /const connectControl = event\.currentTarget;/);
  assert.match(ui, /const selectControl = event\.currentTarget;/);
  assert.doesNotMatch(ui, /finally\s*\{\s*if \(event\.currentTarget/);
});

test("a provider choice survives settings rerenders before Connect is clicked", () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__providerChoice = (() => {
  const status = {
    connection: { mode: "cliproxy-oauth", route: "cliproxyapi-codex-oauth", provider: "codex", model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
    account: { signedIn: true, provider: "codex", name: "Codex User" },
    providers: [
      { id: "codex", label: "OpenAI Codex", description: "Codex", loginKind: "device", signedIn: true },
      { id: "claude", label: "Anthropic Claude", description: "Claude", loginKind: "oauth", signedIn: false },
    ],
    usage: { availability: { state: "ready" } },
    preferences: { catalog: { models: [], reasoningEfforts: [], fastMode: { supported: true } }, defaults: {}, effective: {}, override: null },
  };
  selectedProviderId = "claude";
  providerConnectionNotice = { message: "", tone: "info" };
  const first = connectionPanelHtml(status);
  providerConnectionNotice = { message: "Preparing", tone: "info" };
  const rebuilt = connectionPanelHtml(status);
  return { first, rebuilt };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
    }),
  );
  for (const html of [
    context.__providerChoice.first,
    context.__providerChoice.rebuilt,
  ]) {
    assert.match(html, /value="claude"[^>]+selected[^>]*>Anthropic Claude/);
    assert.match(html, />Connect Anthropic Claude<\/button>/);
  }
});

test("provider polling activates exactly once after a new credential appears and timeout cancellation stays non-blocking", async () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  const context = {
    console,
    TextEncoder,
    URL,
    encodeURIComponent,
    setInterval,
    clearInterval,
  };
  const result = await vm.runInNewContext(
    `${executable}
(async () => {
  const base = {
    connection: { mode: "cliproxy-oauth", route: "cliproxyapi-codex-oauth", provider: "codex", model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
    account: { signedIn: true, provider: "codex", name: "Codex User" },
    providers: [
      { id: "codex", signedIn: true, credentialRevision: 1 },
      { id: "claude", signedIn: false, credentialRevision: null },
    ],
    officialComputer: { mode: "private", state: "signed-in", connected: true },
    preferences: {
      catalog: { models: [{ id: "gpt-5.6-terra", label: "5.6 Terra" }], reasoningEfforts: ["low", "high"], fastMode: { supported: true } },
      defaults: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      effective: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      override: null,
    },
  };
  const connected = {
    ...base,
    providers: base.providers.map((provider) => provider.id === "claude" ? { ...provider, signedIn: true, credentialRevision: 2 } : provider),
  };
  const claude = {
    ...connected,
    connection: { mode: "cliproxy-oauth", route: "cliproxyapi-claude-oauth", provider: "claude", model: "claude-sonnet-5", reasoningEffort: "medium", fastMode: false },
    account: { signedIn: true, provider: "claude", name: "Claude User" },
    preferences: {
      catalog: { models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }], reasoningEfforts: ["none", "medium", "max"], fastMode: { supported: false } },
      defaults: { model: "claude-sonnet-5", reasoningEffort: "medium", fastMode: false },
      effective: { model: "claude-sonnet-5", reasoningEffort: "medium", fastMode: false },
      override: null,
    },
  };
  const statuses = [base, connected];
  const actions = [];
  request = async (pathname, body) => {
    if (pathname === "/api/codex/status") return statuses.shift();
    actions.push(body);
    if (body.action === "use-provider") return { status: claude };
    if (body.action === "cancel-provider-login") return { ok: true };
    throw new Error("unexpected request");
  };
  officialComputerState = () => ({ mode: "private", state: "signed-in", connected: true });
  completeOfficialEnableAfterCursorLogin = async (status) => status;
  syncOfficialConnectionPolling = () => {};
  applyUi = () => {};
  pendingOAuthDevice = {
    provider: "claude",
    providerLabel: "Anthropic Claude",
    previousCredentialRevision: null,
    deadlineAt: Date.now() + 60_000,
  };
  await loadStatus();
  const first = { provider: lastStatus.connection.provider, pending: pendingOAuthDevice.provider, actions: actions.length };
  await loadStatus();
  const second = { provider: lastStatus.connection.provider, pending: pendingOAuthDevice, actions: [...actions], models: inferenceState(lastStatus).models.map((model) => model.id), efforts: inferenceState(lastStatus).reasoningEfforts };
  pendingOAuthDevice = {
    provider: "claude",
    providerLabel: "Anthropic Claude",
    previousCredentialRevision: null,
    deadlineAt: Date.now() - 1,
  };
  await completePendingProviderLogin(lastStatus);
  return { first, second, timeoutPending: pendingOAuthDevice, notice: providerConnectionNotice };
})()`,
    Object.assign(context, {
      document: {
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        },
      },
    }),
  );

  assert.deepEqual(
    { ...result.first },
    {
      provider: "codex",
      pending: "claude",
      actions: 0,
    },
  );
  assert.equal(result.second.provider, "claude");
  assert.equal(result.second.pending, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.second.actions)), [
    { action: "use-provider", provider: "claude" },
  ]);
  assert.deepEqual([...result.second.models], ["claude-sonnet-5"]);
  assert.deepEqual([...result.second.efforts], ["none", "medium", "max"]);
  assert.equal(result.timeoutPending, null);
  assert.equal(result.notice.tone, "info");
  assert.match(result.notice.message, /timed out/i);
});

test("settings mutations preserve omitted verified status without inventing provider state", async () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  assert.ok(
    executable.length < ui.length,
    "renderer setup boundary must exist",
  );

  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__statusMergeRegression = (async () => {
  const previous = {
    product: "Open Bot",
    connection: {
      mode: "codex-oauth",
      route: "cliproxyapi-codex-oauth",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      fastMode: false,
    },
    account: {
      signedIn: true,
      email: "verified@example.test",
      plan: "Plus",
    },
    usage: {
      totalTokens: 120,
      availability: {
        state: "usage-limit",
        message: "Wait for the current allowance window.",
        resetsAt: "2026-08-14T12:00:00.000Z",
      },
    },
    officialComputer: {
      mode: "private",
      connected: true,
      ready: true,
      state: "signed-in",
      retrying: false,
    },
    preferences: {
      catalog: {
        models: [{ id: "gpt-5.6-terra", label: "5.6 Terra", description: "" }],
        reasoningEfforts: ["high", "max"],
      },
      defaults: {
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        fastMode: false,
      },
      effective: {
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        fastMode: false,
      },
      override: null,
    },
    verifiedPlugins: ["verified-plugin"],
  };
  const mutationStatus = {
    connection: {
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      fastMode: true,
    },
    account: { signedIn: true },
    usage: { totalTokens: 121 },
    preferences: {
      defaults: {
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        fastMode: true,
      },
      effective: {
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        fastMode: true,
      },
      override: null,
    },
    verifiedPlugins: [],
  };
  lastStatus = previous;
  request = async (path) => {
    if (path !== "/api/codex/settings") throw new Error("Unexpected request");
    return { ok: true, status: mutationStatus };
  };
  const saved = await saveInferenceSettings({
    scope: "default",
    model: "gpt-5.6-sol",
  });
  const noPriorProvider = mergeStatusSnapshot(null, mutationStatus);
  return {
    saved,
    lastStatus,
    missingProviderMode: officialComputerState(noPriorProvider).mode,
    missingProviderWasInvented: Object.prototype.hasOwnProperty.call(
      noPriorProvider,
      "officialComputer",
    ),
  };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
    }),
  );

  const result = await context.__statusMergeRegression;
  assert.equal(result.saved, result.lastStatus);
  assert.equal(result.saved.connection.model, "gpt-5.6-sol");
  assert.equal(result.saved.connection.mode, "codex-oauth");
  assert.equal(result.saved.connection.route, "cliproxyapi-codex-oauth");
  assert.equal(result.saved.account.signedIn, true);
  assert.equal(result.saved.account.email, "verified@example.test");
  assert.equal(result.saved.account.plan, "Plus");
  assert.equal(result.saved.usage.totalTokens, 121);
  assert.equal(result.saved.usage.availability.state, "usage-limit");
  assert.equal(
    result.saved.usage.availability.message,
    "Wait for the current allowance window.",
  );
  assert.equal(result.saved.officialComputer.mode, "private");
  assert.equal(result.saved.officialComputer.connected, true);
  assert.equal(result.saved.officialComputer.ready, true);
  assert.equal(result.saved.preferences.catalog.models[0].id, "gpt-5.6-terra");
  assert.equal(result.saved.preferences.defaults.model, "gpt-5.6-sol");
  assert.equal(result.saved.verifiedPlugins.length, 0);
  assert.equal(result.missingProviderMode, "unknown");
  assert.equal(result.missingProviderWasInvented, false);
});

test("each employee composer gets an accessible per-chat picker left of the stock action cluster", () => {
  const ui = read("src/renderer/codex-ui.js");
  assert.match(ui, /form\[data-codex-agent-id\]/);
  assert.match(ui, /cluster\.before\(button\)/);
  assert.match(ui, /button\.dataset\.codexAgentId = agentId/);
  assert.match(ui, /aria-haspopup/);
  assert.match(ui, /aria-expanded/);
  assert.match(ui, /role", "dialog"/);
  assert.match(ui, /data-codex-use-defaults/);
  assert.match(ui, /event\.key !== "Escape"/);
  assert.match(ui, /prefers-reduced-motion:reduce/);
  assert.match(ui, /function boltIcon/);
});

test("per-chat picker keeps focus valid with model radios and a native reasoning slider", () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  assert.ok(
    executable.length < ui.length,
    "renderer setup boundary must exist",
  );

  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__pickerAccessibility = (() => {
  const status = {
    connection: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
    preferences: {
      catalog: {
        models: [
          { id: "gpt-5.6-sol", label: "5.6 Sol", description: "" },
          { id: "gpt-5.6-terra", label: "5.6 Terra", description: "" },
          { id: "gpt-5.6-luna", label: "5.6 Luna", description: "" },
        ],
        reasoningEfforts: ["low", "medium", "high"],
      },
      defaults: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      effective: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      override: null,
    },
  };
  const html = modelPickerHtml(status);

  const focused = [];
  const clicked = [];
  let group;
  const makeRadio = (name) => ({
    disabled: false,
    focus() { focused.push(name); },
    click() { clicked.push(name); },
    closest(selector) {
      if (selector === '[role="radio"]') return this;
      if (selector === '[role="radiogroup"]') return group;
      return null;
    },
  });
  const radios = [makeRadio("first"), makeRadio("middle"), makeRadio("last")];
  group = {
    querySelectorAll(selector) {
      if (selector !== '[role="radio"]:not(:disabled)') throw new Error("Unexpected selector: " + selector);
      return radios;
    },
  };
  activeModelPicker = {
    element: { contains(node) { return node === group; } },
  };
  const dispatch = (key, target) => {
    let prevented = false;
    let stopped = false;
    const handled = handleModelPickerRadioKeydown({
      key,
      target,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });
    return { handled, prevented, stopped };
  };
  const keyResults = [
    dispatch("ArrowRight", radios[0]),
    dispatch("ArrowLeft", radios[0]),
    dispatch("ArrowDown", radios[2]),
    dispatch("ArrowUp", radios[0]),
    dispatch("Home", radios[2]),
    dispatch("End", radios[0]),
  ];
  const tabResult = dispatch("Tab", radios[0]);

  const focusEvents = [];
  const disabledDefaults = {
    disabled: true,
    focus() { focusEvents.push("disabled defaults"); },
  };
  const checkedModel = {
    disabled: false,
    focus() { focusEvents.push("checked model"); },
  };
  focusModelPickerControl(
    {
      querySelector(selector) {
        if (selector === "[data-codex-use-defaults]") return disabledDefaults;
        if (selector.includes("[data-codex-pick-model]")) return checkedModel;
        return null;
      },
    },
    "[data-codex-use-defaults]",
  );

  const attributes = {
    "aria-controls": "codex-model-popover-test",
    "aria-expanded": "true",
  };
  let removed = false;
  const button = {
    isConnected: true,
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    focus() {},
  };
  activeModelPicker = {
    button,
    element: { remove() { removed = true; } },
    onViewportChange() {},
  };
  closeModelPicker({ returnFocus: false });

  return {
    html,
    focused,
    clicked,
    keyResults,
    tabResult,
    focusEvents,
    attributes,
    removed,
  };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
      window: {
        removeEventListener() {},
      },
    }),
  );

  const result = context.__pickerAccessibility;
  assert.match(
    result.html,
    /role="radio" aria-checked="true" tabindex="0" data-codex-pick-model="gpt-5\.6-terra"/,
  );
  assert.match(
    result.html,
    /type="range" min="0" max="2" step="1" value="2"[^>]+aria-valuetext="High"[^>]+data-reasoning-values="low\|medium\|high"[^>]+data-codex-pick-reasoning/,
  );
  assert.equal(
    (result.html.match(/tabindex="0"/g) || []).length,
    1,
    "the model radio group exposes one tab stop while the native range remains keyboard focusable",
  );
  assert.deepEqual(
    [...result.focused],
    ["middle", "last", "first", "last", "first", "last"],
  );
  assert.deepEqual([...result.clicked], [...result.focused]);
  assert.ok(
    result.keyResults.every(
      ({ handled, prevented, stopped }) => handled && prevented && stopped,
    ),
  );
  assert.deepEqual(
    { ...result.tabResult },
    {
      handled: false,
      prevented: false,
      stopped: false,
    },
  );
  assert.deepEqual([...result.focusEvents], ["checked model"]);
  assert.equal(result.attributes["aria-expanded"], "false");
  assert.equal(result.attributes["aria-controls"], undefined);
  assert.equal(result.removed, true);
  assert.match(
    ui,
    /focusSelector:\s*"\[data-codex-pick-model\]\[aria-checked='true'\]"/,
  );
});

test("mounted employee pickers restore their saved override without opening the popover", async () => {
  const ui = read("src/renderer/codex-ui.js");
  const executable = ui.slice(0, ui.indexOf("document.addEventListener("));
  assert.ok(
    executable.length < ui.length,
    "renderer setup boundary must exist",
  );

  const context = { console, TextEncoder, URL, encodeURIComponent };
  vm.runInNewContext(
    `${executable}
globalThis.__pickerRegression = (async () => {
  const catalog = {
    models: ${JSON.stringify([
      { id: "gpt-5.6-sol", label: "5.6 Sol", description: "" },
      { id: "gpt-5.6-terra", label: "5.6 Terra", description: "" },
      { id: "gpt-5.6-luna", label: "5.6 Luna", description: "" },
    ])},
    reasoningEfforts: ["low", "high"],
  };
  const defaults = {
    connection: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
    preferences: {
      catalog,
      defaults: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      effective: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
      override: null,
    },
  };
  const restored = {
    connection: defaults.connection,
    preferences: {
      catalog,
      defaults: defaults.preferences.defaults,
      effective: { model: "gpt-5.6-luna", reasoningEffort: "low", fastMode: true },
      override: { model: "gpt-5.6-luna", reasoningEffort: "low", fastMode: true },
    },
  };
  let installedButton = null;
  const parent = { querySelector: () => installedButton };
  const cluster = {
    parentElement: parent,
    before(button) { installedButton = button; },
  };
  const form = {
    dataset: { codexAgentId: "employee-1" },
    querySelector: () => cluster,
  };
  document.querySelectorAll = (selector) => {
    if (selector === "form[data-codex-agent-id]") return [form];
    if (selector === "[data-codex-model-picker]") return installedButton ? [installedButton] : [];
    return [];
  };
  document.createElement = () => ({
    dataset: {},
    attributes: {},
    classList: { toggle() {} },
    isConnected: true,
    innerHTML: "",
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; },
  });

  let resolveRestore;
  const restoreResponse = new Promise((resolve) => { resolveRestore = resolve; });
  let agentLoads = 0;
  request = (path) => {
    if (!path.startsWith("/api/codex/status?agentId=")) throw new Error("Unexpected request");
    agentLoads += 1;
    return restoreResponse;
  };
  lastStatus = defaults;
  installModelPickers();
  const bootstrapLabel = installedButton.innerHTML;
  installModelPickers();
  installModelPickers();
  resolveRestore(restored);
  await Promise.all([...pendingAgentStatusLoads.values()]);
  const restoredLabel = installedButton.innerHTML;
  const restoredAria = installedButton.attributes["aria-label"];

  const changedDefaults = structuredClone(defaults);
  changedDefaults.preferences.defaults = {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    fastMode: false,
  };
  changedDefaults.preferences.effective = changedDefaults.preferences.defaults;
  request = (path) => {
    if (path === "/api/codex/settings") return Promise.resolve({ status: changedDefaults });
    agentLoads += 1;
    return Promise.resolve(restored);
  };
  await saveInferenceSettings({ scope: "default", model: "gpt-5.6-sol" });
  await Promise.all([...pendingAgentStatusLoads.values()]);

  return {
    agentLoads,
    bootstrapLabel,
    restoredLabel,
    restoredAria,
    afterDefaultSave: installedButton.innerHTML,
  };
})();`,
    Object.assign(context, {
      document: {
        querySelectorAll() {
          return [];
        },
      },
      structuredClone,
    }),
  );

  const result = await context.__pickerRegression;
  assert.match(result.bootstrapLabel, /5\.6 Terra[\s\S]*High/);
  assert.match(result.restoredLabel, /5\.6 Luna[\s\S]*Low/);
  assert.match(result.restoredAria, /5\.6 Luna, Low reasoning, Fast mode/);
  assert.match(result.afterDefaultSave, /5\.6 Luna[\s\S]*Low/);
  assert.equal(result.agentLoads, 2, "refreshes are deduplicated per employee");
});

test("Fast mode is backed by all verified OAuth aliases and a post-translation priority override", () => {
  const installer = read("scripts/Install-CodexBot.ps1");
  const bridge = read("src/bridge.cjs");
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.match(
      installer,
      new RegExp(
        `name: "${model.replaceAll(".", "\\.")}"[\\s\\S]*?alias: "${model.replaceAll(".", "\\.")}-fast"`,
      ),
    );
  }
  assert.match(installer, /service_tier: priority/);
  assert.match(bridge, /cliproxy-model-alias/);
  assert.match(bridge, /serviceTier: "fast"/);
  assert.match(bridge, /serviceTier: "default"/);
  assert.match(bridge, /getConnection\(this\.agentId\)/);
});
