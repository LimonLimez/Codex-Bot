"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");

const uiPath = path.join(__dirname, "..", "src", "renderer", "bot-runtime-ui.js");
const { PROVIDER_IDS, providerDescriptor } = require("../src/provider-descriptors.cjs");

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

function eightConnections(overrides = {}) {
  return Object.freeze(PROVIDER_IDS.map((providerId) => Object.freeze({
    providerId,
    label: providerDescriptor(providerId).label,
    loginKind: providerDescriptor(providerId).loginKind,
    state: "disconnected",
    generation: 0,
    capabilities: Object.freeze({
      reasoning: providerDescriptor(providerId).reasoningEfforts.length > 1,
      fast: providerDescriptor(providerId).fastModeSupported === true,
    }),
    errorCode: null,
    ...(overrides[providerId] || {}),
  })));
}

function providerFacade({ connections = eightConnections(), catalog = null, onboarding = null, connect = null, complete = null, disconnect = null, catalogSubscription = null, connectionsSubscription = null, loginPromptSubscription = null } = {}) {
  return {
    async list() { return typeof connections === "function" ? connections() : connections; },
    async connect(request) {
      if (typeof connect === "function") return connect(request);
      const current = typeof connections === "function" ? connections() : connections;
      return current.find((entry) => entry.providerId === request.providerId) ?? null;
    },
    async disconnect(providerId) {
      if (typeof disconnect === "function") return disconnect(providerId);
      const current = typeof connections === "function" ? connections() : connections;
      return current.find((entry) => entry.providerId === providerId) ?? null;
    },
    async catalog() {
      return typeof catalog === "function"
        ? catalog()
        : catalog ?? Object.freeze({ generation: 0, status: "unavailable", models: Object.freeze([]) });
    },
    async readOnboarding() { return typeof onboarding === "function" ? onboarding() : onboarding; },
    async readAuthoritySnapshot() {
      const [connectionValue, catalogValue, onboardingValue] = await Promise.all([
        this.list(),
        this.catalog(),
        this.readOnboarding(),
      ]);
      return authoritySnapshot({
        connections: connectionValue,
        catalog: catalogValue,
        onboarding: onboardingValue,
      });
    },
    async completeOnboarding(providerId) {
      if (typeof complete === "function") return complete(providerId);
      return Object.freeze({
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      });
    },
    onConnectionsChanged(listener) {
      return typeof connectionsSubscription === "function" ? connectionsSubscription(listener) : () => {};
    },
    onCatalogChanged(listener) {
      return typeof catalogSubscription === "function" ? catalogSubscription(listener) : () => {};
    },
    onLoginPrompt(listener) {
      return typeof loginPromptSubscription === "function" ? loginPromptSubscription(listener) : () => {};
    },
  };
}

function providerModel(providerId, model, label, efforts, catalogGeneration = 1, overrides = {}) {
  const descriptor = providerDescriptor(providerId);
  return Object.freeze({
    provider: providerId,
    providerLabel: descriptor.label,
    model,
    label,
    efforts: Object.freeze([...efforts]),
    serviceTiers: Object.freeze(overrides.serviceTiers ?? []),
    defaultReasoningEffort: overrides.defaultReasoningEffort ?? efforts[0],
    defaultServiceTier: overrides.defaultServiceTier ?? null,
    catalogGeneration,
    isDefault: overrides.isDefault === true,
  });
}

function providerCatalog(models, generation = 1, status = "ready") {
  return Object.freeze({
    generation,
    status,
    models: Object.freeze(models),
  });
}

function authoritySnapshot({ connections, catalog, onboarding = null }) {
  return Object.freeze({
    schemaVersion: 1,
    connections,
    catalog,
    onboarding,
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
    this.style = {
      setProperty: (key, value) => { this.style[key] = value; },
      getPropertyValue: (key) => this.style[key] ?? "",
    };
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

test("renderer accepts an explicitly unavailable Cursor Computer without a native agent", async () => {
  const { createBotUiController } = require(uiPath);
  const unavailable = {
    mode: "cursor",
    generation: 2,
    localProfileId: null,
    nativeAgentId: null,
    state: "unavailable",
    lastConfirmedAt: null,
    lastErrorCode: "CURSOR_ACCOUNT_REQUIRED",
  };
  const controller = createBotUiController({
    facade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", unavailable)]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: { async selectBot() { return null; } },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: unavailable }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged() { return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.equal(controller.snapshot().computer.mode, "cursor");
  assert.equal(controller.snapshot().computer.nativeAgentId, null);
  assert.equal(controller.snapshot().computer.state, "unavailable");
  controller.dispose();
});

test("renderer ships no optional model catalog authority", () => {
  const controls = require(uiPath);
  assert.equal(Object.hasOwn(controls, "MODEL_CATALOG"), false);
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
    provider: "anthropic-claude",
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
    providerFacade: providerFacade({
      catalog: providerCatalog([
        providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      ]),
    }),
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
    provider: "anthropic-claude",
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
    providerFacade: providerFacade({
      catalog: providerCatalog([
        providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      ]),
    }),
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
          provider: "anthropic-claude",
          catalogGeneration: 1,
          generation: 1,
        });
      },
    },
    computerFacade,
    providerFacade: providerFacade({
      catalog: providerCatalog([
        providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      ]),
    }),
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
          catalogGeneration: 24,
          generation: ++generation,
        });
      },
    },
    providerFacade: providerFacade({
      catalog: providerCatalog([
        providerModel("openai-codex", "claude-fable-5", "Claude Fable 5", ["medium", "high"], 24),
        providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium", "high", "ultra-code"], 24),
      ], 24),
    }),
  });
  await controller.initialize();
  await controller.selectModel("anthropic-claude", "claude-fable-5", "ultra-code", null);
  assert.equal(controller.snapshot().modelSelection.provider, "anthropic-claude");
  await controller.selectModel("openai-codex", "claude-fable-5", "high", null);
  assert.equal(controller.snapshot().modelSelection.provider, "openai-codex");
  assert.deepEqual(calls.map(({ provider, model, reasoningEffort }) => [provider, model, reasoningEffort]), [
    ["anthropic-claude", "claude-fable-5", "ultra-code"],
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

test("the renderer uses the authoritative provider catalog and refreshes an unsupported saved tuple", async () => {
  const { createBotUiController } = require(uiPath);
  let catalogListener;
  let catalog = providerCatalog([
    providerModel("openai-codex", "gpt-live-only", "GPT Live Only", ["medium", "high", "ultra"], 12, { isDefault: true }),
  ], 12);
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
    providerFacade: providerFacade({
      catalog: () => catalog,
      catalogSubscription(listener) { catalogListener = listener; return () => {}; },
    }),
  });
  await controller.initialize();
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), ["gpt-live-only"]);
  assert.deepEqual(controller.snapshot().modelSelection, stored);

  catalog = providerCatalog([
    providerModel("openai-codex", "gpt-replacement", "GPT Replacement", ["low", "medium"], 13, { isDefault: true }),
  ], 13);
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
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), ["gpt-replacement"]);
  assert.deepEqual(controller.snapshot().modelSelection, stored);
});

