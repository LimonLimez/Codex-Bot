"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const uiPath = path.join(__dirname, "..", "src", "renderer", "bot-runtime-ui.js");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";

function bot(botId, name, state) {
  return Object.freeze({
    botId,
    name,
    runtime: Object.freeze({ state }),
  });
}

class FakeClassList {
  #values = new Set();

  add(...values) {
    for (const value of values) this.#values.add(value);
  }

  remove(...values) {
    for (const value of values) this.#values.delete(value);
  }

  contains(value) {
    return this.#values.has(value);
  }

  toggle(value, force) {
    if (force === undefined ? !this.#values.has(value) : force) this.#values.add(value);
    else this.#values.delete(value);
    return this.#values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.classList = new FakeClassList();
    this.attributes = Object.create(null);
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.hidden = false;
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }
}

const fakeDocument = Object.freeze({
  createElement(tagName) {
    return new FakeElement(tagName);
  },
});

test("runtime presentation is truthful and never offers a local fallback", () => {
  const { runtimePresentation } = require(uiPath);
  assert.deepEqual(runtimePresentation("ready"), {
    label: "Remote computer ready",
    controlsEnabled: true,
    retryVisible: false,
    tone: "ready",
  });
  assert.deepEqual(runtimePresentation("provisioning"), {
    label: "Starting remote computer…",
    controlsEnabled: false,
    retryVisible: false,
    tone: "pending",
  });
  assert.deepEqual(runtimePresentation("reconnecting"), {
    label: "Reconnecting to remote computer…",
    controlsEnabled: false,
    retryVisible: false,
    tone: "pending",
  });
  for (const state of ["unavailable", "failed", "unprovisioned", "detached", "retired"] ) {
    const view = runtimePresentation(state);
    assert.equal(view.label, "Remote computer unavailable");
    assert.equal(view.controlsEnabled, false);
    assert.equal(view.retryVisible, true);
    assert.doesNotMatch(JSON.stringify(view), /local|shared|this Mac/i);
  }
});

test("the reviewed optional-provider manifest preserves model-specific Ultra Code positions", () => {
  const { MODEL_CATALOG } = require(uiPath);
  assert.deepEqual(
    MODEL_CATALOG.map(({ model, efforts }) => [model, efforts]),
    [
      ["claude-fable-5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]],
      ["claude-opus-5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]],
      ["claude-sonnet-5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]],
    ],
  );
  assert.equal(Object.isFrozen(MODEL_CATALOG), true);
  assert.equal(Object.isFrozen(MODEL_CATALOG[0].efforts), true);
});

test("reasoning control preserves the approved direct-child topology and exact tick counts", () => {
  const { createReasoningView, updateReasoningView } = require(uiPath);
  const view = createReasoningView(fakeDocument);
  assert.deepEqual(
    view.control.children.map((child) => child.className),
    ["codex-reasoning-track", "codex-reasoning-thumb-rail", "codex-reasoning-input"],
  );
  assert.deepEqual(
    view.track.children.map((child) => child.className),
    [
      "codex-reasoning-fill",
      "codex-reasoning-ultra-fill",
      "codex-reasoning-particles",
      "codex-reasoning-ticks",
    ],
  );
  assert.equal(view.particles.children.length, 14);
  assert.equal(view.burst.children.length, 16);
  assert.equal(view.input.value, "1");

  updateReasoningView(view, ["low", "medium", "high", "xhigh", "max", "ultra"], 4, {
    enteredUltra: false,
  });
  assert.equal(view.ticks.children.length, 6);
  assert.equal(view.control.classList.contains("is-max"), true);
  assert.equal(view.control.classList.contains("is-ultra"), false);
  assert.equal(view.input.attributes["aria-valuetext"], "Max");

  updateReasoningView(view, ["low", "medium", "high", "xhigh", "max", "ultra"], 5, {
    enteredUltra: true,
  });
  assert.equal(view.control.classList.contains("is-max"), false);
  assert.equal(view.control.classList.contains("is-ultra"), true);
  assert.equal(view.control.classList.contains("is-ultra-entering"), true);
  assert.equal(view.warning.hidden, false);

  updateReasoningView(view, ["low", "medium", "high", "xhigh"], 3, {
    enteredUltra: false,
  });
  assert.equal(view.ticks.children.length, 4);
  assert.equal(view.control.classList.contains("is-ultra"), false);
  assert.equal(view.warning.hidden, true);
  assert.equal(view.input.attributes["aria-valuetext"], "Extra High");

  updateReasoningView(view, ["low", "medium", "high", "xhigh", "max", "ultra-code"], 5, {
    enteredUltra: true,
  });
  assert.equal(view.control.classList.contains("is-ultra"), true);
  assert.equal(view.control.classList.contains("is-ultra-code"), true);
  assert.equal(view.warning.hidden, false);
  assert.equal(view.input.attributes["aria-valuetext"], "Ultra Code");
});

test("bot controller uses literal zero-argument New Bot and explicit rename/retry", async () => {
  const { createBotUiController } = require(uiPath);
  const calls = [];
  let listener;
  const records = [bot(BOT_A, "New Bot", "ready")];
  const facade = {
    async list() {
      calls.push(["list", arguments.length]);
      return records;
    },
    async create() {
      calls.push(["create", arguments.length]);
      return bot(BOT_B, "New Bot", "provisioning");
    },
    async rename(botId, name) {
      calls.push(["rename", botId, name]);
      return bot(botId, name, "ready");
    },
    async retryRuntime(botId) {
      calls.push(["retry", botId]);
      return bot(botId, "Renamed", "provisioning");
    },
    onChanged(callback) {
      listener = callback;
      return () => calls.push(["unsubscribe"]);
    },
  };
  const selected = [];
  const controller = createBotUiController({
    facade,
    onSelectionChanged(botId) {
      selected.push(botId);
    },
  });
  await controller.initialize();
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  await controller.createBot();
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.deepEqual(calls.find(([name]) => name === "create"), ["create", 0]);
  await controller.renameActive("  Renamed  ");
  assert.equal(controller.snapshot().activeBot.name, "Renamed");
  listener(bot(BOT_B, "Renamed", "failed"));
  await controller.retryActive();
  assert.deepEqual(calls.find(([name]) => name === "retry"), ["retry", BOT_B]);
  assert.deepEqual(selected, [null, BOT_A, null, BOT_B]);
  controller.dispose();
  assert.deepEqual(calls.at(-1), ["unsubscribe"]);
});

test("model selection is main-owned, exact, and independent from remote Work readiness", async () => {
  const { createBotUiController } = require(uiPath);
  const calls = [];
  let current = bot(BOT_A, "New Bot", "ready");
  const controller = createBotUiController({
    facade: {
      async list() { return [current]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) {
        calls.push({ selectedBotId: botId });
        return botId;
      },
      async selectModel(selection) {
        calls.push(selection);
        return Object.freeze({
          ...selection,
          provider: "openai-codex",
          serviceTier: null,
          catalogGeneration: 5,
          generation: calls.length,
        });
      },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({
          generation: 5,
          status: "ready",
          models: Object.freeze([
            Object.freeze({
              id: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
            }),
            Object.freeze({
              id: "gpt-5.5",
              displayName: "GPT-5.5",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
            }),
          ]),
        });
      },
    },
  });
  await controller.initialize();
  assert.deepEqual(calls.shift(), { selectedBotId: BOT_A });
  await controller.selectModel("gpt-5.6-sol", "ultra");
  assert.deepEqual(calls, [{ botId: BOT_A, model: "gpt-5.6-sol", reasoningEffort: "ultra" }]);
  await assert.rejects(() => controller.selectModel("gpt-5.5", "ultra"), /selection/i);
  current = bot(BOT_A, "New Bot", "unavailable");
  controller.applyBot(current);
  await controller.selectModel("gpt-5.6-sol", "high");
  assert.deepEqual(calls.at(-1), { botId: BOT_A, model: "gpt-5.6-sol", reasoningEffort: "high" });
});

test("bot selection renders the authoritative persisted model and suppresses stale selection reads", async () => {
  const { createBotUiController } = require(uiPath);
  const releases = new Map();
  const selections = new Map([
    [BOT_A, Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
      serviceTier: null,
      catalogGeneration: 12,
      generation: 7,
    })],
    [BOT_B, Object.freeze({
      botId: BOT_B,
      provider: "openai-codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      serviceTier: null,
      catalogGeneration: 12,
      generation: 3,
    })],
  ]);
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return selections.get(botId); },
      readModel(botId) {
        if (botId === BOT_A && releases.has(botId)) {
          return new Promise((resolve) => releases.set(botId, () => resolve(selections.get(botId))));
        }
        return Promise.resolve(selections.get(botId));
      },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({
          generation: 12,
          status: "ready",
          models: Object.freeze([
            Object.freeze({
              id: "gpt-5.6-terra",
              displayName: "GPT-5.6 Terra",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
            }),
            Object.freeze({
              id: "gpt-5.5",
              displayName: "GPT-5.5",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
            }),
          ]),
        });
      },
    },
  });
  await controller.initialize();
  assert.deepEqual(controller.snapshot().modelSelection, selections.get(BOT_A));

  releases.set(BOT_A, null);
  const stale = controller.selectBot(BOT_B).then(() => controller.selectBot(BOT_A));
  await new Promise((resolve) => setImmediate(resolve));
  const current = controller.selectBot(BOT_B);
  releases.get(BOT_A)?.();
  await assert.rejects(stale, /selection changed/i);
  await current;
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.deepEqual(controller.snapshot().modelSelection, selections.get(BOT_B));
});

