"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");

const uiPath = path.join(__dirname, "..", "src", "renderer", "bot-runtime-ui.js");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const BOT_C = "bot-33333333-3333-4333-8333-333333333333";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function bot(botId, name, state, setupStage = "complete") {
  return Object.freeze({
    botId,
    name,
    setupStage,
    runtime: Object.freeze({ state }),
  });
}

function botWithComputer(botId, name, runtimeState, overrides = {}, setupStage = "complete", appearance = undefined) {
  return Object.freeze({
    ...bot(botId, name, runtimeState, setupStage),
    ...(appearance === undefined ? {} : { appearance: Object.freeze({ ...appearance }) }),
    computer: Object.freeze({
      mode: "not-now",
      generation: 0,
      localProfileId: null,
      nativeAgentId: null,
      state: "unconfigured",
      lastConfirmedAt: null,
      lastErrorCode: null,
      ...overrides,
    }),
  });
}

function pendingBotWithComputer(botId, name = "New Bot", runtimeState = "provisioning", appearance = undefined) {
  return botWithComputer(botId, name, runtimeState, {}, "profile-model", appearance);
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

function createUltraWebGlHarness() {
  const shaderSources = [];
  const calls = [];
  let nextObjectId = 0;
  const gl = {
    ARRAY_BUFFER: 1,
    STATIC_DRAW: 2,
    FLOAT: 3,
    TRIANGLES: 4,
    VERTEX_SHADER: 5,
    FRAGMENT_SHADER: 6,
    COMPILE_STATUS: 7,
    LINK_STATUS: 8,
    createShader(type) { return { kind: "shader", id: ++nextObjectId, type }; },
    shaderSource(shader, source) { shaderSources.push(source); calls.push(["shaderSource", shader.type]); },
    compileShader(shader) { calls.push(["compileShader", shader.id]); },
    getShaderParameter(_shader, parameter) { return parameter === this.COMPILE_STATUS; },
    deleteShader(shader) { calls.push(["deleteShader", shader.id]); },
    createProgram() { return { kind: "program", id: ++nextObjectId }; },
    attachShader(program, shader) { calls.push(["attachShader", program.id, shader.id]); },
    linkProgram(program) { calls.push(["linkProgram", program.id]); },
    getProgramParameter(_program, parameter) { return parameter === this.LINK_STATUS; },
    deleteProgram(program) { calls.push(["deleteProgram", program.id]); },
    createBuffer() { return { kind: "buffer", id: ++nextObjectId }; },
    deleteBuffer(buffer) { calls.push(["deleteBuffer", buffer.id]); },
    getAttribLocation(_program, name) { calls.push(["getAttribLocation", name]); return 9; },
    getUniformLocation(_program, name) { return { name }; },
    useProgram(program) { calls.push(["useProgram", program.id]); },
    bindBuffer(target, buffer) { calls.push(["bindBuffer", target, buffer.id]); },
    bufferData(target, vertices, usage) {
      calls.push(["bufferData", target, Array.from(vertices), usage]);
    },
    enableVertexAttribArray(location) { calls.push(["enableVertexAttribArray", location]); },
    vertexAttribPointer(...args) { calls.push(["vertexAttribPointer", ...args]); },
    viewport(...args) { calls.push(["viewport", ...args]); },
    uniform2f(location, width, height) { calls.push(["uniform2f", location.name, width, height]); },
    uniform1f(location, time) { calls.push(["uniform1f", location.name, time]); },
    drawArrays(...args) { calls.push(["drawArrays", ...args]); },
  };
  const animationFrames = new Map();
  const cancelledFrames = [];
  let nextFrameId = 0;
  let resizeCallback = null;
  let observedCanvas = null;
  let disconnected = false;
  let now = 100;
  class FakeResizeObserver {
    constructor(callback) { resizeCallback = callback; }
    observe(canvas) { observedCanvas = canvas; }
    disconnect() { disconnected = true; }
  }
  const contextOptions = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind, options) { contextOptions.push([kind, options]); return gl; },
    getBoundingClientRect() { return { width: 100.4, height: 24.4 }; },
  };
  const windowRef = {
    WebGLRenderingContext: class WebGLRenderingContext {},
    ResizeObserver: FakeResizeObserver,
    devicePixelRatio: 3,
    performance: { now: () => now },
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { cancelledFrames.push(id); animationFrames.delete(id); },
  };
  return {
    animationFrames,
    calls,
    cancelledFrames,
    canvas,
    contextOptions,
    get disconnected() { return disconnected; },
    get observedCanvas() { return observedCanvas; },
    resize() { resizeCallback(); },
    runAnimationFrame(id, timestamp) {
      const callback = animationFrames.get(id);
      animationFrames.delete(id);
      callback(timestamp);
    },
    setNow(value) { now = value; },
    shaderSources,
    windowRef,
  };
}

test("signed Ultra field sends the exact Codex shaders through a DPR-capped WebGL lifecycle", () => {
  const { startUltraCanvas } = require(uiPath);
  const harness = createUltraWebGlHarness();
  const dispose = startUltraCanvas(harness.canvas, {
    shouldReduceMotion: false,
    windowRef: harness.windowRef,
  });

  assert.deepEqual(harness.contextOptions, [["webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: "high-performance",
    stencil: false,
  }]]);
  assert.deepEqual(
    harness.shaderSources.map((source) => crypto.createHash("sha256").update(source).digest("hex")),
    [
      "0a18f8ebef58896e96acdcffbf49d9dd216ab0568aa0aaf6479c9ca00609a2ad",
      "191a95923b9caeda53854502e6bb6d790f74a49fd0ea2e8d04484ed76d8e9317",
    ],
  );
  assert.equal(harness.canvas.width, 200);
  assert.equal(harness.canvas.height, 48);
  assert.equal(harness.observedCanvas, harness.canvas);
  assert.deepEqual(harness.calls.find((call) => call[0] === "viewport"), ["viewport", 0, 0, 200, 48]);
  assert.deepEqual(harness.calls.find((call) => call[0] === "uniform2f"), ["uniform2f", "uResolution", 100, 24]);
  assert.deepEqual(harness.calls.filter((call) => call[0] === "uniform1f").at(-1), ["uniform1f", "uTime", 0]);

  const firstFrameId = [...harness.animationFrames.keys()][0];
  harness.runAnimationFrame(firstFrameId, 2600);
  assert.deepEqual(harness.calls.filter((call) => call[0] === "uniform1f").at(-1), ["uniform1f", "uTime", 2.5]);
  const pendingFrameId = [...harness.animationFrames.keys()][0];
  dispose();
  assert.equal(harness.disconnected, true);
  assert.deepEqual(harness.cancelledFrames, [pendingFrameId]);
  assert.equal(harness.calls.filter((call) => call[0] === "deleteBuffer").length, 1);
  assert.equal(harness.calls.filter((call) => call[0] === "deleteProgram").length, 1);
});

test("signed Ultra field stays at uTime zero under Reduced Motion while still resizing", () => {
  const { startUltraCanvas } = require(uiPath);
  const harness = createUltraWebGlHarness();
  const dispose = startUltraCanvas(harness.canvas, {
    shouldReduceMotion: true,
    windowRef: harness.windowRef,
  });
  assert.equal(harness.animationFrames.size, 0);
  harness.setNow(8_100);
  harness.resize();
  assert.deepEqual(
    harness.calls.filter((call) => call[0] === "uniform1f").map((call) => call[2]),
    [0, 0],
  );
  dispose();
  assert.equal(harness.disconnected, true);
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

test("local Bot photos accept only bounded PNG data URLs", async () => {
  const { normalizeLocalPngAvatar, readLocalPngFile } = require(uiPath);
  const valid = "data:image/png;base64,aGVsbG8=";
  assert.equal(normalizeLocalPngAvatar(valid), valid);
  assert.throws(() => normalizeLocalPngAvatar("data:image/jpeg;base64,aGVsbG8="), /PNG/i);
  assert.throws(
    () => normalizeLocalPngAvatar(`data:image/png;base64,${"A".repeat(1_999_980)}`),
    /smaller than 2 MB/i,
  );

  class FakeReader {
    readAsDataURL() {
      this.result = valid;
      this.onload();
    }
  }
  assert.equal(
    await readLocalPngFile({ type: "image/png", size: 5 }, FakeReader),
    valid,
  );
  await assert.rejects(
    readLocalPngFile({ type: "image/jpeg", size: 5 }, FakeReader),
    /PNG/i,
  );
  await assert.rejects(
    readLocalPngFile({ type: "image/png", size: 1_500_000 }, FakeReader),
    /smaller than 2 MB/i,
  );
});

test("Power control preserves the approved compact topology exact ticks labels and effects", () => {
  const { createReasoningView, updateReasoningView } = require(uiPath);
  const view = createReasoningView(fakeDocument);
  assert.deepEqual(
    view.control.children.map((child) => child.className),
    ["codex-power-endpoints", "codex-power-track", "codex-power-thumb-rail", "codex-power-input"],
  );
  assert.deepEqual(
    view.track.children.map((child) => child.className),
    [
      "codex-power-fill",
      "codex-power-ultra-field",
      "codex-power-particles",
      "codex-power-ticks",
    ],
  );
  assert.deepEqual(
    view.ultraFill.children.map((child) => child.className),
    ["codex-power-ultra-mask"],
  );
  assert.deepEqual(
    view.ultraFill.children[0].children.map((child) => child.className),
    ["codex-power-ultra-canvas"],
  );
  assert.equal(view.particles.children.length, 14);
  assert.equal(view.burst.children.length, 16);
  assert.equal(view.input.value, "1");
  const stops = ["Light", "Standard", "Extended", "Extra High", "Max", "Ultra"].map((label, index) => ({
    provider: "openai-codex",
    model: index === 0 ? "gpt-5.6-terra" : "gpt-5.6-sol",
    effort: ["low", "medium", "high", "xhigh", "max", "ultra"][index],
    serviceTier: null,
    catalogGeneration: 8,
    label,
    effect: index === 4 ? "max" : index === 5 ? "ultra" : "ordinary",
  }));

  updateReasoningView(view, stops, 4, {
    enteredUltra: false,
  });
  assert.equal(view.ticks.children.length, 6);
  assert.equal(view.control.classList.contains("is-max"), true);
  assert.equal(view.control.classList.contains("is-ultra"), false);
  assert.equal(view.input.attributes["aria-valuetext"], "Max");
  assert.equal(view.label.textContent, "Max");

  updateReasoningView(view, [stops[0], { ...stops[1], serviceTier: "priority", effect: "fast" }], 1);
  assert.equal(view.control.classList.contains("is-fast"), true);
  updateReasoningView(view, stops.slice(0, 2), 1);
  assert.equal(view.control.classList.contains("is-fast"), false);

  updateReasoningView(view, stops, 5, {
    enteredUltra: true,
  });
  assert.equal(view.control.classList.contains("is-max"), false);
  assert.equal(view.control.classList.contains("is-ultra"), true);
  assert.equal(view.control.classList.contains("is-ultra-entering"), true);
  assert.equal(view.warning.hidden, false);

  updateReasoningView(view, [...stops.slice(0, 5), { ...stops[5], effort: "ultra-code", label: "Ultra Code" }], 5, {
    enteredUltra: true,
  });
  assert.equal(view.control.classList.contains("is-ultra"), true);
  assert.equal(view.control.classList.contains("is-ultra-code"), true);
  assert.equal(view.warning.hidden, false);
  assert.equal(view.input.attributes["aria-valuetext"], "Ultra Code");
  assert.equal(view.label.textContent, "Ultra Code");
});

test("signed Ultra particles use seeded initial positions then recurring 1.6-second randomized motion", () => {
  const { createReasoningView, updateReasoningView } = require(uiPath);
  const animationFrames = new Map();
  const cancelledFrames = [];
  const timeouts = new Map();
  const clearedTimeouts = [];
  const motionListeners = new Set();
  let nextAnimationFrame = 0;
  let nextTimeout = 0;
  const motionQuery = {
    matches: false,
    addEventListener(name, listener) { if (name === "change") motionListeners.add(listener); },
    removeEventListener(name, listener) { if (name === "change") motionListeners.delete(listener); },
  };
  const randomValues = [0, 1, 0.5];
  const windowRef = {
    matchMedia() { return motionQuery; },
    requestAnimationFrame(callback) {
      const id = ++nextAnimationFrame;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { cancelledFrames.push(id); animationFrames.delete(id); },
    setTimeout(callback, delay) {
      const id = ++nextTimeout;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { clearedTimeouts.push(id); timeouts.delete(id); },
  };
  const view = createReasoningView(fakeDocument, {
    random: () => randomValues.shift() ?? 0.5,
    windowRef,
  });
  const first = view.particles.children[0];
  const last = view.particles.children[13];
  assert.equal(first.style.left, "calc(50% + 2px)");
  assert.equal(first.style.top, "6px");
  assert.equal(first.style["--particle-delay"], "0ms");
  assert.ok(Math.abs(Number.parseFloat(first.style.transitionDuration) - 2.086208017394) < 1e-12);
  assert.ok(Math.abs(Number(first.style.opacity) - 0.404960707632) < 1e-12);
  assert.equal(last.style.left, "calc(8% + 3px)");
  assert.equal(last.style.top, "15px");
  assert.equal(last.style["--particle-delay"], "442ms");

  const stops = [
    { label: "Max", effort: "max", effect: "max" },
    { label: "Ultra", effort: "ultra", effect: "ultra" },
  ];
  updateReasoningView(view, stops, 1);
  assert.equal(animationFrames.size, 14);
  const [firstFrameId, firstFrame] = animationFrames.entries().next().value;
  animationFrames.delete(firstFrameId);
  firstFrame();
  assert.equal(first.style.left, "calc(50% + -4px)");
  assert.equal(first.style.top, "19px");
  assert.equal(first.style.transitionDuration, "2.2399999999999998s");
  assert.deepEqual([...timeouts.values()].map(({ delay }) => delay), [2_239.9999999999995]);

  motionQuery.matches = true;
  for (const listener of motionListeners) listener({ matches: true });
  assert.equal(animationFrames.size, 0);
  assert.equal(timeouts.size, 0);
  assert.equal(cancelledFrames.length, 13);
  assert.deepEqual(clearedTimeouts, [1]);

  motionQuery.matches = false;
  for (const listener of motionListeners) listener({ matches: false });
  assert.equal(animationFrames.size, 14);
  view.dispose();
  assert.equal(animationFrames.size, 0);
  assert.equal(motionListeners.size, 0);
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

test("New Bot commits profile and authoritative model before opening Computer", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
      isDefault: true,
    })]),
  });
  const selectedModel = Object.freeze({
    botId: BOT_B,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const calls = [];
  const controller = createBotUiController({
    facade: {
      async list() { return []; },
      async create() { calls.push(["create", arguments.length]); return created; },
      async rename(botId, name) {
        calls.push(["rename", botId, name]);
        return pendingBotWithComputer(botId, name);
      },
      async updateProfile(botId, profile) {
        calls.push(["updateProfile", botId, profile]);
        return pendingBotWithComputer(botId, "Research Bot");
      },
      async advanceSetup(value) {
        calls.push(["advanceSetup", value]);
        return botWithComputer(value.botId, "Research Bot", "provisioning", {}, "computer");
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return selectedModel; },
      async readModel() { return selectedModel; },
      async selectModel(selection) {
        calls.push(["selectModel", selection]);
        return Object.freeze({ ...selectedModel, ...selection, generation: 2 });
      },
    },
    accountFacade: {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });

  await controller.initialize();
  await controller.createBot();
  assert.deepEqual(calls[0], ["create", 0]);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().profileSetup.dismissible, false);
  assert.equal(controller.snapshot().profileSetup.name, "New Bot");
  assert.equal(controller.snapshot().profileSetup.model, "gpt-5.6-sol");
  assert.equal(controller.snapshot().computerSetup.open, false);

  controller.updateNewBotSetup({
    name: "  Research Bot  ",
    description: "Find exact primary sources.",
    image: "data:image/png;base64,aGVsbG8=",
    shape: "gem",
    color: "blue",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
  });
  await controller.confirmNewBotSetup();

  assert.deepEqual(calls.slice(1), [
    ["rename", BOT_B, "Research Bot"],
    ["updateProfile", BOT_B, {
      appearance: {
        shape: "gem",
        color: "blue",
        image: "data:image/png;base64,aGVsbG8=",
        description: "Find exact primary sources.",
      },
    }],
    ["selectModel", {
      botId: BOT_B,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: null,
    }],
    ["advanceSetup", {
      botId: BOT_B,
      expectedStage: "profile-model",
      nextStage: "computer",
    }],
  ]);
  assert.equal(controller.snapshot().profileSetup.open, false);
  assert.deepEqual(controller.snapshot().computerSetup, {
    open: true,
    pending: false,
    selectedMode: null,
    dismissible: false,
  });
  controller.dispose();
});

test("New Bot requires a fresh authoritative model confirmation before Computer", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
      isDefault: true,
    })]),
  });
  const selected = Object.freeze({
    botId: BOT_B,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  let modelCalls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return []; },
      async create() { return created; },
      async rename(botId, name) { return pendingBotWithComputer(botId, name); },
      async updateProfile(botId) { return pendingBotWithComputer(botId, "Research Bot"); },
      async advanceSetup(value) {
        return botWithComputer(value.botId, "Research Bot", "provisioning", {}, value.nextStage);
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return selected; },
      async readModel() { return selected; },
      async selectModel(value) {
        modelCalls += 1;
        if (modelCalls === 1) return undefined;
        return Object.freeze({ ...selected, ...value, generation: 2 });
      },
    },
    accountFacade: {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });

  await controller.initialize();
  await controller.createBot();
  controller.updateNewBotSetup({ name: "Research Bot" });
  await assert.rejects(controller.confirmNewBotSetup(), /setup changed/i);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  assert.match(controller.snapshot().profileSetup.error, /try again/i);

  await controller.confirmNewBotSetup();
  assert.equal(modelCalls, 2);
  assert.equal(controller.snapshot().profileSetup.open, false);
  assert.equal(controller.snapshot().computerSetup.open, true);
  controller.dispose();
});

