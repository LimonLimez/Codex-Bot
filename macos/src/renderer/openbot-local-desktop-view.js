(function exposeOpenBotLocalDesktopView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenBotLocalDesktopView = api;
})(typeof window === "object" ? window : null, function createOpenBotLocalDesktopViewApi() {
  "use strict";

  const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const FRAME_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "viewGeneration", "sequence",
    "width", "height", "mimeType", "bytes",
  ]);
  const MAX_FRAME_BYTES = 1_048_576;

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function exactFrame(value) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if ((prototype !== Object.prototype && prototype !== null) || keys.length !== FRAME_FIELDS.size
        || keys.some((key) => typeof key !== "string" || !FRAME_FIELDS.has(key)
          || !("value" in descriptors[key]))
        || [...FRAME_FIELDS].some((key) => !descriptors[key])) return null;
      const frame = Object.fromEntries([...FRAME_FIELDS].map((key) => [key, descriptors[key].value]));
      if (typeof frame.botId !== "string" || !BOT_ID.test(frame.botId)
        || typeof frame.targetId !== "string" || !TARGET_ID.test(frame.targetId)
        || !Number.isSafeInteger(frame.targetGeneration) || frame.targetGeneration < 0
        || !Number.isSafeInteger(frame.viewGeneration) || frame.viewGeneration < 1
        || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1
        || !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > 640
        || !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 400
        || frame.mimeType !== "image/png" || !(frame.bytes instanceof Uint8Array)
        || frame.bytes.byteLength < 1 || frame.bytes.byteLength > MAX_FRAME_BYTES) return null;
      return Object.freeze({ ...frame, bytes: Uint8Array.from(frame.bytes) });
    } catch { return null; }
  }

  function sameTarget(left, right) {
    return Boolean(left && right && left.targetId === right.targetId
      && left.targetGeneration === right.targetGeneration);
  }

  function createLocalDesktopView({ documentRef, windowRef, container } = {}) {
    if (!documentRef || typeof documentRef.createElement !== "function"
      || !windowRef || !container || typeof container.append !== "function") {
      throw new Error("OpenBot Local Desktop view is unavailable.");
    }
    const facade = windowRef.openbotLocalDesktop;
    const BlobClass = windowRef.Blob;
    const decodeBitmap = windowRef.createImageBitmap;
    if (!facade || typeof facade.select !== "function" || typeof facade.clear !== "function"
      || typeof facade.onFrame !== "function" || typeof BlobClass !== "function"
      || typeof decodeBitmap !== "function") {
      throw new Error("OpenBot Local Desktop view is unavailable.");
    }

    const surface = element(documentRef, "section", "openbot-local-desktop-view");
    surface.setAttribute("aria-label", "Selected bot Free Local Desktop");
    const header = element(documentRef, "header", "openbot-local-desktop-view-header");
    const status = element(documentRef, "span", "openbot-local-desktop-view-status", "No local desktop selected");
    header.append(
      element(documentRef, "strong", "", "Free Local Desktop"),
      status,
    );
    const viewport = element(documentRef, "div", "openbot-local-desktop-viewport");
    const canvas = element(documentRef, "canvas", "openbot-local-desktop-canvas");
    canvas.width = 640;
    canvas.height = 400;
    canvas.setAttribute("aria-label", "Live selected bot desktop frame");
    viewport.append(canvas);
    surface.append(header, viewport);
    container.append(surface);
    const context = canvas.getContext("2d");
    if (!context || typeof context.clearRect !== "function" || typeof context.drawImage !== "function") {
      surface.remove?.();
      throw new Error("OpenBot Local Desktop view is unavailable.");
    }

    let disposed = false;
    let selectedBotId = null;
    let viewGeneration = 0;
    let target = null;
    let lastSequence = 0;
    let decodeGeneration = 0;

    function clearCanvas() {
      decodeGeneration += 1;
      target = null;
      lastSequence = 0;
      context.clearRect(0, 0, canvas.width, canvas.height);
    }

    function selectBot(value) {
      if (disposed) return;
      viewGeneration += 1;
      selectedBotId = typeof value === "string" && BOT_ID.test(value) ? value : null;
      clearCanvas();
      status.textContent = selectedBotId ? "Connecting to local desktop…" : "No local desktop selected";
      const request = Object.freeze({ viewGeneration });
      const operation = selectedBotId
        ? facade.select(Object.freeze({ botId: selectedBotId, viewGeneration }))
        : facade.clear(request);
      void Promise.resolve(operation).catch(() => {
        if (!disposed && request.viewGeneration === viewGeneration) status.textContent = "Local desktop unavailable";
      });
    }

    async function onFrame(value) {
      if (disposed) return;
      const frame = exactFrame(value);
      if (!frame || frame.botId !== selectedBotId || frame.viewGeneration !== viewGeneration) return;
      const nextTarget = Object.freeze({
        targetId: frame.targetId,
        targetGeneration: frame.targetGeneration,
      });
      if (sameTarget(target, nextTarget)) {
        if (frame.sequence <= lastSequence) return;
      } else {
        clearCanvas();
        target = nextTarget;
      }
      lastSequence = frame.sequence;
      decodeGeneration += 1;
      const pendingGeneration = decodeGeneration;
      let bitmap;
      try {
        const blob = new BlobClass([frame.bytes], { type: "image/png" });
        bitmap = await decodeBitmap(blob);
        if (disposed || pendingGeneration !== decodeGeneration || frame.botId !== selectedBotId
          || frame.viewGeneration !== viewGeneration || !sameTarget(target, nextTarget)
          || lastSequence !== frame.sequence) return;
        canvas.width = frame.width;
        canvas.height = frame.height;
        context.drawImage(bitmap, 0, 0, frame.width, frame.height);
        status.textContent = "Live local desktop";
      } catch {
        if (!disposed && pendingGeneration === decodeGeneration) status.textContent = "Local desktop unavailable";
      } finally {
        try { bitmap?.close?.(); } catch {}
      }
    }

    const stopFrames = facade.onFrame(onFrame);
    const stopComputer = typeof windowRef.openbotComputer?.onChanged === "function"
      ? windowRef.openbotComputer.onChanged((value) => {
        if (!disposed && value?.botId === selectedBotId) selectBot(selectedBotId);
      })
      : () => {};

    return Object.freeze({
      canvas,
      selectBot,
      dispose() {
        if (disposed) return;
        disposed = true;
        viewGeneration += 1;
        clearCanvas();
        try { stopFrames?.(); } catch {}
        try { stopComputer?.(); } catch {}
        try { facade.clear(Object.freeze({ viewGeneration })); } catch {}
        surface.remove?.();
      },
    });
  }

  return Object.freeze({ createLocalDesktopView });
});
