(function exposeReasoningControl(root, factory) {
  const controls = factory();
  if (typeof module === "object" && module.exports) module.exports = controls;
  if (root) root.CodexReasoningControl = controls;
})(typeof window === "object" ? window : null, function createReasoningControl() {
  "use strict";

  function normalizeOptions(input) {
    const options = [];
    for (const option of Array.isArray(input) ? input : []) {
      if (typeof option !== "string") continue;
      const effort = option.trim();
      if (effort && !options.includes(effort)) options.push(effort);
    }
    return Object.freeze(options);
  }

  function clampIndex(index, count, fallback) {
    if (!count) return -1;
    const candidate = Number.isFinite(index) ? Math.round(index) : fallback;
    return Math.max(0, Math.min(count - 1, Number.isInteger(candidate) ? candidate : 0));
  }

  function isUltraEffect(effort) {
    return effort === "ultra" || effort === "ultra-code";
  }

  function didEnterUltra(previousEffort, nextEffort, changed) {
    return changed && typeof previousEffort === "string" && !isUltraEffect(previousEffort) && isUltraEffect(nextEffort);
  }

  function normalizePowerStops(input) {
    const stops = [];
    const seen = new Set();
    for (const raw of Array.isArray(input) ? input : []) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || typeof raw.provider !== "string" || !raw.provider
        || typeof raw.model !== "string" || !raw.model
        || typeof raw.effort !== "string" || !raw.effort
        || !(raw.serviceTier === null || (typeof raw.serviceTier === "string" && raw.serviceTier))
        || !Number.isSafeInteger(raw.catalogGeneration) || raw.catalogGeneration < 0
        || typeof raw.label !== "string" || !raw.label
        || !new Set(["ordinary", "fast", "max", "ultra"]).has(raw.effect)) continue;
      const key = `${raw.provider}\u0000${raw.model}\u0000${raw.effort}\u0000${raw.serviceTier ?? ""}\u0000${raw.catalogGeneration}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stops.push(Object.freeze({
        provider: raw.provider,
        model: raw.model,
        effort: raw.effort,
        serviceTier: raw.serviceTier,
        catalogGeneration: raw.catalogGeneration,
        label: raw.label,
        effect: raw.effect,
      }));
    }
    return Object.freeze(stops);
  }

  function sameSelection(left, right) {
    return Boolean(left && right
      && left.provider === right.provider
      && left.model === right.model
      && left.effort === right.effort
      && left.serviceTier === right.serviceTier
      && left.catalogGeneration === right.catalogGeneration);
  }

  function modelLabel(value) {
    return String(value || "Model")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  class PowerControlState {
    constructor(stops, selected, { ownerKey = "" } = {}) {
      this.stops = normalizePowerStops(stops);
      this.ownerKey = String(ownerKey);
      this.committedIndex = this.#selectionIndex(selected);
      this.previewIndex = this.committedIndex;
      this.pointerActive = false;
      this.pointerMoved = false;
      this.holdStartedAt = null;
      this.endpointLabelsVisible = false;
      this.focused = false;
      this.hovered = false;
      this.disabled = false;
    }

    #selectionIndex(selected) {
      if (!this.stops.length) return -1;
      if (Number.isFinite(selected)) return clampIndex(selected, this.stops.length, 0);
      const exact = this.stops.findIndex((stop) => sameSelection(stop, selected));
      return exact >= 0 ? exact : 0;
    }

    #visibleIndex() {
      return this.previewIndex >= 0 ? this.previewIndex : this.committedIndex;
    }

    #commit(index, { pointerDrag = false } = {}) {
      if (this.disabled || !this.stops.length) return this.snapshot();
      const previous = this.stops[this.committedIndex] ?? null;
      const nextIndex = clampIndex(index, this.stops.length, this.committedIndex);
      const next = this.stops[nextIndex] ?? null;
      const changed = nextIndex !== this.committedIndex;
      this.committedIndex = nextIndex;
      this.previewIndex = nextIndex;
      const enteredUltra = pointerDrag && changed && nextIndex === this.stops.length - 1
        && previous?.effect !== "ultra" && next?.effect === "ultra";
      return this.snapshot(changed, enteredUltra);
    }

    setStops(stops, selected, { ownerKey = this.ownerKey } = {}) {
      const previous = this.stops[this.committedIndex] ?? null;
      const previousOwner = this.ownerKey;
      this.stops = normalizePowerStops(stops);
      this.ownerKey = String(ownerKey);
      this.committedIndex = this.#selectionIndex(selected);
      this.previewIndex = this.committedIndex;
      this.pointerActive = false;
      this.pointerMoved = false;
      this.holdStartedAt = null;
      this.endpointLabelsVisible = false;
      const next = this.stops[this.committedIndex] ?? null;
      const changed = previousOwner !== this.ownerKey || !sameSelection(previous, next);
      return this.snapshot(changed, false);
    }

    pointerDown(index, now = 0) {
      if (this.disabled || !this.stops.length) return this.snapshot();
      this.pointerActive = true;
      this.pointerMoved = false;
      this.previewIndex = clampIndex(index, this.stops.length, this.committedIndex);
      this.holdStartedAt = Number.isFinite(now) ? now : 0;
      this.endpointLabelsVisible = false;
      return this.snapshot();
    }

    pointerMove(index) {
      if (this.disabled || !this.pointerActive) return this.snapshot();
      const nextIndex = clampIndex(index, this.stops.length, this.previewIndex);
      if (nextIndex !== this.previewIndex) this.pointerMoved = true;
      this.previewIndex = nextIndex;
      return this.snapshot();
    }

    pointerUp(index = this.previewIndex) {
      if (this.disabled || !this.pointerActive) return this.snapshot();
      const pointerDrag = this.pointerMoved;
      this.pointerActive = false;
      this.pointerMoved = false;
      this.holdStartedAt = null;
      this.endpointLabelsVisible = false;
      return this.#commit(index, { pointerDrag });
    }

    pointerCancel() {
      this.pointerActive = false;
      this.pointerMoved = false;
      this.holdStartedAt = null;
      this.endpointLabelsVisible = false;
      this.previewIndex = this.committedIndex;
      return this.snapshot();
    }

    tick(now) {
      if (this.pointerActive && Number.isFinite(now) && Number.isFinite(this.holdStartedAt)
        && now - this.holdStartedAt >= 450) this.endpointLabelsVisible = true;
      return this.snapshot();
    }

    wheel(deltaY) {
      if (this.disabled || !Number.isFinite(deltaY) || deltaY === 0) return this.snapshot();
      return this.#commit(this.committedIndex + (deltaY > 0 ? 1 : -1));
    }

    keyDown(key) {
      if (this.disabled) return this.snapshot();
      if (key === "Home") return this.#commit(0);
      if (key === "End") return this.#commit(this.stops.length - 1);
      if (key === "ArrowLeft" || key === "ArrowDown") return this.#commit(this.committedIndex - 1);
      if (key === "ArrowRight" || key === "ArrowUp") return this.#commit(this.committedIndex + 1);
      return this.snapshot();
    }

    setFocus(value) {
      this.focused = Boolean(value);
      return this.snapshot();
    }

    setHover(value) {
      this.hovered = Boolean(value);
      return this.snapshot();
    }

    setDisabled(value) {
      this.disabled = Boolean(value);
      if (this.disabled) this.pointerCancel();
      return this.snapshot();
    }

    snapshot(changed = false, enteredUltra = false) {
      const selection = this.stops[this.#visibleIndex()] ?? null;
      const label = selection?.label ?? "Power unavailable";
      const speed = selection?.serviceTier ? `, ${modelLabel(selection.serviceTier)} speed` : "";
      return Object.freeze({
        stops: this.stops,
        ownerKey: this.ownerKey,
        committedIndex: this.committedIndex,
        previewIndex: this.previewIndex,
        selection,
        label,
        effect: selection?.effect ?? "ordinary",
        changed: Boolean(changed),
        enteredUltra: Boolean(enteredUltra),
        pointerActive: this.pointerActive,
        endpointLabelsVisible: this.endpointLabelsVisible,
        focused: this.focused,
        hovered: this.hovered,
        disabled: this.disabled,
        liveText: selection ? `${label}, ${modelLabel(selection.model)}${speed}` : "Power unavailable",
      });
    }
  }

  class ReasoningControlState {
    constructor(options, preferredEffort) {
      this.options = normalizeOptions(options);
      this.index = this.options.indexOf(preferredEffort);
      if (this.index < 0) this.index = this.options.length ? 0 : -1;
    }

    setOptions(options, preferredEffort) {
      const previousEffort = this.effort;
      const nextOptions = normalizeOptions(options);
      let nextIndex = nextOptions.indexOf(preferredEffort);
      if (nextIndex < 0) nextIndex = nextOptions.indexOf(previousEffort);
      if (nextIndex < 0) nextIndex = nextOptions.length ? 0 : -1;
      const nextEffort = nextIndex < 0 ? null : nextOptions[nextIndex];
      const changed = nextEffort !== previousEffort;
      this.options = nextOptions;
      this.index = nextIndex;
      return this.snapshot(changed, didEnterUltra(previousEffort, nextEffort, changed));
    }

    selectIndex(index, _options = {}) {
      const previousEffort = this.effort;
      const nextIndex = clampIndex(index, this.options.length, this.index);
      const nextEffort = nextIndex < 0 ? null : this.options[nextIndex];
      const changed = nextEffort !== previousEffort;
      this.index = nextIndex;
      return this.snapshot(changed, didEnterUltra(previousEffort, nextEffort, changed));
    }

    get effort() {
      return this.index < 0 ? null : this.options[this.index];
    }

    snapshot(changed, enteredUltra) {
      return Object.freeze({
        options: Object.freeze([...this.options]),
        index: this.index,
        effort: this.effort,
        changed: Boolean(changed),
        enteredUltra: Boolean(enteredUltra),
      });
    }
  }

  return Object.freeze({ PowerControlState, ReasoningControlState });
});