test("a loading provider catalog keeps an unsupported stored tuple unavailable until the live catalog arrives", async () => {
  const { createBotUiController } = require(uiPath);
  let catalogListener;
  let catalog = providerCatalog([], 0, "loading");
  const stored = Object.freeze({
    botId: BOT_A,
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 0,
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
    providerFacade: providerFacade({
      catalog: () => catalog,
      catalogSubscription(listener) { catalogListener = listener; return () => {}; },
    }),
  });
  await controller.initialize();
  assert.equal(controller.snapshot().modelSelection, null);
  assert.deepEqual(controller.snapshot().modelCatalog, []);
  catalog = providerCatalog([
    providerModel("openai-codex", "gpt-live", "GPT Live", ["medium", "high"], 2, { isDefault: true }),
  ], 2);
  catalogListener(catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(controller.snapshot().modelCatalog.map(({ model }) => model), ["gpt-live"]);
  assert.equal(controller.snapshot().modelSelection, null);
});

test("a pending provider catalog keeps the bot active but rejects unadvertised model choices", async () => {
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
  const controller = createBotUiController({
    facade: {
      async list() { return [bot(BOT_A, "A", "unavailable")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot() { return official; },
      async readModel() { return official; },
      async selectModel() { throw new Error("selection should be rejected before transport"); },
    },
    providerFacade: providerFacade({ catalog: providerCatalog([], 0, "loading") }),
  });
  await controller.initialize();
  assert.equal(controller.snapshot().activeBotId, BOT_A);
  assert.equal(controller.snapshot().modelSelection, null);
  await assert.rejects(
    () => controller.selectModel("anthropic-claude", "claude-fable-5", "ultra-code"),
    /selection/i,
  );
  assert.equal(controller.snapshot().modelSelection, null);
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

test("unavailable or malformed provider catalog events fail closed without inventing models", async () => {
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
    providerFacade: providerFacade({
      catalog: providerCatalog([
        providerModel("openai-codex", "gpt-live", "GPT Live", ["medium", "high"], 8, { isDefault: true }),
      ], 8),
      catalogSubscription(listener) { catalogListener = listener; return () => {}; },
    }),
  });
  await controller.initialize();
  catalogListener(Object.freeze({ generation: 9, status: "unavailable", models: Object.freeze([]) }));
  assert.equal(controller.snapshot().modelSelection, null);
  assert.deepEqual(controller.snapshot().modelCatalog, []);
  catalogListener(Object.freeze({ generation: 10, status: "ready", models: "private malformed" }));
  assert.equal(controller.snapshot().modelSelection, null);
  assert.deepEqual(controller.snapshot().modelCatalog, []);
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
    provider: "anthropic-claude",
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
    providerFacade: providerFacade({
      catalog: providerCatalog([
        providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      ]),
    }),
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
  const explicitNativeComposer = { id: "native-composer" };
  const explicitBotSettings = { id: "bot-settings" };
  const explicitConnections = { id: "connections" };
  const explicitDocument = {
    querySelector(selector) {
      if (selector === "[data-codex-bot-sidebar-host]") return explicitSidebar;
      if (selector === "[data-codex-bot-composer-host]") return explicitComposer;
      if (selector === "[data-openbot-model-picker-host]") return explicitNativeComposer;
      if (selector === "[data-openbot-bot-settings-host]") return explicitBotSettings;
      if (selector === "[data-openbot-connections-host]") return explicitConnections;
      return null;
    },
    querySelectorAll() { return []; },
  };
  assert.deepEqual(findUiMounts(explicitDocument), {
    sidebarHost: explicitSidebar,
    composerHost: explicitComposer,
    nativeComposerHost: explicitNativeComposer,
    nativeBotSettingsHost: explicitBotSettings,
    nativeConnectionsHost: explicitConnections,
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
    nativeComposerHost: null,
    nativeBotSettingsHost: null,
    nativeConnectionsHost: null,
  });
});

test("mounted model controls use only the authoritative provider catalog", async () => {
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
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "high",
    serviceTier: null,
    catalogGeneration: 1,
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
          provider: "anthropic-claude",
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
    openbotProviders: providerFacade({
      connections: eightConnections({
        "anthropic-claude": { state: "connected", generation: 1 },
      }),
      catalog: providerCatalog([
        providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      ]),
    }),
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
  };
  const mounted = mount({ windowRef, documentRef });
  await new Promise((resolve) => setImmediate(resolve));
  const find = (node, className) => {
    if (node.className.split(/\s+/).includes(className)) return node;
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
  const pickerMenu = find(mounted.modelDock, "codex-power-menu");
  const viewTrack = find(mounted.modelDock, "codex-power-view-track");
  const powerShell = find(mounted.modelDock, "codex-power-shell");
  const fastToggle = find(mounted.modelDock, "codex-power-fast-toggle");
  const advancedToggle = find(mounted.modelDock, "codex-power-advanced-toggle");
  const simple = find(mounted.modelDock, "codex-power-view-simple");
  const advanced = find(mounted.modelDock, "codex-power-view-advanced");
  const advancedModel = find(mounted.modelDock, "codex-power-advanced-row");
  assert.equal(mounted.controller.snapshot().activeBotId, BOT_A);
  assert.deepEqual(mounted.controller.snapshot().modelSelection, official);
  assert.equal(power.disabled, false);
  assert.ok(trigger);
  assert.equal(trigger.attributes["aria-haspopup"], "dialog");
  assert.equal(trigger.attributes["aria-expanded"], "false");
  assert.equal(popover.hidden, true);
  assert.equal(pickerMenu.dataset.view, "simple");
  assert.deepEqual(viewTrack.children, [simple, advanced]);
  trigger.listeners.get("click")();
  assert.equal(trigger.attributes["aria-expanded"], "true");
  assert.equal(popover.hidden, false);
  assert.equal(fastToggle.hidden, true);
  mounted.modelDock.listeners.get("keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(trigger.attributes["aria-expanded"], "false");
  assert.equal(popover.hidden, true);
  trigger.listeners.get("click")();
  assert.equal(advancedToggle.disabled, false);
  assert.equal(advanced.attributes["aria-hidden"], "true");
  assert.equal(advancedModel.dataset.kind, "model");
  assert.equal(advancedModel.dataset.provider, "anthropic-claude");
  assert.equal(advancedModel.dataset.model, "claude-fable-5");
  assert.equal(find(mounted.modelDock, "codex-model-select"), null);
  power.listeners.get("pointerdown")();
  power.value = "5";
  power.listeners.get("input")();
  power.listeners.get("pointerup")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, [{
    botId: BOT_A,
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
  }]);
  assert.equal(find(mounted.modelDock, "codex-power-label").textContent, "Ultra Code");
  assert.equal(triggerModel.textContent, "Claude Fable 5");
  assert.equal(triggerEffort.textContent, "Ultra Code");
  advancedToggle.listeners.get("click")();
  assert.equal(pickerMenu.dataset.view, "advanced");
  assert.equal(advanced.attributes["aria-hidden"], "false");
  assert.equal(simple.attributes["aria-hidden"], "true");
  assert.equal(powerShell.parentElement, simple);
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
  accountFacade = null,
  providerFacade = null,
  localDesktopViewApi = null,
  localStorage = null,
  nativeProtocol = false,
  nativeHost = nativeProtocol,
  nativeActiveBotId = nativeProtocol ? BOT_A : undefined,
  reducedMotion = false,
  viewMetrics = Object.freeze({}),
  viewportMetrics = Object.freeze({ width: 1040, height: 760 }),
  focusBeforeMount = false,
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
    get offsetHeight() {
      for (const [className, height] of Object.entries(viewMetrics)) {
        if (!this.className.split(/\s+/).includes(className)) continue;
        return typeof height === "object" ? height.height ?? 0 : height;
      }
      return 0;
    }
    get offsetWidth() {
      for (const [className, metrics] of Object.entries(viewMetrics)) {
        if (!this.className.split(/\s+/).includes(className)) continue;
        return typeof metrics === "object" ? metrics.width ?? 0 : 0;
      }
      return 0;
    }
    getBoundingClientRect() {
      for (const [className, metrics] of Object.entries(viewMetrics)) {
        if (!this.className.split(/\s+/).includes(className) || typeof metrics !== "object") continue;
        const left = metrics.left ?? 0;
        const top = metrics.top ?? 0;
        const width = metrics.width ?? 0;
        const height = metrics.height ?? 0;
        return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
      }
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    append(...children) {
      for (const child of children) {
        if (child.parentElement && child.parentElement !== this) {
          child.parentElement.children = child.parentElement.children.filter((entry) => entry !== child);
        }
      }
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
    nativeModelHost: null,
    nativeBotSettingsHost: null,
    nativeConnectionsHost: null,
    listeners: new Map(),
    createElement(tagName) { return new MountElement(tagName, this); },
    getElementById() { return null; },
    querySelector(selector) {
      if (selector === "[data-codex-bot-sidebar-host]") return this.sidebar;
      if (selector === "[data-codex-bot-composer-host]") return this.composer;
      if (selector === "[data-openbot-model-picker-host]") return this.nativeModelHost;
      if (selector === "[data-openbot-bot-settings-host]") return this.nativeBotSettingsHost;
      if (selector === "[data-openbot-connections-host]") return this.nativeConnectionsHost;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    removeEventListener(name) { this.listeners.delete(name); },
  };
  documentRef.body = documentRef.createElement("body");
  documentRef.sidebar = documentRef.createElement("aside");
  documentRef.composer = documentRef.createElement("form");
  if (nativeHost) {
    documentRef.nativeModelHost = documentRef.createElement("div");
    documentRef.nativeBotSettingsHost = documentRef.createElement("div");
    documentRef.nativeConnectionsHost = documentRef.createElement("div");
    documentRef.composer.append(documentRef.nativeModelHost);
    documentRef.body.append(documentRef.nativeBotSettingsHost, documentRef.nativeConnectionsHost);
  }
  let mountObserver = null;
  class MountObserver {
    constructor(callback) {
      this.callback = callback;
      mountObserver = this;
    }
    observe() {}
    disconnect() {}
  }
  const resizeObservers = [];
  class ViewResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      resizeObservers.push(this);
    }
    observe(target) { this.observed.push(target); }
    disconnect() { this.disconnected = true; }
  }
  const animationFrames = new Map();
  const windowListeners = new Map();
  const cancelledAnimationFrames = [];
  let nextAnimationFrame = 0;
  let current = initialSelection;
  let generation = initialSelection.generation;
  const selected = [];
  let runtimeApi = runtimeFacade ?? {
    async selectBot() { return current; },
    async readModel() { return current; },
    async selectModel(value) {
      selected.push(value);
      const model = catalog.models.find((entry) => entry.id === value.model || entry.model === value.model);
      current = Object.freeze({
        ...value,
        provider: "openai-codex",
        catalogGeneration: catalog.generation,
        generation: ++generation,
      });
      assert.ok(model);
      return current;
    },
  };
  if (nativeProtocol && nativeActiveBotId !== undefined
    && typeof runtimeApi.readActiveBotId !== "function") {
    runtimeApi = Object.freeze({
      ...runtimeApi,
      async readActiveBotId() { return nativeActiveBotId; },
    });
  }
  const windowRef = {
    ...(nativeProtocol ? {
      openbotProtocol: Object.freeze({ schemaVersion: 1, mode: "local-protocol" }),
    } : {}),
    codexBots: botsFacade ?? {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
    codexRuntime: runtimeApi,
    codexAccount: accountFacade ?? {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    dispatchEvent() {},
    setTimeout: windowTimers.setTimeout,
    clearTimeout: windowTimers.clearTimeout,
    MutationObserver: MountObserver,
    ResizeObserver: ViewResizeObserver,
    requestAnimationFrame(callback) {
      const id = ++nextAnimationFrame;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledAnimationFrames.push(id);
      animationFrames.delete(id);
    },
    matchMedia() {
      return Object.freeze({ matches: reducedMotion });
    },
    innerWidth: viewportMetrics.width,
    innerHeight: viewportMetrics.height,
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name) { windowListeners.delete(name); },
  };
  if (fileReader) windowRef.FileReader = fileReader;
  if (computerFacade) windowRef.openbotComputer = computerFacade;
  if (providerFacade) {
    let mountedProviderFacade = providerFacade;
    let hasAtomicRead = false;
    let hasLegacyReads = false;
    try {
      const readDescriptor = Object.getOwnPropertyDescriptor(providerFacade, "readAuthoritySnapshot");
      hasAtomicRead = Boolean(readDescriptor && "value" in readDescriptor
        && typeof readDescriptor.value === "function");
      hasLegacyReads = ["list", "catalog", "readOnboarding"].every((method) => {
        const descriptor = Object.getOwnPropertyDescriptor(providerFacade, method);
        return Boolean(descriptor && "value" in descriptor && typeof descriptor.value === "function");
      });
    } catch {}
    if (!hasAtomicRead && hasLegacyReads) {
      mountedProviderFacade = Object.freeze({
        ...providerFacade,
        async readAuthoritySnapshot() {
          const [connections, providerCatalog, onboarding] = await Promise.all([
            providerFacade.list(),
            providerFacade.catalog(),
            providerFacade.readOnboarding(),
          ]);
          return authoritySnapshot({ connections, catalog: providerCatalog, onboarding });
        },
      });
    }
    windowRef.openbotProviders = mountedProviderFacade;
  }
  if (localDesktopViewApi) windowRef.OpenBotLocalDesktopView = localDesktopViewApi;
  if (localStorage) windowRef.localStorage = localStorage;
  const focusAnchor = focusBeforeMount ? documentRef.createElement("button") : null;
  if (focusAnchor) {
    focusAnchor.className = "provider-return-focus-anchor";
    documentRef.body.append(focusAnchor);
    focusAnchor.focus();
  }
  const mounted = mount({ windowRef, documentRef });
  const find = (node, className, seen = new Set()) => {
    if (seen.has(node)) return null;
    seen.add(node);
    if (node.className.split(/\s+/).includes(className)) return node;
    for (const child of node.children) {
      const found = find(child, className, seen);
      if (found) return found;
    }
    return null;
  };
  const findAll = (node, className, matches = [], seen = new Set()) => {
    if (seen.has(node)) return matches;
    seen.add(node);
    if (node.className.split(/\s+/).includes(className)) matches.push(node);
    for (const child of node.children) findAll(child, className, matches, seen);
    return matches;
  };
  return {
    animationFrames,
    cancelledAnimationFrames,
    documentRef,
    focusAnchor,
    find: (className) => find(mounted.modelDock, className),
    findAll: (className) => findAll(mounted.modelDock, className),
    findPanel: (className) => find(mounted.panel, className) ?? find(documentRef.body, className),
    findAllPanel: (className) => findAll(documentRef.body, className),
    flushAnimationFrames() {
      const pending = [...animationFrames.entries()];
      animationFrames.clear();
      for (const [, callback] of pending) callback(0);
    },
    mounted,
    get mountObserver() { return mountObserver; },
    resizeObservers,
    selected,
    windowListeners,
  };
}

function providerSurface(harness, first = true) {
  return harness.findPanel(first ? "codex-first-provider-picker" : "codex-settings-provider-picker");
}

function providerCard(harness, providerId, first = true) {
  return harness.findAllPanel("codex-provider-choice-button").find((node) => (
    node.dataset.providerId === providerId
      && node.dataset.surface === (first ? "first" : "settings")
  ));
}

function providerCardField(harness, providerId, className, first = true) {
  const card = providerCard(harness, providerId, first);
  const visit = (node) => {
    if (node.className.split(/\s+/).includes(className)) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(card);
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

function connectedNativeProviderHarness({
  providerFacade: providerOverride = null,
  onboarding = null,
  connections = eightConnections(),
  providerModels = [],
  focusBeforeMount = false,
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
    focusBeforeMount,
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
  const pointerdown = dialog.listeners.get("pointerdown");
  assert.equal(typeof pointerdown, "function");
  pointerdown(backdrop);
  assert.equal(backdrop.prevented, true);
  dialog.close();
  const close = dialog.listeners.get("close");
  assert.equal(typeof close, "function");
  close();
  assert.equal(dialog.open, true);
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

test("provider keyboard navigation roves focus across both surfaces without facade calls", async (context) => {
  const facade = providerFacade();
  const calls = [];
  for (const method of ["list", "catalog", "readOnboarding", "connect", "disconnect", "completeOnboarding"]) {
    const original = facade[method];
    facade[method] = async (...args) => {
      calls.push([method, args]);
      return original.apply(facade, args);
    };
  }
  const harness = connectedNativeProviderHarness({ providerFacade: facade, onboarding: null, focusBeforeMount: true });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;

  assert.equal(harness.documentRef.activeElement, providerCard(harness, "openai-codex"));
  assert.equal(harness.documentRef.activeElement === harness.focusAnchor, false);
  for (const providerId of PROVIDER_IDS) {
    assert.equal(providerCard(harness, providerId).tabIndex, providerId === "openai-codex" ? 0 : -1);
  }

  const keyEvent = (key) => ({
    key,
    prevented: false,
    preventDefault() { this.prevented = true; },
  });
  const down = keyEvent("ArrowDown");
  providerCard(harness, "openai-codex").listeners.get("keydown")(down);
  assert.equal(down.prevented, true);
  assert.equal(providerCard(harness, "google-antigravity").attributes["aria-pressed"], "true");
  assert.equal(harness.documentRef.activeElement, providerCard(harness, "google-antigravity"));
  assert.equal(providerCard(harness, "google-antigravity").tabIndex, 0);
  assert.equal(providerCard(harness, "openai-codex").tabIndex, -1);

  providerCard(harness, "google-antigravity").listeners.get("keydown")(keyEvent("ArrowUp"));
  assert.equal(harness.documentRef.activeElement, providerCard(harness, "openai-codex"));
  providerCard(harness, "openai-codex").listeners.get("keydown")(keyEvent("End"));
  assert.equal(harness.documentRef.activeElement, providerCard(harness, "local-openai-compatible"));
  providerCard(harness, "local-openai-compatible").listeners.get("keydown")(keyEvent("Home"));
  assert.equal(harness.documentRef.activeElement, providerCard(harness, "openai-codex"));

  clickProviderCard(harness, "xai", false);
  assert.equal(harness.documentRef.activeElement, providerActionButton(harness, false));
  assert.equal(providerCard(harness, "xai", false).attributes["aria-pressed"], "true");
  providerCard(harness, "xai", false).listeners.get("keydown")(keyEvent("ArrowLeft"));
  assert.equal(harness.documentRef.activeElement, providerCard(harness, "moonshot-kimi", false));
  assert.equal(providerCard(harness, "moonshot-kimi", false).tabIndex, 0);
  assert.equal(providerCard(harness, "openai-codex", false).tabIndex, -1);
  assert.equal(providerCard(harness, "openai-codex").attributes["aria-pressed"], "true");
  assert.equal(calls.length, 0);
});

test("provider failure after a Settings detail rebuild appears and focuses the current panel", async (context) => {
  const failure = deferred();
  const facade = providerFacade({
    catalog: providerCatalog([], 0, "unavailable"),
    connect() { return failure.promise; },
  });
  const harness = connectedNativeProviderHarness({ providerFacade: facade, onboarding: null });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  clickProviderCard(harness, "moonshot-kimi", false);
  const detachedAction = providerActionButton(harness, false);
  detachedAction.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "openai-codex", false);
  clickProviderCard(harness, "moonshot-kimi", false);
  const currentAction = providerActionButton(harness, false);
  assert.notEqual(currentAction, detachedAction);

  failure.reject(new Error("settings provider failure"));
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const currentDetail = providerDetail(harness, false);
  const error = providerControl(harness, "codex-provider-connection-error", false);
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /could not be connected|try again/i);
  assert.equal(harness.documentRef.activeElement, currentAction);
});

test("native View Bot owns Computer controls and selects the active Free Local Desktop", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "high", "ultra"]),
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
  const local = Object.freeze({
    mode: "local",
    generation: 3,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  });
  const notNow = Object.freeze({
    mode: "not-now",
    generation: 4,
    localProfileId: null,
    nativeAgentId: null,
    state: "unconfigured",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  let computerListener;
  const desktopSelections = [];
  let desktopDisposed = 0;
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
    nativeHost: true,
    botsFacade: {
      async list() { return [botWithComputer(BOT_A, "A", "ready", local)]; },
      onChanged() { return () => {}; },
    },
    computerFacade: {
      async read() { return { botId: BOT_A, computer: local }; },
      async listPermissions() { return { botId: BOT_A, permissions: [] }; },
      async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
      onChanged(listener) { computerListener = listener; return () => {}; },
      onPermissionRequested() { return () => {}; },
    },
    localDesktopViewApi: {
      createLocalDesktopView({ container }) {
        assert.equal(container.className.split(/\s+/).includes("codex-bot-desktop-host"), true);
        return Object.freeze({
          selectBot(value) { desktopSelections.push(value); },
          dispose() { desktopDisposed += 1; },
        });
      },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const settings = harness.findPanel("codex-native-bot-settings");
  assert.equal(settings.parentElement, harness.documentRef.nativeBotSettingsHost);
  assert.equal(harness.find("codex-runtime-row"), null);
  assert.equal(harness.find("codex-computer-row"), null);
  assert.equal(harness.find("codex-computer-grants"), null);
  assert.equal(harness.findPanel("codex-computer-row").parentElement, settings);
  assert.deepEqual(desktopSelections, [BOT_A]);

  computerListener({ botId: BOT_A, computer: notNow });
  assert.equal(harness.findPanel("codex-computer-status").textContent, "Computer not configured");
  assert.deepEqual(desktopSelections, [BOT_A, null]);
  harness.mounted.dispose();
  assert.equal(desktopDisposed, 1);
});

test("existing bots without a durable receipt still open the eight-route gate", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium", "high"]),
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
    nativeHost: true,
    botsFacade: {
      async list() { return [bot(BOT_A, "Legacy Bot", "ready")]; },
      onChanged() { return () => {}; },
    },
    providerFacade: providerFacade({
      catalog: Object.freeze({
        generation: 2,
        status: "unavailable",
        models: Object.freeze([]),
      }),
      onboarding: null,
      connections: eightConnections({
        "openai-codex": { state: "connected", generation: 2 },
        "anthropic-claude": { state: "connecting", generation: 1 },
        xai: { state: "unavailable", generation: 3, errorCode: "OPENBOT_PROVIDER_CANCELLED" },
      }),
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const setup = harness.findPanel("codex-first-connection-setup");
  assert.equal(setup.open, true);
  assert.equal(setup.attributes["aria-modal"], "true");
  assert.equal(harness.findPanel("codex-first-connection-skip"), null);
  const cards = PROVIDER_IDS.map((providerId) => providerCard(harness, providerId));
  assert.deepEqual(
    cards.map((node) => node.dataset.providerId),
    PROVIDER_IDS,
  );
  const expectedLabels = PROVIDER_IDS.map((providerId) => providerDescriptor(providerId).label);
  assert.deepEqual(
    PROVIDER_IDS.map((providerId) => providerCardField(harness, providerId, "codex-provider-choice-label").textContent),
    expectedLabels,
  );
  assert.deepEqual(
    PROVIDER_IDS.map((providerId) => providerCardField(harness, providerId, "codex-provider-choice-state").textContent),
    ["Connected", "Connecting…", "Not connected", "Not connected", "Retry available", "Unavailable", "Not connected", "Not connected"],
  );
});

test("native renderer reads provider list catalog and onboarding independently of bot count", async (context) => {
  const calls = [];
  const localStorage = {
    getItem() { throw new Error("renderer onboarding storage is forbidden"); },
    setItem() { throw new Error("renderer onboarding storage is forbidden"); },
  };
  const facade = {
    async list() { calls.push("list"); return eightConnections(); },
    async catalog() { calls.push("catalog"); return { generation: 1, status: "unavailable", models: [] }; },
    async readOnboarding() { calls.push("onboarding"); return null; },
    onConnectionsChanged() { calls.push("connections-subscribe"); return () => {}; },
    onCatalogChanged() { calls.push("catalog-subscribe"); return () => {}; },
    onLoginPrompt() { calls.push("login-prompt-subscribe"); return () => {}; },
    async connect() { calls.push("connect"); },
    async completeOnboarding() { calls.push("complete"); },
    async disconnect() { calls.push("disconnect"); },
  };
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
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 1,
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection,
    nativeProtocol: true,
    nativeHost: true,
    botsFacade: {
      async list() { return [bot(BOT_A, "Legacy Bot", "ready")]; },
      onChanged() { return () => {}; },
    },
    providerFacade: facade,
    localStorage,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("list"), true);
  assert.equal(calls.includes("catalog"), true);
  assert.equal(calls.includes("onboarding"), true);
  assert.equal(harness.mounted.panel.inert, true);
  assert.equal(harness.mounted.modelDock.inert, true);
});

test("provider chooser sends exact route requests, completes first onboarding, and clears API secrets", async (context) => {
  let connections = eightConnections();
  let onboarding = null;
  const requests = [];
  const catalog = providerCatalog([
    providerModel("moonshot-kimi", "kimi-k2", "Kimi K2", ["medium"], 1, { isDefault: true }),
  ], 1);
  const facade = {
    async list() { return connections; },
    async catalog() { return catalog; },
    async readOnboarding() { return onboarding; },
    async connect(request) {
      requests.push(request);
      connections = eightConnections({
        [request.providerId]: { state: "connected", generation: 1 },
      });
    },
    async completeOnboarding(providerId) {
      onboarding = {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
      return onboarding;
    },
    async disconnect(providerId) {
      connections = eightConnections({ [providerId]: { state: "disconnected", generation: 2 } });
    },
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const codexCatalog = Object.freeze({
    generation: 1,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
    })]),
  });
  const harness = createMountedUiHarness({
    catalog: codexCatalog,
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
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "moonshot-kimi");
  providerActionButton(harness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[0], { providerId: "moonshot-kimi" });
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);

  clickProviderCard(harness, "openai-api-key", false);
  const apiInput = providerControl(harness, "codex-provider-api-key", false);
  apiInput.value = "sk-test-secret";
  providerActionButton(harness, false).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[1], { providerId: "openai-api-key", apiKey: "sk-test-secret" });
  assert.equal(apiInput.value, "");
  providerControl(harness, "codex-provider-disconnect", false).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
});

test("Direct Codex exposes browser and device actions through the provider facade", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const requests = [];
  let connections = eightConnections();
  let onboarding = null;
  const facade = providerFacade({
    connections: () => connections,
    catalog,
    catalogSubscription() { return () => {}; },
    connect(request) {
      requests.push(request);
      connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
    },
    disconnect() {},
  });
  facade.completeOnboarding = async (providerId) => {
    onboarding = {
      schemaVersion: 1,
      providerId,
      connectionGeneration: 1,
      catalogGeneration: 1,
      completedAt: "2026-08-19T00:00:00.000Z",
    };
    return onboarding;
  };
  facade.readOnboarding = async () => onboarding;
  const makeHarness = () => createMountedUiHarness({
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
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  const browserHarness = makeHarness();
  context.after(() => browserHarness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  providerActionButton(browserHarness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[0], { providerId: "openai-codex", authMode: "browser" });
  browserHarness.mounted.dispose();

  connections = eightConnections();
  onboarding = null;
  const deviceHarness = makeHarness();
  context.after(() => deviceHarness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  providerControl(deviceHarness, "codex-provider-auth-mode").value = "device-code";
  providerActionButton(deviceHarness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests[1], { providerId: "openai-codex", authMode: "device-code" });
});

test("cancelled provider connections keep the chooser open and restore focus to the same route", async (context) => {
  const facade = providerFacade({
    catalog: providerCatalog([], 0, "unavailable"),
    connect() {
      const error = new Error("cancelled");
      error.code = "OPENBOT_PROVIDER_CANCELLED";
      return Promise.reject(error);
    },
  });
  const harness = createMountedUiHarness({
    catalog: providerCatalog([], 0, "unavailable"),
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "moonshot-kimi");
  const action = providerActionButton(harness);
  action.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
  assert.equal(harness.documentRef.activeElement, action);
  assert.match(providerText(harness), /cancelled|try again/i);
  assert.doesNotMatch(providerText(harness), /cancelled.*secret|Users|token/i);
});

test("successful onboarding restores the active bot and never creates one", async (context) => {
  let connections = eightConnections();
  let receipt = null;
  let createCalls = 0;
  const catalog = providerCatalog([
    providerModel("moonshot-kimi", "kimi-k2", "Kimi K2", ["medium"], 1, { isDefault: true }),
  ], 1);
  const facade = providerFacade({
    connections: () => connections,
    catalog,
    onboarding: () => receipt,
    connect(request) {
      connections = eightConnections({ [request.providerId]: { state: "connected", generation: 1 } });
    },
    complete(providerId) {
      receipt = {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
      return receipt;
    },
  });
  const selection = (botId) => Object.freeze({
    botId,
    provider: "moonshot-kimi",
    model: "kimi-k2",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 1,
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection(BOT_A),
    nativeProtocol: true,
    nativeHost: true,
    focusBeforeMount: true,
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      async create() { createCalls += 1; return bot(BOT_C, "C", "ready"); },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async selectBot(botId) { return selection(botId); },
      async readModel(botId) { return selection(botId); },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const botSelect = harness.findPanel("codex-bot-select");
  botSelect.value = BOT_B;
  botSelect.listeners.get("change")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mounted.controller.snapshot().activeBotId, BOT_B);
  clickProviderCard(harness, "moonshot-kimi");
  providerActionButton(harness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mounted.controller.snapshot().activeBotId, BOT_B);
  assert.equal(createCalls, 0);
  assert.equal(harness.documentRef.activeElement, harness.focusAnchor);
});

test("mounted Advanced summary keeps a same-id provider selection provider-scoped", async (context) => {
  const catalog = providerCatalog([
    providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium", "high", "ultra-code"], 24),
  ], 24);
  let generation = 1;
  let current = Object.freeze({
    botId: BOT_A,
    provider: "anthropic-claude",
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
        catalogGeneration: catalog.generation,
        generation: ++generation,
      });
      return current;
    },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: current,
    runtimeFacade,
    providerFacade: providerFacade({
      connections: eightConnections({
        "anthropic-claude": { state: "connected", generation: 24 },
      }),
      catalog,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const model = harness.findAll("codex-power-advanced-row").find((row) => row.dataset.kind === "model");
  const triggerModel = harness.find("codex-model-trigger-model");
  assert.equal(triggerModel.textContent, "Claude Fable 5");
  assert.equal(model.dataset.provider, "anthropic-claude");
  assert.equal(model.dataset.model, "claude-fable-5");
  assert.equal(model.children[1].textContent, "Claude Fable 5");
  assert.deepEqual(selected, []);
});

test("native protocol mode preserves the Grok shell and owns the Codex Advanced view", async (context) => {
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
  assert.equal(harness.mounted.modelDock.parentElement, harness.documentRef.nativeModelHost);
  assert.equal(harness.documentRef.composer.children.includes(harness.mounted.modelDock), false);
  assert.equal(
    harness.findPanel("codex-new-bot-setup") === null,
    true,
    "native Grok creation must not mount the legacy setup dialog",
  );
  for (const className of ["codex-computer-setup", "codex-permission-sheet"]) {
    const dialog = harness.findPanel(className);
    assert.equal(dialog.parentElement, harness.documentRef.body, className);
    assert.equal(dialog.tagName, "DIALOG");
  }
  assert.equal(harness.find("codex-provider-select"), null, "the native Grok picker owns provider selection");
  assert.equal(harness.find("codex-provider-connect"), null);
  const advancedToggle = harness.find("codex-power-advanced-toggle");
  const menu = harness.find("codex-power-menu");
  const simple = harness.find("codex-power-view-simple");
  const advanced = harness.find("codex-power-view-advanced");
  assert.ok(advancedToggle);
  assert.equal(harness.find("codex-power-model-select"), null);
  assert.equal(harness.find("codex-power-effort-select"), null);
  assert.equal(harness.find("codex-power-speed-select"), null);
  assert.deepEqual(
    harness.findAll("codex-power-advanced-row").map((row) => row.dataset.kind),
    ["model", "effort", "speed"],
  );
  assert.equal(menu.dataset.view, "simple");
  assert.equal(simple.attributes["aria-hidden"], "false");
  assert.equal(simple.inert, false);
  assert.equal(advanced.attributes["aria-hidden"], "true");
  assert.equal(advanced.inert, true);
  advancedToggle.listeners.get("click")();
  assert.equal(menu.dataset.view, "advanced");
  assert.equal(simple.attributes["aria-hidden"], "true");
  assert.equal(simple.inert, true);
  assert.equal(advanced.attributes["aria-hidden"], "false");
  assert.equal(advanced.inert, false);
  assert.equal(advancedToggle.attributes["aria-expanded"], "true");
  assert.equal(harness.find("codex-power-input").tagName, "INPUT");
});

test("native composer Power surfaces use viewport coordinates outside Grok's clipped input frame", async (context) => {
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "ultra",
      supportedReasoningEfforts: Object.freeze(["medium", "max", "ultra"]),
      supportedServiceTiers: Object.freeze(["priority"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 1,
  });
  const popoverMetrics = { width: 224, height: 112 };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
    viewMetrics: Object.freeze({
      "codex-model-trigger": Object.freeze({ left: 850, top: 708, width: 130, height: 28 }),
      "codex-power-popover": popoverMetrics,
      "codex-power-flyout": Object.freeze({ width: 280, height: 180 }),
      "codex-power-view-simple": 132,
      "codex-power-view-advanced": 168,
      "codex-power-view-controls": 36,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const trigger = harness.find("codex-model-trigger");
  const popover = harness.find("codex-power-popover");
  trigger.listeners.get("click")();
  assert.equal(popover.hidden, false);
  assert.equal(popover.style.left, "756px");
  assert.equal(popover.style.top, "588px");
  popoverMetrics.height = 243;
  harness.resizeObservers[1].callback();
  assert.equal(popover.style.top, "457px");
  assert.equal(harness.windowListeners.has("resize"), true);
  assert.equal(harness.windowListeners.has("scroll"), true);

  harness.find("codex-power-advanced-toggle").listeners.get("click")();
  const modelRow = harness.findAll("codex-power-advanced-row").find((row) => row.dataset.kind === "model");
  modelRow.listeners.get("click")();
  const flyout = harness.find("codex-power-flyout");
  assert.equal(flyout.hidden, false);
  assert.equal(flyout.style.left, "468px");
  assert.equal(flyout.style.top, "520px");
});

test("compact simple content keeps stable Codex Advanced view panels and exact active height", async (context) => {
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
    viewMetrics: Object.freeze({
      "codex-power-view-simple": 48,
      "codex-power-view-advanced": 132,
      "codex-power-view-controls": 36,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const menu = harness.find("codex-power-menu");
  const simple = harness.find("codex-power-view-simple");
  const advanced = harness.find("codex-power-view-advanced");
  const controls = harness.find("codex-power-view-controls");
  const track = harness.find("codex-power-view-track");
  assert.equal(menu.style.getPropertyValue("--simple-view-height"), "48px");
  assert.equal(menu.style.getPropertyValue("--advanced-view-height"), "132px");
  assert.equal(menu.style.height, "84px");
  assert.deepEqual(harness.resizeObservers[0].observed, [simple, advanced, controls]);
  assert.deepEqual(
    harness.resizeObservers[1].observed,
    [harness.find("codex-power-popover"), harness.find("codex-power-flyout")],
  );
  harness.flushAnimationFrames();
  assert.equal(menu.dataset.transitionsReady, "true");
  assert.equal(menu.classList.contains("transitions-ready"), true);

  harness.find("codex-power-advanced-toggle").listeners.get("click")();
  assert.equal(menu.style.height, "168px");
  assert.equal(harness.find("codex-power-view-track"), track);
  assert.equal(harness.find("codex-power-view-simple"), simple);
  assert.equal(harness.find("codex-power-view-advanced"), advanced);

  harness.mounted.dispose();
  assert.equal(harness.resizeObservers[0].disconnected, true);
  assert.equal(harness.resizeObservers[1].disconnected, true);
});

test("rapid Power view toggles settle on compact Simple geometry without moving focus or surfaces", async (context) => {
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
    viewMetrics: Object.freeze({
      "codex-model-trigger": Object.freeze({ left: 850, top: 708, width: 130, height: 28 }),
      "codex-power-popover": Object.freeze({ width: 224, height: 84 }),
      "codex-power-view-simple": 48,
      "codex-power-view-advanced": 132,
      "codex-power-view-controls": 36,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const trigger = harness.find("codex-model-trigger");
  const popover = harness.find("codex-power-popover");
  const menu = harness.find("codex-power-menu");
  const simple = harness.find("codex-power-view-simple");
  const advanced = harness.find("codex-power-view-advanced");
  const advancedToggle = harness.find("codex-power-advanced-toggle");
  trigger.listeners.get("click")();
  const initialCoordinates = { left: popover.style.left, top: popover.style.top };
  advancedToggle.focus();

  advancedToggle.listeners.get("click")();
  advancedToggle.listeners.get("click")();
  advancedToggle.listeners.get("click")();
  advancedToggle.listeners.get("click")();

  assert.equal(menu.dataset.view, "simple");
  assert.equal(menu.style.height, "84px");
  assert.equal(simple.attributes["aria-hidden"], "false");
  assert.equal(simple.inert, false);
  assert.equal(advanced.attributes["aria-hidden"], "true");
  assert.equal(advanced.inert, true);
  assert.deepEqual({ left: popover.style.left, top: popover.style.top }, initialCoordinates);
  assert.equal(harness.documentRef.activeElement, advancedToggle);
});

test("reduced-motion rapid Power toggles track compact anchors and preserve the final Simple state", async (context) => {
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
  const popoverMetrics = { width: 224, height: 84 };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
    reducedMotion: true,
    viewMetrics: Object.freeze({
      "codex-model-trigger": Object.freeze({ left: 850, top: 708, width: 130, height: 28 }),
      "codex-power-popover": popoverMetrics,
      "codex-power-view-simple": 48,
      "codex-power-view-advanced": 132,
      "codex-power-view-controls": 36,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  const trigger = harness.find("codex-model-trigger");
  const popover = harness.find("codex-power-popover");
  const menu = harness.find("codex-power-menu");
  const simple = harness.find("codex-power-view-simple");
  const advanced = harness.find("codex-power-view-advanced");
  const advancedToggle = harness.find("codex-power-advanced-toggle");
  const surfaceResizeObserver = harness.resizeObservers[1];
  assert.equal(menu.dataset.reducedMotion, "true");
  assert.equal(menu.style.height, "84px");
  trigger.listeners.get("click")();
  advancedToggle.focus();
  assert.deepEqual({ left: popover.style.left, top: popover.style.top }, { left: "756px", top: "616px" });

  const assertView = ({ expanded, height, top }) => {
    popoverMetrics.height = height;
    surfaceResizeObserver.callback();
    assert.equal(menu.dataset.view, expanded ? "advanced" : "simple");
    assert.equal(menu.style.height, `${height}px`);
    assert.equal(simple.attributes["aria-hidden"], String(expanded));
    assert.equal(simple.inert, expanded);
    assert.equal(advanced.attributes["aria-hidden"], String(!expanded));
    assert.equal(advanced.inert, !expanded);
    assert.equal(popover.style.left, "756px");
    assert.equal(popover.style.top, `${top}px`);
    assert.equal(harness.documentRef.activeElement, advancedToggle);
  };

  advancedToggle.listeners.get("click")();
  assertView({ expanded: true, height: 168, top: 532 });
  advancedToggle.listeners.get("click")();
  assertView({ expanded: false, height: 84, top: 616 });
  advancedToggle.listeners.get("click")();
  assertView({ expanded: true, height: 168, top: 532 });
  advancedToggle.listeners.get("click")();
  assertView({ expanded: false, height: 84, top: 616 });
});

test("Advanced flyout content and focus follow Codex menu semantics", async (context) => {
  const catalog = Object.freeze({
    generation: 31,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "max", "ultra"]),
    })]),
  });
  const selection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 31,
    generation: 1,
  });
  const harness = createMountedUiHarness({ catalog, initialSelection: selection });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const row = (kind) => harness.findAll("codex-power-advanced-row")
    .find((candidate) => candidate.dataset.kind === kind);
  const options = () => harness.findAll("codex-power-flyout-option");
  const keyEvent = (key) => ({
    key,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  });

  const trigger = harness.find("codex-model-trigger");
  trigger.listeners.get("click")();
  harness.find("codex-power-advanced-toggle").listeners.get("click")();
  const effortRow = row("effort");
  effortRow.listeners.get("click")();
  const flyout = harness.find("codex-power-flyout");
  assert.equal(flyout.hidden, false);
  assert.equal(flyout.attributes.role, "menu");
  assert.equal(flyout.style.width, "180px");
  assert.equal(harness.find("codex-power-flyout-title").textContent, "Effort");
  const medium = options().find((option) => option.dataset.value === "medium");
  const ultra = options().find((option) => option.dataset.value === "ultra");
  assert.equal(medium.attributes["aria-checked"], "true");
  assert.equal(medium.children[1].textContent, "✓");
  assert.equal(ultra.children[0].children[1].textContent, "Consumes usage limits faster");
  assert.equal(harness.documentRef.activeElement, medium);

  const down = keyEvent("ArrowDown");
  flyout.listeners.get("keydown")(down);
  assert.equal(down.prevented, true);
  assert.equal(harness.documentRef.activeElement.dataset.value, "high");
  const escapeChild = keyEvent("Escape");
  flyout.listeners.get("keydown")(escapeChild);
  assert.equal(escapeChild.stopped, true);
  assert.equal(flyout.hidden, true);
  assert.equal(harness.documentRef.activeElement, effortRow);
  assert.equal(harness.find("codex-power-popover").hidden, false);

  effortRow.listeners.get("click")();
  flyout.listeners.get("keydown")(keyEvent("ArrowDown"));
  flyout.listeners.get("keydown")(keyEvent("Enter"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(effortRow.dataset.value, "high");
  assert.equal(effortRow.children[1].textContent, "High");

  const speedRow = row("speed");
  speedRow.listeners.get("click")();
  assert.equal(flyout.style.width, "233px");
  const fast = options().find((option) => option.dataset.value === "priority");
  assert.equal(fast.children[0].children[1].textContent, "1.5x speed, more usage");
  flyout.listeners.get("keydown")(keyEvent("Escape"));
  const modelRow = row("model");
  modelRow.listeners.get("click")();
  assert.equal(flyout.style.width, "280px");
  flyout.listeners.get("keydown")(keyEvent("Escape"));

  const escapeParent = keyEvent("Escape");
  harness.mounted.modelDock.listeners.get("keydown")(escapeParent);
  assert.equal(harness.find("codex-power-popover").hidden, true);
  assert.equal(harness.documentRef.activeElement, trigger);
});

test("canonical collision choices preserve provider identity and rebuild model defaults", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "claude-fable-5", "Claude Fable 5", ["medium", "high"], 24),
    providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium", "high", "ultra-code"], 24),
    providerModel("openai-codex", "gpt-next", "GPT Next", ["high", "max"], 24, {
      defaultReasoningEffort: "high",
      defaultServiceTier: "priority",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Lower latency" }],
    }),
  ], 24);
  let generation = 1;
  let current = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 24,
    generation,
  });
  const selected = [];
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: current,
    runtimeFacade: {
      async selectBot() { return current; },
      async readModel() { return current; },
      async selectModel(value) {
        selected.push(structuredClone(value));
        current = Object.freeze({
          ...value,
          catalogGeneration: 24,
          generation: ++generation,
        });
        return current;
      },
    },
    providerFacade: providerFacade({
      connections: eightConnections({
        "openai-codex": { state: "connected", generation: 24 },
        "anthropic-claude": { state: "connected", generation: 24 },
      }),
      catalog,
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const row = (kind) => harness.findAll("codex-power-advanced-row")
    .find((candidate) => candidate.dataset.kind === kind);
  harness.find("codex-model-trigger").listeners.get("click")();
  harness.find("codex-power-advanced-toggle").listeners.get("click")();

  row("model").listeners.get("click")();
  const optional = harness.findAll("codex-power-flyout-option")
    .find((option) => option.dataset.key
      === JSON.stringify(["anthropic-claude", "claude-fable-5"]));
  optional.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected.at(-1), {
    botId: BOT_A,
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  });

  row("model").listeners.get("click")();
  const nextModel = harness.findAll("codex-power-flyout-option")
    .find((option) => option.dataset.key === JSON.stringify(["openai-codex", "gpt-next"]));
  nextModel.listeners.get("click")();
  assert.equal(row("effort").dataset.value, "high");
  assert.equal(row("effort").children[1].textContent, "High");
  assert.equal(row("speed").dataset.value, "priority");
  assert.equal(row("speed").children[1].textContent, "Fast");
  row("effort").listeners.get("click")();
  assert.deepEqual(
    harness.findAll("codex-power-flyout-option").map((option) => option.dataset.value),
    ["high", "max"],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected.at(-1), {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-next",
    reasoningEffort: "high",
    serviceTier: "priority",
  });
});

test("Advanced mutation replies preserve click order and only repaint the latest intent", async (context) => {
  for (const releaseOrder of [[1, 0], [0, 1]]) {
    const catalog = Object.freeze({
      generation: 7,
      status: "ready",
      models: Object.freeze([Object.freeze({
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: Object.freeze(["medium", "high", "max"]),
      })]),
    });
    let generation = 2;
    let current = Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 7,
      generation,
    });
    const gates = [deferred(), deferred()];
    const selected = [];
    const harness = createMountedUiHarness({
      catalog,
      initialSelection: current,
      runtimeFacade: {
        async selectBot() { return current; },
        async readModel() { return current; },
        selectModel(value) {
          const index = selected.length;
          selected.push(structuredClone(value));
          return gates[index].promise.then(() => {
            current = Object.freeze({
              ...value,
              catalogGeneration: 7,
              generation: ++generation,
            });
            return current;
          });
        },
      },
    });
    context.after(() => harness.mounted.dispose());
    await new Promise((resolve) => setImmediate(resolve));
    const effortRow = harness.findAll("codex-power-advanced-row")
      .find((row) => row.dataset.kind === "effort");
    harness.find("codex-model-trigger").listeners.get("click")();
    harness.find("codex-power-advanced-toggle").listeners.get("click")();
    const choose = (effort) => {
      effortRow.listeners.get("click")();
      harness.findAll("codex-power-flyout-option")
        .find((option) => option.dataset.value === effort)
        .listeners.get("click")();
    };
    choose("high");
    choose("max");
    assert.deepEqual(selected, [
      {
        botId: BOT_A,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        serviceTier: null,
      },
      {
        botId: BOT_A,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        serviceTier: null,
      },
    ]);
    gates[releaseOrder[0]].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    gates[releaseOrder[1]].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effortRow.dataset.value, "max");
    assert.equal(effortRow.children[1].textContent, "Max");
    harness.mounted.dispose();
  }
});

test("Advanced mutation completions stay inert after a bot switch and disposal", async () => {
  const catalog = Object.freeze({
    generation: 8,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "max"]),
    })]),
  });
  const selections = new Map([
    [BOT_A, Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 8,
      generation: 1,
    })],
    [BOT_B, Object.freeze({
      botId: BOT_B,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      serviceTier: null,
      catalogGeneration: 8,
      generation: 1,
    })],
  ]);
  const gates = [deferred(), deferred()];
  const selected = [];
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
      selectModel(value) {
        const index = selected.length;
        selected.push(structuredClone(value));
        return gates[index].promise.then(() => Object.freeze({
          ...value,
          catalogGeneration: 8,
          generation: 2,
        }));
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const effortRow = harness.findAll("codex-power-advanced-row")
    .find((row) => row.dataset.kind === "effort");
  harness.find("codex-model-trigger").listeners.get("click")();
  harness.find("codex-power-advanced-toggle").listeners.get("click")();
  const choose = (effort) => {
    effortRow.listeners.get("click")();
    harness.findAll("codex-power-flyout-option")
      .find((option) => option.dataset.value === effort)
      .listeners.get("click")();
  };

  choose("high");
  await harness.mounted.controller.selectBot(BOT_B);
  assert.equal(effortRow.dataset.value, "low");
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(effortRow.dataset.value, "low");

  choose("max");
  assert.equal(effortRow.dataset.value, "max");
  harness.mounted.dispose();
  gates[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mounted.modelDock.parentElement, null);
  assert.equal(effortRow.dataset.value, "max");
  assert.deepEqual(selected.map((entry) => [entry.botId, entry.reasoningEffort]), [
    [BOT_A, "high"],
    [BOT_B, "max"],
  ]);
});

