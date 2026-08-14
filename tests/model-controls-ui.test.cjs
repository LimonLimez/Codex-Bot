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
    product: "Codex Bot",
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

test("per-chat picker keeps focus valid and implements the ARIA radio keyboard pattern", () => {
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
    /role="radio" aria-checked="true" tabindex="0" data-codex-pick-reasoning="high"/,
  );
  assert.equal(
    (result.html.match(/tabindex="0"/g) || []).length,
    2,
    "each radio group exposes exactly one tab stop",
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
