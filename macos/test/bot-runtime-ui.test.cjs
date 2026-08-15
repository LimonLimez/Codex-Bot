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

test("the approved model catalog preserves Codex and CLIProxyAPI model-specific effort positions", () => {
  const { MODEL_CATALOG } = require(uiPath);
  assert.deepEqual(
    MODEL_CATALOG.map(({ model, efforts }) => [model, efforts]),
    [
      ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
      ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
      ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
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

test("model selection is main-owned, ready-only, exact, and generation scoped", async () => {
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
        return selection;
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
  await assert.rejects(() => controller.selectModel("gpt-5.6-sol", "high"), /unavailable|ready/i);
  assert.equal(calls.length, 1);
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