test("native protocol model dock waits for the exact composer host and remounts one identity", async (context) => {
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
  const missing = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
    nativeHost: false,
  });
  context.after(() => missing.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(missing.mounted.modelDock.dataset.codexMountState, "pending");
  assert.equal(missing.mounted.modelDock.parentElement, null);
  assert.equal(missing.documentRef.composer.children.includes(missing.mounted.modelDock), false);
  assert.equal(missing.documentRef.body.children.includes(missing.mounted.modelDock), false);

  const firstHost = missing.documentRef.createElement("div");
  missing.documentRef.nativeModelHost = firstHost;
  missing.documentRef.composer.append(firstHost);
  missing.mountObserver.callback();
  assert.equal(missing.mounted.modelDock.parentElement, firstHost);
  assert.equal(firstHost.children.filter((node) => node === missing.mounted.modelDock).length, 1);

  const replacement = missing.documentRef.createElement("div");
  missing.documentRef.nativeModelHost = replacement;
  missing.documentRef.composer.append(replacement);
  missing.mountObserver.callback();
  assert.equal(missing.mounted.modelDock.parentElement, replacement);
  assert.equal(firstHost.children.includes(missing.mounted.modelDock), false);
  assert.equal(replacement.children.filter((node) => node === missing.mounted.modelDock).length, 1);
});

