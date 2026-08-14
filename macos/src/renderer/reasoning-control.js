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

  return Object.freeze({ ReasoningControlState });
});