test("restart resumes the persisted setup stage without creating or inferring from New Bot", async () => {
  const { createBotUiController } = require(uiPath);
  const appearance = {
    shape: "gem",
    color: "blue",
    image: "data:image/png;base64,aGVsbG8=",
    description: "Persisted after a partial setup.",
  };
  const profileBot = pendingBotWithComputer(BOT_B, "Research Bot", "provisioning", appearance);
  const selected = Object.freeze({
    botId: BOT_B,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 2,
  });
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "ultra"]),
      isDefault: true,
    })]),
  });
  let createCalls = 0;
  const facadeFor = (record, records = [record]) => ({
    async list() { return records; },
    async create() { createCalls += 1; return record; },
    onChanged() { return () => {}; },
  });
  const runtimeFacade = {
    async selectBot() { return selected; },
    async readModel() { return selected; },
  };
  const accountFacade = { async catalog() { return catalog; } };
  const computerFacade = {
    async read(botId) { return { botId, computer: profileBot.computer }; },
    async listPermissions(botId) { return { botId, permissions: [] }; },
    async listPermissionRequests(botId) { return { botId, requests: [] }; },
    onChanged() { return () => {}; },
    onPermissionRequested() { return () => {}; },
  };

  const profileController = createBotUiController({
    facade: facadeFor(profileBot, [botWithComputer(BOT_A, "Existing", "ready"), profileBot]),
    runtimeFacade,
    accountFacade,
    computerFacade,
  });
  await profileController.initialize();
  assert.equal(createCalls, 0);
  assert.equal(profileController.snapshot().activeBotId, BOT_B);
  assert.equal(profileController.snapshot().profileSetup.open, true);
  assert.equal(profileController.snapshot().profileSetup.dismissible, false);
  assert.equal(profileController.snapshot().profileSetup.name, "Research Bot");
  assert.equal(profileController.snapshot().profileSetup.description, appearance.description);
  assert.equal(profileController.snapshot().profileSetup.shape, "gem");
  assert.equal(profileController.snapshot().profileSetup.color, "blue");
  assert.equal(profileController.snapshot().profileSetup.image, appearance.image);
  assert.equal(profileController.snapshot().computerSetup.open, false);
  profileController.dispose();

  const computerBot = botWithComputer(BOT_B, "Research Bot", "provisioning", {}, "computer", appearance);
  const computerController = createBotUiController({
    facade: facadeFor(computerBot), runtimeFacade, accountFacade, computerFacade,
  });
  await computerController.initialize();
  assert.equal(createCalls, 0);
  assert.equal(computerController.snapshot().profileSetup.open, false);
  assert.deepEqual(computerController.snapshot().computerSetup, {
    open: true,
    pending: false,
    selectedMode: null,
    dismissible: false,
  });
  computerController.dispose();

  const existingNamedNewBot = botWithComputer(BOT_A, "New Bot", "ready", {}, "complete");
  const existingSelection = Object.freeze({ ...selected, botId: BOT_A });
  const existingController = createBotUiController({
    facade: facadeFor(existingNamedNewBot),
    runtimeFacade: {
      async selectBot() { return existingSelection; },
      async readModel() { return existingSelection; },
    },
    accountFacade,
    computerFacade: {
      ...computerFacade,
      async read(botId) { return { botId, computer: existingNamedNewBot.computer }; },
    },
  });
  await existingController.initialize();
  assert.equal(existingController.snapshot().profileSetup.open, false);
  assert.equal(existingController.snapshot().computerSetup.open, false);
  existingController.dispose();
});

test("restart retries a persisted profile setup when the live catalog becomes ready", async () => {
  const { createBotUiController } = require(uiPath);
  const persisted = pendingBotWithComputer(BOT_B);
  const readyCatalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
      isDefault: true,
    })]),
  });
  const selected = Object.freeze({
    botId: BOT_B,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 0,
  });
  let catalogReady = false;
  let catalogListener;
  let selectionCalls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [persisted]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() {
        selectionCalls += 1;
        if (!catalogReady) throw new Error("catalog is still loading");
        return selected;
      },
      async readModel() { return selected; },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({ generation: 0, status: "loading", models: Object.freeze([]) });
      },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: persisted.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });

  await controller.initialize();
  assert.equal(selectionCalls, 1);
  assert.equal(controller.snapshot().activeBotId, null);
  assert.equal(controller.snapshot().profileSetup.open, false);
  assert.equal(controller.snapshot().mandatorySetupPending, true);

  catalogReady = true;
  catalogListener(readyCatalog);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(selectionCalls, 2);
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().profileSetup.name, "New Bot");
  assert.equal(controller.snapshot().computerSetup.open, false);
  controller.dispose();
});

test("failed profile setup preserves the same bot and sanitized draft for retry", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "ultra"]),
      isDefault: true,
    })]),
  });
  const selected = Object.freeze({
    botId: BOT_B,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  let createCalls = 0;
  let profileCalls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return []; },
      async create() { createCalls += 1; return created; },
      async rename(botId, name) { return pendingBotWithComputer(botId, name); },
      async updateProfile(botId) {
        profileCalls += 1;
        if (profileCalls === 1) {
          throw new Error("ENOSPC /Users/private endpoint=https://provider token=secret");
        }
        return pendingBotWithComputer(botId, "Research Bot");
      },
      async advanceSetup(value) {
        return botWithComputer(value.botId, "Research Bot", "provisioning", {}, value.nextStage);
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return selected; },
      async readModel() { return selected; },
      async selectModel(value) { return Object.freeze({ ...selected, ...value, generation: 2 }); },
    },
    accountFacade: {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });

  await controller.initialize();
  await controller.createBot();
  controller.updateNewBotSetup({
    name: "Research Bot",
    description: "Keep this exact draft.",
    image: "data:image/png;base64,aGVsbG8=",
    shape: "gem",
    color: "blue",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
  });
  await assert.rejects(controller.confirmNewBotSetup(), /ENOSPC/);
  const failed = controller.snapshot();
  assert.equal(failed.profileSetup.open, true);
  assert.equal(failed.profileSetup.pending, false);
  assert.equal(failed.profileSetup.name, "Research Bot");
  assert.equal(failed.profileSetup.description, "Keep this exact draft.");
  assert.equal(failed.profileSetup.image, "data:image/png;base64,aGVsbG8=");
  assert.match(failed.profileSetup.error, /try again/i);
  assert.doesNotMatch(failed.profileSetup.error, /ENOSPC|Users\/private|provider|token|secret/i);
  assert.equal(failed.computerSetup.open, false);
  assert.equal(createCalls, 1);

  await controller.confirmNewBotSetup();
  assert.equal(createCalls, 1);
  assert.equal(profileCalls, 2);
  assert.equal(controller.snapshot().profileSetup.open, false);
  assert.equal(controller.snapshot().computerSetup.open, true);
  controller.dispose();
});

test("catalog changes fence stale setup completion and permit explicit re-confirmation", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const renameRelease = deferred();
  let catalogListener;
  let catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-old",
      displayName: "GPT Old",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
      isDefault: true,
    })]),
  });
  const oldSelection = Object.freeze({
    botId: BOT_B,
    provider: "openai-codex",
    model: "gpt-old",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const calls = [];
  let holdRename = true;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "Existing", "ready")]; },
      async create() { return created; },
      async rename(botId, name) {
        calls.push(["rename", botId, name]);
        if (holdRename) await renameRelease.promise;
        return pendingBotWithComputer(botId, name);
      },
      async updateProfile(botId) {
        calls.push(["updateProfile", botId]);
        return pendingBotWithComputer(botId, "Research Bot");
      },
      async advanceSetup(value) {
        calls.push(["advanceSetup", value]);
        return botWithComputer(value.botId, "Research Bot", "provisioning", {}, value.nextStage);
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return botId === BOT_B ? oldSelection : null; },
      async readModel(botId) { return botId === BOT_B ? oldSelection : null; },
      async selectModel(value) {
        calls.push(["selectModel", value]);
        return Object.freeze({
          ...value,
          provider: "openai-codex",
          catalogGeneration: 13,
          generation: 2,
        });
      },
    },
    accountFacade: {
      async catalog() { return catalog; },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });

  await controller.initialize();
  await controller.createBot();
  controller.updateNewBotSetup({ name: "Research Bot" });
  const stale = controller.confirmNewBotSetup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => controller.selectBot(BOT_A), /setup is pending/i);
  catalog = Object.freeze({
    generation: 13,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-new",
      displayName: "GPT New",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: Object.freeze(["medium", "high"]),
      isDefault: true,
    })]),
  });
  catalogListener(catalog);
  renameRelease.resolve();
  await assert.rejects(stale, /setup changed/i);
  assert.equal(calls.some(([name]) => name === "updateProfile"), false);
  assert.equal(calls.some(([name]) => name === "selectModel"), false);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().profileSetup.name, "Research Bot");
  assert.equal(controller.snapshot().computerSetup.open, false);

  holdRename = false;
  controller.updateNewBotSetup({
    provider: "openai-codex",
    model: "gpt-new",
    reasoningEffort: "high",
    serviceTier: null,
  });
  await controller.confirmNewBotSetup();
  assert.equal(controller.snapshot().profileSetup.open, false);
  assert.equal(controller.snapshot().computerSetup.open, true);
  assert.equal(calls.filter(([name]) => name === "selectModel").length, 1);
  controller.dispose();
});

test("disposing during profile setup fences every late completion", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const profileRelease = deferred();
  const selected = Object.freeze({
    botId: BOT_B,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 1,
  });
  let profileStarted = false;
  let modelCalls = 0;
  let publications = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return []; },
      async create() { return created; },
      async rename(botId, name) { return pendingBotWithComputer(botId, name); },
      async updateProfile(botId) {
        profileStarted = true;
        await profileRelease.promise;
        return pendingBotWithComputer(botId, "Research Bot");
      },
      async advanceSetup() { throw new Error("unexpected setup advance"); },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return selected; },
      async readModel() { return selected; },
      async selectModel() { modelCalls += 1; return selected; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
    onStateChanged() { publications += 1; },
  });

  await controller.initialize();
  await controller.createBot();
  controller.updateNewBotSetup({ name: "Research Bot" });
  const finishing = controller.confirmNewBotSetup();
  while (!profileStarted) await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
  const publicationsAfterDispose = publications;
  profileRelease.resolve();
  await assert.rejects(finishing, /setup changed/i);
  assert.equal(modelCalls, 0);
  assert.equal(publications, publicationsAfterDispose);
  assert.equal(controller.snapshot().activeBotId, null);
  assert.equal(controller.snapshot().profileSetup.open, false);
  assert.equal(controller.snapshot().computerSetup.open, false);
});