test("mounted async provider completion never mutates detached controls after disposal", async () => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium", "max", "ultra"], 12),
  ], 12);
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
  const providers = providerFacade({
    catalog,
    connect() { return connection.promise; },
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: providers,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const connect = providerActionButton(harness);
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
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["low", "medium", "high", "xhigh", "max", "ultra"], 12),
    providerModel("openai-codex", "gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"], 12),
  ], 12);
  const initialSelection = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: null,
    catalogGeneration: 12,
    generation: 4,
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection,
    providerFacade: providerFacade({
      connections: eightConnections({
        "openai-codex": { state: "connected", generation: 12 },
      }),
      catalog,
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.find("codex-model-trigger-model").textContent, "GPT-5.5");
  assert.equal(harness.find("codex-model-trigger-effort").textContent, "Extra High");
  const power = harness.find("codex-power-input");
  power.listeners.get("pointerdown")();
  power.value = "0";
  power.listeners.get("input")();
  power.listeners.get("pointerup")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.selected, [{
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    serviceTier: null,
  }]);
  assert.equal(harness.find("codex-model-trigger-model").textContent, "GPT-5.6 Sol");
  harness.mounted.dispose();
});

test("provider single-flight survives an unrelated Power repaint", async (context) => {
  const catalog = providerCatalog([
    providerModel(
      "openai-codex",
      "gpt-5.6-sol",
      "GPT-5.6 Sol",
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      12,
      { isDefault: true },
    ),
  ], 12);
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
  let connectCalls = 0;
  let completeCalls = 0;
  let onboarding = null;
  const facade = providerFacade({
    connections: eightConnections({
      "openai-codex": { state: "connected", generation: 12 },
    }),
    catalog,
    connect() {
      connectCalls += 1;
      return connection.promise;
    },
    onboarding: () => onboarding,
    complete(providerId) {
      completeCalls += 1;
      onboarding = {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 12,
        catalogGeneration: 12,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
      return onboarding;
    },
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: selection,
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const action = providerActionButton(harness);
  action.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 0);
  assert.equal(action.disabled, true);

  const power = harness.find("codex-power-input");
  power.listeners.get("pointerdown")();
  power.value = "5";
  power.listeners.get("input")();
  power.listeners.get("pointerup")();
  assert.equal(harness.find("codex-power-warning").hidden, false);
  harness.mounted.controller.applyBot(bot(BOT_A, "A", "ready"));
  await new Promise((resolve) => setImmediate(resolve));
  action.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 0);
  assert.equal(completeCalls, 1);
  connection.resolve();
});

test("late lower-generation provider events cannot reopen a completed onboarding gate", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 2, { isDefault: true }),
  ], 2);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 2,
    catalogGeneration: 2,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const current = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
  });
  let emitConnections = () => {};
  let emitCatalog = () => {};
  const facade = providerFacade({
    connections: current,
    catalog,
    onboarding: receipt,
    connectionsSubscription(listener) {
      emitConnections = listener;
      return () => {};
    },
    catalogSubscription(listener) {
      emitCatalog = listener;
      return () => {};
    },
  });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 2,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  emitConnections(eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  emitCatalog(providerCatalog([], 1, "unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("an older all-settled provider refresh cannot overwrite a newer connection and receipt", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const oldList = deferred();
  const oldCatalog = deferred();
  const oldOnboarding = deferred();
  let listCalls = 0;
  let catalogCalls = 0;
  let onboardingCalls = 0;
  let connections = eightConnections();
  let onboarding = null;
  const facade = {
    async list() {
      listCalls += 1;
      return listCalls === 1 ? oldList.promise : connections;
    },
    async catalog() {
      catalogCalls += 1;
      return catalogCalls === 1 ? oldCatalog.promise : catalog;
    },
    async readOnboarding() {
      onboardingCalls += 1;
      return onboardingCalls === 1 ? oldOnboarding.promise : onboarding;
    },
    async connect(request) {
      connections = eightConnections({
        [request.providerId]: { state: "connected", generation: 1 },
      });
    },
    async completeOnboarding(providerId) {
      onboarding = {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
      return onboarding;
    },
    async disconnect() {},
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  providerActionButton(harness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  oldList.resolve(eightConnections());
  oldCatalog.resolve(providerCatalog([], 0, "unavailable"));
  oldOnboarding.resolve(null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(onboarding !== null, true);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);

  oldList.resolve(eightConnections());
  oldCatalog.resolve(providerCatalog([], 0, "unavailable"));
  oldOnboarding.resolve(null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("native initialization consumes the authoritative active-bot event before selecting a roster item", async () => {
  const { createBotUiController } = require(uiPath);
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const selection = (botId) => Object.freeze({
    botId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 1,
  });
  const selected = [];
  const controller = createBotUiController({
    nativeMode: true,
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async readActiveBotId() { return BOT_B; },
      onEvent(listener) {
        listener({ type: "active-bot-changed", botId: BOT_B });
        return () => {};
      },
      async selectBot(botId) { selected.push(botId); return selection(botId); },
      async readModel(botId) { return selection(botId); },
    },
    providerFacade: {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.deepEqual(selected, [BOT_B]);
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  controller.dispose();
});

test("invalid or missing native provider facades keep the chooser blocked and product surfaces inert", async (context) => {
  let accessorReads = 0;
  const invalidFacade = {};
  Object.defineProperty(invalidFacade, "list", {
    get() {
      accessorReads += 1;
      throw new Error("hostile accessor");
    },
  });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const harness = createMountedUiHarness({
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
    providerFacade: invalidFacade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accessorReads, 0);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
  assert.equal(harness.mounted.panel.inert, true);
  assert.equal(harness.mounted.modelDock.inert, true);
  assert.equal(providerActionButton(harness).disabled, true);

  const missing = createMountedUiHarness({
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
  });
  context.after(() => missing.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(missing.findPanel("codex-first-connection-setup").open, true);
  assert.equal(missing.mounted.panel.inert, true);
  assert.equal(missing.mounted.modelDock.inert, true);
});

test("an externally connecting provider route is not actionable until it becomes retryable", async (context) => {
  const catalog = providerCatalog([], 0, "unavailable");
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: providerFacade({
      catalog,
      connections: eightConnections({
        "anthropic-claude": { state: "connecting", generation: 4 },
      }),
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "anthropic-claude");
  assert.equal(providerActionButton(harness).disabled, true);
});

test("provider chooser and Settings render the validated connection DTO label", async (context) => {
  const catalog = providerCatalog([], 0, "unavailable");
  const connections = eightConnections({ xai: { label: "DTO xAI label" } });
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: providerFacade({ connections, catalog }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "xai");
  clickProviderCard(harness, "xai", false);
  const chooser = providerDetail(harness);
  const settings = providerDetail(harness, false);
  assert.equal(providerControl(harness, "codex-provider-details-title").textContent, "DTO xAI label");
  assert.equal(providerControl(harness, "codex-provider-details-title", false).textContent, "DTO xAI label");
  assert.equal(chooser.dataset.loginKind, providerDescriptor("xai").loginKind);
  assert.equal(settings.dataset.loginKind, providerDescriptor("xai").loginKind);
});

test("hostile provider DTOs reject missing fields, custom arrays, and non-canonical receipts", async (context) => {
  const catalogModels = [
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ];
  catalogModels.extra = "reject me";
  const malformedCatalog = Object.freeze({
    generation: 1,
    status: "ready",
    models: catalogModels,
  });
  const malformedConnections = eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  }).map((entry) => {
    if (entry.providerId !== "openai-codex") return entry;
    const copy = { ...entry };
    delete copy.capabilities;
    return copy;
  });
  const harness = createMountedUiHarness({
    catalog: malformedCatalog,
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
    providerFacade: providerFacade({
      connections: malformedConnections,
      catalog: malformedCatalog,
      onboarding: {
        schemaVersion: 1,
        providerId: "openai-codex",
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19",
      },
    }),
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
  assert.equal(harness.mounted.panel.inert, true);
  assert.equal(harness.mounted.modelDock.inert, true);
});

test("external browser launch cannot complete onboarding before an authoritative connected catalog event", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  let connections = eightConnections({
    "openai-codex": { state: "connecting", generation: 1 },
  });
  let onboarding = null;
  let emitConnections = () => {};
  let completeCalls = 0;
  const facade = providerFacade({
    connections: () => connections,
    catalog,
    onboarding: () => onboarding,
    connect() { return undefined; },
    complete(providerId) {
      completeCalls += 1;
      onboarding = {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
      return onboarding;
    },
    connectionsSubscription(listener) {
      emitConnections = listener;
      return () => {};
    },
  });
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  providerActionButton(harness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completeCalls, 0);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);

  connections = eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  });
  emitConnections(connections);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completeCalls, 0);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
});

test("held Direct Codex browser connect stays Connecting and cannot complete onboarding before the atomic snapshot", async (context) => {
  const unavailable = providerCatalog([], 0, "unavailable");
  const connectedCatalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const heldConnect = deferred();
  let connections = eightConnections();
  let onboarding = null;
  let completeCalls = 0;
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const facade = providerFacade({
    connections: () => connections,
    catalog: () => connections.find((entry) => entry.providerId === "openai-codex")?.state === "connected"
      ? connectedCatalog : unavailable,
    onboarding: () => onboarding,
    connect(request) {
      assert.deepEqual(request, { providerId: "openai-codex", authMode: "browser" });
      return heldConnect.promise.then(() => {
        connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
      });
    },
    complete(providerId) {
      completeCalls += 1;
      onboarding = { ...receipt, providerId };
      return onboarding;
    },
  });
  const harness = createMountedUiHarness({
    catalog: unavailable,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const action = providerActionButton(harness);
  action.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(action.disabled, true);
  assert.equal(providerControl(harness, "codex-provider-details-status").textContent, "Connecting…");
  assert.equal(completeCalls, 0);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);

  heldConnect.resolve();
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completeCalls, 1);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("Direct Codex device prompt accepts only the exact bounded DTO for the pending operation", async (context) => {
  const unavailable = providerCatalog([], 0, "unavailable");
  const heldConnect = deferred();
  let emitPrompt = () => {};
  let connections = eightConnections();
  let connectCalls = 0;
  let promptCallbackCalls = 0;
  const facade = providerFacade({
    connections: () => connections,
    catalog: unavailable,
    connect(request) {
      connectCalls += 1;
      assert.deepEqual(request, { providerId: "openai-codex", authMode: "device-code" });
      return heldConnect.promise;
    },
    loginPromptSubscription(listener) {
      emitPrompt = (value) => {
        promptCallbackCalls += 1;
        listener(value);
      };
      return () => { emitPrompt = () => {}; };
    },
  });
  const harness = createMountedUiHarness({
    catalog: unavailable,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  providerControl(harness, "codex-provider-auth-mode").value = "device-code";
  providerActionButton(harness).listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 1);

  const prompt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    generation: 1,
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  };
  emitPrompt(prompt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCallbackCalls, 1);
  const promptNode = harness.findPanel("codex-provider-login-prompt");
  assert.equal(promptNode.hidden, false);
  assert.match(promptNode.children[1].textContent, /ABCD-1234/);

  const hostilePrompt = { ...prompt, loginId: "private-login-id" };
  emitPrompt(hostilePrompt);
  emitPrompt({ ...prompt, providerId: "anthropic-claude", userCode: "WXYZ-5678" });
  emitPrompt(new Proxy(prompt, {}));
  emitPrompt({ ...prompt, generation: 0, userCode: "BAD-0000" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(promptNode.children[1].textContent, /ABCD-1234/);
  assert.doesNotMatch(promptNode.children[1].textContent, /private-login-id|WXYZ-5678|BAD-0000/);

  emitPrompt({ ...prompt, generation: 2, userCode: "EFGH-5678" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(promptNode.children[1].textContent, /EFGH-5678/);
  emitPrompt(prompt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(promptNode.children[1].textContent, /EFGH-5678/);
  harness.mounted.dispose();
  assert.equal(promptNode.hidden, true);
  heldConnect.resolve();
});

test("disconnect-pending Direct Codex is model-free and exposes Settings Retry disconnect", async (context) => {
  const connections = eightConnections({
    "openai-codex": {
      state: "unavailable",
      generation: 3,
      errorCode: "OPENBOT_PROVIDER_DISCONNECT_PENDING",
    },
  });
  const calls = [];
  const facade = providerFacade({
    connections,
    catalog: providerCatalog([], 0, "unavailable"),
    disconnect(providerId) {
      calls.push(providerId);
    },
  });
  const harness = createMountedUiHarness({
    catalog: providerCatalog([], 0, "unavailable"),
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const settings = providerDetail(harness, false);
  const retry = providerControl(harness, "codex-provider-disconnect", false);
  assert.equal(harness.mounted.controller.snapshot().modelCatalog.length, 0);
  assert.equal(providerControl(harness, "codex-provider-details-status", false).textContent, "Retry available");
  assert.equal(providerActionButton(harness, false).disabled, true);
  assert.equal(retry.hidden, false);
  assert.equal(retry.textContent, "Retry disconnect OpenAI Codex");
  retry.listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["openai-codex"]);
});

test("postcommit onboarding refresh failure offers stale refresh only and never Finish setup", async (context) => {
  const connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  let completeCalls = 0;
  let committed = false;
  let refreshFailed = false;
  const facade = {
    async readAuthoritySnapshot() {
      if (refreshFailed) throw new Error("postcommit readback failed");
      return authoritySnapshot({ connections, catalog, onboarding: committed ? receipt : null });
    },
    async connect() { throw new Error("connect must not be retried"); },
    async disconnect() {},
    async completeOnboarding() {
      completeCalls += 1;
      committed = true;
      refreshFailed = true;
      return receipt;
    },
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
    botsFacade: {
      async list() { return [bot(BOT_A, "A", "ready")]; },
      onChanged() { return () => {}; },
    },
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const action = providerActionButton(harness);
  assert.equal(action.textContent, "Continue with OpenAI Codex");
  action.listeners.get("click")();
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const staleStatus = harness.findPanel("codex-first-connection-status");
  const staleRetry = harness.findPanel("codex-first-connection-retry");
  assert.equal(completeCalls, 1);
  assert.equal(staleStatus.hidden, false);
  assert.equal(staleRetry.hidden, false);
  assert.notEqual(action.textContent, "Finish setup");

  refreshFailed = false;
  staleRetry.listeners.get("click")();
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completeCalls, 1);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("closed Power trigger uses compact labels while Advanced summary keeps raw effort labels", async () => {
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
  const advancedEffort = harness.findAll("codex-power-advanced-row")
    .find((row) => row.dataset.kind === "effort");
  assert.equal(triggerEffort.textContent, "Standard");
  advancedToggle.listeners.get("click")();
  assert.equal(advancedEffort.children[1].textContent, "Medium");
  assert.equal(advancedEffort.dataset.value, "medium");
  assert.equal(harness.find("codex-power-menu").dataset.view, "advanced");
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

test("persisted Ultra keeps the Advanced summary steady without replaying pointer entry", async () => {
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
  const effort = harness.findAll("codex-power-advanced-row")
    .find((row) => row.dataset.kind === "effort");
  assert.equal(harness.find("codex-power-fast-toggle").hidden, true);
  assert.equal(warning.hidden, true);
  assert.equal(harness.find("codex-power-control").classList.contains("is-ultra-entering"), false);
  assert.equal(timers.size, 0);

  assert.equal(effort.children[1].textContent, "Ultra");
  assert.equal(effort.dataset.value, "ultra");
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
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium", "high", "ultra"], 9),
    providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium", "high", "ultra-code"], 9),
  ], 9);
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
      provider: "anthropic-claude",
      model: "claude-fable-5",
      reasoningEffort: "ultra-code",
      serviceTier: null,
      catalogGeneration: 9,
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
    providerFacade: providerFacade({
      connections: eightConnections({
        "openai-codex": { state: "connected", generation: 9 },
        "anthropic-claude": { state: "connected", generation: 9 },
      }),
      catalog,
    }),
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

test("provider events before a held startup refresh trigger a receipt-aware replacement refresh", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 2, { isDefault: true }),
  ], 2);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 2,
    catalogGeneration: 2,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
  });
  const heldList = deferred();
  const heldCatalog = deferred();
  const heldReceipt = deferred();
  let phase = "held";
  let emitConnections = () => {};
  let emitCatalog = () => {};
  const facade = {
    async list() { return phase === "held" ? heldList.promise : connections; },
    async catalog() { return phase === "held" ? heldCatalog.promise : catalog; },
    async readOnboarding() { return phase === "held" ? heldReceipt.promise : receipt; },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged(listener) {
      emitConnections = listener;
      return () => {};
    },
    onCatalogChanged(listener) {
      emitCatalog = listener;
      return () => {};
    },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 2,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  phase = "latest";
  emitConnections(connections);
  emitCatalog(catalog);
  await new Promise((resolve) => setImmediate(resolve));
  heldList.resolve(connections);
  heldCatalog.resolve(catalog);
  heldReceipt.resolve(receipt);
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("concurrent provider operations keep out-of-order A and B refreshes independent", async (context) => {
  const unavailable = providerCatalog([], 0, "unavailable");
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
    providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium"], 1, { isDefault: true }),
  ], 1);
  const disconnected = eightConnections();
  let currentConnections = disconnected;
  let connectCalls = 0;
  const facade = {
    async list() { return currentConnections; },
    async catalog() {
      return currentConnections.some((entry) => entry.state === "connected") ? catalog : unavailable;
    },
    async readOnboarding() { return null; },
    async connect(request) {
      connectCalls += 1;
      const connected = Object.fromEntries(currentConnections
        .filter((entry) => entry.state === "connected")
        .map((entry) => [entry.providerId, { state: "connected", generation: entry.generation }]));
      connected[request.providerId] = { state: "connected", generation: 1 };
      currentConnections = eightConnections(connected);
    },
    async disconnect() {},
    async completeOnboarding() {},
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog: unavailable,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 0,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  clickProviderCard(harness, "openai-codex", false);
  providerActionButton(harness, false).listeners.get("click")();
  clickProviderCard(harness, "anthropic-claude", false);
  providerActionButton(harness, false).listeners.get("click")();
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 2);
  assert.equal(harness.mounted.controller.snapshot().modelCatalog.length, 2);
});

test("a connected first route stays retryable when receipt completion fails", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  let connections = eightConnections();
  let onboarding = null;
  let connectCalls = 0;
  let completeCalls = 0;
  const facade = providerFacade({
    connections: () => connections,
    catalog,
    onboarding: () => onboarding,
    connect() {
      connectCalls += 1;
      connections = eightConnections({
        "openai-codex": { state: "connected", generation: 1 },
      });
    },
    complete(providerId) {
      completeCalls += 1;
      if (completeCalls === 1) throw new Error("durable receipt write failed");
      onboarding = {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
      return onboarding;
    },
  });
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const action = providerActionButton(harness);
  action.listeners.get("click")();
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const error = providerControl(harness, "codex-provider-connection-error");
  assert.equal(connectCalls, 1);
  assert.equal(completeCalls, 1);
  assert.equal(action.disabled, false);
  assert.equal(harness.documentRef.activeElement, action);
  assert.match(error.textContent, /setup|receipt|save|try again/i);

  action.listeners.get("click")();
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(connectCalls, 1);
  assert.equal(completeCalls, 2);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("native initialization reads the exact authoritative active bot before roster selection", async () => {
  const { createBotUiController } = require(uiPath);
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const selection = (botId) => Object.freeze({
    botId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 1,
  });
  const selected = [];
  const controller = createBotUiController({
    nativeMode: true,
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async readActiveBotId() { return BOT_B; },
      onEvent() { return () => {}; },
      async selectBot(botId) { selected.push(botId); return selection(botId); },
      async readModel(botId) { return selection(botId); },
    },
    providerFacade: {
      async catalog() { return catalog; },
      onCatalogChanged() { return () => {}; },
    },
  });
  await controller.initialize();
  assert.deepEqual(selected, [BOT_B]);
  assert.equal(controller.snapshot().activeBotId, BOT_B);
  controller.dispose();
});

test("native initialization fails closed for missing or hostile active identity without inventing a roster item", async () => {
  const { createBotUiController } = require(uiPath);
  const makeController = (runtimeFacade) => createBotUiController({
    nativeMode: true,
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged() { return () => {}; },
    },
    runtimeFacade,
  });
  const selection = [];
  const missing = makeController({
    onEvent() { return () => {}; },
    async selectBot(botId) { selection.push(botId); },
  });
  await missing.initialize();
  assert.deepEqual(selection, []);
  assert.equal(missing.snapshot().activeBotId, null);
  missing.dispose();

  const hostile = makeController({
    async readActiveBotId() { return { botId: BOT_B }; },
    onEvent() { return () => {}; },
    async selectBot(botId) { selection.push(botId); },
  });
  await assert.rejects(hostile.initialize(), /active bot|identity/i);
  assert.deepEqual(selection, []);
  hostile.dispose();
});

test("native active identity read and future events are fenced by disposal", async () => {
  const { createBotUiController } = require(uiPath);
  const read = deferred();
  const listed = deferred();
  let runtimeListener;
  let readCalls = 0;
  const selected = [];
  const controller = createBotUiController({
    nativeMode: true,
    facade: {
      async list() { return listed.promise; },
      onChanged() { return () => {}; },
    },
    runtimeFacade: {
      async readActiveBotId() {
        readCalls += 1;
        return read.promise;
      },
      onEvent(listener) {
        runtimeListener = listener;
        return () => {};
      },
      async selectBot(botId) { selected.push(botId); },
    },
  });
  const initialization = controller.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCalls, 1);
  controller.dispose();
  runtimeListener({ type: "active-bot-changed", botId: BOT_B });
  read.resolve(BOT_B);
  listed.resolve([bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]);
  await assert.rejects(initialization, /unavailable|changed/i);
  assert.deepEqual(selected, []);
});

test("R3-N1 older failed refresh cannot reopen a newer healthy gate", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 2, { isDefault: true }),
  ], 2);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 2,
    catalogGeneration: 2,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
  });
  const oldReads = { list: deferred(), catalog: deferred(), onboarding: deferred() };
  let listCalls = 0;
  let catalogCalls = 0;
  let onboardingCalls = 0;
  let emitConnections = () => {};
  const facade = {
    async list() { return ++listCalls === 1 ? oldReads.list.promise : connections; },
    async catalog() { return ++catalogCalls === 1 ? oldReads.catalog.promise : catalog; },
    async readOnboarding() {
      return ++onboardingCalls === 1 ? oldReads.onboarding.promise : receipt;
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 2,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  while (listCalls < 1 || catalogCalls < 1 || onboardingCalls < 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  emitConnections(connections);
  oldReads.list.reject(new Error("old list failed"));
  oldReads.catalog.reject(new Error("old catalog failed"));
  oldReads.onboarding.reject(new Error("old receipt failed"));
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("R3-N2 same-generation stale receipt cannot switch onboarding provider", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 2, { isDefault: true }),
    providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium"], 2),
  ], 2);
  const connected = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
    "anthropic-claude": { state: "connected", generation: 2 },
  });
  const receiptA = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 2,
    catalogGeneration: 2,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const receiptB = { ...receiptA, providerId: "anthropic-claude" };
  let onboardingReads = 0;
  let currentConnections = connected;
  let emitConnections;
  const facade = {
    async list() { return currentConnections; },
    async catalog() {
      return providerCatalog(catalog.models.filter((entry) => currentConnections
        .some((connection) => connection.providerId === entry.provider && connection.state === "connected")), 2);
    },
    async readOnboarding() {
      onboardingReads += 1;
      return onboardingReads === 2 ? receiptB : onboardingReads === 3 ? null : receiptA;
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receiptA; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 2,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  emitConnections(connected);
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);

  currentConnections = eightConnections({
    "openai-codex": { state: "disconnected", generation: 3 },
    "anthropic-claude": { state: "connected", generation: 2 },
  });
  emitConnections(currentConnections);
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
});

test("R3-N3 same-generation stale catalog cannot reintroduce disconnected models", async (context) => {
  const currentCatalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 2, { isDefault: true }),
  ], 2);
  const staleCatalog = providerCatalog([
    ...currentCatalog.models,
    providerModel("anthropic-claude", "claude-stale", "Claude stale", ["medium"], 2),
  ], 2);
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
    "anthropic-claude": { state: "disconnected", generation: 2 },
  });
  let emitCatalog;
  const facade = providerFacade({
    connections,
    catalog: currentCatalog,
    catalogSubscription(listener) { emitCatalog = listener; return () => {}; },
  });
  const harness = createMountedUiHarness({
    catalog: currentCatalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 2,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  emitCatalog(staleCatalog);
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [...new Set(harness.mounted.controller.snapshot().modelCatalog.map((entry) => entry.provider))],
    ["openai-codex"],
  );
});

test("R3-N4 failed disconnect preserves the connected receipt-retry marker", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  let connections = eightConnections();
  let completeCalls = 0;
  const facade = providerFacade({
    connections: () => connections,
    catalog,
    connect() {
      connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
    },
    complete(providerId) {
      completeCalls += 1;
      if (completeCalls === 1) throw new Error("receipt write failed");
      return {
        schemaVersion: 1,
        providerId,
        connectionGeneration: 1,
        catalogGeneration: 1,
        completedAt: "2026-08-19T00:00:00.000Z",
      };
    },
    disconnect() { throw new Error("disconnect failed"); },
  });
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const firstAction = providerActionButton(harness);
  firstAction.listeners.get("click")();
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  providerControl(harness, "codex-provider-disconnect", false).listeners.get("click")();
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstAction.disabled, false);
  assert.equal(firstAction.textContent, "Finish setup");
});

test("R3-N5 an active-bot event before or during the initial read wins over stale identity", async () => {
  const { createBotUiController } = require(uiPath);
  for (const readValue of [null, BOT_A]) {
    const read = deferred();
    let runtimeListener;
    const selected = [];
    const controller = createBotUiController({
      nativeMode: true,
      facade: {
        async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
        onChanged() { return () => {}; },
      },
      runtimeFacade: {
        async readActiveBotId() { return read.promise; },
        onEvent(listener) { runtimeListener = listener; return () => {}; },
        async selectBot(botId) { selected.push(botId); return null; },
      },
    });
    const initialization = controller.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    runtimeListener({ type: "active-bot-changed", botId: BOT_B });
    read.resolve(readValue);
    await initialization;
    assert.deepEqual(selected, [BOT_B]);
    controller.dispose();
  }
});

test("R4-N1 provider catalog metadata generation is independent from connection generation", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 2);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 2,
    catalogGeneration: 2,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const harness = createMountedUiHarness({
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
    providerFacade: providerFacade({
      connections: eightConnections({
        "openai-codex": { state: "connected", generation: 2 },
      }),
      catalog,
      onboarding: receipt,
    }),
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  assert.deepEqual(
    harness.mounted.controller.snapshot().modelCatalog.map(({ provider, model, catalogGeneration }) => ({
      provider,
      model,
      catalogGeneration,
    })),
    [{ provider: "openai-codex", model: "gpt-5.6-sol", catalogGeneration: 1 }],
  );
});

test("R4-N2 a partial catalog signal cannot erase another connected provider during refresh", async (context) => {
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
    "anthropic-claude": { state: "connected", generation: 2 },
  });
  const fullCatalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
    providerModel("anthropic-claude", "claude-fable-5", "Claude Fable 5", ["medium"], 2),
  ], 2);
  const partialCatalog = providerCatalog([fullCatalog.models[1]], 2);
  const heldRefreshCatalog = deferred();
  let catalogCalls = 0;
  let emitCatalog;
  const facade = {
    async list() { return connections; },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return null; },
    async readOnboarding() { return null; },
    async catalog() {
      catalogCalls += 1;
      return catalogCalls === 2 ? heldRefreshCatalog.promise : fullCatalog;
    },
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged(listener) { emitCatalog = listener; return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog: fullCatalog,
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  while (catalogCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    new Set(harness.mounted.controller.snapshot().modelCatalog.map(({ provider }) => provider)),
    new Set(["openai-codex", "anthropic-claude"]),
  );

  emitCatalog(partialCatalog);
  while (catalogCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    new Set(harness.mounted.controller.snapshot().modelCatalog.map(({ provider }) => provider)),
    new Set(["openai-codex", "anthropic-claude"]),
  );
  heldRefreshCatalog.resolve(fullCatalog);
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    new Set(harness.mounted.controller.snapshot().modelCatalog.map(({ provider }) => provider)),
    new Set(["openai-codex", "anthropic-claude"]),
  );
});

