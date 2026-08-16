(function exposeOpenBotStandaloneShell(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenBotStandaloneShell = api;
})(typeof window === "object" ? window : null, function createOpenBotStandaloneShellApi() {
  "use strict";

  const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function vendorMountsPresent(documentRef) {
    if (!documentRef || typeof documentRef.querySelector !== "function") return false;
    const selectors = [
      "[data-codex-bot-sidebar-host]",
      "[data-codex-bot-composer-host]",
      '[data-testid*="sidebar" i]',
      '[aria-label*="sidebar" i]',
      "nav[aria-label]",
      "aside[aria-label]",
      'form [placeholder*="message" i]',
      'form [placeholder*="prompt" i]',
    ];
    for (const selector of selectors) {
      const candidate = documentRef.querySelector(selector);
      const openBotOwned = candidate
        && (candidate.id === "openbot-standalone-shell"
          || candidate.id === "codex-bot-controls"
          || candidate.closest?.("#openbot-standalone-shell") != null
          || candidate.closest?.("#codex-bot-controls") != null);
      if (candidate && !openBotOwned) return true;
    }
    return false;
  }

  async function cursorStatus(windowRef) {
    const desktop = windowRef?.desktop;
    let value;
    if (desktop?.cursorAccount && typeof desktop.cursorAccount.getStatus === "function") {
      value = await desktop.cursorAccount.getStatus();
    } else if (typeof desktop?.getCursorAuthStatus === "function") {
      value = await desktop.getCursorAuthStatus();
    } else return "unknown";
    const kind = value?.kind ?? value?.status;
    if (kind === "logged-out" || kind === "signed-out") return "logged-out";
    if (kind === "logged-in" || kind === "ready") return "logged-in";
    return "unknown";
  }

  function healthyAccount(account, catalog) {
    return (account?.status === "ready" || account?.status === "signed-out")
      && catalog?.status === "ready"
      && Array.isArray(catalog.models) && catalog.models.length > 0;
  }

  function buildShell(documentRef, windowRef) {
    const shell = element(documentRef, "div", "openbot-standalone-shell");
    shell.setAttribute("id", "openbot-standalone-shell");
    shell.dataset.openbotHost = "standalone";

    const sidebar = element(documentRef, "aside", "openbot-standalone-sidebar");
    sidebar.setAttribute("data-codex-bot-sidebar-host", "");
    sidebar.setAttribute("aria-label", "OpenBot bots");
    const brand = element(documentRef, "div", "openbot-standalone-brand");
    brand.append(
      element(documentRef, "span", "openbot-standalone-brand-mark", "O"),
      element(documentRef, "strong", "", "OpenBot"),
    );
    const lane = element(documentRef, "p", "openbot-standalone-lane", "Direct Codex · Cursor optional");
    sidebar.append(brand, lane);

    const workspace = element(documentRef, "main", "openbot-standalone-workspace");
    const header = element(documentRef, "header", "openbot-standalone-header");
    const title = element(documentRef, "div", "");
    title.append(
      element(documentRef, "strong", "", "OpenBot"),
      element(documentRef, "span", "", "Free Local Desktop"),
    );
    const status = element(documentRef, "span", "openbot-standalone-status", "OpenAI Codex");
    header.append(title, status);
    const transcript = element(documentRef, "section", "openbot-standalone-transcript");
    transcript.setAttribute("aria-label", "Conversation transcript");
    transcript.setAttribute("aria-live", "polite");
    const welcome = element(documentRef, "div", "openbot-standalone-welcome");
    welcome.append(
      element(documentRef, "span", "openbot-standalone-orb", "O"),
      element(documentRef, "h1", "", "What should OpenBot do?"),
      element(documentRef, "p", "", "Chat through your Codex account. Choose Free Local Desktop when a task needs Mac apps or files."),
    );
    transcript.append(welcome);
    const queueSurface = element(documentRef, "section", "openbot-standalone-queue");
    queueSurface.hidden = true;
    queueSurface.setAttribute("aria-label", "Queued follow-ups");
    const composer = element(documentRef, "form", "openbot-standalone-composer");
    composer.setAttribute("data-codex-bot-composer-host", "");
    const input = element(documentRef, "textarea", "openbot-standalone-input");
    input.rows = 2;
    input.placeholder = "Message OpenBot";
    input.setAttribute("aria-label", "Message OpenBot");
    const send = element(documentRef, "button", "openbot-standalone-send", "↑");
    send.type = "submit";
    send.setAttribute("aria-label", "Send message");
    const stop = element(documentRef, "button", "openbot-standalone-stop", "Stop");
    stop.type = "button";
    stop.disabled = true;
    stop.hidden = true;
    stop.setAttribute("aria-label", "Stop response");
    composer.append(input, stop, send);
    const desktopHost = element(documentRef, "section", "openbot-local-desktop-host");
    desktopHost.setAttribute("aria-label", "Free Local Desktop live view");
    workspace.append(header, desktopHost, transcript, queueSurface, composer);
    shell.append(sidebar, workspace);

    const conversations = windowRef?.openbotConversations;
    const bots = windowRef?.codexBots;
    let desktopView = null;
    try {
      desktopView = windowRef?.OpenBotLocalDesktopView?.createLocalDesktopView?.({
        container: desktopHost,
        documentRef,
        windowRef,
      }) ?? null;
    } catch { desktopHost.hidden = true; }
    const botStates = new Map();
    let disposed = false;
    let knownBots = [];
    let selectedBotId = null;
    let selectionEpoch = 0;
    let nextQueueId = 1;

    function stateFor(botId) {
      let state = botStates.get(botId);
      if (!state) {
        state = {
          botId,
          conversationId: null,
          conversationFlight: null,
          hydrated: false,
          hydrationFlight: null,
          hydrationData: null,
          hydrationReadGeneration: 0,
          messages: [],
          active: null,
          sendPending: false,
          earlyEvents: [],
          queue: [],
          status: "Direct Codex ready",
        };
        botStates.set(botId, state);
      }
      return state;
    }

    function activeBotId() {
      return selectedBotId;
    }

    function message(role, text, target = transcript) {
      const row = element(documentRef, "article", `openbot-standalone-message is-${role}`);
      row.append(
        element(documentRef, "strong", "", role === "user" ? "You" : "OpenBot"),
        element(documentRef, "p", "", text),
      );
      target.append(row);
      return row;
    }

    function queueBytes(state, replacementId = null, replacementText = null) {
      return state.queue.reduce((total, item) => {
        const value = item.id === replacementId ? replacementText : item.text;
        try { return total + new TextEncoder().encode(value).byteLength; }
        catch { return Number.POSITIVE_INFINITY; }
      }, 0);
    }

    function renderQueue(state) {
      queueSurface.replaceChildren?.();
      const items = state?.queue ?? [];
      queueSurface.hidden = items.length === 0;
      if (items.length === 0) return;
      queueSurface.append(element(documentRef, "strong", "openbot-standalone-queue-title", "Queued follow-ups"));
      for (const item of items) {
        const row = element(documentRef, "div", "openbot-standalone-queue-item");
        const editor = element(documentRef, "textarea", "openbot-standalone-queue-editor");
        editor.value = item.text;
        editor.rows = 1;
        editor.setAttribute("aria-label", "Edit queued follow-up");
        const remove = element(documentRef, "button", "openbot-standalone-queue-remove", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove queued follow-up");
        editor.addEventListener?.("input", () => {
          const candidate = typeof editor.value === "string" ? editor.value : "";
          let bytes;
          try { bytes = new TextEncoder().encode(candidate).byteLength; } catch { bytes = Number.POSITIVE_INFINITY; }
          if (!candidate.trim() || candidate.includes("\0") || bytes > 64 * 1024
            || queueBytes(state, item.id, candidate) > 64 * 1024) {
            editor.value = item.text;
            if (selectedBotId === state.botId) status.textContent = "Queued follow-up is too large";
            return;
          }
          item.text = candidate;
          if (selectedBotId === state.botId) status.textContent = `${state.queue.length} follow-up${state.queue.length === 1 ? "" : "s"} queued`;
        });
        remove.addEventListener?.("click", (event) => {
          event?.preventDefault?.();
          const index = state.queue.findIndex((entry) => entry.id === item.id);
          if (index >= 0) state.queue.splice(index, 1);
          if (selectedBotId === state.botId) {
            renderQueue(state);
            status.textContent = state.queue.length > 0
              ? `${state.queue.length} follow-up${state.queue.length === 1 ? "" : "s"} queued`
              : state.active ? "OpenBot is thinking…" : "Direct Codex ready";
          }
        });
        row.append(editor, remove);
        queueSurface.append(row);
      }
    }

    function renderCurrent() {
      transcript.replaceChildren?.();
      const state = selectedBotId ? stateFor(selectedBotId) : null;
      if (!state || state.messages.length === 0) transcript.append(welcome);
      else for (const entry of state.messages) message(entry.role, entry.text ?? "");
      renderQueue(state);
      stop.disabled = !state?.active;
      stop.hidden = !state?.active;
      send.disabled = Boolean(state?.sendPending);
      status.textContent = state?.active ? "OpenBot is thinking…"
        : state?.status ?? "Create or select a bot first";
    }

    function selectBot(botId) {
      selectionEpoch += 1;
      selectedBotId = typeof botId === "string" && BOT_ID.test(botId) ? botId : null;
      desktopView?.selectBot?.(selectedBotId);
      renderCurrent();
      if (selectedBotId) void hydrateBot(selectedBotId, selectionEpoch);
    }

    function selectionFromPanel() {
      const panel = documentRef.getElementById?.("codex-bot-controls");
      if (panel) {
        const value = panel.dataset?.activeBotId;
        return typeof value === "string" && BOT_ID.test(value) ? value : null;
      }
      const first = knownBots.find((bot) => typeof bot?.botId === "string" && BOT_ID.test(bot.botId));
      return first?.botId ?? null;
    }

    function onSelectionChanging() {
      if (!disposed) selectBot(selectionFromPanel());
    }
    windowRef.addEventListener?.("codex-bot-selection-changing", onSelectionChanging);

    async function ensureConversation(botId) {
      const state = stateFor(botId);
      if (state.conversationId) return state.conversationId;
      if (!state.conversationFlight) {
        state.conversationFlight = Promise.resolve()
          .then(() => conversations.list(botId))
          .then(async (listed) => listed[0] ?? conversations.create({ botId }))
          .then((conversation) => {
            if (!conversation || conversation.botId !== botId
              || typeof conversation.conversationId !== "string") throw new Error("invalid conversation");
            state.conversationId = conversation.conversationId;
            return state.conversationId;
          })
          .finally(() => { state.conversationFlight = null; });
      }
      return state.conversationFlight;
    }

    function hydrationRead(state, botId, conversationId, force) {
      if (!force && state.hydrationData) {
        return Promise.resolve({
          generation: state.hydrationReadGeneration,
          messages: state.hydrationData,
        });
      }
      if (!force && state.hydrationFlight) return state.hydrationFlight.promise;
      const generation = state.hydrationReadGeneration + 1;
      state.hydrationReadGeneration = generation;
      const flight = {
        generation,
        promise: Promise.resolve()
          .then(() => conversations.read({ botId, conversationId }))
          .then((record) => {
            if (!record || !Array.isArray(record.messages)) throw new Error("invalid conversation");
            const messages = record.messages
              .filter((entry) => entry?.role === "user" || entry?.role === "assistant")
              .map((entry) => ({ role: entry.role, text: entry.text ?? "" }));
            if (state.hydrationReadGeneration === generation) state.hydrationData = messages;
            return { generation, messages };
          }),
      };
      state.hydrationFlight = flight;
      void flight.promise.finally(() => {
        if (state.hydrationFlight === flight) state.hydrationFlight = null;
      }).catch(() => {});
      return flight.promise;
    }

    async function hydrateBot(botId, epoch = selectionEpoch, { force = false } = {}) {
      if (disposed || !conversations || typeof conversations.read !== "function") return;
      const state = stateFor(botId);
      const conversationId = await ensureConversation(botId);
      if (!force && state.hydrated) return state.hydrationData;
      let result;
      try {
        result = await hydrationRead(state, botId, conversationId, force);
      } catch {
        if (!disposed && selectedBotId === botId && selectionEpoch === epoch) {
          status.textContent = "Conversation could not be restored";
        }
        return null;
      }
      if (disposed || selectedBotId !== botId || selectionEpoch !== epoch
        || state.hydrationReadGeneration !== result.generation
        || (force && (state.active || state.sendPending))) return result.messages;
      state.messages = result.messages.map((entry) => ({ ...entry }));
      state.hydrated = true;
      renderCurrent();
      return result.messages;
    }

    function setActive(operation) {
      const state = stateFor(operation.botId);
      state.active = operation;
      state.status = "OpenBot is thinking…";
      if (selectedBotId === operation.botId) renderCurrent();
    }

    function clearActive(operation) {
      const state = stateFor(operation.botId);
      if (state.active?.invocationId !== operation.invocationId) return false;
      state.active = null;
      return true;
    }

    async function sendText(botId, text) {
      const state = stateFor(botId);
      if (state.active || state.sendPending) return false;
      state.sendPending = true;
      state.status = "OpenBot is thinking…";
      if (selectedBotId === botId) renderCurrent();
      try {
        const conversationId = await ensureConversation(botId);
        await hydrateBot(botId);
        if (disposed) return false;
        if (!state.hydrated && state.hydrationData && state.messages.length === 0) {
          state.messages = state.hydrationData.map((entry) => ({ ...entry }));
          state.hydrated = true;
        }
        state.messages.push({ role: "user", text });
        if (selectedBotId === botId) renderCurrent();
        const operation = await conversations.send({ botId, conversationId, text });
        if (disposed) return false;
        state.sendPending = false;
        state.messages.push({ role: "assistant", text: "", invocationId: operation.invocationId });
        setActive(operation);
        const early = state.earlyEvents.splice(0);
        for (const event of early) processEvent(event);
        return true;
      } catch {
        state.sendPending = false;
        state.status = "Message could not be sent";
        if (!disposed && selectedBotId === botId) renderCurrent();
        return false;
      } finally {
        if (!disposed && selectedBotId === botId) {
          send.disabled = Boolean(state.sendPending);
          input.focus?.();
        }
      }
    }

    async function submit(event) {
      event?.preventDefault?.();
      if (disposed || !conversations) return;
      const text = typeof input.value === "string" ? input.value : "";
      if (!text.trim()) return;
      let textBytes;
      try { textBytes = new TextEncoder().encode(text).byteLength; } catch { textBytes = Number.POSITIVE_INFINITY; }
      if (text.includes("\0") || textBytes > 64 * 1024) {
        status.textContent = "Message is too large";
        return;
      }
      const botId = activeBotId();
      if (!botId) {
        status.textContent = "Create or select a bot first";
        return;
      }
      input.value = "";
      const state = stateFor(botId);
      if (state.active || state.sendPending) {
        if (state.queue.length >= 4 || queueBytes(state) + textBytes > 64 * 1024) {
          input.value = text;
          status.textContent = "Follow-up queue is full";
          return;
        }
        state.queue.push({ id: nextQueueId, text });
        nextQueueId += 1;
        status.textContent = `${state.queue.length} follow-up${state.queue.length === 1 ? "" : "s"} queued`;
        renderQueue(state);
        return;
      }
      await sendText(botId, text);
    }
    composer.addEventListener?.("submit", submit);
    async function cancelActive(event) {
      event?.preventDefault?.();
      const botId = activeBotId();
      const state = botId ? stateFor(botId) : null;
      const operation = state?.active;
      if (!operation || stop.disabled) return;
      stop.disabled = true;
      try {
        await conversations.cancel({
          botId: operation.botId,
          conversationId: operation.conversationId,
          invocationId: operation.invocationId,
        });
        if (clearActive(operation)) {
          state.status = "Stopped";
          if (selectedBotId === botId) renderCurrent();
        }
      } catch {
        if (!disposed) {
          stop.disabled = false;
          state.status = "Response could not be stopped";
          status.textContent = "Response could not be stopped";
        }
      }
    }
    async function onInputKeydown(event) {
      if (event.key === "Enter" && !event.shiftKey) await submit(event);
      else if (event.key === "Escape") await cancelActive(event);
    }
    input.addEventListener?.("keydown", onInputKeydown);
    stop.addEventListener?.("click", cancelActive);

    function receiveBots(value) {
      if (disposed || !Array.isArray(value)) return;
      knownBots = value;
      const botId = selectionFromPanel();
      if (botId !== selectedBotId) selectBot(botId);
      else if (botId) void hydrateBot(botId, selectionEpoch);
    }
    const stopBot = typeof bots?.onChanged === "function" ? bots.onChanged(() => {
      void bots.list().then(receiveBots, () => {});
    }) : () => {};
    if (typeof bots?.list === "function") {
      void bots.list().then(receiveBots, () => {});
    }
    const stopChanged = typeof conversations?.onChanged === "function"
      ? conversations.onChanged((value) => {
        if (value?.botId !== selectedBotId) return;
        const state = stateFor(value.botId);
        if (!state.active && !state.sendPending) {
          void hydrateBot(value.botId, selectionEpoch, { force: true });
        }
      }) : () => {};
    async function drainQueue(state) {
      if (disposed || state.active || state.sendPending || state.queue.length === 0) return;
      const item = state.queue.shift();
      if (selectedBotId === state.botId) renderQueue(state);
      const sent = await sendText(state.botId, item.text);
      if (!sent && !disposed) {
        state.queue.unshift(item);
        if (selectedBotId === state.botId) renderQueue(state);
      }
    }
    function processEvent(event) {
      if (disposed || !event || typeof event.invocationId !== "string") return;
      const state = typeof event.botId === "string" ? botStates.get(event.botId) : null;
      if (!state) return;
      const operation = state.active;
      if (!operation) {
        if (state.sendPending && state.conversationId === event.conversationId) state.earlyEvents.push(event);
        return;
      }
      if (operation.conversationId !== event.conversationId
        || operation.invocationId !== event.invocationId
        || operation.generation !== event.generation) return;
      if (event.type === "text-delta") {
        const entry = state.messages.find((item) => item.invocationId === event.invocationId);
        if (entry) entry.text = `${entry.text ?? ""}${event.text}`;
        if (selectedBotId === state.botId) renderCurrent();
        return;
      }
      if (["completed", "cancelled", "failed"].includes(event.type)) {
        if (!clearActive(operation)) return;
        state.status = event.type === "completed" ? "Direct Codex ready"
          : event.type === "cancelled" ? "Stopped" : "Message failed";
        if (selectedBotId === state.botId) renderCurrent();
        if (event.type === "completed") void drainQueue(state);
      }
    }
    const stopEvent = typeof conversations?.onEvent === "function"
      ? conversations.onEvent(processEvent) : () => {};

    return Object.freeze({
      shell,
      dispose() {
        if (disposed) return;
        disposed = true;
        stopBot?.();
        stopChanged?.();
        stopEvent?.();
        desktopView?.dispose?.();
        desktopView = null;
        composer.removeEventListener?.("submit", submit);
        input.removeEventListener?.("keydown", onInputKeydown);
        stop.removeEventListener?.("click", cancelActive);
        windowRef.removeEventListener?.("codex-bot-selection-changing", onSelectionChanging);
        botStates.clear();
        shell.remove?.();
      },
    });
  }

  function createHostController({ windowRef, documentRef } = {}) {
    if (!windowRef || !documentRef || typeof documentRef.createElement !== "function") {
      throw new Error("OpenBot standalone host is unavailable.");
    }
    let host = "pending";
    let disposed = false;
    let evaluating = null;
    let mounted = null;
    let rootState = null;
    const disposers = [];

    function selectVendor() {
      if (disposed || host !== "pending") return host;
      host = "vendor";
      stopWatching();
      return host;
    }

    function selectStandalone() {
      if (disposed || host !== "pending") return host;
      const vendorRoot = documentRef.getElementById?.("root") ?? documentRef.querySelector?.("#root");
      if (vendorRoot) {
        rootState = {
          hidden: vendorRoot.hidden === true,
          ariaHidden: vendorRoot.getAttribute?.("aria-hidden"),
          root: vendorRoot,
        };
        vendorRoot.hidden = true;
        vendorRoot.setAttribute?.("aria-hidden", "true");
      }
      mounted = buildShell(documentRef, windowRef);
      documentRef.body.append(mounted.shell);
      host = "standalone";
      stopWatching();
      return host;
    }

    function stopWatching() {
      while (disposers.length) {
        try { disposers.pop()?.(); } catch {}
      }
    }

    async function evaluate() {
      if (disposed) return "disposed";
      if (host !== "pending") return host;
      if (vendorMountsPresent(documentRef)) return selectVendor();
      let cursor;
      let account;
      let catalog;
      try {
        [cursor, account, catalog] = await Promise.all([
          cursorStatus(windowRef),
          windowRef.codexAccount?.read?.(),
          windowRef.codexAccount?.catalog?.(),
        ]);
      } catch { return disposed ? "disposed" : host; }
      if (disposed) return "disposed";
      if (vendorMountsPresent(documentRef)) return selectVendor();
      if (cursor === "logged-out" && healthyAccount(account, catalog)) return selectStandalone();
      return host;
    }

    function start() {
      if (disposed) return Promise.resolve("disposed");
      if (host !== "pending") return Promise.resolve(host);
      if (evaluating) return evaluating;
      evaluating = evaluate().finally(() => { evaluating = null; });
      return evaluating;
    }

    const account = windowRef.codexAccount;
    if (typeof account?.onChanged === "function") {
      try { disposers.push(account.onChanged(() => { void start(); })); } catch {}
    }
    if (typeof account?.onCatalogChanged === "function") {
      try { disposers.push(account.onCatalogChanged(() => { void start(); })); } catch {}
    }
    const Observer = windowRef.MutationObserver;
    if (typeof Observer === "function" && documentRef.body) {
      try {
        const observer = new Observer(() => { if (vendorMountsPresent(documentRef)) selectVendor(); });
        observer.observe(documentRef.body, { childList: true, subtree: true });
        disposers.push(() => observer.disconnect());
      } catch {}
    }

    return Object.freeze({
      start,
      snapshot: () => Object.freeze({ host, disposed }),
      dispose() {
        if (disposed) return;
        disposed = true;
        stopWatching();
        mounted?.dispose();
        mounted = null;
        if (rootState) {
          rootState.root.hidden = rootState.hidden;
          if (rootState.ariaHidden === null || rootState.ariaHidden === undefined) {
            rootState.root.removeAttribute?.("aria-hidden");
          } else rootState.root.setAttribute?.("aria-hidden", rootState.ariaHidden);
          rootState = null;
        }
        host = "disposed";
      },
    });
  }

  if (typeof window === "object" && typeof document === "object") {
    window.addEventListener("DOMContentLoaded", () => {
      const controller = createHostController({ windowRef: window, documentRef: document });
      window.__openbotStandaloneHost = controller;
      void controller.start();
      window.addEventListener("pagehide", () => controller.dispose(), { once: true });
    }, { once: true });
  }

  return Object.freeze({
    createHostController,
    vendorMountsPresent,
  });
});