test("disposing during the durable setup-stage advance fences its late completion", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const advanceRelease = deferred();
  const selected = Object.freeze({
    botId: BOT_B,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 1,
  });
  let advanceStarted = false;
  let publications = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return []; },
      async create() { return created; },
      async rename(botId, name) { return pendingBotWithComputer(botId, name); },
      async updateProfile(botId) { return pendingBotWithComputer(botId, "Research Bot"); },
      async advanceSetup(value) {
        advanceStarted = true;
        await advanceRelease.promise;
        return botWithComputer(value.botId, "Research Bot", "provisioning", {}, "computer");
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return selected; },
      async readModel() { return selected; },
      async selectModel() { return selected; },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
    onStateChanged() { publications += 1; },
  });

  await controller.initialize();
  await controller.createBot();
  controller.updateNewBotSetup({ name: "Research Bot" });
  const finishing = controller.confirmNewBotSetup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(advanceStarted, true);
  controller.dispose();
  const publicationsAfterDispose = publications;
  advanceRelease.resolve();
  await assert.rejects(finishing, /setup changed/i);
  assert.equal(publications, publicationsAfterDispose);
  assert.equal(controller.snapshot().activeBotId, null);
  assert.equal(controller.snapshot().computerSetup.open, false);
});

test("New Bot setup asks for an explicit Computer mode with no default", async () => {
  const { createBotUiController } = require(uiPath);
  const selectedModes = [];
  const setupTransitions = [];
  let changed;
  let permissionRequested;
  const created = pendingBotWithComputer(BOT_B);
  const computerFacade = {
    async read(botId) { return { botId, computer: created.computer }; },
    async selectMode(value) {
      selectedModes.push(value);
      return {
        botId: value.botId,
        computer: {
          ...created.computer,
          mode: value.mode,
          generation: 1,
          localProfileId: value.mode === "local" ? "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : null,
          state: value.mode === "local" ? "ready" : "unconfigured",
          lastConfirmedAt: value.mode === "local" ? "2026-08-15T12:34:56.000Z" : null,
        },
      };
    },
    async listPermissions(botId) { return { botId, permissions: [] }; },
    async decidePermission() {},
    async revokePermission() {},
    onChanged(listener) { changed = listener; return () => { changed = null; }; },
    onPermissionRequested(listener) { permissionRequested = listener; return () => { permissionRequested = null; }; },
  };
  const controller = createBotUiController({
    facade: {
      async list() { return []; },
      async create() { return created; },
      async rename(botId, name) { return pendingBotWithComputer(botId, name); },
      async updateProfile(botId) { return pendingBotWithComputer(botId); },
      async advanceSetup(value) {
        setupTransitions.push(value);
        return botWithComputer(
          value.botId,
          "New Bot",
          "provisioning",
          {},
          value.nextStage,
        );
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return null; },
      async selectModel(value) {
        return Object.freeze({
          ...value,
          provider: "cliproxy-anthropic",
          catalogGeneration: 1,
          generation: 1,
        });
      },
    },
    computerFacade,
  });
  await controller.initialize();
  await controller.createBot();
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  await controller.confirmNewBotSetup();
  assert.deepEqual(setupTransitions, [{
    botId: BOT_B,
    expectedStage: "profile-model",
    nextStage: "computer",
  }]);
  assert.deepEqual(controller.snapshot().computerSetup, {
    open: true,
    pending: false,
    selectedMode: null,
    dismissible: false,
  });
  assert.throws(() => controller.openComputerSetup(), /already|unavailable/i);
  assert.throws(() => controller.dismissComputerSetup(), /cannot be dismissed/i);
  assert.equal(controller.snapshot().computerSetup.dismissible, false);
  assert.deepEqual(controller.snapshot().computerChoices, [
    { value: "local", label: "Free Local Desktop" },
    { value: "cursor", label: "Cursor Remote Computer" },
    { value: "not-now", label: "Not Now" },
  ]);
  assert.equal(selectedModes.length, 0);
  controller.chooseComputerMode("local");
  assert.equal(controller.snapshot().computerSetup.selectedMode, "local");
  await controller.confirmComputerMode();
  assert.deepEqual(selectedModes, [{ botId: BOT_B, mode: "local" }]);
  assert.deepEqual(setupTransitions.at(-1), {
    botId: BOT_B,
    expectedStage: "computer",
    nextStage: "complete",
  });
  assert.equal(controller.snapshot().computerSetup.open, false);
  assert.equal(controller.snapshot().computer.mode, "local");
  assert.equal(controller.snapshot().computer.label, "Runs on this Mac");
  controller.openComputerSetup();
  assert.deepEqual(controller.snapshot().computerSetup, {
    open: true,
    pending: false,
    selectedMode: null,
    dismissible: true,
  });
  assert.equal(typeof changed, "function");
  assert.equal(typeof permissionRequested, "function");
  controller.dispose();
  assert.equal(changed, null);
  assert.equal(permissionRequested, null);
});

test("New Bot creation is single-flight until its mandatory setup is established", async () => {
  const { createBotUiController } = require(uiPath);
  const heldCreate = deferred();
  let createCalls = 0;
  const created = pendingBotWithComputer(BOT_B);
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready")]; },
      async create() { createCalls += 1; return heldCreate.promise; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read(botId) { return { botId, computer: created.computer }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const first = controller.createBot();
  while (createCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = controller.createBot();
  const secondObserved = second.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(createCalls, 1, "a concurrent click must not reach persistent creation");
  } finally {
    heldCreate.resolve(created);
  }
  const [firstResult, secondResult] = await Promise.all([
    first.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })),
    secondObserved,
  ]);
  assert.equal(firstResult.status, "fulfilled");
  assert.equal(secondResult.status, "rejected");
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.equal(controller.snapshot().bots.filter(({ botId }) => botId === BOT_B).length, 1);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  await assert.rejects(controller.createBot(), /pending|unavailable/i);
  assert.equal(createCalls, 1);
  controller.dispose();
});

test("a persisted New Bot keeps its mandatory profile setup after selection recovery", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  let createCalls = 0;
  let failCreatedSelection = true;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready")]; },
      async create() { createCalls += 1; return created; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) {
        if (botId === BOT_B && failCreatedSelection) throw new Error("selection unavailable");
        return null;
      },
    },
    computerFacade: {
      async read(botId) {
        const computer = botId === BOT_B
          ? created.computer
          : botWithComputer(BOT_A, "A", "ready").computer;
        return { botId, computer };
      },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  await assert.rejects(controller.createBot(), /selection unavailable/);
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  assert.equal(controller.snapshot().bots.some(({ botId }) => botId === BOT_B), true);
  assert.equal(controller.snapshot().mandatorySetupPending, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  await assert.rejects(controller.createBot(), /pending|unavailable/i);
  assert.equal(createCalls, 1);

  failCreatedSelection = false;
  await controller.selectBot(BOT_B);
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  assert.throws(() => controller.selectBot(BOT_B, true), /setup is pending/i);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().mandatorySetupPending, true);
  controller.dispose();
});

test("a forced catalog refresh coalesces with the created bot's mandatory selection", async () => {
  const { createBotUiController } = require(uiPath);
  const created = pendingBotWithComputer(BOT_B);
  const selectionStarted = deferred();
  const selectionRelease = deferred();
  let createdSelectionCalls = 0;
  let catalogListener;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready")]; },
      async create() { return created; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) {
        if (botId !== BOT_B) return null;
        createdSelectionCalls += 1;
        if (createdSelectionCalls > 1) throw new Error("forced refresh replaced selection");
        selectionStarted.resolve();
        return selectionRelease.promise;
      },
    },
    accountFacade: {
      async catalog() { return Object.freeze({ generation: 0, status: "loading", models: Object.freeze([]) }); },
      onCatalogChanged(listener) { catalogListener = listener; return () => {}; },
    },
    computerFacade: {
      async read(botId) {
        const computer = botId === BOT_B
          ? created.computer
          : botWithComputer(BOT_A, "A", "ready").computer;
        return { botId, computer };
      },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const creating = controller.createBot();
  await selectionStarted.promise;
  const refreshing = controller.selectBot(BOT_B, true);
  const refreshObserved = refreshing.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  selectionRelease.resolve(null);
  const [createdResult, refreshedResult] = await Promise.all([
    creating.then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })),
    refreshObserved,
  ]);
  assert.equal(createdSelectionCalls, 1);
  assert.equal(createdResult.status, "fulfilled");
  assert.equal(refreshedResult.status, "fulfilled");
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  assert.equal(controller.snapshot().mandatorySetupPending, true);
  assert.doesNotThrow(() => catalogListener(Object.freeze({
    generation: 1,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  })));
  assert.equal(controller.snapshot().profileSetup.open, true);
  assert.equal(controller.snapshot().computerSetup.open, false);
  controller.dispose();
});