test("the renderer uses the live official catalog and refreshes an unsupported saved tuple", async () => {
  const { createBotUiController } = require(uiPath);
  let catalogListener;
  let catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-live-only",
      displayName: "GPT Live Only",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: Object.freeze(["medium", "high", "ultra"]),
      inputModalities: Object.freeze(["text", "image"]),
      supportsPersonality: false,
      isDefault: true,
    })]),
  });
  let stored = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-live-only",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 4,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return stored; },
      async readModel() { return stored; },
    },
    accountFacade: {
      async catalog() { return catalog; },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
  });
  await controller.initialize();
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), [
    "gpt-live-only", "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
  ]);
  assert.deepEqual(controller.snapshot().modelSelection, stored);

  catalog = Object.freeze({
    generation: 13,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-replacement",
      displayName: "GPT Replacement",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium"]),
      inputModalities: Object.freeze(["text"]),
      supportsPersonality: false,
      isDefault: true,
    })]),
  });
  stored = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-replacement",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 13,
    generation: 5,
  });
  catalogListener(catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().modelCatalog[0].model, "gpt-replacement");
  assert.deepEqual(controller.snapshot().modelSelection, stored);
});

test("a loading official catalog keeps reviewed optional models usable until the live catalog arrives", async () => {
  const { createBotUiController } = require(uiPath);
  let catalogListener;
  const stored = Object.freeze({
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 2,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return stored; },
      async readModel() { return stored; },
    },
    accountFacade: {
      async catalog() { return Object.freeze({ generation: 0, status: "loading", models: Object.freeze([]) }); },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
  });
  await controller.initialize();
  assert.deepEqual(controller.snapshot().modelSelection, stored);
  assert.equal(controller.snapshot().modelCatalog[0].model, "claude-fable-5");
  catalogListener(Object.freeze({
    generation: 2,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-live",
      displayName: "GPT Live",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "high"]),
    })]),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), [
    "gpt-live", "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
  ]);
});

