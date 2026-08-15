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
  const COMPACT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra", "ultra-code"]);
  const COMPACT_LABELS = Object.freeze({
    low: "Light",
    medium: "Standard",
    high: "Extended",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
    "ultra-code": "Ultra Code",
  });

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

  function catalogEfforts(model) {
    const seen = new Set();
    const result = [];
    for (const entry of Array.isArray(model?.efforts)
      ? model.efforts
      : Array.isArray(model?.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : []) {
      const effort = effortId(entry);
      if (effort && !seen.has(effort)) {
        seen.add(effort);
        result.push(effort);
      }
    }
    return result;
  }

  function catalogTiers(model) {
    const seen = new Set();
    const result = [];
    for (const entry of Array.isArray(model?.serviceTiers) ? model.serviceTiers : []) {
      const id = tierId(entry);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(Object.freeze({
        id,
        name: typeof entry === "object" && typeof (entry.name || entry.displayName || entry.label) === "string"
          ? entry.name || entry.displayName || entry.label
          : effortLabel(id),
        description: typeof entry === "object" && typeof entry.description === "string"
          ? entry.description
          : "",
      }));
    }
    return result;
  }

  function validPowerModel(model) {
    return model && typeof model === "object"
      && typeof model.model === "string" && model.model.length > 0
      && typeof model.provider === "string" && model.provider.length > 0
      && Number.isSafeInteger(model.catalogGeneration) && model.catalogGeneration >= 0
      && catalogEfforts(model).length > 0;
  }

  function powerEffect(effort, serviceTier) {
    if (effort === "ultra" || effort === "ultra-code") return "ultra";
    if (effort === "max") return "max";
    if (typeof serviceTier === "string"
      && (serviceTier === "priority" || serviceTier.includes("fast"))) return "fast";
    return "ordinary";
  }

  function powerStop(model, effort, selected) {
    if (!validPowerModel(model) || !catalogEfforts(model).includes(effort)
      || !COMPACT_LABELS[effort]) return null;
    const tiers = catalogTiers(model);
    const selectedTier = selected && selected.provider === model.provider
      && Object.prototype.hasOwnProperty.call(selected, "serviceTier")
      && (selected.serviceTier === null
        || tiers.some((entry) => entry.id === selected.serviceTier))
      ? selected.serviceTier
      : undefined;
    const serviceTier = selectedTier !== undefined
      ? selectedTier
      : typeof model.defaultServiceTier === "string"
        && tiers.some((entry) => entry.id === model.defaultServiceTier)
        ? model.defaultServiceTier
        : null;
    return Object.freeze({
      provider: model.provider,
      model: model.model,
      effort,
      serviceTier,
      catalogGeneration: model.catalogGeneration,
      label: COMPACT_LABELS[effort],
      effect: powerEffect(effort, serviceTier),
    });
  }

  function buildPowerStops(catalog, selected = {}) {
    const models = (Array.isArray(catalog) ? catalog : []).filter(validPowerModel);
    if (!models.length) return Object.freeze([]);
    const selectedModel = models.find((entry) => entry.model === selected?.model);
    if (selectedModel && selectedModel.provider !== "openai-codex") {
      return Object.freeze(COMPACT_EFFORTS
        .map((effort) => powerStop(selectedModel, effort, selected))
        .filter(Boolean));
    }
    if (!models.some((entry) => entry.provider === "openai-codex")) {
      return Object.freeze(COMPACT_EFFORTS
        .map((effort) => powerStop(models[0], effort, selected))
        .filter(Boolean));
    }
    const fallback = models.find((entry) => entry.provider === "openai-codex" && entry.isDefault === true)
      ?? models.find((entry) => entry.provider === "openai-codex")
      ?? selectedModel
      ?? models[0];
    const terra = models.find((entry) => entry.provider === "openai-codex"
      && entry.model === "gpt-5.6-terra") ?? fallback;
    const sol = models.find((entry) => entry.provider === "openai-codex"
      && entry.model === "gpt-5.6-sol") ?? fallback;
    const sequence = [
      [terra, "low"],
      [sol, "low"],
      [sol, "medium"],
      [sol, "high"],
      [sol, "xhigh"],
      [sol, "max"],
      [sol, "ultra"],
    ];
    const seen = new Set();
    const stops = [];
    for (const [model, effort] of sequence) {
      const stop = powerStop(model, effort, selected);
      if (!stop) continue;
      const key = `${stop.provider}\u0000${stop.model}\u0000${stop.effort}\u0000${stop.serviceTier ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stops.push(stop);
    }
    return Object.freeze(stops);
  }

  function buildAdvancedOptions(catalog, selectedModel) {
    const models = (Array.isArray(catalog) ? catalog : []).filter(validPowerModel);
    const current = models.find((entry) => entry.model === selectedModel) ?? models[0];
    const modelOptions = Object.freeze(models.map((entry) => Object.freeze({
      model: entry.model,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.model,
      provider: entry.provider,
    })));
    const efforts = Object.freeze((current ? catalogEfforts(current) : []).map((effort) => Object.freeze({
      effort,
      label: effortLabel(effort),
    })));
    const speeds = Object.freeze([
      Object.freeze({ serviceTier: null, label: "Standard", description: "Default speed" }),
      ...(current ? catalogTiers(current) : []).map((tier) => Object.freeze({
        serviceTier: tier.id,
        label: tier.name,
        description: tier.description,
      })),
    ]);
    return Object.freeze({ models: modelOptions, efforts, speeds });
  }

  function resolveAdvancedSelection(catalog, selected) {
    if (!selected || typeof selected !== "object") return null;
    const model = (Array.isArray(catalog) ? catalog : []).find((entry) => validPowerModel(entry)
      && entry.model === selected.model);
    if (!model || !catalogEfforts(model).includes(selected.effort)) return null;
    const serviceTier = selected.serviceTier ?? null;
    if (serviceTier !== null && !catalogTiers(model).some((entry) => entry.id === serviceTier)) return null;
    return Object.freeze({
      provider: model.provider,
      model: model.model,
      effort: selected.effort,
      serviceTier,
      catalogGeneration: model.catalogGeneration,
    });
  }

  function closestPowerStop(stops, selected) {
    if (!Array.isArray(stops) || !stops.length || !selected || typeof selected !== "object") return -1;
    const exact = stops.findIndex((stop) => stop.provider === selected.provider
      && stop.model === selected.model
      && stop.effort === selected.effort
      && stop.serviceTier === selected.serviceTier
      && stop.catalogGeneration === selected.catalogGeneration);
    if (exact >= 0) return exact;
    const effortRank = COMPACT_EFFORTS.indexOf(selected.effort);
    let best = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < stops.length; index += 1) {
      const stop = stops[index];
      const stopRank = COMPACT_EFFORTS.indexOf(stop.effort);
      let score = stop.provider === selected.provider ? 16 : 0;
      if (stop.model === selected.model) score += 8;
      if (stop.serviceTier === selected.serviceTier) score += 4;
      if (effortRank >= 0 && stopRank >= 0) score -= Math.abs(effortRank - stopRank);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
    return best;
  }

  return Object.freeze({
    chatPickerOptions,
    workPickerModels,
    workEffortOptions,
    workPowerSelection,
    workTierOptions,
    workReasoningOptions,
    resolveWorkSelection,
    sliderCenter,
    effortLabel,
    effortOptions,
    sliderSelection,
    pickerModels,
    buildPowerStops,
    buildAdvancedOptions,
    resolveAdvancedSelection,
    closestPowerStop,
  });
});