test("permission decisions remain bound to the requesting bot and generation", async () => {
  const { createBotUiController } = require(uiPath);
  let onPermission;
  const decisions = [];
  const local = {
    mode: "local",
    generation: 4,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const firstPrompt = {
    requestId: "permission-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: 4,
    capability: "filesystem.read",
    resourceLabel: "Folder A",
    reason: "Read a selected folder for this task",
  };
  let firstPromptPublished = false;
  const records = [
    botWithComputer(BOT_A, "A", "ready", local),
    botWithComputer(BOT_B, "B", "ready", { ...local, localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  ];
  const computerFacade = {
    async read(botId) { const record = records.find((entry) => entry.botId === botId); return { botId, computer: record.computer }; },
    async selectMode() {},
    async listPermissions(botId) { return { botId, permissions: [] }; },
    async listPermissionRequests(botId) {
      return { botId, requests: botId === BOT_A && firstPromptPublished ? [firstPrompt] : [] };
    },
    async decidePermission(value) { decisions.push(value); return { botId: value.botId, permissions: [] }; },
    async revokePermission() {},
    onChanged() { return () => {}; },
    onPermissionRequested(listener) { onPermission = listener; return () => {}; },
  };
  const controller = createBotUiController({
    facade: { async list() { return records; }, onChanged() { return () => {}; } },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade,
  });
  await controller.initialize();
  firstPromptPublished = true;
  onPermission(firstPrompt);
  assert.equal(controller.snapshot().permissionRequest.botId, BOT_A);
  await controller.selectBot(BOT_B);
  assert.equal(controller.snapshot().permissionRequest, null);
  await assert.rejects(controller.decideComputerPermission("always"), /unavailable|changed/i);
  assert.equal(decisions.length, 0);

  await controller.selectBot(BOT_A);
  onPermission({
    requestId: "permission-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: 3,
    capability: "filesystem.read",
    resourceLabel: "Folder A",
    reason: "Read a selected folder for this task",
  });
  assert.equal(
    controller.snapshot().permissionRequest.requestId,
    "permission-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  );
  assert.equal(controller.snapshot().permissionRequests.length, 1);
  controller.dispose();
});

test("a newer Computer event cannot be overwritten by an older selection read", async () => {
  const { createBotUiController } = require(uiPath);
  const permissionsStarted = deferred();
  const permissionsRelease = deferred();
  let onComputerChanged;
  let onBotChanged;
  const generationFour = {
    mode: "local",
    generation: 4,
    localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const generationFive = {
    ...generationFour,
    mode: "not-now",
    generation: 5,
    state: "unconfigured",
    lastConfirmedAt: null,
  };
  const botA = botWithComputer(BOT_A, "A", "ready");
  const controller = createBotUiController({
    facade: {
      async list() {
        return [botA, botWithComputer(BOT_B, "B", "ready", generationFour)];
      },
      onChanged(listener) { onBotChanged = listener; return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read(botId) {
        return { botId, computer: botId === BOT_B ? generationFour : botA.computer };
      },
      async listPermissions(botId) {
        if (botId === BOT_B) {
          permissionsStarted.resolve();
          await permissionsRelease.promise;
        }
        return { botId, permissions: [] };
      },
      onChanged(listener) { onComputerChanged = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const selecting = controller.selectBot(BOT_B);
  await permissionsStarted.promise;
  onComputerChanged({ botId: BOT_B, computer: generationFive });
  onBotChanged(botWithComputer(BOT_B, "B", "ready", generationFour));
  assert.equal(controller.snapshot().bots.find((entry) => entry.botId === BOT_B).computer.generation, 5);
  permissionsRelease.resolve();
  await selecting;
  assert.equal(controller.snapshot().computer.generation, 5);
  assert.equal(controller.snapshot().computer.mode, "not-now");
  controller.dispose();
});

test("a same-generation ready Computer event wins over a held starting read", async () => {
  const { createBotUiController } = require(uiPath);
  const permissionsStarted = deferred();
  const permissionsRelease = deferred();
  let onComputerChanged;
  const starting = {
    mode: "local",
    generation: 4,
    localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    nativeAgentId: null,
    state: "starting",
    lastConfirmedAt: null,
    lastErrorCode: null,
  };
  const ready = {
    ...starting,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
  };
  const botA = botWithComputer(BOT_A, "A", "ready");
  const controller = createBotUiController({
    facade: {
      async list() { return [botA, botWithComputer(BOT_B, "B", "ready", starting)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read(botId) { return { botId, computer: botId === BOT_B ? starting : botA.computer }; },
      async listPermissions(botId) {
        if (botId === BOT_B) {
          permissionsStarted.resolve();
          await permissionsRelease.promise;
        }
        return { botId, permissions: [] };
      },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged(listener) { onComputerChanged = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const selecting = controller.selectBot(BOT_B);
  await permissionsStarted.promise;
  onComputerChanged({ botId: BOT_B, computer: ready });
  assert.equal(controller.snapshot().bots.find((entry) => entry.botId === BOT_B).computer.state, "ready");
  permissionsRelease.resolve();
  await selecting;
  assert.equal(controller.snapshot().computer.generation, 4);
  assert.equal(controller.snapshot().computer.state, "ready");
  controller.dispose();
});

test("selection commits grants for the newer authoritative Computer it reads", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [grant] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.equal(controller.snapshot().computer.mode, "local");
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Workspace"]);
  controller.dispose();
});

test("a delayed Computer confirmation cannot publish one bot's grants onto another", async () => {
  const { createBotUiController } = require(uiPath);
  const permissionsStarted = deferred();
  const permissionsRelease = deferred();
  const localA = {
    mode: "local",
    generation: 3,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const localB = { ...localA, localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const grant = (botId, suffix, label) => ({
    grantId: `grant-${suffix}`,
    botId,
    capability: "filesystem.read",
    resourceId: label.toLowerCase().replaceAll(" ", "-"),
    resourceLabel: label,
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const grantA = grant(BOT_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Private A");
  const grantB = grant(BOT_B, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Private B");
  let holdA = false;
  const records = [
    botWithComputer(BOT_A, "A", "ready", localA),
    botWithComputer(BOT_B, "B", "ready", localB),
  ];
  const controller = createBotUiController({
    facade: { async list() { return records; }, onChanged() { return () => {}; } },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read(botId) {
        return { botId, computer: botId === BOT_A ? localA : localB };
      },
      async selectMode(value) { return { botId: value.botId, computer: localA }; },
      async listPermissions(botId) {
        if (botId === BOT_A && holdA) {
          permissionsStarted.resolve();
          await permissionsRelease.promise;
        }
        return { botId, permissions: botId === BOT_A ? [grantA] : [grantB] };
      },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  controller.openComputerSetup();
  controller.chooseComputerMode("local");
  holdA = true;
  const confirming = controller.confirmComputerMode();
  await permissionsStarted.promise;
  await controller.selectBot(BOT_B);
  assert.equal(controller.snapshot().permissions[0].resourceLabel, "Private B");
  permissionsRelease.resolve();
  await assert.rejects(confirming, /changed/i);
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.equal(controller.snapshot().permissions[0].resourceLabel, "Private B");
  controller.dispose();
});

test("failed bot selection cannot restore grants for a changed inactive Computer", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const selectionStarted = deferred();
  const selectionRelease = deferred();
  let computerListener;
  const controller = createBotUiController({
    facade: {
      async list() {
        return [
          botWithComputer(BOT_A, "A", "ready", local),
          botWithComputer(BOT_B, "B", "ready"),
        ];
      },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) {
        if (botId === BOT_B) {
          selectionStarted.resolve();
          return selectionRelease.promise;
        }
        return null;
      },
    },
    computerFacade: {
      async read(botId) { return { botId, computer: botId === BOT_A ? local : botWithComputer(BOT_B, "B", "ready").computer }; },
      async listPermissions(botId) { return { botId, permissions: botId === BOT_A ? [grant] : [] }; },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const selecting = controller.selectBot(BOT_B);
  await selectionStarted.promise;
  computerListener({
    botId: BOT_A,
    computer: {
      mode: "not-now",
      generation: 2,
      localProfileId: null,
      nativeAgentId: null,
      state: "unconfigured",
      lastConfirmedAt: null,
      lastErrorCode: null,
    },
  });
  selectionRelease.reject(new Error("selection failed"));
  await assert.rejects(selecting, /selection failed/);
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  assert.equal(controller.snapshot().computer.mode, "not-now");
  assert.deepEqual(controller.snapshot().permissions, []);
  controller.dispose();
});

test("Computer confirmation accepts its exact self-emitted authoritative event", async () => {
  const { createBotUiController } = require(uiPath);
  const unconfigured = botWithComputer(BOT_A, "A", "ready").computer;
  const ready = {
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const grant = (suffix, label) => Object.freeze({
    grantId: `grant-${suffix}`,
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: label.toLowerCase().replaceAll(" ", "-"),
    resourceLabel: label,
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const staleGrant = grant("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Stale Workspace");
  const freshGrant = grant("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Fresh Workspace");
  const staleRefresh = deferred();
  let permissionReads = 0;
  let computerListener;
  const result = Object.freeze({ botId: BOT_A, computer: ready });
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", unconfigured)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: unconfigured }; },
      async selectMode() {
        computerListener(result);
        return result;
      },
      async listPermissions(botId) {
        permissionReads += 1;
        if (permissionReads === 2) return staleRefresh.promise;
        return { botId, permissions: permissionReads === 3 ? [freshGrant] : [] };
      },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  controller.openComputerSetup();
  controller.chooseComputerMode("local");
  await controller.confirmComputerMode();
  assert.equal(controller.snapshot().computerSetup.open, false);
  assert.equal(controller.snapshot().computer.mode, "local");
  assert.equal(controller.snapshot().computer.generation, 1);
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Fresh Workspace"]);
  staleRefresh.resolve({ botId: BOT_A, permissions: [staleGrant] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Fresh Workspace"]);
  controller.dispose();
});

test("a newer same-target grant refresh survives a held Computer confirmation", async () => {
  const { createBotUiController } = require(uiPath);
  const unconfigured = botWithComputer(BOT_A, "A", "ready").computer;
  const ready = {
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const confirmationReadStarted = deferred();
  const confirmationReadRelease = deferred();
  let computerListener;
  let permissionReads = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", unconfigured)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: unconfigured }; },
      async selectMode() { return { botId: BOT_A, computer: ready }; },
      async listPermissions() {
        permissionReads += 1;
        if (permissionReads === 2) {
          confirmationReadStarted.resolve();
          return confirmationReadRelease.promise;
        }
        return { botId: BOT_A, permissions: permissionReads === 3 ? [grant] : [] };
      },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  controller.openComputerSetup();
  controller.chooseComputerMode("local");
  const confirming = controller.confirmComputerMode();
  await confirmationReadStarted.promise;
  computerListener({ botId: BOT_A, computer: ready });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Workspace"]);
  confirmationReadRelease.resolve({ botId: BOT_A, permissions: [] });
  await confirming;
  assert.equal(controller.snapshot().computerSetup.open, false);
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Workspace"]);
  controller.dispose();
});

test("a stale Computer confirmation never clears grants for the newer target", async () => {
  const { createBotUiController } = require(uiPath);
  const unconfigured = botWithComputer(BOT_A, "A", "ready").computer;
  const stale = {
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const current = {
    ...stale,
    generation: 2,
    localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  const grant = Object.freeze({
    grantId: "grant-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "new-workspace",
    resourceLabel: "New Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const selectionStarted = deferred();
  const selectionRelease = deferred();
  let computerListener;
  let permissionReads = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", unconfigured)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: unconfigured }; },
      async selectMode() {
        selectionStarted.resolve();
        return selectionRelease.promise;
      },
      async listPermissions() {
        permissionReads += 1;
        return { botId: BOT_A, permissions: permissionReads === 2 ? [grant] : [] };
      },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  controller.openComputerSetup();
  controller.chooseComputerMode("local");
  const confirming = controller.confirmComputerMode();
  await selectionStarted.promise;
  computerListener({ botId: BOT_A, computer: current });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["New Workspace"]);
  selectionRelease.resolve({ botId: BOT_A, computer: stale });
  await assert.rejects(confirming, /changed/i);
  assert.equal(controller.snapshot().computer.generation, 2);
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["New Workspace"]);
  controller.dispose();
});

test("a Computer identity change clears grants and fences a held stale grant read", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const oldGrant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "previous-workspace",
    resourceLabel: "Previous Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const held = deferred();
  let listCalls = 0;
  let computerListener;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() {
        listCalls += 1;
        return listCalls === 2 ? held.promise : { botId: BOT_A, permissions: [oldGrant] };
      },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Previous Workspace"]);
  const refresh = controller.selectBot(BOT_A, true);
  while (listCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  computerListener({
    botId: BOT_A,
    computer: {
      mode: "not-now",
      generation: 2,
      localProfileId: null,
      nativeAgentId: null,
      state: "unconfigured",
      lastConfirmedAt: null,
      lastErrorCode: null,
    },
  });
  assert.deepEqual(controller.snapshot().permissions, []);
  held.resolve({ botId: BOT_A, permissions: [oldGrant] });
  await refresh;
  assert.deepEqual(controller.snapshot().permissions, []);
  assert.equal(controller.snapshot().computer.generation, 2);
  controller.dispose();
});

test("permission requests replay after initialization and queue by bot without loss", async () => {
  const { createBotUiController } = require(uiPath);
  const localA = {
    mode: "local",
    generation: 4,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const localB = {
    ...localA,
    localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  const prompt = (requestId, botId, computer) => Object.freeze({
    requestId,
    botId,
    targetId: computer.localProfileId,
    targetGeneration: computer.generation,
    capability: "application.open",
    resourceLabel: "Google Chrome",
    reason: "Open an approved app for this task",
  });
  const promptA = prompt("permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", BOT_A, localA);
  const promptB1 = prompt("permission-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", BOT_B, localB);
  const promptB2 = prompt("permission-cccccccc-cccc-4ccc-8ccc-cccccccccccc", BOT_B, localB);
  const pending = [promptA];
  let onPermission;
  const records = [
    botWithComputer(BOT_A, "A", "ready", localA),
    botWithComputer(BOT_B, "B", "ready", localB),
  ];
  const computerFacade = {
    async read(botId) {
      const record = records.find((entry) => entry.botId === botId);
      return { botId, computer: record.computer };
    },
    async listPermissions(botId) { return { botId, permissions: [] }; },
    async listPermissionRequests(botId) {
      return { botId, requests: pending.filter((entry) => entry.botId === botId) };
    },
    async decidePermission(value) {
      const index = pending.findIndex((entry) => entry.requestId === value.requestId);
      if (index >= 0) pending.splice(index, 1);
      return { botId: value.botId, permissions: [] };
    },
    onChanged() { return () => {}; },
    onPermissionRequested(listener) { onPermission = listener; return () => {}; },
  };
  const controller = createBotUiController({
    facade: {
      async list() { return records; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade,
  });
  await controller.initialize();
  assert.equal(controller.snapshot().permissionRequest.requestId, promptA.requestId);

  pending.push(promptB1, promptB2);
  onPermission(promptB1);
  onPermission(promptB2);
  assert.equal(controller.snapshot().permissionRequest.requestId, promptA.requestId);
  await controller.selectBot(BOT_B);
  assert.deepEqual(
    controller.snapshot().permissionRequests.map(({ requestId }) => requestId),
    [promptB1.requestId, promptB2.requestId],
  );
  assert.equal(controller.snapshot().permissionRequest.requestId, promptB1.requestId);
  await controller.decideComputerPermission("once");
  assert.equal(controller.snapshot().permissionRequest.requestId, promptB2.requestId);
  await controller.selectBot(BOT_A);
  assert.equal(controller.snapshot().permissionRequest.requestId, promptA.requestId);
  controller.dispose();
});

test("renderer bounds and authoritatively recovers live permission prompts for one bot", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 4,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  let onPermission;
  let pending = [];
  let listCalls = 0;
  let heldRefresh = null;
  const makePrompt = (index) => ({
    requestId: `permission-aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "application.open",
    resourceLabel: `App ${index}`,
    reason: "Open an approved app for this task",
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() {
        listCalls += 1;
        if (heldRefresh && listCalls === 2) return heldRefresh.promise;
        return { botId: BOT_A, requests: pending };
      },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { onPermission = listener; return () => {}; },
    },
  });
  await controller.initialize();
  pending = Array.from({ length: 32 }, (_, index) => makePrompt(index + 1));
  for (const prompt of pending) onPermission(prompt);
  assert.equal(controller.snapshot().permissionRequests.length, 32);
  assert.equal(controller.snapshot().permissionRequests.at(-1).resourceLabel, "App 32");
  heldRefresh = deferred();
  const firstSnapshot = Array.from({ length: 32 }, (_, index) => makePrompt(index + 2));
  pending = firstSnapshot;
  onPermission(firstSnapshot.at(-1));
  while (listCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  pending = Array.from({ length: 32 }, (_, index) => makePrompt(index + 3));
  onPermission(pending.at(-1));
  heldRefresh.resolve({ botId: BOT_A, requests: firstSnapshot });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().permissionRequests.length, 32);
  assert.equal(controller.snapshot().permissionRequests[0].resourceLabel, "App 3");
  assert.equal(controller.snapshot().permissionRequests.at(-1).resourceLabel, "App 34");
  assert.ok(listCalls >= 3, "a dropped event during refresh must trigger one more authoritative refresh");
  controller.dispose();
});

test("authoritative prompts for the active bot evict only inactive cached prompts at the global cap", async () => {
  const { createBotUiController } = require(uiPath);
  const identity = (suffix) => ({
    mode: "local",
    generation: 4,
    localProfileId: `local-${suffix}`,
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  });
  const identities = new Map([
    [BOT_A, identity("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")],
    [BOT_B, identity("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")],
    [BOT_C, identity("cccccccc-cccc-4ccc-8ccc-cccccccccccc")],
  ]);
  const records = [...identities].map(([botId, computer], index) => botWithComputer(botId, `Bot ${index}`, "ready", computer));
  const prompt = (botId, index) => ({
    requestId: `permission-${botId.slice(4, 12)}-${index.toString(16).padStart(4, "0")}-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
    botId,
    targetId: identities.get(botId).localProfileId,
    targetGeneration: 4,
    capability: "application.open",
    resourceLabel: `App ${index}`,
    reason: "Open an approved app for this task",
  });
  const pending = new Map([[BOT_A, []], [BOT_B, []], [BOT_C, []]]);
  let onPermission;
  const controller = createBotUiController({
    facade: { async list() { return records; }, onChanged() { return () => {}; } },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read(botId) { return { botId, computer: identities.get(botId) }; },
      async listPermissions(botId) { return { botId, permissions: [] }; },
      async listPermissionRequests(botId) { return { botId, requests: pending.get(botId) }; },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { onPermission = listener; return () => {}; },
    },
  });
  await controller.initialize();
  for (const botId of [BOT_A, BOT_B]) {
    pending.set(botId, Array.from({ length: 32 }, (_, index) => prompt(botId, index + 1)));
    for (const value of pending.get(botId)) onPermission(value);
  }
  pending.set(BOT_C, [prompt(BOT_C, 1)]);
  await controller.selectBot(BOT_C);
  assert.equal(controller.snapshot().permissionRequest?.botId, BOT_C);
  assert.equal(controller.snapshot().permissionRequest?.resourceLabel, "App 1");
  controller.dispose();
});

test("renderer rejects legacy and hostile Computer DTOs without invoking accessors", async () => {
  const { createBotUiController } = require(uiPath);
  const current = botWithComputer(BOT_A, "A", "ready");
  let modeReads = 0;
  const hostileComputer = { ...current.computer };
  Object.defineProperty(hostileComputer, "mode", {
    enumerable: true,
    get() { modeReads += 1; return "not-now"; },
  });
  const controller = createBotUiController({
    facade: { async list() { return [current]; }, onChanged() { return () => {}; } },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: hostileComputer }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.equal(modeReads, 0);
  await assert.rejects(controller.selectBot(BOT_A, true), /Computer state/i);
  assert.equal(modeReads, 0);
  controller.dispose();

  const legacy = createBotUiController({
    facade: { async list() { return [current]; }, onChanged() { return () => {}; } },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: current.computer }; },
      async listPermissions() { return []; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await legacy.initialize();
  await assert.rejects(legacy.selectBot(BOT_A, true), /permissions/i);
  legacy.dispose();
});

test("renderer rejects cross-bot and extra permission DTO fields", async () => {
  const { createBotUiController } = require(uiPath);
  const localA = {
    mode: "local",
    generation: 2,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
  };
  const localB = { ...localA, localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const records = [
    botWithComputer(BOT_A, "A", "ready", localA),
    botWithComputer(BOT_B, "B", "ready", localB),
  ];
  let onPermission;
  let crossBot = false;
  let grantExtra = false;
  const controller = createBotUiController({
    facade: { async list() { return records; }, onChanged() { return () => {}; } },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read(botId) {
        return {
          botId: crossBot && botId === BOT_B ? BOT_A : botId,
          computer: records.find((entry) => entry.botId === botId).computer,
        };
      },
      async listPermissions(botId) {
        return {
          botId,
          permissions: grantExtra ? [{
            grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            botId,
            capability: "filesystem.read",
            resourceId: "workspace",
            resourceLabel: "Workspace",
            scope: "always",
            createdAt: "2026-08-15T12:34:56.000Z",
            unexpected: true,
          }] : [],
        };
      },
      async listPermissionRequests(botId) { return { botId, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { onPermission = listener; return () => {}; },
    },
  });
  await controller.initialize();
  onPermission({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: records[0].computer.localProfileId,
    targetGeneration: records[0].computer.generation,
    capability: "application.open",
    resourceLabel: "Google Chrome",
    reason: "Open an approved app for this task",
    unexpected: true,
  });
  assert.equal(controller.snapshot().permissionRequest, null);
  for (const reason of [
    " Read the workspace",
    "Read /Users/example/private",
    "Read file:/tmp/private",
    "Read ~/private",
    "Read\\private",
    "Read\nprivate",
  ]) {
    onPermission({
      requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      botId: BOT_A,
      targetId: records[0].computer.localProfileId,
      targetGeneration: records[0].computer.generation,
      capability: "filesystem.read",
      resourceLabel: "Workspace",
      reason,
    });
    assert.equal(controller.snapshot().permissionRequest, null, `private reason must be rejected: ${reason}`);
  }
  crossBot = true;
  await assert.rejects(controller.selectBot(BOT_B), /Computer state/i);
  crossBot = false;
  grantExtra = true;
  await assert.rejects(controller.selectBot(BOT_B), /permissions/i);
  controller.dispose();
});

test("permission decisions are single-flight for the exact queued request", async () => {
  const { createBotUiController } = require(uiPath);
  const decision = deferred();
  const local = {
    mode: "local",
    generation: 7,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const prompt = Object.freeze({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "application.open",
    resourceLabel: "Google Chrome",
    reason: "Open an approved app for this task",
  });
  let onPermission;
  let calls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: calls === 0 ? [prompt] : [] }; },
      async decidePermission() { calls += 1; return decision.promise; },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { onPermission = listener; return () => {}; },
    },
  });
  await controller.initialize();
  onPermission(prompt);
  const first = controller.decideComputerPermission("once");
  assert.equal(controller.snapshot().permissionDecisionPending, true);
  await assert.rejects(controller.decideComputerPermission("deny"), /pending|changed|unavailable/i);
  assert.equal(calls, 1);
  decision.resolve({ botId: BOT_A, permissions: [] });
  await first;
  assert.equal(controller.snapshot().permissionDecisionPending, false);
  assert.equal(controller.snapshot().permissionRequest, null);
  controller.dispose();
});

test("a failed permission decision and failed replay keep the broker-owned request retryable", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 7,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const prompt = Object.freeze({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "filesystem.read",
    resourceLabel: "Workspace",
    reason: "Read the approved workspace for this task",
  });
  let permissionListener;
  let requestReads = 0;
  let decisionCalls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() {
        requestReads += 1;
        if (requestReads === 2) throw new Error("replay unavailable");
        return { botId: BOT_A, requests: [] };
      },
      async decidePermission() {
        decisionCalls += 1;
        if (decisionCalls === 1) throw new Error("decision unavailable");
        return { botId: BOT_A, permissions: [] };
      },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
    },
  });
  await controller.initialize();
  permissionListener(prompt);
  await assert.rejects(controller.decideComputerPermission("once"), /decision unavailable/);
  assert.equal(controller.snapshot().permissionDecisionPending, false);
  assert.equal(controller.snapshot().permissionRequest.requestId, prompt.requestId);
  await controller.decideComputerPermission("once");
  assert.equal(decisionCalls, 2);
  assert.equal(controller.snapshot().permissionRequest, null);
  controller.dispose();
});

test("same-bot forced selection cannot discard an authoritative permission decision", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 2,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const prompt = Object.freeze({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "filesystem.read",
    resourceLabel: "Workspace",
    reason: "Read the approved workspace for this task",
  });
  const secondPrompt = Object.freeze({
    ...prompt,
    requestId: "permission-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    resourceLabel: "Downloads",
  });
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const decisionStarted = deferred();
  const decisionRelease = deferred();
  let permissionListener;
  let computerListener;
  let requestReads = 0;
  let decisionCalls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() {
        requestReads += 1;
        return { botId: BOT_A, requests: requestReads === 1 ? [] : [secondPrompt] };
      },
      async decidePermission() {
        decisionCalls += 1;
        if (decisionCalls > 1) return { botId: BOT_A, permissions: [] };
        decisionStarted.resolve();
        return decisionRelease.promise;
      },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
    },
  });
  await controller.initialize();
  permissionListener(prompt);
  const deciding = controller.decideComputerPermission("always");
  await decisionStarted.promise;
  computerListener({ botId: BOT_A, computer: local });
  await controller.selectBot(BOT_A, true);
  assert.equal(controller.snapshot().permissionRequest.requestId, secondPrompt.requestId);
  assert.equal(controller.snapshot().permissionDecisionPending, true);
  await assert.rejects(controller.decideComputerPermission("once"), /unavailable|changed/i);
  assert.equal(decisionCalls, 1);
  decisionRelease.resolve({ botId: BOT_A, permissions: [grant] });
  await deciding;
  assert.deepEqual(controller.snapshot().permissions.map(({ resourceLabel }) => resourceLabel), ["Workspace"]);
  assert.equal(controller.snapshot().permissionDecisionPending, false);
  controller.dispose();
});

test("a failed forced selection cannot cancel an authoritative revoke result", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 2,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const revokeStarted = deferred();
  const revokeRelease = deferred();
  let selectionCalls = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() {
        selectionCalls += 1;
        if (selectionCalls > 1) throw new Error("selection failed");
        return null;
      },
    },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [grant] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      async revokePermission() {
        revokeStarted.resolve();
        return revokeRelease.promise;
      },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const revoking = controller.revokeComputerPermission(grant.grantId);
  await revokeStarted.promise;
  await assert.rejects(controller.selectBot(BOT_A, true), /selection failed/);
  revokeRelease.resolve({ botId: BOT_A, permissions: [] });
  await revoking;
  assert.deepEqual(controller.snapshot().permissions, []);
  controller.dispose();
});

test("a duplicate same-target Computer event cannot discard an authoritative revoke result", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 2,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const revokeStarted = deferred();
  const revokeRelease = deferred();
  const refreshStarted = deferred();
  const refreshRelease = deferred();
  let computerListener;
  let permissionReads = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() {
        permissionReads += 1;
        if (permissionReads === 1) return { botId: BOT_A, permissions: [grant] };
        refreshStarted.resolve();
        return refreshRelease.promise;
      },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      async revokePermission() {
        revokeStarted.resolve();
        return revokeRelease.promise;
      },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  const revoking = controller.revokeComputerPermission(grant.grantId);
  await revokeStarted.promise;
  computerListener({ botId: BOT_A, computer: local });
  await refreshStarted.promise;
  refreshRelease.resolve({ botId: BOT_A, permissions: [grant] });
  await new Promise((resolve) => setImmediate(resolve));
  revokeRelease.resolve({ botId: BOT_A, permissions: [] });
  await revoking;
  assert.deepEqual(controller.snapshot().permissions, []);
  controller.dispose();
});

test("permission cleanup never renders after controller disposal", async () => {
  const { createBotUiController } = require(uiPath);
  const local = {
    mode: "local",
    generation: 2,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const prompt = Object.freeze({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "filesystem.read",
    resourceLabel: "Workspace",
    reason: "Read the approved workspace for this task",
  });
  const replayStarted = deferred();
  const replayRelease = deferred();
  let permissionListener;
  let requestReads = 0;
  let afterDispose = false;
  let postDisposeRenders = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() {
        requestReads += 1;
        if (requestReads > 1) {
          replayStarted.resolve();
          return replayRelease.promise;
        }
        return { botId: BOT_A, requests: [] };
      },
      async decidePermission() { return { botId: BOT_A, permissions: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
    },
    onStateChanged() { if (afterDispose) postDisposeRenders += 1; },
  });
  await controller.initialize();
  permissionListener(prompt);
  const deciding = controller.decideComputerPermission("once");
  await replayStarted.promise;
  afterDispose = true;
  controller.dispose();
  replayRelease.resolve({ botId: BOT_A, requests: [] });
  await assert.rejects(deciding, /changed/i);
  assert.equal(postDisposeRenders, 0);
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
              defaultServiceTier: "priority",
              serviceTiers: Object.freeze([
                Object.freeze({ id: "priority", name: "Fast", description: "1.5x speed" }),
                Object.freeze({ id: "ultrafast", name: "Ultra fast", description: "Fastest" }),
              ]),
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
  await controller.selectModel("openai-codex", "gpt-5.6-sol", "ultra", "ultrafast");
  assert.deepEqual(calls, [{
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: "ultrafast",
  }]);
  await assert.rejects(
    () => controller.selectModel("openai-codex", "gpt-5.6-sol", "ultra", "invented"),
    /selection/i,
  );
  await assert.rejects(() => controller.selectModel("openai-codex", "gpt-5.5", "ultra"), /selection/i);
  current = bot(BOT_A, "New Bot", "unavailable");
  controller.applyBot(current);
  await controller.selectModel("openai-codex", "gpt-5.6-sol", "high");
  assert.deepEqual(calls.at(-1), {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    serviceTier: "priority",
  });
});

test("controller model selection round-trips an exact provider when raw model ids collide", async () => {
  const { createBotUiController } = require(uiPath);
  const calls = [];
  let generation = 1;
  const direct = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 24,
    generation,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return direct; },
      async readModel() { return direct; },
      async selectModel(selection) {
        calls.push(structuredClone(selection));
        return Object.freeze({
          ...selection,
          catalogGeneration: selection.provider === "openai-codex" ? 24 : 1,
          generation: ++generation,
        });
      },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({
          generation: 24,
          status: "ready",
          models: Object.freeze([Object.freeze({
            id: "claude-fable-5",
            displayName: "Direct Claude Fable 5",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: Object.freeze(["medium", "high"]),
          })]),
        });
      },
    },
  });
  await controller.initialize();
  await controller.selectModel("cliproxy-anthropic", "claude-fable-5", "ultra-code", null);
  assert.equal(controller.snapshot().modelSelection.provider, "cliproxy-anthropic");
  await controller.selectModel("openai-codex", "claude-fable-5", "high", null);
  assert.equal(controller.snapshot().modelSelection.provider, "openai-codex");
  assert.deepEqual(calls.map(({ provider, model, reasoningEffort }) => [provider, model, reasoningEffort]), [
    ["cliproxy-anthropic", "claude-fable-5", "ultra-code"],
    ["openai-codex", "claude-fable-5", "high"],
  ]);
});

test("newer same-bot model intent wins when selection replies resolve out of order", async () => {
  const { createBotUiController } = require(uiPath);
  const releases = [];
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return null; },
      selectModel(selection) {
        return new Promise((resolve) => releases.push(() => resolve(Object.freeze({
          ...selection,
          provider: "openai-codex",
          catalogGeneration: 4,
          generation: releases.length,
        }))));
      },
    },
    accountFacade: {
      async catalog() {
        return Object.freeze({
          generation: 4,
          status: "ready",
          models: Object.freeze([
            Object.freeze({
              id: "gpt-5.6-terra",
              displayName: "GPT-5.6 Terra",
              defaultReasoningEffort: "low",
              supportedReasoningEfforts: Object.freeze(["low"]),
            }),
            Object.freeze({
              id: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: Object.freeze(["medium", "ultra"]),
            }),
          ]),
        });
      },
    },
  });
  await controller.initialize();
  const older = controller.selectModel("openai-codex", "gpt-5.6-terra", "low");
  const newer = controller.selectModel("openai-codex", "gpt-5.6-sol", "ultra");
  releases[1]();
  await newer;
  releases[0]();
  await assert.rejects(older, /selection changed/i);
  assert.deepEqual(controller.snapshot().modelSelection, {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 4,
    generation: 2,
  });
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
  await controller.selectModel("cliproxy-anthropic", "claude-fable-5", "ultra-code");
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

test("disposal fences pending initialization and immediately releases late subscriptions", async () => {
  const { createBotUiController } = require(uiPath);
  const catalog = deferred();
  const calls = [];
  const controller = createBotUiController({
    facade: {
      async list() { calls.push("list"); return [bot(BOT_A, "A", "ready")]; },
      onChanged() { calls.push("bots-subscribe"); return () => calls.push("bots-unsubscribe"); },
    },
    runtimeFacade: {
      async selectBot() { calls.push("select"); return null; },
      onEvent() { calls.push("runtime-subscribe"); return () => calls.push("runtime-unsubscribe"); },
    },
    accountFacade: {
      catalog() { return catalog.promise; },
      onCatalogChanged() { calls.push("catalog-subscribe"); return () => calls.push("catalog-unsubscribe"); },
    },
    onStateChanged() { calls.push("render"); },
  });
  const initialization = controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
  catalog.resolve(Object.freeze({ generation: 0, status: "loading", models: Object.freeze([]) }));
  await assert.rejects(initialization, /unavailable/i);
  assert.deepEqual(calls, ["catalog-subscribe", "catalog-unsubscribe"]);
  assert.deepEqual(controller.snapshot().bots, []);
});

test("disposal fences a late bot creation result without reviving local state", async () => {
  const { createBotUiController } = require(uiPath);
  const creation = deferred();
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      create() { return creation.promise; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
  });
  await controller.initialize();
  const pending = controller.createBot();
  controller.dispose();
  creation.resolve(bot(BOT_B, "New Bot", "provisioning"));
  await assert.rejects(pending, /unavailable/i);
  assert.deepEqual(controller.snapshot().bots, []);
  assert.equal(controller.snapshot().activeBotId, null);
});

test("disposal during the initial selection prevents post-dispose renders and subscriptions", async () => {
  const { createBotUiController } = require(uiPath);
  const selection = deferred();
  const calls = [];
  let renders = 0;
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { calls.push("bots-subscribe"); return () => calls.push("bots-unsubscribe"); },
    },
    runtimeFacade: {
      selectBot() { calls.push("select"); return selection.promise; },
      onEvent() { calls.push("runtime-subscribe"); return () => calls.push("runtime-unsubscribe"); },
    },
    onStateChanged() { renders += 1; },
  });
  const initialization = controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  const rendersBeforeDispose = renders;
  controller.dispose();
  selection.resolve(null);
  await assert.rejects(initialization, /changed|unavailable/i);
  assert.equal(renders, rendersBeforeDispose);
  assert.deepEqual(calls, ["select"]);
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

test("native coordinator selection switches the active bot before model and Computer controls update", async () => {
  const { createBotUiController } = require(uiPath);
  let runtimeListener;
  const selections = [];
  const selectionFor = (botId) => Object.freeze({
    botId,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: selections.length,
  });
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { selections.push(botId); return selectionFor(botId); },
      onEvent(listener) { runtimeListener = listener; return () => {}; },
    },
  });
  await controller.initialize();
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  runtimeListener(Object.freeze({ type: "active-bot-changed", botId: BOT_B }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  assert.deepEqual(selections, [BOT_A, BOT_B]);
  controller.dispose();
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
  const selected = [];
  class MountElement extends FakeElement {
    constructor(tagName, documentRef) {
      super(tagName);
      this.ownerDocument = documentRef;
      this.dataset = Object.create(null);
      this.parentElement = null;
      this.value = "";
      this.disabled = false;
      this.open = false;
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
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; this.hidden = false; }
    close() { this.open = false; this.hidden = true; }
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
      async selectModel(value) {
        selected.push(value);
        return Object.freeze({
          ...value,
          provider: "cliproxy-anthropic",
          catalogGeneration: 1,
          generation: 3,
        });
      },
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
  const power = find(mounted.modelDock, "codex-power-input");
  const trigger = find(mounted.modelDock, "codex-model-trigger");
  const triggerModel = find(mounted.modelDock, "codex-model-trigger-model");
  const triggerEffort = find(mounted.modelDock, "codex-model-trigger-effort");
  const popover = find(mounted.modelDock, "codex-power-popover");
  const panelStack = find(mounted.modelDock, "codex-power-panel-stack");
  const powerShell = find(mounted.modelDock, "codex-power-shell");
  const fastToggle = find(mounted.modelDock, "codex-power-fast-toggle");
  const advancedToggle = find(mounted.modelDock, "codex-power-advanced-toggle");
  const advanced = find(mounted.modelDock, "codex-power-advanced");
  const advancedModel = find(mounted.modelDock, "codex-power-model-select");
  assert.equal(mounted.controller.snapshot().activeBotId, BOT_A);
  assert.equal(mounted.controller.snapshot().modelSelection, null);
  assert.equal(power.disabled, false);
  assert.ok(trigger);
  assert.equal(trigger.attributes["aria-haspopup"], "dialog");
  assert.equal(trigger.attributes["aria-expanded"], "false");
  assert.equal(popover.hidden, true);
  assert.deepEqual(panelStack.children.map((child) => child.className), [
    "codex-power-shell",
    "codex-power-advanced",
  ]);
  trigger.listeners.get("click")();
  assert.equal(trigger.attributes["aria-expanded"], "true");
  assert.equal(popover.hidden, false);
  assert.equal(fastToggle.hidden, true);
  mounted.modelDock.listeners.get("keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(trigger.attributes["aria-expanded"], "false");
  assert.equal(popover.hidden, true);
  trigger.listeners.get("click")();
  assert.equal(advancedToggle.disabled, false);
  assert.equal(advanced.hidden, true);
  assert.equal(advancedModel.children[0].value,
    JSON.stringify(["cliproxy-anthropic", "claude-fable-5"]));
  assert.equal(find(mounted.modelDock, "codex-model-select"), null);
  power.listeners.get("pointerdown")();
  power.value = "5";
  power.listeners.get("input")();
  power.listeners.get("pointerup")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, [{
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
  }]);
  assert.equal(find(mounted.modelDock, "codex-power-label").textContent, "Ultra Code");
  assert.equal(triggerModel.textContent, "Claude Fable 5");
  assert.equal(triggerEffort.textContent, "Ultra Code");
  advancedToggle.listeners.get("click")();
  assert.equal(advanced.hidden, false);
  assert.equal(powerShell.hidden, true);
  assert.equal(advancedToggle.attributes["aria-expanded"], "true");
  mounted.dispose();
});

function createMountedUiHarness({
  catalog,
  initialSelection,
  fileReader = null,
  windowTimers = { clearTimeout, setTimeout },
  botsFacade = null,
  computerFacade = null,
  runtimeFacade = null,
  nativeProtocol = false,
}) {
  const { mount } = require(uiPath);
  class MountElement extends FakeElement {
    constructor(tagName, documentRef) {
      super(tagName);
      this.ownerDocument = documentRef;
      this.dataset = Object.create(null);
      this.parentElement = null;
      this.value = "";
      this.disabled = false;
      this.open = false;
      this.listeners = new Map();
    }
    append(...children) {
      super.append(...children);
      for (const child of children) child.parentElement = this;
    }
    replaceChildren(...children) {
      super.replaceChildren(...children);
      for (const child of children) child.parentElement = this;
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    contains(candidate) {
      return candidate === this || this.children.some((child) => child.contains?.(candidate));
    }
    focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; this.hidden = false; }
    close() { this.open = false; this.hidden = true; }
    remove() { this.parentElement = null; }
  }
  const documentRef = {
    body: null,
    sidebar: null,
    composer: null,
    listeners: new Map(),
    createElement(tagName) { return new MountElement(tagName, this); },
    getElementById() { return null; },
    querySelector(selector) {
      if (selector === "[data-codex-bot-sidebar-host]") return this.sidebar;
      if (selector === "[data-codex-bot-composer-host]") return this.composer;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    removeEventListener(name) { this.listeners.delete(name); },
  };
  documentRef.body = documentRef.createElement("body");
  documentRef.sidebar = documentRef.createElement("aside");
  documentRef.composer = documentRef.createElement("form");
  let current = initialSelection;
  let generation = initialSelection.generation;
  const selected = [];
  const windowRef = {
    ...(nativeProtocol ? {
      openbotProtocol: Object.freeze({ schemaVersion: 1, mode: "local-protocol" }),
    } : {}),
    codexBots: botsFacade ?? {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    codexRuntime: runtimeFacade ?? {
      async selectBot() { return current; },
      async readModel() { return current; },
      async selectModel(value) {
        selected.push(value);
        const model = catalog.models.find((entry) => entry.id === value.model);
        current = Object.freeze({
          ...value,
          provider: "openai-codex",
          catalogGeneration: catalog.generation,
          generation: ++generation,
        });
        assert.ok(model);
        return current;
      },
    },
    codexAccount: {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    dispatchEvent() {},
    setTimeout: windowTimers.setTimeout,
    clearTimeout: windowTimers.clearTimeout,
  };
  if (fileReader) windowRef.FileReader = fileReader;
  if (computerFacade) windowRef.openbotComputer = computerFacade;
  const mounted = mount({ windowRef, documentRef });
  const find = (node, className) => {
    if (node.className === className) return node;
    for (const child of node.children) {
      const found = find(child, className);
      if (found) return found;
    }
    return null;
  };
  return {
    documentRef,
    find: (className) => find(mounted.modelDock, className),
    findPanel: (className) => find(mounted.panel, className),
    mounted,
    selected,
  };
}

test("mounted model controls keep same-id official and CLIProxy rows provider-scoped", async (context) => {
  const catalog = Object.freeze({
    generation: 24,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "claude-fable-5",
      displayName: "Direct Claude Fable 5",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "high"]),
    })]),
  });
  let generation = 1;
  let current = Object.freeze({
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
    generation,
  });
  const selected = [];
  const runtimeFacade = {
    async selectBot() { return current; },
    async readModel() { return current; },
    async selectModel(value) {
      selected.push(structuredClone(value));
      current = Object.freeze({
        ...value,
        catalogGeneration: value.provider === "openai-codex" ? catalog.generation : 1,
        generation: ++generation,
      });
      return current;
    },
  };
  const harness = createMountedUiHarness({ catalog, initialSelection: current, runtimeFacade });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const model = harness.find("codex-power-model-select");
  const triggerModel = harness.find("codex-model-trigger-model");
  const option = (label) => model.children.find((entry) => entry.textContent === label);
  assert.equal(triggerModel.textContent, "Claude Fable 5");
  assert.ok(option("Direct Claude Fable 5"));
  assert.ok(option("Claude Fable 5"));
  assert.notEqual(option("Direct Claude Fable 5").value, option("Claude Fable 5").value);

  model.value = option("Direct Claude Fable 5").value;
  model.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected.at(-1), {
    botId: BOT_A,
    provider: "openai-codex",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  });
  assert.equal(triggerModel.textContent, "Direct Claude Fable 5");

  model.value = option("Claude Fable 5").value;
  model.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected.at(-1), {
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  });
  assert.equal(triggerModel.textContent, "Claude Fable 5");
});

test("native protocol mode preserves the Grok shell and mounts only Power plus owned dialogs", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.mounted.panel.parentElement, null);
  assert.equal(harness.documentRef.sidebar.children.includes(harness.mounted.panel), false);
  assert.equal(harness.mounted.modelDock.parentElement, harness.documentRef.composer);
  for (const className of ["codex-new-bot-setup", "codex-computer-setup", "codex-permission-sheet"]) {
    const dialog = harness.findPanel(className);
    assert.equal(dialog.parentElement, harness.documentRef.body, className);
    assert.equal(dialog.tagName, "DIALOG");
  }
  assert.equal(harness.find("codex-provider-select"), null, "the native Grok picker owns provider selection");
  assert.equal(harness.find("codex-provider-connect"), null);
  assert.equal(harness.find("codex-power-advanced-toggle"), null, "the native Grok picker owns Advanced model controls");
  assert.equal(harness.find("codex-power-model-select"), null);
  assert.equal(harness.find("codex-power-effort-select"), null);
  assert.equal(harness.find("codex-power-speed-select"), null);
  assert.equal(harness.find("codex-power-input").tagName, "INPUT");
});

test("mounted async provider completion never mutates detached controls after disposal", async () => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const connection = deferred();
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    runtimeFacade: {
      async selectBot() { return selection; },
      async readModel() { return selection; },
      async selectModel() { return selection; },
      async connectProvider() { return connection.promise; },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const provider = harness.findPanel("codex-provider-select");
  const connect = harness.findPanel("codex-provider-connect");
  provider.value = "claude";
  connect.listeners.get("click")();
  assert.equal(connect.disabled, true);
  harness.mounted.dispose();
  connection.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connect.disabled, true, "a detached control must not be mutated by late completion");
});

test("mounted New Bot creation exposes a sanitized failure and a retry succeeds once", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const created = bot(BOT_B, "New Bot", "ready");
  let createCalls = 0;
  const botsFacade = {
    async list() { return [bot(BOT_A, "A", "ready")]; },
    async create() {
      createCalls += 1;
      if (createCalls === 1) throw new Error("ENOSPC /Users/private endpoint=https://provider token=secret");
      return created;
    },
    onChanged() { return () => {}; },
  };
  const runtimeFacade = {
    async selectBot(botId) { return Object.freeze({ ...initialSelection, botId, generation: createCalls + 1 }); },
    async readModel(botId) { return Object.freeze({ ...initialSelection, botId, generation: createCalls + 1 }); },
    async selectModel(value) { return Object.freeze({ ...value, provider: "openai-codex", generation: 4 }); },
  };
  const harness = createMountedUiHarness({ catalog, initialSelection, botsFacade, runtimeFacade });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const newButton = harness.findPanel("codex-bot-new");
  const creationAlert = harness.findPanel("codex-bot-create-error");
  newButton.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCalls, 1);
  assert.equal(newButton.disabled, false);
  assert.equal(creationAlert.hidden, false);
  assert.equal(creationAlert.attributes.role, "alert");
  assert.match(creationAlert.textContent, /could not create|try again/i);
  assert.doesNotMatch(creationAlert.textContent, /ENOSPC|Users\/private|provider|token|secret/i);

  newButton.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCalls, 2);
  assert.equal(harness.mounted.controller.snapshot().activeBotId, BOT_B);
  assert.equal(harness.mounted.controller.snapshot().bots.filter(({ botId }) => botId === BOT_B).length, 1);
  assert.equal(creationAlert.hidden, true);
  assert.equal(creationAlert.textContent, "");
});

test("mounted New Bot requires profile and model confirmation before unselected Computer", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    })]),
  });
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const created = pendingBotWithComputer(BOT_B);
  const selections = new Map([[BOT_A, initialSelection], [BOT_B, Object.freeze({ ...initialSelection, botId: BOT_B })]]);
  let permissionListener;
  const modes = [];
  const decisions = [];
  const setupCalls = [];
  class SetupPhotoReader {
    readAsDataURL() {
      this.result = "data:image/png;base64,aGVsbG8=";
      this.onload();
    }
  }
  const computerFacade = {
    async read(botId) { return { botId, computer: created.computer }; },
    async listPermissions(botId) { return { botId, permissions: [] }; },
    async selectMode(value) {
      modes.push(value);
      return {
        botId: value.botId,
        computer: {
          ...created.computer,
          mode: "local",
          generation: 1,
          localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          state: "ready",
          lastConfirmedAt: "2026-08-15T12:34:56.000Z",
        },
      };
    },
    async decidePermission(value) { decisions.push(value); return { botId: value.botId, permissions: [] }; },
    async revokePermission(value) { return { botId: value.botId, permissions: [] }; },
    onChanged() { return () => {}; },
    onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
  };
  const botsFacade = {
    async list() { return [botWithComputer(BOT_A, "A", "ready")]; },
    async create() { return created; },
    async rename(botId, name) {
      setupCalls.push(["rename", botId, name]);
      return pendingBotWithComputer(botId, name);
    },
    async updateProfile(botId, profile) {
      setupCalls.push(["updateProfile", botId, profile]);
      return pendingBotWithComputer(botId, "Research Bot");
    },
    async advanceSetup(value) {
      setupCalls.push(["advanceSetup", value]);
      return botWithComputer(value.botId, "Research Bot", "provisioning", {}, value.nextStage);
    },
    onChanged() { return () => {}; },
  };
  const runtimeFacade = {
    async selectBot(botId) { return selections.get(botId); },
    async readModel(botId) { return selections.get(botId); },
    async selectModel(value) {
      setupCalls.push(["selectModel", value]);
      const selected = Object.freeze({
        ...value,
        provider: "openai-codex",
        catalogGeneration: 12,
        generation: 2,
      });
      selections.set(value.botId, selected);
      return selected;
    },
  };
  const harness = createMountedUiHarness({
    catalog,
    fileReader: SetupPhotoReader,
    initialSelection,
    botsFacade,
    computerFacade,
    runtimeFacade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const newButton = harness.findPanel("codex-bot-new");
  newButton.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  const profileSetup = harness.findPanel("codex-new-bot-setup");
  const profileTitle = harness.findPanel("codex-new-bot-setup-title");
  const name = harness.findPanel("codex-new-bot-name");
  const description = harness.findPanel("codex-new-bot-description");
  const photo = harness.findPanel("codex-new-bot-photo");
  const shape = harness.findPanel("codex-new-bot-shape");
  const color = harness.findPanel("codex-new-bot-color");
  const provider = harness.findPanel("codex-new-bot-provider");
  const model = harness.findPanel("codex-new-bot-model");
  const power = harness.findPanel("codex-new-bot-power");
  const profileContinue = harness.findPanel("codex-new-bot-continue");
  assert.equal(profileSetup.hidden, false);
  assert.equal(profileSetup.open, true);
  assert.equal(profileSetup.tagName, "DIALOG");
  assert.equal(profileSetup.attributes.role, "dialog");
  assert.equal(profileSetup.attributes["aria-modal"], "true");
  assert.equal(profileTitle.textContent, "Set up New Bot");
  assert.equal(name.value, "New Bot");
  assert.equal(name.placeholder, "Name your Bot");
  assert.equal(name.required, true);
  assert.equal(name.attributes["aria-required"], "true");
  assert.equal(description.placeholder, "What should this Bot help with?");
  assert.equal(photo.type, "file");
  assert.equal(photo.accept, "image/png");
  assert.deepEqual(shape.children.map((option) => option.value).slice(0, 3), ["blob", "pebble", "bean"]);
  assert.deepEqual(color.children.map((option) => option.value).slice(0, 3), ["black", "brown", "red"]);
  assert.equal(provider.value, "openai-codex");
  assert.equal(model.value, "gpt-5.6-sol");
  assert.equal(power.value, "medium");
  assert.equal(profileContinue.disabled, false);
  assert.equal(harness.mounted.controller.snapshot().computerSetup.open, false);
  assert.equal(harness.documentRef.activeElement, name);

  const botSelect = harness.findPanel("codex-bot-select");
  botSelect.value = BOT_A;
  assert.doesNotThrow(() => botSelect.listeners.get("change")());
  assert.equal(harness.mounted.controller.snapshot().activeBotId, BOT_B);
  assert.equal(harness.mounted.controller.snapshot().profileSetup.open, true);
  name.value = " ";
  name.listeners.get("input")();
  assert.equal(profileContinue.disabled, true, "a non-empty Bot name is required");
  name.value = "Research Bot";
  name.listeners.get("input")();
  description.value = "Find exact primary sources.";
  description.listeners.get("input")();
  shape.value = "gem";
  shape.listeners.get("change")();
  color.value = "blue";
  color.listeners.get("change")();
  power.value = "ultra";
  power.listeners.get("change")();
  photo.files = [{ type: "image/png", size: 5 }];
  photo.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  profileContinue.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setupCalls, [
    ["rename", BOT_B, "Research Bot"],
    ["updateProfile", BOT_B, {
      appearance: {
        shape: "gem",
        color: "blue",
        image: "data:image/png;base64,aGVsbG8=",
        description: "Find exact primary sources.",
      },
    }],
    ["selectModel", {
      botId: BOT_B,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: null,
    }],
    ["advanceSetup", {
      botId: BOT_B,
      expectedStage: "profile-model",
      nextStage: "computer",
    }],
  ]);
  assert.equal(profileSetup.hidden, true);
  assert.equal(profileSetup.open, false);

  const setup = harness.findPanel("codex-computer-setup");
  const choices = harness.findPanel("codex-computer-choices");
  const continueButton = harness.findPanel("codex-computer-continue");
  const cancelButton = harness.findPanel("codex-computer-cancel");
  assert.equal(setup.hidden, false);
  assert.equal(setup.open, true);
  assert.equal(setup.tagName, "DIALOG");
  assert.equal(setup.attributes.role, "dialog");
  assert.equal(setup.attributes["aria-modal"], "true");
  assert.deepEqual(choices.children.map((label) => [
    label.children[0].value,
    label.children[1].children[0].textContent,
  ]), [
    ["local", "Free Local Desktop"],
    ["cursor", "Cursor Remote Computer"],
    ["not-now", "Not Now"],
  ]);
  assert.equal(choices.children.every((label) => label.children[0].checked !== true), true);
  assert.equal(continueButton.disabled, true);
  assert.equal(cancelButton.hidden, true, "initial setup must remain an explicit choice");
  const localInput = choices.children[0].children[0];
  assert.equal(harness.documentRef.activeElement === localInput, true, "setup must focus its first choice");
  localInput.checked = true;
  localInput.listeners.get("change")();
  assert.equal(continueButton.disabled, false);
  continueButton.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(modes, [{ botId: BOT_B, mode: "local" }]);
  assert.equal(setup.hidden, true);
  assert.equal(setup.open, false);
  assert.equal(harness.documentRef.activeElement === newButton, true, "setup must restore focus");
  assert.equal(harness.findPanel("codex-computer-status").textContent, "Runs on this Mac");

  permissionListener({
    requestId: "permission-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    botId: BOT_B,
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 1,
    capability: "application.open",
    resourceLabel: "Google Chrome",
    reason: "Open an approved app for this task",
  });
  const sheet = harness.findPanel("codex-permission-sheet");
  assert.equal(sheet.hidden, false);
  assert.equal(sheet.open, true);
  assert.equal(sheet.tagName, "DIALOG");
  assert.equal(
    harness.documentRef.activeElement === harness.findPanel("codex-permission-deny"),
    true,
    "permission sheet must focus Deny",
  );
  assert.equal(harness.findPanel("codex-permission-title").textContent, "Allow Research Bot to use Google Chrome?");
  harness.findPanel("codex-permission-once").listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(decisions.map(({ decision }) => decision), ["once"]);
  assert.equal(sheet.hidden, true);
  assert.equal(sheet.open, false);
  assert.equal(harness.documentRef.activeElement === newButton, true, "permission sheet must restore focus");
  assert.equal(selections.has(BOT_B), true);
  harness.mounted.dispose();
});