test("a pending official catalog keeps the bot active so a reviewed optional model can be chosen", async () => {
  const { createBotUiController } = require(uiPath);
  const official = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-not-loaded-yet",
    reasoningEffort: "high",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 2,
  });
  const optional = Object.freeze({
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 3,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "unavailable")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return official; },
      async readModel() { return official; },
      async selectModel() { return optional; },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({ generation: 0, status: "loading", models: Object.freeze([]) });
      },
      onCatalogChanged() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  assert.equal(controller.snapshot().modelSelection, null);
  await controller.selectModel("claude-fable-5", "ultra-code");
  assert.deepEqual(controller.snapshot().modelSelection, optional);
});

test("a newer catalog event wins over an older in-flight catalog reply", async () => {
  const { createBotUiController } = require(uiPath);
  let catalogListener;
  let releaseCatalog;
  const newer = Object.freeze({
    generation: 13,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-newer",
      displayName: "GPT Newer",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: Object.freeze(["medium", "high"]),
    })]),
  });
  const stored = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-newer",
    reasoningEffort: "high",
    serviceTier: null,
    catalogGeneration: 13,
    generation: 2,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return stored; },
      async readModel() { return stored; },
    },
    accountFacade: {
      catalog() { return new Promise((resolve) => { releaseCatalog = resolve; }); },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
  });
  const initialization = controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  catalogListener(newer);
  releaseCatalog(Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-older",
      displayName: "GPT Older",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
    })]),
  }));
  await initialization;
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  assert.deepEqual(controller.snapshot().modelSelection, stored);
  assert.equal(controller.snapshot().modelCatalog[0].model, "gpt-newer");
});

