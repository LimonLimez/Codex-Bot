(function exposeBotRuntimeUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodexBotRuntimeUi = api;
})(typeof window === "object" ? window : null, function createBotRuntimeUi() {
  "use strict";

  const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const MODEL_CONTROLS = typeof globalThis.CodexModelControls === "object"
    ? globalThis.CodexModelControls
    : typeof require === "function"
      ? require("./model-controls.js")
      : null;
  const POWER_CONTROL = typeof globalThis.CodexReasoningControl === "object"
    ? globalThis.CodexReasoningControl
    : typeof require === "function"
      ? require("./reasoning-control.js")
      : null;
  const OPTIONAL_MODEL_CATALOG = Object.freeze([
    Object.freeze({
      model: "claude-fable-5",
      label: "Claude Fable 5",
      efforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      provider: "cliproxy-anthropic",
      serviceTier: null,
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      catalogGeneration: 1,
      defaultReasoningEffort: "medium",
      isDefault: false,
    }),
    Object.freeze({
      model: "claude-opus-5",
      label: "Claude Opus 5",
      efforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      provider: "cliproxy-anthropic",
      serviceTier: null,
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      catalogGeneration: 1,
      defaultReasoningEffort: "medium",
      isDefault: false,
    }),
    Object.freeze({
      model: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      efforts: Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
      provider: "cliproxy-anthropic",
      serviceTier: null,
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      catalogGeneration: 1,
      defaultReasoningEffort: "medium",
      isDefault: false,
    }),
  ]);
  const MODEL_CATALOG = OPTIONAL_MODEL_CATALOG;
  const EFFORT_LABELS = Object.freeze({
    low: "Light",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
    "ultra-code": "Ultra Code",
  });

  function isUltraEffect(effort) {
    return effort === "ultra" || effort === "ultra-code";
  }

  function runtimePresentation(state) {
    if (state === "ready") {
      return Object.freeze({
        label: "Remote computer ready",
        controlsEnabled: true,
        retryVisible: false,
        tone: "ready",
      });
    }
    if (state === "provisioning") {
      return Object.freeze({
        label: "Starting remote computer…",
        controlsEnabled: false,
        retryVisible: false,
        tone: "pending",
      });
    }
    if (state === "reconnecting") {
      return Object.freeze({
        label: "Reconnecting to remote computer…",
        controlsEnabled: false,
        retryVisible: false,
        tone: "pending",
      });
    }
    return Object.freeze({
      label: "Remote computer unavailable",
      controlsEnabled: false,
      retryVisible: true,
      tone: "unavailable",
    });
  }

  function normalizeBot(value) {
    if (
      value == null ||
      typeof value !== "object" ||
      typeof value.botId !== "string" ||
      !BOT_ID.test(value.botId) ||
      typeof value.name !== "string" ||
      value.name.trim().length === 0 ||
      value.name.length > 160 ||
      value.runtime == null ||
      typeof value.runtime !== "object" ||
      typeof value.runtime.state !== "string"
    ) {
      throw new Error("Bot state is unavailable.");
    }
    return Object.freeze({
      botId: value.botId,
      name: value.name,
      runtime: Object.freeze({ state: value.runtime.state }),
    });
  }

  function normalizeModelCatalog(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "ready" || !Number.isSafeInteger(value.generation)
      || value.generation < 1 || !Array.isArray(value.models)) {
      throw new Error("Model catalog is unavailable.");
    }
    const official = [];
    const names = new Set();
    for (const raw of value.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(raw.id)
        || typeof raw.displayName !== "string" || raw.displayName.length < 1
        || raw.displayName.length > 160 || !Array.isArray(raw.supportedReasoningEfforts)
        || raw.supportedReasoningEfforts.length < 1 || names.has(raw.id)) {
        throw new Error("Model catalog is unavailable.");
      }
      const efforts = Object.freeze([...raw.supportedReasoningEfforts]);
      if (efforts.some((effort) => typeof effort !== "string"
        || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))) {
        throw new Error("Model catalog is unavailable.");
      }
      const rawServiceTiers = raw.serviceTiers ?? [];
      const defaultServiceTier = raw.defaultServiceTier ?? null;
      if (!Array.isArray(rawServiceTiers) || rawServiceTiers.length > 16
        || !(defaultServiceTier === null || (typeof defaultServiceTier === "string"
          && /^[a-z][a-z0-9_-]{0,31}$/.test(defaultServiceTier)))) {
        throw new Error("Model catalog is unavailable.");
      }
      const tierIds = new Set();
      const serviceTiers = Object.freeze(rawServiceTiers.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || typeof entry.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.id)
          || tierIds.has(entry.id) || typeof entry.name !== "string"
          || entry.name.trim().length < 1 || entry.name.length > 160
          || typeof entry.description !== "string" || entry.description.length > 1024) {
          throw new Error("Model catalog is unavailable.");
        }
        tierIds.add(entry.id);
        return Object.freeze({ id: entry.id, name: entry.name, description: entry.description });
      }));
      if (defaultServiceTier !== null && !tierIds.has(defaultServiceTier)) {
        throw new Error("Model catalog is unavailable.");
      }
      names.add(raw.id);
      official.push(Object.freeze({
        model: raw.id,
        label: raw.displayName,
        efforts,
        provider: "openai-codex",
        serviceTier: defaultServiceTier,
        defaultServiceTier,
        serviceTiers,
        catalogGeneration: value.generation,
        defaultReasoningEffort: raw.defaultReasoningEffort,
        isDefault: raw.isDefault === true,
      }));
    }
    return Object.freeze([
      ...official,
      ...OPTIONAL_MODEL_CATALOG.map((entry) => Object.freeze({
        ...entry,
        provider: "cliproxy-anthropic",
        serviceTier: null,
        defaultServiceTier: null,
        serviceTiers: Object.freeze([]),
        catalogGeneration: 1,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        isDefault: false,
      })),
    ]);
  }

  function normalizeModelSelection(value, botId, catalog = MODEL_CATALOG) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Model selection is unavailable.");
    }
    let descriptors;
    let prototype;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
      prototype = Object.getPrototypeOf(value);
    } catch {
      throw new Error("Model selection is unavailable.");
    }
    const fields = [
      "botId", "provider", "model", "reasoningEffort", "serviceTier",
      "catalogGeneration", "generation",
    ];
    if ((prototype !== Object.prototype && prototype !== null)
      || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
        || !fields.includes(key) || !("value" in descriptors[key]))
      || fields.some((field) => !descriptors[field])) {
      throw new Error("Model selection is unavailable.");
    }
    const read = (field) => descriptors[field].value;
    const model = catalog.find((entry) => entry.model === read("model"));
    if (read("botId") !== botId || !model || !model.efforts.includes(read("reasoningEffort"))
      || read("provider") !== model.provider
      || (read("serviceTier") !== null
        && !model.serviceTiers.some((entry) => entry.id === read("serviceTier")))
      || read("catalogGeneration") !== model.catalogGeneration
      || !(read("serviceTier") === null || (typeof read("serviceTier") === "string"
        && /^[a-z][a-z0-9_-]{0,31}$/.test(read("serviceTier"))))
      || !Number.isSafeInteger(read("catalogGeneration")) || read("catalogGeneration") < 0
      || !Number.isSafeInteger(read("generation")) || read("generation") < 0) {
      throw new Error("Model selection is unavailable.");
    }
    return Object.freeze(Object.fromEntries(fields.map((field) => [field, read(field)])));
  }

  function isPendingOfficialSelection(value, botId) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return (prototype === Object.prototype || prototype === null)
        && descriptors.botId && "value" in descriptors.botId
        && descriptors.botId.value === botId
        && descriptors.provider && "value" in descriptors.provider
        && descriptors.provider.value === "openai-codex";
    } catch { return false; }
  }

  function createBotUiController({
    facade,
    runtimeFacade = null,
    accountFacade = null,
    onSelectionChanged = () => {},
    onRuntimeEvent = () => {},
    onStateChanged = () => {},
  } = {}) {
    if (
      facade == null ||
      typeof facade.list !== "function" ||
      typeof facade.onChanged !== "function" ||
      typeof onSelectionChanged !== "function" ||
      typeof onRuntimeEvent !== "function" ||
      typeof onStateChanged !== "function"
    ) {
      throw new Error("Bot controls are unavailable.");
    }
    const bots = new Map();
    let activeBotId = null;
    let unsubscribe = null;
    let runtimeUnsubscribe = null;
    let catalogUnsubscribe = null;
    let disposed = false;
    let selectionEpoch = 0;
    let modelRequestEpoch = 0;
    let selectionFlight = null;
    let selectionPending = false;
    let modelSelection = null;
    let modelCatalog = OPTIONAL_MODEL_CATALOG;
    let catalogGeneration = -1;
    let catalogStatus = "loading";

    function activeBot() {
      return activeBotId == null ? null : bots.get(activeBotId) ?? null;
    }

    function snapshot() {
      const records = Object.freeze([...bots.values()]);
      const selected = activeBot();
      return Object.freeze({
        bots: records,
        activeBotId,
        activeBot: selected,
        runtime: runtimePresentation(selected?.runtime.state),
        modelSelection,
        modelCatalog,
        catalogGeneration,
        catalogStatus,
        selectionEpoch,
        selectionPending,
      });
    }

    function publish() {
      try {
        onStateChanged(snapshot());
      } catch {}
    }

    function applyBot(value) {
      if (disposed) throw new Error("Bot controls are unavailable.");
      const record = normalizeBot(value);
      bots.set(record.botId, record);
      if (activeBotId == null) void selectBot(record.botId).catch(() => {});
      else publish();
      return record;
    }

    function applyCatalog(value, { refreshSelection = true } = {}) {
      if (disposed) return false;
      const generation = value && typeof value === "object" && !Array.isArray(value)
        && Number.isSafeInteger(value.generation) && value.generation >= 0
        ? value.generation
        : null;
      if (generation !== null && generation < catalogGeneration) return false;

      let nextCatalog = OPTIONAL_MODEL_CATALOG;
      let nextStatus = "unavailable";
      if (value && typeof value === "object" && !Array.isArray(value)
        && value.status === "ready") {
        try {
          nextCatalog = normalizeModelCatalog(value);
          nextStatus = "ready";
        } catch {}
      } else if (value && typeof value === "object" && !Array.isArray(value)
        && typeof value.status === "string" && value.status.length > 0) {
        nextStatus = value.status;
      }

      if (generation !== null) catalogGeneration = generation;
      catalogStatus = nextStatus;
      modelCatalog = nextCatalog;
      let retainedSelection = null;
      if (modelSelection && activeBotId) {
        try {
          retainedSelection = normalizeModelSelection(modelSelection, activeBotId, nextCatalog);
        } catch {}
      }
      const selectionInvalidated = modelSelection !== null && retainedSelection === null;
      modelSelection = retainedSelection;
      publish();
      if (refreshSelection && nextStatus === "ready" && activeBotId
        && (selectionInvalidated || modelSelection === null)) {
        void selectBot(activeBotId, true).catch(() => {});
      }
      return true;
    }

    function selectBot(botId, force = false) {
      if (disposed || typeof botId !== "string" || !bots.has(botId)) {
        throw new Error("Bot selection is unavailable.");
      }
      if (activeBotId === botId && !force) {
        return selectionFlight?.botId === botId
          ? selectionFlight.promise
          : Promise.resolve(snapshot());
      }
      const previousBotId = activeBotId;
      const previousModelSelection = modelSelection;
      const epoch = ++selectionEpoch;
      try {
        onSelectionChanged(null);
      } catch {}
      activeBotId = botId;
      modelSelection = null;
      selectionPending = true;
      publish();
      const operation = (async () => {
        try {
          let selectedResult = null;
          if (runtimeFacade && typeof runtimeFacade.selectBot === "function") {
            selectedResult = await runtimeFacade.selectBot(botId);
          }
          const stored = runtimeFacade && typeof runtimeFacade.readModel === "function"
            ? await runtimeFacade.readModel(botId)
            : selectedResult;
          if (disposed || epoch !== selectionEpoch || activeBotId !== botId) {
            throw new Error("Bot selection changed.");
          }
          if (stored && typeof stored === "object") {
            try {
              modelSelection = normalizeModelSelection(stored, botId, modelCatalog);
            } catch (error) {
              if (catalogStatus === "ready" || !isPendingOfficialSelection(stored, botId)) throw error;
              modelSelection = null;
            }
          }
          selectionPending = false;
          try { onSelectionChanged(botId); } catch {}
          publish();
          return snapshot();
        } catch (error) {
          if (!disposed && epoch === selectionEpoch && activeBotId === botId) {
            activeBotId = previousBotId;
            modelSelection = previousModelSelection;
            selectionPending = false;
            try { onSelectionChanged(previousBotId); } catch {}
            publish();
          }
          throw error;
        }
      })();
      selectionFlight = { botId, epoch, promise: operation };
      const clear = () => {
        if (selectionFlight?.epoch === epoch) selectionFlight = null;
      };
      operation.then(clear, clear);
      return operation;
    }

    async function initialize() {
      if (disposed) throw new Error("Bot controls are unavailable.");
      if (accountFacade && typeof accountFacade.onCatalogChanged === "function") {
        const candidateCatalog = accountFacade.onCatalogChanged((value) => {
          applyCatalog(value);
        });
        catalogUnsubscribe = typeof candidateCatalog === "function" ? candidateCatalog : null;
      }
      if (accountFacade && typeof accountFacade.catalog === "function") {
        try { applyCatalog(await accountFacade.catalog(), { refreshSelection: false }); }
        catch { applyCatalog(null, { refreshSelection: false }); }
      }
      const records = await facade.list();
      if (!Array.isArray(records)) throw new Error("Bot controls are unavailable.");
      for (const value of records) {
        const record = normalizeBot(value);
        bots.set(record.botId, record);
      }
      if (bots.size > 0) {
        try { await selectBot(bots.keys().next().value); }
        catch { publish(); }
      }
      else publish();
      const candidate = facade.onChanged((value) => {
        try {
          applyBot(value);
        } catch {}
      });
      unsubscribe = typeof candidate === "function" ? candidate : null;
      if (runtimeFacade && typeof runtimeFacade.onEvent === "function") {
        const runtimeCandidate = runtimeFacade.onEvent((event) => {
          if (
            disposed ||
            !event ||
            typeof event !== "object" ||
            event.botId !== activeBotId ||
            !Number.isSafeInteger(event.generation) ||
            event.generation < 0
          ) return;
          try { onRuntimeEvent(event); } catch {}
        });
        runtimeUnsubscribe = typeof runtimeCandidate === "function" ? runtimeCandidate : null;
      }
      return snapshot();
    }

    async function createBot() {
      if (disposed || typeof facade.create !== "function") {
        throw new Error("Bot creation is unavailable.");
      }
      const record = normalizeBot(await facade.create());
      bots.set(record.botId, record);
      await selectBot(record.botId);
      return record;
    }

    async function connectProvider(provider) {
      if (disposed || !new Set(["codex", "claude", "kimi"]).has(provider)) {
        throw new Error("Provider connection is unavailable.");
      }
      if (provider === "codex") {
        if (!accountFacade || typeof accountFacade.login !== "function") {
          throw new Error("Provider connection is unavailable.");
        }
        return accountFacade.login("browser");
      }
      if (runtimeFacade == null || typeof runtimeFacade.connectProvider !== "function") {
        throw new Error("Provider connection is unavailable.");
      }
      return runtimeFacade.connectProvider(provider);
    }

    async function renameActive(name) {
      const bot = activeBot();
      const nextName = typeof name === "string" ? name.trim() : "";
      if (
        disposed ||
        !bot ||
        typeof facade.rename !== "function" ||
        nextName.length < 1 ||
        nextName.length > 160
      ) {
        throw new Error("Bot rename is unavailable.");
      }
      return applyBot(await facade.rename(bot.botId, nextName));
    }

    async function retryActive() {
      const bot = activeBot();
      if (
        disposed ||
        !bot ||
        !runtimePresentation(bot.runtime.state).retryVisible ||
        typeof facade.retryRuntime !== "function"
      ) {
        throw new Error("Remote computer retry is unavailable.");
      }
      return applyBot(await facade.retryRuntime(bot.botId));
    }

    async function selectModel(model, reasoningEffort, requestedServiceTier) {
      const bot = activeBot();
      const catalog = modelCatalog.find((entry) => entry.model === model);
      const serviceTier = requestedServiceTier === undefined
        ? catalog?.defaultServiceTier ?? null
        : requestedServiceTier;
      if (
        disposed ||
        !bot ||
        !catalog ||
        !catalog.efforts.includes(reasoningEffort) ||
        !(serviceTier === null
          || catalog.serviceTiers.some((entry) => entry.id
            === serviceTier)) ||
        runtimeFacade == null ||
        typeof runtimeFacade.selectModel !== "function"
      ) {
        throw new Error("Model selection is unavailable.");
      }
      const epoch = selectionEpoch;
      const requestEpoch = ++modelRequestEpoch;
      const selection = Object.freeze({
        botId: bot.botId,
        model,
        reasoningEffort,
        serviceTier,
      });
      const result = await runtimeFacade.selectModel(selection);
      if (disposed || epoch !== selectionEpoch || requestEpoch !== modelRequestEpoch
        || activeBotId !== bot.botId) {
        throw new Error("Model selection changed.");
      }
      if (result && typeof result === "object") {
        modelSelection = normalizeModelSelection(result, bot.botId, modelCatalog);
        publish();
      }
      return result;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (unsubscribe) unsubscribe();
      if (runtimeUnsubscribe) runtimeUnsubscribe();
      if (catalogUnsubscribe) catalogUnsubscribe();
      unsubscribe = null;
      runtimeUnsubscribe = null;
      catalogUnsubscribe = null;
      bots.clear();
      activeBotId = null;
      modelSelection = null;
      selectionPending = false;
    }

    return Object.freeze({
      applyBot,
      connectProvider,
      createBot,
      dispose,
      initialize,
      renameActive,
      retryActive,
      selectBot,
      selectModel,
      snapshot,
    });
  }

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function findUiMounts(documentRef) {
    if (!documentRef || typeof documentRef.querySelector !== "function") {
      return Object.freeze({ sidebarHost: null, composerHost: null });
    }
    const sidebarSelectors = [
      "[data-codex-bot-sidebar-host]",
      '[data-testid*="sidebar" i]',
      '[aria-label*="sidebar" i]',
      "nav[aria-label]",
      "aside[aria-label]",
      "nav",
      "aside",
    ];
    let sidebarHost = null;
    for (const selector of sidebarSelectors) {
      const candidate = documentRef.querySelector(selector);
      if (candidate && candidate.id !== "codex-bot-controls") {
        sidebarHost = candidate;
        break;
      }
    }

    let composerHost = documentRef.querySelector("[data-codex-bot-composer-host]");
    if (!composerHost && typeof documentRef.querySelectorAll === "function") {
      const inputs = documentRef.querySelectorAll(
        'textarea,[contenteditable="true"],input[placeholder]',
      );
      for (const input of inputs) {
        const placeholder = input?.getAttribute?.("placeholder") || input?.placeholder || "";
        const label = input?.getAttribute?.("aria-label") || "";
        if (!/ask anything|drop a file|message|prompt/i.test(`${placeholder} ${label}`)) continue;
        composerHost = input.closest?.(
          '[data-testid*="composer" i],form,[role="form"],[class*="composer" i]',
        ) || input.parentElement || null;
        if (composerHost) break;
      }
    }
    return Object.freeze({ sidebarHost, composerHost });
  }

  function createReasoningView(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== "function") {
      throw new Error("Power control is unavailable.");
    }
    const control = element(documentRef, "div", "codex-power-control");
    const endpoints = element(documentRef, "div", "codex-power-endpoints");
    const firstLabel = element(documentRef, "span", "codex-power-endpoint is-first");
    const lastLabel = element(documentRef, "span", "codex-power-endpoint is-last");
    endpoints.append(firstLabel, lastLabel);
    endpoints.hidden = true;
    const track = element(documentRef, "div", "codex-power-track");
    track.setAttribute("aria-hidden", "true");
    const fill = element(documentRef, "div", "codex-power-fill");
    const ultraFill = element(documentRef, "div", "codex-power-ultra-field");
    const particles = element(documentRef, "div", "codex-power-particles");
    for (let index = 0; index < 14; index += 1) {
      particles.append(element(documentRef, "i", "codex-power-particle"));
    }
    const ticks = element(documentRef, "div", "codex-power-ticks");
    track.append(fill, ultraFill, particles, ticks);
    const thumbRail = element(documentRef, "div", "codex-power-thumb-rail");
    thumbRail.setAttribute("aria-hidden", "true");
    const thumb = element(documentRef, "i", "codex-power-thumb");
    const burst = element(documentRef, "span", "codex-power-burst");
    for (let index = 0; index < 16; index += 1) burst.append(element(documentRef, "i"));
    thumbRail.append(thumb, burst);
    const input = element(documentRef, "input", "codex-power-input");
    input.type = "range";
    input.min = "0";
    input.step = "1";
    input.value = "1";
    input.setAttribute("aria-label", "Power");
    input.setAttribute("aria-describedby", "codex-power-instructions");
    const label = element(documentRef, "output", "codex-power-label", "Standard");
    label.setAttribute("aria-live", "polite");
    const instructions = element(
      documentRef,
      "span",
      "codex-power-instructions",
      "Use arrow keys, Home, End, or the scroll wheel to change Power.",
    );
    instructions.id = "codex-power-instructions";
    const warning = element(
      documentRef,
      "div",
      "codex-power-warning",
      "Consumes usage limits faster",
    );
    warning.setAttribute("role", "status");
    warning.setAttribute("aria-live", "polite");
    warning.hidden = true;
    control.append(endpoints, track, thumbRail, input);
    return Object.freeze({
      burst,
      control,
      endpoints,
      fill,
      firstLabel,
      input,
      instructions,
      label,
      lastLabel,
      particles,
      thumb,
      ticks,
      track,
      ultraFill,
      warning,
    });
  }

  function reasoningCenter(index, count) {
    const percent = count <= 1 ? 50 : (index / (count - 1)) * 100;
    const offset = Math.round((13 - (percent / 50) * 13) * 10) / 10;
    return `calc(${percent}% + ${offset}px)`;
  }

  function updateReasoningView(view, stops, selectedIndex, {
    enteredUltra = false,
    endpointLabelsVisible = false,
  } = {}) {
    if (!view?.control || !view?.ticks || !view?.input) {
      throw new Error("Power control is unavailable.");
    }
    const options = Array.isArray(stops) ? stops.filter((stop) => stop && typeof stop === "object"
      && typeof stop.label === "string") : [];
    if (options.length < 1) throw new Error("Power options are unavailable.");
    const index = Math.max(0, Math.min(options.length - 1, Math.round(Number(selectedIndex) || 0)));
    const tickNodes = options.map((_stop, tickIndex) => {
      const tick = element(view.input.ownerDocument || {
        createElement: (tag) => view.input.constructor ? new view.input.constructor(tag) : null,
      }, "i", "codex-power-tick");
      tick.classList.toggle("is-selected", tickIndex === index);
      tick.style.left = reasoningCenter(tickIndex, options.length);
      return tick;
    });
    view.ticks.replaceChildren(...tickNodes);
    const position = reasoningCenter(index, options.length);
    view.control.style.setProperty("--codex-power-thumb-position", position);
    view.control.style.setProperty("--codex-power-fill-position", position);
    view.input.max = String(options.length - 1);
    view.input.value = String(index);
    const stop = options[index];
    view.input.setAttribute("aria-valuetext", stop.label);
    view.label.textContent = stop.label;
    view.firstLabel.textContent = options[0].label;
    view.lastLabel.textContent = options.at(-1).label;
    view.endpoints.hidden = !endpointLabelsVisible;
    view.control.classList.toggle("is-fast", stop.effect === "fast");
    view.control.classList.toggle("is-max", stop.effect === "max");
    view.control.classList.toggle("is-ultra", stop.effect === "ultra");
    view.control.classList.toggle("is-ultra-code", stop.effort === "ultra-code");
    view.control.classList.toggle("is-ultra-entering", stop.effect === "ultra" && enteredUltra);
    view.warning.hidden = stop.effect !== "ultra" || !enteredUltra;
    return Object.freeze({ stop, index });
  }

  function mount({ windowRef = window, documentRef = document } = {}) {
    if (!documentRef?.body || documentRef.getElementById("codex-bot-controls")) return null;
    const facade = windowRef.codexBots;
    if (!facade || !MODEL_CONTROLS || typeof POWER_CONTROL?.PowerControlState !== "function") return null;
    const panel = element(documentRef, "aside", "codex-bot-controls");
    panel.id = "codex-bot-controls";
    panel.dataset.codexMountState = "pending";
    panel.setAttribute("aria-label", "OpenBot and remote computer controls");
    const header = element(documentRef, "div", "codex-bot-header");
    const botSelect = element(documentRef, "select", "codex-bot-select");
    botSelect.setAttribute("aria-label", "Active bot");
    const newButton = element(documentRef, "button", "codex-bot-new", "New Bot");
    newButton.type = "button";
    header.append(botSelect, newButton);
    const renameRow = element(documentRef, "div", "codex-bot-rename-row");
    const rename = element(documentRef, "input", "codex-bot-rename");
    rename.maxLength = 160;
    rename.setAttribute("aria-label", "Bot name");
    const renameButton = element(documentRef, "button", "codex-bot-rename-action", "Rename");
    renameButton.type = "button";
    renameRow.append(rename, renameButton);
    const statusRow = element(documentRef, "div", "codex-runtime-row");
    const status = element(documentRef, "span", "codex-runtime-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const retry = element(documentRef, "button", "codex-runtime-retry", "Retry");
    retry.type = "button";
    statusRow.append(status, retry);
    const modelDock = element(documentRef, "section", "codex-model-dock");
    modelDock.id = "codex-model-dock";
    modelDock.dataset.codexMountState = "pending";
    modelDock.setAttribute("aria-label", "OpenBot Power controls");
    const providerRow = element(documentRef, "div", "codex-provider-row");
    const providerSelect = element(documentRef, "select", "codex-provider-select");
    providerSelect.setAttribute("aria-label", "Inference provider");
    for (const [value, label] of [["codex", "OpenAI Codex"], ["claude", "Claude"], ["kimi", "Kimi"]]) {
      const option = element(documentRef, "option", "", label);
      option.value = value;
      providerSelect.append(option);
    }
    const connectProvider = element(documentRef, "button", "codex-provider-connect", "Connect account");
    connectProvider.type = "button";
    providerRow.append(providerSelect, connectProvider);
    const reasoningView = createReasoningView(documentRef);
    const reasoning = reasoningView.input;
    const powerShell = element(documentRef, "div", "codex-power-shell");
    const powerTitle = element(documentRef, "span", "codex-power-title", "Power");
    const advancedToggle = element(documentRef, "button", "codex-power-advanced-toggle", "Advanced");
    advancedToggle.type = "button";
    advancedToggle.setAttribute("aria-expanded", "false");
    powerShell.append(powerTitle, reasoningView.control, reasoningView.label, advancedToggle);
    const advanced = element(documentRef, "div", "codex-power-advanced");
    advanced.hidden = true;
    const advancedModelLabel = element(documentRef, "label", "codex-power-advanced-field");
    advancedModelLabel.append(element(documentRef, "span", "", "Model"));
    const advancedModel = element(documentRef, "select", "codex-power-model-select");
    advancedModel.setAttribute("aria-label", "Model");
    advancedModelLabel.append(advancedModel);
    const advancedEffortLabel = element(documentRef, "label", "codex-power-advanced-field");
    advancedEffortLabel.append(element(documentRef, "span", "", "Effort"));
    const advancedEffort = element(documentRef, "select", "codex-power-effort-select");
    advancedEffort.setAttribute("aria-label", "Effort");
    advancedEffortLabel.append(advancedEffort);
    const advancedSpeedLabel = element(documentRef, "label", "codex-power-advanced-field");
    advancedSpeedLabel.append(element(documentRef, "span", "", "Speed"));
    const advancedSpeed = element(documentRef, "select", "codex-power-speed-select");
    advancedSpeed.setAttribute("aria-label", "Speed");
    advancedSpeedLabel.append(advancedSpeed);
    advanced.append(advancedModelLabel, advancedEffortLabel, advancedSpeedLabel);
    panel.append(header, renameRow, providerRow, statusRow);
    modelDock.append(powerShell, advanced, reasoningView.warning, reasoningView.instructions);
    documentRef.body.append(panel, modelDock);

    function attachToProductHosts() {
      const { sidebarHost, composerHost } = findUiMounts(documentRef);
      if (sidebarHost) {
        if (panel.parentElement !== sidebarHost) sidebarHost.append(panel);
        panel.dataset.codexMountState = "mounted";
      } else {
        panel.dataset.codexMountState = "pending";
      }
      if (composerHost) {
        if (modelDock.parentElement !== composerHost) {
          if (typeof composerHost.prepend === "function") composerHost.prepend(modelDock);
          else composerHost.insertBefore?.(modelDock, composerHost.firstChild || null);
        }
        modelDock.dataset.codexMountState = "mounted";
      } else {
        modelDock.dataset.codexMountState = "pending";
      }
    }
    attachToProductHosts();
    const MountObserver = windowRef.MutationObserver;
    const mountObserver = typeof MountObserver === "function"
      ? new MountObserver(() => attachToProductHosts())
      : null;
    mountObserver?.observe(documentRef.body, { childList: true, subtree: true });

    let lastSnapshot = null;
    let lastEffect = null;
    let warningTimer = null;
    let holdTimer = null;
    const powerState = new POWER_CONTROL.PowerControlState([], null, { ownerKey: "unselected" });
    let controller;

    function paintPower(snapshot, { enteredUltra = snapshot.enteredUltra } = {}) {
      if (!snapshot.stops.length) return;
      updateReasoningView(reasoningView, snapshot.stops, snapshot.previewIndex, {
        enteredUltra,
        endpointLabelsVisible: snapshot.endpointLabelsVisible,
      });
      reasoning.disabled = snapshot.disabled;
      reasoningView.control.classList.toggle("is-disabled", snapshot.disabled);
      modelDock.classList.toggle("is-fast", snapshot.effect === "fast");
      modelDock.classList.toggle("is-max", snapshot.effect === "max");
      modelDock.classList.toggle("is-ultra", snapshot.effect === "ultra");
      modelDock.classList.toggle("is-ultra-code", snapshot.selection?.effort === "ultra-code");
      if (warningTimer != null) {
        (windowRef.clearTimeout || clearTimeout)(warningTimer);
        warningTimer = null;
      }
      if (enteredUltra) {
        warningTimer = (windowRef.setTimeout || setTimeout)(() => {
          reasoningView.control.classList.remove("is-ultra-entering");
          reasoningView.warning.hidden = true;
          warningTimer = null;
        }, 2000);
      }
      lastEffect = snapshot.effect;
    }

    function populateAdvanced(next, preferredModel) {
      const modelId = preferredModel
        ?? next.modelSelection?.model
        ?? powerState.snapshot().selection?.model
        ?? next.modelCatalog[0]?.model;
      const options = MODEL_CONTROLS.buildAdvancedOptions(next.modelCatalog, modelId);
      advancedModel.replaceChildren(...options.models.map((entry) => {
        const option = element(documentRef, "option", "", entry.label);
        option.value = entry.model;
        option.selected = entry.model === modelId;
        return option;
      }));
      if (modelId) advancedModel.value = modelId;
      const catalog = next.modelCatalog.find((entry) => entry.model === modelId);
      const effort = next.modelSelection?.model === modelId
        ? next.modelSelection.reasoningEffort
        : catalog?.defaultReasoningEffort ?? options.efforts[0]?.effort;
      advancedEffort.replaceChildren(...options.efforts.map((entry) => {
        const option = element(documentRef, "option", "", entry.label);
        option.value = entry.effort;
        option.selected = entry.effort === effort;
        return option;
      }));
      if (effort) advancedEffort.value = effort;
      const serviceTier = next.modelSelection?.model === modelId
        ? next.modelSelection.serviceTier
        : catalog?.defaultServiceTier ?? null;
      advancedSpeed.replaceChildren(...options.speeds.map((entry) => {
        const option = element(documentRef, "option", "", entry.label);
        option.value = entry.serviceTier ?? "__standard__";
        option.title = entry.description;
        option.selected = entry.serviceTier === serviceTier;
        return option;
      }));
      advancedSpeed.value = serviceTier ?? "__standard__";
    }

    function render(next) {
      lastSnapshot = next;
      const selected = next.activeBot;
      botSelect.replaceChildren();
      for (const record of next.bots) {
        const option = element(documentRef, "option", "", record.name);
        option.value = record.botId;
        option.selected = record.botId === next.activeBotId;
        botSelect.append(option);
      }
      rename.value = selected?.name ?? "";
      status.textContent = next.runtime.label;
      status.dataset.tone = next.runtime.tone;
      retry.hidden = !next.runtime.retryVisible;
      retry.disabled = !next.runtime.retryVisible;
      const enabled = selected != null && !next.selectionPending && next.modelCatalog.length > 0;
      const selectedTuple = next.modelSelection ? {
        provider: next.modelSelection.provider,
        model: next.modelSelection.model,
        effort: next.modelSelection.reasoningEffort,
        serviceTier: next.modelSelection.serviceTier,
        catalogGeneration: next.modelSelection.catalogGeneration,
      } : null;
      const stops = MODEL_CONTROLS.buildPowerStops(next.modelCatalog, selectedTuple);
      const selectedIndex = selectedTuple ? MODEL_CONTROLS.closestPowerStop(stops, selectedTuple) : 0;
      const ownerKey = `${next.activeBotId ?? "none"}:${next.modelSelection?.generation ?? "pending"}:${stops[0]?.catalogGeneration ?? 0}`;
      let power = powerState.setStops(stops, selectedIndex, { ownerKey });
      power = powerState.setDisabled(!enabled);
      const enteredUltra = power.effect === "ultra" && lastEffect !== "ultra";
      if (power.stops.length) paintPower(power, { enteredUltra });
      advancedToggle.disabled = !enabled;
      advancedModel.disabled = !enabled;
      advancedEffort.disabled = !enabled;
      advancedSpeed.disabled = !enabled;
      populateAdvanced(next);
    }

    controller = createBotUiController({
      facade,
      runtimeFacade: windowRef.codexRuntime,
      accountFacade: windowRef.codexAccount,
      onStateChanged: render,
      onSelectionChanged(botId) {
        panel.dataset.activeBotId = botId ?? "";
        windowRef.dispatchEvent?.(new windowRef.CustomEvent("codex-bot-selection-changing"));
      },
      onRuntimeEvent(event) {
        windowRef.dispatchEvent?.(new windowRef.CustomEvent("codex-bot-runtime-event", { detail: event }));
      },
    });
    botSelect.addEventListener("change", () => controller.selectBot(botSelect.value));
    newButton.addEventListener("click", () => void controller.createBot().catch(() => {}));
    const submitRename = () => void controller.renameActive(rename.value).catch(() => render(lastSnapshot));
    renameButton.addEventListener("click", submitRename);
    rename.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitRename();
      }
    });
    retry.addEventListener("click", () => void controller.retryActive().catch(() => {}));
    connectProvider.addEventListener("click", () => {
      connectProvider.disabled = true;
      void controller.connectProvider(providerSelect.value).catch(() => {}).finally(() => {
        connectProvider.disabled = false;
      });
    });

    const commitPower = (snapshot) => {
      paintPower(snapshot);
      if (!snapshot.changed || !snapshot.selection) return;
      const selection = snapshot.selection;
      void controller.selectModel(
        selection.model,
        selection.effort,
        selection.serviceTier,
      ).catch(() => render(controller.snapshot()));
    };
    reasoning.addEventListener("pointerdown", () => {
      if (holdTimer != null) (windowRef.clearTimeout || clearTimeout)(holdTimer);
      paintPower(powerState.pointerDown(Number(reasoning.value), Date.now()));
      holdTimer = (windowRef.setTimeout || setTimeout)(() => {
        paintPower(powerState.tick(Date.now() + 450));
        holdTimer = null;
      }, 450);
    });
    reasoning.addEventListener("input", () => {
      const snapshot = powerState.snapshot().pointerActive
        ? powerState.pointerMove(Number(reasoning.value))
        : powerState.pointerDown(Number(reasoning.value), Date.now());
      paintPower(snapshot);
    });
    reasoning.addEventListener("change", () => {
      commitPower(powerState.pointerUp(Number(reasoning.value)));
    });
    reasoning.addEventListener("pointerup", () => {
      if (holdTimer != null) {
        (windowRef.clearTimeout || clearTimeout)(holdTimer);
        holdTimer = null;
      }
      commitPower(powerState.pointerUp(Number(reasoning.value)));
    });
    reasoning.addEventListener("pointercancel", () => paintPower(powerState.pointerCancel()));
    reasoning.addEventListener("wheel", (event) => {
      event.preventDefault?.();
      commitPower(powerState.wheel(Number(event.deltaY)));
    }, { passive: false });
    reasoning.addEventListener("keydown", (event) => {
      if (!new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]).has(event.key)) return;
      event.preventDefault?.();
      commitPower(powerState.keyDown(event.key));
    });
    reasoning.addEventListener("focus", () => paintPower(powerState.setFocus(true)));
    reasoning.addEventListener("blur", () => paintPower(powerState.setFocus(false)));
    reasoning.addEventListener("mouseenter", () => paintPower(powerState.setHover(true)));
    reasoning.addEventListener("mouseleave", () => paintPower(powerState.setHover(false)));

    advancedToggle.addEventListener("click", () => {
      advanced.hidden = !advanced.hidden;
      advancedToggle.setAttribute("aria-expanded", String(!advanced.hidden));
      if (!advanced.hidden && lastSnapshot) populateAdvanced(lastSnapshot);
    });
    const submitAdvanced = () => {
      if (!lastSnapshot) return;
      const selection = MODEL_CONTROLS.resolveAdvancedSelection(lastSnapshot.modelCatalog, {
        model: advancedModel.value,
        effort: advancedEffort.value,
        serviceTier: advancedSpeed.value === "__standard__" ? null : advancedSpeed.value,
      });
      if (!selection) return;
      void controller.selectModel(selection.model, selection.effort, selection.serviceTier)
        .catch(() => render(controller.snapshot()));
    };
    advancedModel.addEventListener("change", () => {
      if (!lastSnapshot) return;
      populateAdvanced(lastSnapshot, advancedModel.value);
      submitAdvanced();
    });
    advancedEffort.addEventListener("change", submitAdvanced);
    advancedSpeed.addEventListener("change", submitAdvanced);
    void controller.initialize().catch(() => {
      status.textContent = "Remote computer unavailable";
      reasoning.disabled = true;
      advancedToggle.disabled = true;
      advancedModel.disabled = true;
      advancedEffort.disabled = true;
      advancedSpeed.disabled = true;
    });
    return Object.freeze({
      controller,
      modelDock,
      panel,
      dispose() {
        mountObserver?.disconnect();
        if (holdTimer != null) (windowRef.clearTimeout || clearTimeout)(holdTimer);
        if (warningTimer != null) (windowRef.clearTimeout || clearTimeout)(warningTimer);
        controller.dispose();
        panel.remove?.();
        modelDock.remove?.();
      },
    });
  }

  if (typeof window === "object" && typeof document === "object") {
    window.addEventListener("DOMContentLoaded", () => mount(), { once: true });
  }

  return Object.freeze({
    EFFORT_LABELS,
    MODEL_CATALOG,
    createReasoningView,
    createBotUiController,
    findUiMounts,
    mount,
    runtimePresentation,
    updateReasoningView,
  });
});