test("mounted permission actions disable atomically and Escape cannot decide twice", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const local = {
    mode: "local",
    generation: 3,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const prompt = Object.freeze({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "application.open",
    resourceLabel: "Google Chrome",
    reason: "Open an approved app for this task",
  });
  const secondPrompt = Object.freeze({
    ...prompt,
    requestId: "permission-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    resourceLabel: "Downloads",
  });
  const held = deferred();
  const decisions = [];
  let pending = [];
  let permissionListener;
  const computerFacade = {
    async read() { return { botId: BOT_A, computer: local }; },
    async listPermissions() { return { botId: BOT_A, permissions: [] }; },
    async listPermissionRequests() { return { botId: BOT_A, requests: pending }; },
    async decidePermission(value) {
      decisions.push(value);
      pending = pending.filter((entry) => entry.requestId !== value.requestId);
      return decisions.length === 1 ? held.promise : { botId: BOT_A, permissions: [] };
    },
    async revokePermission() { return { botId: BOT_A, permissions: [] }; },
    onChanged() { return () => {}; },
    onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    botsFacade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    computerFacade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const newButton = harness.findPanel("codex-bot-new");
  newButton.focus();
  pending = [prompt, secondPrompt];
  permissionListener(prompt);
  permissionListener(secondPrompt);
  const once = harness.findPanel("codex-permission-once");
  const deny = harness.findPanel("codex-permission-deny");
  const always = harness.findPanel("codex-permission-always");
  const sheet = harness.findPanel("codex-permission-sheet");
  once.focus();
  once.listeners.get("click")();
  assert.equal(harness.mounted.controller.snapshot().permissionDecisionPending, true);
  assert.deepEqual([deny.disabled, once.disabled, always.disabled], [true, true, true]);
  let prevented = false;
  sheet.listeners.get("cancel")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(decisions.length, 1);
  await harness.mounted.controller.selectBot(BOT_A, true);
  assert.equal(harness.mounted.controller.snapshot().permissionRequest.requestId, secondPrompt.requestId);
  assert.equal(harness.mounted.controller.snapshot().permissionDecisionPending, true);
  assert.equal(harness.documentRef.activeElement === deny, false, "a disabled Deny action cannot take focus");
  held.resolve({ botId: BOT_A, permissions: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mounted.controller.snapshot().permissionRequest.requestId, secondPrompt.requestId);
  assert.equal(harness.documentRef.activeElement === deny, true, "the queued prompt must focus Deny");
  deny.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sheet.hidden, true);
  assert.equal(harness.mounted.controller.snapshot().permissionDecisionPending, false);
  assert.equal(harness.documentRef.activeElement === newButton, true, "the prompt queue must restore original focus");
});

test("mounted shell consent shows the exact full-host command and offers no Always action", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const local = {
    mode: "local",
    generation: 3,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const command = "printf 'exact command'\n/usr/bin/true";
  const prompt = Object.freeze({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "shell.execute",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command,
    allowsAlways: false,
  });
  const decisions = [];
  let pending = [];
  let permissionListener;
  const computerFacade = {
    async read() { return { botId: BOT_A, computer: local }; },
    async listPermissions() { return { botId: BOT_A, permissions: [] }; },
    async listPermissionRequests() { return { botId: BOT_A, requests: pending }; },
    async decidePermission(value) {
      decisions.push(value);
      pending = [];
      return { botId: BOT_A, permissions: [] };
    },
    onChanged() { return () => {}; },
    onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    botsFacade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    computerFacade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  pending = [prompt];
  permissionListener(prompt);
  assert.equal(harness.findPanel("codex-permission-title").textContent, "Allow A to use Full host shell?");
  assert.equal(harness.findPanel("codex-permission-reason").textContent, prompt.reason);
  assert.equal(harness.findPanel("codex-permission-command").textContent, command);
  const always = harness.findPanel("codex-permission-always");
  assert.equal(always.hidden, true);
  assert.equal(always.disabled, true);
  await assert.rejects(harness.mounted.controller.decideComputerPermission("always"), /unavailable|changed/i);
  assert.equal(decisions.length, 0);
  harness.findPanel("codex-permission-once").listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(decisions.map(({ decision }) => decision), ["once"]);
});

test("mounted Computer grants stay bot-scoped and expose revoke plus Change Computer", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const selectionFor = (botId) => Object.freeze({
    botId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const localFor = (suffix) => ({
    mode: "local",
    generation: 2,
    localProfileId: `local-${suffix}`,
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  });
  const localA = localFor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const localB = localFor("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const grantFor = (botId, suffix, label, capability = "filesystem.read") => Object.freeze({
    grantId: `grant-${suffix}`,
    botId,
    capability,
    resourceId: label.toLowerCase().replaceAll(" ", "-"),
    resourceLabel: label,
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const grantA = grantFor(BOT_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Project A");
  const grantB = grantFor(BOT_B, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Project B");
  const grantBWrite = grantFor(
    BOT_B,
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "Project B",
    "filesystem.write",
  );
  const grants = new Map([[BOT_A, [grantA]], [BOT_B, [grantB, grantBWrite]]]);
  const revoked = [];
  const records = [
    botWithComputer(BOT_A, "A", "ready", localA),
    botWithComputer(BOT_B, "B", "ready", localB),
  ];
  const computerFacade = {
    async read(botId) {
      const record = records.find((entry) => entry.botId === botId);
      return { botId, computer: record.computer };
    },
    async listPermissions(botId) { return { botId, permissions: grants.get(botId) }; },
    async listPermissionRequests(botId) { return { botId, requests: [] }; },
    async revokePermission(value) {
      revoked.push(value);
      grants.set(value.botId, []);
      return { botId: value.botId, permissions: [] };
    },
    onChanged() { return () => {}; },
    onPermissionRequested() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selectionFor(BOT_A),
    botsFacade: {
      async list() { return records; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return selectionFor(botId); },
      async readModel(botId) { return selectionFor(botId); },
      async selectModel(value) { return selectionFor(value.botId); },
    },
    computerFacade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const grantsList = harness.findPanel("codex-computer-grants-list");
  assert.equal(grantsList.children.length, 1);
  assert.equal(grantsList.children[0].children[0].children[0].textContent, "Project A");
  const botSelect = harness.findPanel("codex-bot-select");
  botSelect.value = BOT_B;
  botSelect.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(grantsList.children.length, 2);
  assert.equal(grantsList.children[0].children[0].children[0].textContent, "Project B");
  const revoke = grantsList.children[0].children.at(-1);
  assert.equal(revoke.attributes["aria-label"], "Revoke filesystem read access to Project B");
  assert.equal(
    grantsList.children[1].children.at(-1).attributes["aria-label"],
    "Revoke filesystem write access to Project B",
  );
  revoke.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(revoked, [{ botId: BOT_B, grantId: grantB.grantId }]);
  assert.equal(grantsList.children.length, 0);
  const change = harness.findPanel("codex-computer-change");
  change.focus();
  change.listeners.get("click")();
  assert.equal(harness.mounted.controller.snapshot().computerSetup.open, true);
  assert.equal(harness.mounted.controller.snapshot().computerSetup.dismissible, true);
  const setup = harness.findPanel("codex-computer-setup");
  const cancel = harness.findPanel("codex-computer-cancel");
  assert.equal(cancel.hidden, false);
  let prevented = false;
  setup.listeners.get("cancel")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(setup.hidden, true);
  assert.equal(harness.documentRef.activeElement === change, true, "Change setup must restore focus when cancelled");
});

test("closing a changed Computer and its stale permission prompt restores the original Change focus", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const local = {
    mode: "local",
    generation: 3,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  };
  const changed = deferred();
  let permissionListener;
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    botsFacade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      async selectMode() { return changed.promise; },
      onChanged() { return () => {}; },
      onPermissionRequested(listener) { permissionListener = listener; return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const change = harness.findPanel("codex-computer-change");
  change.focus();
  change.listeners.get("click")();
  const localInput = harness.findPanel("codex-computer-choices").children[0].children[0];
  localInput.checked = true;
  localInput.listeners.get("change")();
  harness.findPanel("codex-computer-continue").listeners.get("click")();
  permissionListener({
    requestId: "permission-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    targetId: local.localProfileId,
    targetGeneration: local.generation,
    capability: "filesystem.read",
    resourceLabel: "Project A",
    reason: "Read the approved project for this task",
  });
  assert.equal(harness.documentRef.activeElement === harness.findPanel("codex-permission-deny"), true);
  changed.resolve({
    botId: BOT_A,
    computer: { ...local, generation: 4 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-computer-setup").hidden, true);
  assert.equal(harness.findPanel("codex-permission-sheet").hidden, true);
  assert.equal(harness.documentRef.activeElement === change, true);
});

test("mounted Power keeps an authoritative noncompact tuple visible until a projected stop commits", async () => {
  const catalog = Object.freeze({
    generation: 12,
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
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 4,
  });
  const harness = createMountedUiHarness({ catalog, initialSelection });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.find("codex-model-trigger-model").textContent, "GPT-5.5");
  assert.equal(harness.find("codex-model-trigger-effort").textContent, "Extra High");
  const power = harness.find("codex-power-input");
  power.listeners.get("pointerdown")();
  power.listeners.get("pointerup")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.selected, [{
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    serviceTier: null,
  }]);
  assert.equal(harness.find("codex-model-trigger-model").textContent, "GPT-5.6 Sol");
  harness.mounted.dispose();
});

test("closed Power trigger uses compact labels while Advanced keeps raw effort labels", async () => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    })]),
  });
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 4,
  });
  const harness = createMountedUiHarness({ catalog, initialSelection });
  await new Promise((resolve) => setImmediate(resolve));

  const triggerEffort = harness.find("codex-model-trigger-effort");
  const advancedToggle = harness.find("codex-power-advanced-toggle");
  const advancedEffort = harness.find("codex-power-effort-select");
  assert.equal(triggerEffort.textContent, "Standard");
  advancedToggle.listeners.get("click")();
  assert.equal(advancedEffort.children.find((option) => option.value === "medium").textContent, "Medium");
  assert.equal(advancedEffort.children.find((option) => option.value === "high").textContent, "High");

  advancedEffort.value = "high";
  advancedEffort.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(triggerEffort.textContent, "Extended");
  harness.mounted.dispose();
});