test("unavailable or malformed catalog events fail closed without disabling reviewed optional models", async () => {
  const { createBotUiController } = require(uiPath);
  let catalogListener;
  const stored = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-live",
    reasoningEffort: "high",
    serviceTier: null,
    catalogGeneration: 8,
    generation: 2,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return stored; },
      async readModel() { return stored; },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({
          generation: 8,
          status: "ready",
          models: Object.freeze([Object.freeze({
            id: "gpt-live",
            displayName: "GPT Live",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: Object.freeze(["medium", "high"]),
          })]),
        });
      },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
  });
  await controller.initialize();
  catalogListener(Object.freeze({ generation: 9, status: "unavailable", models: Object.freeze([]) }));
  assert.equal(controller.snapshot().modelSelection, null);
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), [
    "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
  ]);
  catalogListener(Object.freeze({ generation: 10, status: "ready", models: "private malformed" }));
  assert.equal(controller.snapshot().modelSelection, null);
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), [
    "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
  ]);
});

test("initialization and creation keep send gated until the main-owned selection is durable", async () => {
  const { createBotUiController } = require(uiPath);
  const releases = [];
  const selected = [];
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "unavailable")]; },
      async create() { return bot(BOT_B, "New Bot", "provisioning"); },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      selectBot(botId) {
        return new Promise((resolve) => releases.push(() => resolve(botId)));
      },
    },
    onSelectionChanged(botId) { selected.push(botId); },
  });
  let initialized = false;
  const initialization = controller.initialize().then(() => { initialized = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initialized, false);
  assert.deepEqual(selected, [null]);
  releases.shift()();
  await initialization;
  assert.deepEqual(selected, [null, BOT_A]);

  let created = false;
  const creation = controller.createBot().then(() => { created = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, false);
  assert.deepEqual(selected, [null, BOT_A, null]);
  releases.shift()();
  await creation;
  assert.deepEqual(selected, [null, BOT_A, null, BOT_B]);
});

test("runtime events remain scoped to the selected bot and detach on disposal", async () => {
  const { createBotUiController } = require(uiPath);
  let runtimeListener;
  let runtimeUnsubscribed = 0;
  const delivered = [];
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return botId; },
      onEvent(callback) {
        runtimeListener = callback;
        return () => { runtimeUnsubscribed += 1; };
      },
    },
    onRuntimeEvent(event) { delivered.push(event); },
  });
  await controller.initialize();
  const eventA = Object.freeze({
    botId: BOT_A,
    generation: 4,
    runtime: Object.freeze({ state: "ready" }),
    event: Object.freeze({ type: "computer/frame", sequence: 1 }),
  });
  const eventB = Object.freeze({
    botId: BOT_B,
    generation: 8,
    runtime: Object.freeze({ state: "ready" }),
    event: Object.freeze({ type: "computer/frame", sequence: 2 }),
  });
  runtimeListener(eventB);
  runtimeListener(eventA);
  controller.selectBot(BOT_B);
  runtimeListener(eventA);
  runtimeListener(eventB);
  assert.deepEqual(delivered, [eventA, eventB]);
  controller.dispose();
  assert.equal(runtimeUnsubscribed, 1);
});

test("provider connection uses only the fixed CLIProxyAPI provider facade", async () => {
  const { createBotUiController } = require(uiPath);
  const calls = [];
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return botId; },
      async connectProvider(provider) { calls.push(provider); },
    },
  });
  await controller.initialize();
  await controller.connectProvider("claude");
  assert.deepEqual(calls, ["claude"]);
  await assert.rejects(() => controller.connectProvider("xai"), /provider/i);
  assert.deepEqual(calls, ["claude"]);
});