test("R4-N3 an external disconnect clears receipt retry only after the disconnected snapshot commits", async (context) => {
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  let connections = eightConnections();
  let emitConnections;
  let completeCalls = 0;
  const facade = providerFacade({
    connections: () => connections,
    catalog: () => connections.find((entry) => entry.providerId === "openai-codex")?.state === "connected"
      ? catalog : providerCatalog([], 0, "unavailable"),
    connect() {
      connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
    },
    complete(providerId) {
      completeCalls += 1;
      throw new Error("receipt write failed");
    },
    connectionsSubscription(listener) { emitConnections = listener; return () => {}; },
  });
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  const retryAction = providerActionButton(harness);
  retryAction.listeners.get("click")();
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completeCalls, 1);
  assert.equal(retryAction.textContent, "Finish setup");
  assert.equal(retryAction.disabled, false);

  connections = eightConnections({ "openai-codex": { state: "disconnected", generation: 2 } });
  emitConnections(connections);
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(retryAction.textContent, "Finish setup");
  assert.equal(retryAction.disabled, false);
});

test("R4-N4 an older higher-generation refresh cannot commit a mixed connection/catalog/receipt snapshot", async (context) => {
  const firstRead = deferred();
  const generationOneConnections = eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  });
  const generationTwoConnections = eightConnections({
    "openai-codex": { state: "disconnected", generation: 2 },
  });
  const generationOneCatalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 1);
  const generationTwoCatalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol-v2", "GPT-5.6 Sol v2", ["medium"], 2, { isDefault: true }),
  ], 2);
  const generationOneReceipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const generationTwoReceipt = {
    ...generationOneReceipt,
    connectionGeneration: 2,
    catalogGeneration: 2,
  };
  let authorityReads = 0;
  let emitConnections = () => {};
  const facade = {
    async readAuthoritySnapshot() {
      authorityReads += 1;
      return authorityReads === 1
        ? firstRead.promise
        : authoritySnapshot({
          connections: generationOneConnections,
          catalog: generationOneCatalog,
          onboarding: generationOneReceipt,
        });
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return generationOneReceipt; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog: generationOneCatalog,
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  while (authorityReads < 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  emitConnections(generationOneConnections);
  firstRead.resolve(authoritySnapshot({
    connections: generationTwoConnections,
    catalog: generationTwoCatalog,
    onboarding: generationTwoReceipt,
  }));
  while (authorityReads < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerControl(harness, "codex-provider-details-status", false).textContent, "Connected");
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  assert.deepEqual(
    harness.mounted.controller.snapshot().modelCatalog.map(({ model }) => model),
    ["gpt-5.6-sol"],
  );
});

test("R4-N5 native applyBot never selects the first roster item without an authoritative active event", async () => {
  const { createBotUiController } = require(uiPath);
  let runtimeListener;
  let botListener;
  const selected = [];
  const controller = createBotUiController({
    nativeMode: true,
    facade: {
      async list() { return [bot(BOT_A, "A", "ready"), bot(BOT_B, "B", "ready")]; },
      onChanged(listener) { botListener = listener; return () => {}; },
    },
    runtimeFacade: {
      async readActiveBotId() { return null; },
      onEvent(listener) { runtimeListener = listener; return () => {}; },
      async selectBot(botId) { selected.push(botId); return null; },
    },
  });
  await controller.initialize();
  assert.deepEqual(selected, []);
  botListener(bot(BOT_A, "A updated", "ready"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, []);
  runtimeListener({ type: "active-bot-changed", botId: BOT_B });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, [BOT_B]);
  controller.dispose();
});

test("provider event storms coalesce into one bounded stable retry", async (context) => {
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 2 },
  });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 1, { isDefault: true }),
  ], 2);
  const heldCatalog = deferred();
  let catalogCalls = 0;
  let emitConnections;
  const facade = {
    async list() { return connections; },
    async catalog() {
      catalogCalls += 1;
      return catalogCalls === 1 ? heldCatalog.promise : catalog;
    },
    async readOnboarding() { return null; },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return null; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
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
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  while (catalogCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 50; index += 1) emitConnections(connections);
  heldCatalog.resolve(catalog);
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catalogCalls, 2);
  assert.deepEqual(
    harness.mounted.controller.snapshot().modelCatalog.map(({ provider, model }) => ({ provider, model })),
    [{ provider: "openai-codex", model: "gpt-5.6-sol" }],
  );
});