test("mounted Fast state distinguishes priority from other authoritative service tiers", async () => {
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
        Object.freeze({ id: "flex", name: "Flex", description: "Flexible scheduling" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    })]),
  });
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "flex",
    catalogGeneration: 7,
    generation: 2,
  });
  const harness = createMountedUiHarness({ catalog, initialSelection });
  await new Promise((resolve) => setImmediate(resolve));
  const fast = harness.find("codex-power-fast-toggle");
  assert.equal(fast.classList.contains("is-active"), false);
  assert.equal(fast.attributes["aria-pressed"], "false");
  assert.equal(harness.mounted.modelDock.classList.contains("has-fast-tier"), false);
  fast.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.selected[0].serviceTier, "priority");
  assert.equal(fast.classList.contains("is-active"), true);
  assert.equal(harness.mounted.modelDock.classList.contains("has-fast-tier"), true);
  fast.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.selected[1].serviceTier, null);
  harness.mounted.dispose();
});

test("mounted Fast rapid double toggle preserves the second intent after a held first acknowledgement", async () => {
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    })]),
  });
  let current = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 2,
  });
  const first = deferred();
  const calls = [];
  let serial = Promise.resolve();
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: current,
    runtimeFacade: {
      async selectBot() { return current; },
      async readModel() { return current; },
      selectModel(value) {
        calls.push(structuredClone(value));
        const callIndex = calls.length - 1;
        const operation = serial.then(async () => {
          if (callIndex === 0) await first.promise;
          current = Object.freeze({
            ...value,
            provider: "openai-codex",
            catalogGeneration: 7,
            generation: current.generation + 1,
          });
          return current;
        });
        serial = operation.catch(() => {});
        return operation;
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fast = harness.find("codex-power-fast-toggle");
  fast.listeners.get("click")();
  fast.listeners.get("click")();
  assert.deepEqual(calls.map((value) => value.serviceTier), ["priority", null]);
  first.resolve();
  await serial;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((value) => value.serviceTier), ["priority", null]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.serviceTier, null);
  assert.equal(fast.attributes["aria-pressed"], "false");
  harness.mounted.dispose();
});