test("official Codex sign-in never starts CLIProxy while optional providers remain explicit", async () => {
  const { createBotUiController } = require(uiPath);
  const calls = [];
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return botId; },
      async connectProvider(provider) { calls.push(["cliproxy", provider]); },
    },
    accountFacade: {
      async login(mode) { calls.push(["official", mode]); },
    },
  });
  await controller.initialize();
  await controller.connectProvider("codex");
  await controller.connectProvider("claude");
  assert.deepEqual(calls, [["official", "browser"], ["cliproxy", "claude"]]);
});

test("UI mount discovery selects explicit or semantic sidebar and composer hosts", () => {
  const { findUiMounts } = require(uiPath);
  const explicitSidebar = { id: "sidebar" };
  const explicitComposer = { id: "composer" };
  const explicitDocument = {
    querySelector(selector) {
      if (selector === "[data-codex-bot-sidebar-host]") return explicitSidebar;
      if (selector === "[data-codex-bot-composer-host]") return explicitComposer;
      return null;
    },
    querySelectorAll() { return []; },
  };
  assert.deepEqual(findUiMounts(explicitDocument), {
    sidebarHost: explicitSidebar,
    composerHost: explicitComposer,
  });

  const semanticSidebar = { id: "semantic-sidebar" };
  const composerForm = { id: "semantic-composer" };
  const prompt = {
    placeholder: "Ask anything, or drop a file.",
    getAttribute(name) { return name === "placeholder" ? this.placeholder : null; },
    closest(selector) { return selector.includes("form") ? composerForm : null; },
    parentElement: null,
  };
  const semanticDocument = {
    querySelector(selector) {
      if (selector === "nav[aria-label]") return semanticSidebar;
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes("textarea") ? [prompt] : [];
    },
  };
  assert.deepEqual(findUiMounts(semanticDocument), {
    sidebarHost: semanticSidebar,
    composerHost: composerForm,
  });
});

test("mounted optional model controls stay reachable while the official catalog is pending", async () => {
  const { mount } = require(uiPath);
  class MountElement extends FakeElement {
    constructor(tagName, documentRef) {
      super(tagName);
      this.ownerDocument = documentRef;
      this.dataset = Object.create(null);
      this.parentElement = null;
      this.value = "";
      this.disabled = false;
      this.listeners = new Map();
    }
    append(...children) {
      super.append(...children);
      for (const child of children) child.parentElement = this;
    }
    prepend(...children) {
      this.children.unshift(...children);
      for (const child of children) child.parentElement = this;
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    remove() { this.parentElement = null; }
  }
  const documentRef = {
    body: null,
    sidebar: null,
    composer: null,
    createElement(tagName) { return new MountElement(tagName, this); },
    getElementById() { return null; },
    querySelector(selector) {
      if (selector === "[data-codex-bot-sidebar-host]") return this.sidebar;
      if (selector === "[data-codex-bot-composer-host]") return this.composer;
      return null;
    },
    querySelectorAll() { return []; },
  };
  documentRef.body = documentRef.createElement("body");
  documentRef.sidebar = documentRef.createElement("aside");
  documentRef.composer = documentRef.createElement("form");
  const official = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-not-loaded-yet",
    reasoningEffort: "high",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 2,
  });
  const windowRef = {
    codexBots: {
      async list() { return [bot(BOT_A, "A", "unavailable")]; },
      onChanged() { return () => {}; },
    },
    codexRuntime: {
      async selectBot() { return official; },
      async readModel() { return official; },
    },
    codexAccount: {
      async catalog() {
        return Object.freeze({ generation: 0, status: "loading", models: Object.freeze([]) });
      },
      onCatalogChanged() { return () => {}; },
    },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
  };
  const mounted = mount({ windowRef, documentRef });
  await new Promise((resolve) => setImmediate(resolve));
  const find = (node, className) => {
    if (node.className === className) return node;
    for (const child of node.children) {
      const found = find(child, className);
      if (found) return found;
    }
    return null;
  };
  const modelSelect = find(mounted.modelDock, "codex-model-select");
  const reasoning = find(mounted.modelDock, "codex-reasoning-input");
  assert.equal(mounted.controller.snapshot().activeBotId, BOT_A);
  assert.equal(mounted.controller.snapshot().modelSelection, null);
  assert.equal(modelSelect.disabled, false);
  assert.equal(reasoning.disabled, false);
  assert.equal(modelSelect.children[0].value, "claude-fable-5");
  mounted.dispose();
});