test("R5-N1 atomic authority accepts model metadata newer than its envelope", async (context) => {
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const facade = {
    async readAuthoritySnapshot() { return authoritySnapshot({ connections, catalog, onboarding: receipt }); },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  assert.deepEqual(harness.mounted.controller.snapshot().modelCatalog.map(({ model, catalogGeneration }) => ({
    model,
    catalogGeneration,
  })), [{ model: "gpt-5.6-sol", catalogGeneration: 3 }]);
});

test("R5-N2 a connected legacy route confirms onboarding without reconnecting", async (context) => {
  const connections = eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  let current = authoritySnapshot({ connections, catalog, onboarding: null });
  let connectCalls = 0;
  let completeCalls = 0;
  const facade = {
    async readAuthoritySnapshot() { return current; },
    async connect() { connectCalls += 1; },
    async disconnect() {},
    async completeOnboarding(providerId) {
      completeCalls += 1;
      current = authoritySnapshot({ connections, catalog, onboarding: { ...receipt, providerId } });
      return current.onboarding;
    },
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const action = providerActionButton(harness);
  assert.equal(action.disabled, false);
  assert.equal(action.textContent, "Continue with OpenAI Codex");
  action.listeners.get("click")();
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 0);
  assert.equal(completeCalls, 1);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("R5-N3 finite authority signals converge after a quiet trailing read", async (context) => {
  const disconnected = eightConnections();
  const connected = eightConnections({
    "openai-codex": { state: "connected", generation: 1 },
  });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const initial = authoritySnapshot({
    connections: disconnected,
    catalog: providerCatalog([], 0, "unavailable"),
    onboarding: null,
  });
  const valid = authoritySnapshot({ connections: connected, catalog, onboarding: receipt });
  const firstRead = deferred();
  const secondRead = deferred();
  let reads = 0;
  let emitConnections = () => {};
  let emitCatalog = () => {};
  const facade = {
    async readAuthoritySnapshot() {
      reads += 1;
      if (reads === 1) return firstRead.promise;
      if (reads === 2) return secondRead.promise;
      return valid;
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged(listener) { emitCatalog = listener; return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  emitConnections(disconnected);
  firstRead.resolve(valid);
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  emitCatalog(catalog);
  secondRead.resolve(valid);
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(reads >= 3);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  assert.equal(harness.mounted.controller.snapshot().modelCatalog.length, 1);
});

test("R5-N4 full-snapshot concurrent connects converge for either completion order", async (context) => {
  const orders = [
    ["openai-codex", "anthropic-claude"],
    ["anthropic-claude", "openai-codex"],
  ];
  for (const order of orders) {
    const disconnected = eightConnections();
    const initial = authoritySnapshot({
      connections: disconnected,
      catalog: providerCatalog([], 0, "unavailable"),
      onboarding: null,
    });
    const connectionFor = (providerId) => ({ state: "connected", generation: 1 });
    const snapshotFor = (providerIds) => {
      const overrides = Object.fromEntries(providerIds.map((providerId) => [providerId, connectionFor(providerId)]));
      const connections = eightConnections(overrides);
      const models = providerIds.map((providerId) => providerModel(
        providerId,
        providerId === "openai-codex" ? "gpt-5.6-sol" : "claude-fable-5",
        providerId === "openai-codex" ? "GPT-5.6 Sol" : "Claude Fable 5",
        ["medium"],
        3,
        { isDefault: providerId === order[0] },
      ));
      return authoritySnapshot({ connections, catalog: providerCatalog(models, 1), onboarding: null });
    };
    let current = initial;
    let emitConnections;
    let reads = 0;
    let maxConcurrentReads = 0;
    let activeReads = 0;
    let heldFirstRead = null;
    const connectFlights = new Map(order.map((providerId) => [providerId, deferred()]));
    let connectCalls = 0;
    const facade = {
      async readAuthoritySnapshot() {
        reads += 1;
        activeReads += 1;
        maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
        if (reads === 1) {
          activeReads -= 1;
          return current;
        }
        if (!heldFirstRead) heldFirstRead = deferred();
        const value = reads === 2 ? heldFirstRead.promise : Promise.resolve(current);
        return value.then((snapshot) => {
          activeReads -= 1;
          return snapshot;
        });
      },
      async connect({ providerId }) {
        connectCalls += 1;
        await connectFlights.get(providerId).promise;
        const connectedProviders = order.filter((candidate) => candidate === providerId
          || current.connections.some((entry) => entry.providerId === candidate && entry.state === "connected"));
        current = snapshotFor(connectedProviders);
        emitConnections(current.connections);
        return current.connections.find((entry) => entry.providerId === providerId);
      },
      async disconnect() {},
      async completeOnboarding() { return null; },
      onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
      onCatalogChanged() { return () => {}; },
      onLoginPrompt() { return () => {}; },
    };
    const harness = createMountedUiHarness({
      catalog: providerCatalog([], 0, "unavailable"),
      initialSelection: Object.freeze({
        botId: BOT_A,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: null,
        catalogGeneration: 3,
        generation: 1,
      }),
      nativeProtocol: true,
      nativeHost: true,
      providerFacade: facade,
    });
    context.after(() => harness.mounted.dispose());
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    clickProviderCard(harness, order[0], false);
    providerActionButton(harness, false).listeners.get("click")();
    clickProviderCard(harness, order[1], false);
    providerActionButton(harness, false).listeners.get("click")();
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    connectFlights.get(order[0]).resolve();
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
    connectFlights.get(order[1]).resolve();
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
    heldFirstRead?.resolve(snapshotFor(order));
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connectCalls, 2);
    assert.equal(maxConcurrentReads, 1);
    clickProviderCard(harness, order[0], false);
    assert.equal(providerControl(harness, "codex-provider-connection-error", false).hidden, true);
    clickProviderCard(harness, order[1], false);
    assert.equal(providerControl(harness, "codex-provider-connection-error", false).hidden, true);
    assert.deepEqual(
      new Set(harness.mounted.controller.snapshot().modelCatalog.map(({ provider }) => provider)),
      new Set(order),
    );
    harness.mounted.dispose();
  }
});

test("R5-N5 synchronous authority signal reentry cannot start a second reader", async (context) => {
  const connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const snapshot = authoritySnapshot({ connections, catalog, onboarding: null });
  const firstRead = deferred();
  let emitConnections = () => {};
  let reads = 0;
  let activeReads = 0;
  let maxConcurrentReads = 0;
  const facade = {
    async readAuthoritySnapshot() {
      reads += 1;
      activeReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
      if (reads === 1) {
        emitConnections(connections);
        return firstRead.promise.then((value) => {
          activeReads -= 1;
          return value;
        });
      }
      activeReads -= 1;
      return snapshot;
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return null; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  firstRead.resolve(snapshot);
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrentReads, 1);
  assert.ok(reads >= 2);
});

test("atomic authority rejects transparent Proxy wrappers at every snapshot nesting level", async (context) => {
  const connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
  const model = providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true });
  const catalog = providerCatalog([model], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const transparent = (value) => new Proxy(value, {});
  const cases = [
    ["snapshot", transparent(authoritySnapshot({ connections, catalog, onboarding: receipt }))],
    ["connections", authoritySnapshot({ connections: transparent(connections), catalog, onboarding: receipt })],
    ["catalog", authoritySnapshot({ connections, catalog: transparent(catalog), onboarding: receipt })],
    ["models", authoritySnapshot({
      connections,
      catalog: providerCatalog(transparent([model]), 1),
      onboarding: receipt,
    })],
    ["model", authoritySnapshot({
      connections,
      catalog: providerCatalog([transparent(model)], 1),
      onboarding: receipt,
    })],
    ["onboarding", authoritySnapshot({ connections, catalog, onboarding: transparent(receipt) })],
  ];
  for (const [, hostileSnapshot] of cases) {
    const facade = {
      async readAuthoritySnapshot() { return hostileSnapshot; },
      async connect() {},
      async disconnect() {},
      async completeOnboarding() { return receipt; },
      onConnectionsChanged() { return () => {}; },
      onCatalogChanged() { return () => {}; },
      onLoginPrompt() { return () => {}; },
    };
    const harness = createMountedUiHarness({
      catalog,
      initialSelection: Object.freeze({
        botId: BOT_A,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: null,
        catalogGeneration: 3,
        generation: 1,
      }),
      nativeProtocol: true,
      nativeHost: true,
      providerFacade: facade,
    });
    context.after(() => harness.mounted.dispose());
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.findPanel("codex-first-connection-setup").open, true);
    assert.deepEqual(harness.mounted.controller.snapshot().modelCatalog, []);
    harness.mounted.dispose();
  }
});

test("failed authority refresh surfaces stale retry state and clears after a successful quiet retry", async (context) => {
  const connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const snapshot = authoritySnapshot({ connections, catalog, onboarding: receipt });
  let phase = "valid";
  let reads = 0;
  let emitConnections = () => {};
  const facade = {
    async readAuthoritySnapshot() {
      reads += 1;
      if (phase === "failed") throw new Error("temporary authority failure");
      return snapshot;
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  phase = "failed";
  emitConnections(connections);
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const status = harness.findPanel("codex-ai-connections-status");
  const retry = harness.findPanel("codex-ai-connections-retry");
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  assert.equal(harness.mounted.controller.snapshot().modelCatalog.length, 1);
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /stale|retry|unavailable/i);
  assert.equal(status.attributes.role, "status");
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);

  const readsAfterFailure = reads;
  phase = "valid";
  retry.listeners.get("click")();
  retry.listeners.get("click")();
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(reads > readsAfterFailure);
  assert.equal(status.hidden, true);
  assert.equal(retry.hidden, true);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("a valid receipt followed by a null receipt announces stale authority and retries visibly", async (context) => {
  const connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const valid = authoritySnapshot({ connections, catalog, onboarding: receipt });
  const stale = authoritySnapshot({ connections, catalog, onboarding: null });
  let phase = "valid";
  let emitCatalog = () => {};
  const facade = {
    async readAuthoritySnapshot() { return phase === "stale" ? stale : valid; },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged() { return () => {}; },
    onCatalogChanged(listener) { emitCatalog = listener; return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  phase = "stale";
  emitCatalog(catalog);
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const status = harness.findPanel("codex-ai-connections-status");
  const retry = harness.findPanel("codex-ai-connections-retry");
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
  assert.equal(harness.mounted.controller.snapshot().modelCatalog.length, 1);
  assert.equal(status.hidden, false);
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);
  phase = "valid";
  retry.listeners.get("click")();
  retry.listeners.get("click")();
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.hidden, true);
  assert.equal(retry.hidden, true);
  assert.equal(harness.findPanel("codex-first-connection-setup").open, false);
});

test("stale authority retry is single-flight and disposal-safe", async (context) => {
  const connections = eightConnections({ "openai-codex": { state: "connected", generation: 1 } });
  const catalog = providerCatalog([
    providerModel("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol", ["medium"], 3, { isDefault: true }),
  ], 1);
  const receipt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const snapshot = authoritySnapshot({ connections, catalog, onboarding: receipt });
  const held = deferred();
  let phase = "valid";
  let reads = 0;
  let emitConnections = () => {};
  const facade = {
    async readAuthoritySnapshot() {
      reads += 1;
      if (phase === "failed") throw new Error("temporary authority failure");
      if (phase === "held") return held.promise;
      return snapshot;
    },
    async connect() {},
    async disconnect() {},
    async completeOnboarding() { return receipt; },
    onConnectionsChanged(listener) { emitConnections = listener; return () => {}; },
    onCatalogChanged() { return () => {}; },
    onLoginPrompt() { return () => {}; },
  };
  const harness = createMountedUiHarness({
    catalog,
    initialSelection: Object.freeze({
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 3,
      generation: 1,
    }),
    nativeProtocol: true,
    nativeHost: true,
    providerFacade: facade,
  });
  context.after(() => harness.mounted.dispose());
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  phase = "failed";
  emitConnections(connections);
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const retry = harness.findPanel("codex-ai-connections-retry");
  phase = "held";
  const beforeRetry = reads;
  retry.listeners.get("click")();
  retry.listeners.get("click")();
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, beforeRetry + 1);
  harness.mounted.dispose();
  held.resolve(snapshot);
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
});