test("mounted Fast rapid double toggle from Fast restores Fast after a held first acknowledgement", async () => {
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    })]),
  });
  let current = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: "priority",
    catalogGeneration: 7,
    generation: 2,
  });
  const first = deferred();
  const calls = [];
  let serial = Promise.resolve();
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: current,
    runtimeFacade: {
      async selectBot() { return current; },
      async readModel() { return current; },
      selectModel(value) {
        calls.push(structuredClone(value));
        const callIndex = calls.length - 1;
        const operation = serial.then(async () => {
          if (callIndex === 0) await first.promise;
          current = Object.freeze({
            ...value,
            provider: "openai-codex",
            catalogGeneration: 7,
            generation: current.generation + 1,
          });
          return current;
        });
        serial = operation.catch(() => {});
        return operation;
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fast = harness.find("codex-power-fast-toggle");
  fast.listeners.get("click")();
  fast.listeners.get("click")();
  assert.deepEqual(calls.map((value) => value.serviceTier), [null, "priority"]);
  first.resolve();
  await serial;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.serviceTier, "priority");
  assert.equal(fast.attributes["aria-pressed"], "true");
  harness.mounted.dispose();
});

test("mounted Fast rejection resyncs the final authoritative tier instead of retaining optimistic state", async () => {
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["medium"]),
    })]),
  });
  let current = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 2,
  });
  const first = deferred();
  const calls = [];
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: current,
    runtimeFacade: {
      async selectBot() { return current; },
      async readModel() { return current; },
      selectModel(value) {
        calls.push(structuredClone(value));
        if (calls.length === 1) return first.promise.then(() => {
          current = Object.freeze({
            ...value,
            provider: "openai-codex",
            catalogGeneration: 7,
            generation: 3,
          });
          return current;
        });
        return first.promise.then(() => { throw new Error("second write rejected"); });
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fast = harness.find("codex-power-fast-toggle");
  fast.listeners.get("click")();
  fast.listeners.get("click")();
  assert.deepEqual(calls.map((value) => value.serviceTier), ["priority", null]);
  assert.equal(fast.attributes["aria-pressed"], "false");
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.serviceTier, "priority");
  assert.equal(fast.attributes["aria-pressed"], "true");
  harness.mounted.dispose();
});

