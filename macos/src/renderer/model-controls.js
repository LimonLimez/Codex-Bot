(function exposeModelControls(root, factory) {
  const controls = factory();
  if (typeof module === "object" && module.exports) module.exports = controls;
  if (root) root.CodexModelControls = controls;
})(typeof window === "object" ? window : null, function createModelControls() {
  "use strict";

  const LABELS = Object.freeze({
    none: "None",
    minimal: "Minimal",
    low: "Light",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
    "ultra-code": "Ultra Code",
  });
  const RAW_CHAT_LABELS = new Set(["max", "ultra"]);

  function effortLabel(value) {
    return LABELS[value] || String(value || "Reasoning").replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function chatPickerOptions(chatgptModels) {
    const options = [];
    for (const { modelID, displayName } of Array.isArray(chatgptModels) ? chatgptModels : []) {
      if (typeof modelID !== "string" || !modelID || typeof displayName !== "string" || !displayName) continue;
      if (RAW_CHAT_LABELS.has(displayName.trim().toLowerCase())) continue;
      options.push({ modelID, label: displayName });
    }
    return options;
  }

  function workPickerModels(codexModels) {
    const models = [];
    for (const entry of Array.isArray(codexModels) ? codexModels : []) {
      const model = typeof entry?.model === "string" ? entry.model : "";
      if (!model) continue;
      models.push({
        model,
        ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.isDefault === "boolean" ? { isDefault: entry.isDefault } : {}),
        ...(tierId(entry.defaultServiceTier) ? { defaultServiceTier: tierId(entry.defaultServiceTier) } : {}),
        ...(effortId(entry.defaultReasoningEffort) ? { defaultReasoningEffort: effortId(entry.defaultReasoningEffort) } : {}),
        serviceTiers: Array.isArray(entry.serviceTiers) ? entry.serviceTiers.filter((tier) => tierId(tier)).map((tier) => typeof tier === "string" ? tier : { ...tier, id: tierId(tier) }) : [],
        supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts.filter((effort) => effortId(effort)).map((effort) => typeof effort === "string" ? effort : { ...effort, reasoningEffort: effortId(effort) }) : [],
      });
    }
    return models;
  }

  function tierId(tier) {
    const id = typeof tier === "string" ? tier : tier?.id;
    return typeof id === "string" && id ? id : null;
  }

  function effortId(effort) {
    const id = typeof effort === "string" ? effort : effort?.reasoningEffort || effort?.effort;
    return typeof id === "string" && id ? id : null;
  }

  function workEffortOptions(codexModel) {
    const modelId = typeof codexModel?.model === "string" ? codexModel.model : "";
    const serviceTiers = (Array.isArray(codexModel?.serviceTiers) ? codexModel.serviceTiers : []).map(tierId).filter(Boolean);
    if (!modelId || !serviceTiers.length) return [];
    const efforts = (Array.isArray(codexModel?.supportedReasoningEfforts) ? codexModel.supportedReasoningEfforts : []).map(effortId).filter(Boolean);
    const options = [];
    for (const serviceTier of serviceTiers) {
      for (const effort of efforts) options.push({ modelId, effort, serviceTier, label: effortLabel(effort) });
    }
    return options;
  }

  function workTierOptions(codexModel) {
    return (Array.isArray(codexModel?.serviceTiers) ? codexModel.serviceTiers : []).flatMap((tier) => {
      const serviceTier = tierId(tier);
      if (!serviceTier) return [];
      const label = typeof tier === "object" && typeof (tier.displayName || tier.label) === "string"
        ? tier.displayName || tier.label
        : effortLabel(serviceTier);
      return [{ serviceTier, label }];
    });
  }

  function workReasoningOptions(codexModel) {
    const seen = new Set();
    return (Array.isArray(codexModel?.supportedReasoningEfforts) ? codexModel.supportedReasoningEfforts : []).flatMap((entry) => {
      const effort = effortId(entry);
      if (!effort || seen.has(effort)) return [];
      seen.add(effort);
      return [{ effort, label: effortLabel(effort), description: typeof entry === "object" && typeof entry.description === "string" ? entry.description : "" }];
    });
  }

  function resolveWorkSelection(model, remembered = {}) {
    const options = workReasoningOptions(model);
    const tiers = workTierOptions(model);
    if (!model?.model || !options.length || !tiers.length) return null;
    const effort = options.some((entry) => entry.effort === remembered.effort)
      ? remembered.effort
      : options.some((entry) => entry.effort === model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : options[0].effort;
    const serviceTier = tiers.some((entry) => entry.serviceTier === remembered.serviceTier)
      ? remembered.serviceTier
      : tiers.some((entry) => entry.serviceTier === model.defaultServiceTier)
        ? model.defaultServiceTier
        : tiers[0].serviceTier;
    return { modelId: model.model, effort, serviceTier, index: options.findIndex((entry) => entry.effort === effort) };
  }

  function sliderCenter(index, count) {
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) return null;
    const percent = count === 1 ? 50 : index / (count - 1) * 100;
    return { percent, offsetPx: Math.round((13 - percent / 50 * 13) * 10) / 10 };
  }

  function workPowerSelection(options, selected) {
    if (!Array.isArray(options) || !options.length) return null;
    let index = typeof selected === "number" ? Math.round(selected) : options.findIndex((option) => option.modelId === selected?.modelId && option.effort === selected?.effort && option.serviceTier === selected?.serviceTier);
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(options.length - 1, index));
    const { modelId, effort, serviceTier } = options[index];
    return { index, option: { modelId, effort, serviceTier } };
  }

  function effortOptions(codexModel, mode) {
    if (mode !== "work") return [];
    return (codexModel?.supportedReasoningEfforts || []).map((entry) => ({ reasoningEffort: effortId(entry), description: entry?.description || "" })).filter(({ reasoningEffort }) => reasoningEffort);
  }

  function sliderSelection(options, selected) {
    if (!Array.isArray(options) || !options.length) return null;
    let index = typeof selected === "number" ? Math.round(selected) : options.findIndex((option) => option.reasoningEffort === selected);
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(options.length - 1, index));
    return { index, option: options[index] };
  }

  function pickerModels(codexModels) {
    return workPickerModels(codexModels).map((entry) => ({ ...entry, id: entry.model }));
  }

  return Object.freeze({ chatPickerOptions, workPickerModels, workEffortOptions, workPowerSelection, workTierOptions, workReasoningOptions, resolveWorkSelection, sliderCenter, effortLabel, effortOptions, sliderSelection, pickerModels });
});