test("mounted Fast intent stays bot-scoped across a switch while its request is held", async () => {
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["medium"]),
    })]),
  });
  const selection = (botId, serviceTier, generation) => Object.freeze({
    botId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier,
    catalogGeneration: 7,
    generation,
  });
  const selections = new Map([
    [BOT_A, selection(BOT_A, null, 2)],
    [BOT_B, selection(BOT_B, null, 4)],
  ]);
  const held = deferred();
  const calls = [];
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selections.get(BOT_A),
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return selections.get(botId); },
      async readModel(botId) { return selections.get(botId); },
      async selectModel(value) {
        calls.push(structuredClone(value));
        await held.promise;
        const next = selection(value.botId, value.serviceTier, selections.get(value.botId).generation + 1);
        selections.set(value.botId, next);
        return next;
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fast = harness.find("codex-power-fast-toggle");
  fast.listeners.get("click")();
  assert.equal(fast.attributes["aria-pressed"], "true");
  const botSelect = harness.findPanel("codex-bot-select");
  botSelect.value = BOT_B;
  botSelect.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mounted.controller.snapshot().activeBotId, BOT_B);
  assert.equal(fast.attributes["aria-pressed"], "false");
  held.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mounted.controller.snapshot().activeBotId, BOT_B);
  assert.equal(fast.attributes["aria-pressed"], "false");
  botSelect.value = BOT_A;
  botSelect.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fast.attributes["aria-pressed"], "true");
  assert.deepEqual(calls.map((value) => [value.botId, value.serviceTier]), [[BOT_A, "priority"]]);
  harness.mounted.dispose();
});

test("mounted Ultra entry survives an immediate authoritative reply for its full warning window", async () => {
  const timers = new Map();
  let timerId = 0;
  const windowTimers = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const catalog = Object.freeze({
    generation: 9,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
    })]),
  });
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 9,
    generation: 3,
  });
  const harness = createMountedUiHarness({ catalog, initialSelection, windowTimers });
  await new Promise((resolve) => setImmediate(resolve));
  const power = harness.find("codex-power-input");
  const warning = harness.find("codex-power-warning");
  power.listeners.get("pointerdown")();
  power.value = "5";
  power.listeners.get("input")();
  power.listeners.get("pointerup")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.selected.at(-1).reasoningEffort, "ultra");
  assert.equal(warning.hidden, false);
  assert.equal(harness.mounted.modelDock.classList.contains("is-warning"), true);
  const pending = [...timers.values()];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].delay, 2000);
  pending[0].callback();
  assert.equal(warning.hidden, true);
  assert.equal(harness.mounted.modelDock.classList.contains("is-warning"), false);
  harness.mounted.dispose();
});

test("persisted and Advanced-selected Ultra stay steady without replaying pointer entry", async () => {
  const timers = new Map();
  let timerId = 0;
  const windowTimers = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const catalog = Object.freeze({
    generation: 9,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
    })]),
  });
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 9,
    generation: 3,
  });
  const harness = createMountedUiHarness({ catalog, initialSelection, windowTimers });
  await new Promise((resolve) => setImmediate(resolve));
  const warning = harness.find("codex-power-warning");
  const effort = harness.find("codex-power-effort-select");
  assert.equal(harness.find("codex-power-fast-toggle").hidden, true);
  assert.equal(warning.hidden, true);
  assert.equal(harness.find("codex-power-control").classList.contains("is-ultra-entering"), false);
  assert.equal(timers.size, 0);

  effort.value = "max";
  effort.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warning.hidden, true);
  assert.equal(timers.size, 0);
  effort.value = "ultra";
  effort.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warning.hidden, true);
  assert.equal(harness.mounted.modelDock.classList.contains("is-warning"), false);
  assert.equal(timers.size, 0);
  harness.mounted.dispose();
});

test("switching to a bot with persisted Ultra Code starts steady", async () => {
  const timers = new Map();
  let timerId = 0;
  const windowTimers = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const catalog = Object.freeze({
    generation: 9,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "high", "ultra"]),
    })]),
  });
  const selections = new Map([
    [BOT_A, Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 9,
      generation: 3,
    })],
    [BOT_B, Object.freeze({
      botId: BOT_B,
      provider: "cliproxy-anthropic",
      model: "claude-fable-5",
      reasoningEffort: "ultra-code",
      serviceTier: null,
      catalogGeneration: 1,
      generation: 7,
    })],
  ]);
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selections.get(BOT_A),
    windowTimers,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return selections.get(botId); },
      async readModel(botId) { return selections.get(botId); },
      async selectModel() { throw new Error("not used"); },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const botSelect = harness.findPanel("codex-bot-select");
  botSelect.value = BOT_B;
  botSelect.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.find("codex-model-trigger-effort").textContent, "Ultra Code");
  assert.equal(harness.find("codex-power-warning").hidden, true);
  assert.equal(harness.find("codex-power-control").classList.contains("is-ultra-entering"), false);
  assert.equal(timers.size, 0);
  harness.mounted.dispose();
});
