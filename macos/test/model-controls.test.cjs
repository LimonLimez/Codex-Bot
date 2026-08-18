const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const controls = require(path.join(__dirname, "..", "src", "renderer", "model-controls.js"));

const chatCatalog = [
  { modelID: "chatgpt-instant", displayName: "Instant" },
  { modelID: "chatgpt-medium", displayName: "Medium" },
  { modelID: "chatgpt-high", displayName: "High" },
  { modelID: "chatgpt-xhigh", displayName: "Extra High" },
  { modelID: "chatgpt-pro-standard", displayName: "Pro Standard" },
  { modelID: "chatgpt-pro-extended", displayName: "Pro Extended" },
  { modelID: "chatgpt-raw-max", displayName: "Max" },
  { modelID: "chatgpt-raw-ultra", displayName: "Ultra" },
];

const codexCatalog = [
  {
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Frontier coding model",
    isDefault: true,
    defaultServiceTier: "fast",
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "fast" }],
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
      { reasoningEffort: "ultra" },
    ],
  },
  {
    model: "gpt-5.6-terra",
    serviceTiers: [{ id: "standard" }],
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
  },
];

test("Chat picker keeps native ChatGPT IDs and omits only raw Max and Ultra", () => {
  const options = controls.chatPickerOptions(chatCatalog);

  assert.deepEqual(options, [
    { modelID: "chatgpt-instant", label: "Instant" },
    { modelID: "chatgpt-medium", label: "Medium" },
    { modelID: "chatgpt-high", label: "High" },
    { modelID: "chatgpt-xhigh", label: "Extra High" },
    { modelID: "chatgpt-pro-standard", label: "Pro Standard" },
    { modelID: "chatgpt-pro-extended", label: "Pro Extended" },
  ]);
});

test("Work picker exposes only advertised native Codex models and efforts", () => {
  const models = controls.workPickerModels(codexCatalog);

  assert.deepEqual(models.map(({ model }) => model), ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(models[0], {
    model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Frontier coding model", isDefault: true,
    defaultServiceTier: "fast", defaultReasoningEffort: "high", serviceTiers: [{ id: "fast" }],
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
  });
  assert.deepEqual(
    controls.workReasoningOptions(models[0]).map(({ effort, label }) => [effort, label]),
    [["low", "Light"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra High"], ["max", "Max"], ["ultra", "Ultra"]],
  );
  assert.deepEqual(
    controls.workReasoningOptions(models[1]).map(({ effort, label }) => [effort, label]),
    [["low", "Light"], ["medium", "Medium"], ["high", "High"]],
  );
});

test("Advanced Work controls expose the same exact tiers and efforts as Power", () => {
  const model = {
    model: "gpt-5.6-sol",
    serviceTiers: [{ id: "fast", displayName: "Fast" }, "standard"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, "high"],
  };
  assert.deepEqual(controls.workTierOptions(model), [
    { serviceTier: "fast", label: "Fast" }, { serviceTier: "standard", label: "Standard" },
  ]);
  assert.deepEqual(controls.workReasoningOptions(model), [
    { effort: "low", label: "Light", description: "Quick" }, { effort: "high", label: "High", description: "" },
  ]);
});

test("Work reasoning options preserve the first valid advertised effort order", () => {
  const model = {
    model: "gpt-5.6-sol",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Quick" }, "high", { effort: "ultra", description: "Deep" },
      { reasoningEffort: "high", description: "Duplicate" }, { reasoningEffort: "" }, { reasoningEffort: 3 }, null,
    ],
  };

  assert.deepEqual(controls.workReasoningOptions(model), [
    { effort: "low", label: "Light", description: "Quick" },
    { effort: "high", label: "High", description: "" },
    { effort: "ultra", label: "Ultra", description: "Deep" },
  ]);
});

test("Work selection uses advertised reasoning capabilities and valid fallback defaults", () => {
  const sol = {
    model: "gpt-5.6-sol", defaultReasoningEffort: "high", defaultServiceTier: "priority",
    serviceTiers: [{ id: "priority" }, { id: "standard" }],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  };
  const terra = { ...sol, model: "gpt-5.6-terra", defaultReasoningEffort: "xhigh" };
  const fiveFive = {
    model: "gpt-5.5", defaultReasoningEffort: "high", defaultServiceTier: "standard", serviceTiers: ["standard"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  };

  assert.deepEqual(controls.workReasoningOptions(sol).map(({ effort }) => effort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(controls.workReasoningOptions(terra).map(({ effort }) => effort), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(controls.workReasoningOptions(fiveFive).map(({ effort }) => effort), ["low", "medium", "high", "xhigh"]);
  assert.equal(controls.workReasoningOptions(fiveFive).some(({ effort }) => effort === "ultra"), false);
  assert.deepEqual(controls.resolveWorkSelection(fiveFive, { effort: "ultra", serviceTier: "priority" }), {
    modelId: "gpt-5.5", effort: "high", serviceTier: "standard", index: 2,
  });
});

test("slider centers align the first and last native reasoning ticks", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((index) => controls.sliderCenter(index, 6)), [
    { percent: 0, offsetPx: 13 }, { percent: 20, offsetPx: 7.8 }, { percent: 40, offsetPx: 2.6 },
    { percent: 60, offsetPx: -2.6 }, { percent: 80, offsetPx: -7.8 }, { percent: 100, offsetPx: -13 },
  ]);
  assert.deepEqual(controls.sliderCenter(0, 1), { percent: 50, offsetPx: 0 });
  assert.equal(controls.sliderCenter(1, 1), null);
  assert.equal(controls.sliderCenter(0, 0), null);
});

test("effort labels use the advertised Work vocabulary", () => {
  assert.deepEqual(
    ["low", "medium", "high", "xhigh", "max", "ultra", "ultra-code"].map(controls.effortLabel),
    ["Light", "Medium", "High", "Extra High", "Max", "Ultra", "Ultra Code"],
  );
});

test("native Power stops are immutable exact live-catalog tuples with approved labels and effects", () => {
  const catalog = [
    {
      model: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      provider: "openai-codex",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultServiceTier: null,
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
      catalogGeneration: 17,
      isDefault: false,
    },
    {
      model: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      provider: "openai-codex",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultServiceTier: "priority",
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
      catalogGeneration: 17,
      isDefault: true,
    },
  ];
  const stops = controls.buildPowerStops(catalog);
  assert.deepEqual(stops, [
    { provider: "openai-codex", model: "gpt-5.6-terra", effort: "low", serviceTier: null, catalogGeneration: 17, label: "Light", effect: "ordinary" },
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "low", serviceTier: "priority", catalogGeneration: 17, label: "Light", effect: "fast" },
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium", serviceTier: "priority", catalogGeneration: 17, label: "Standard", effect: "fast" },
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", serviceTier: "priority", catalogGeneration: 17, label: "Extended", effect: "fast" },
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "xhigh", serviceTier: "priority", catalogGeneration: 17, label: "Extra High", effect: "fast" },
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "max", serviceTier: "priority", catalogGeneration: 17, label: "Max", effect: "max" },
    { provider: "openai-codex", model: "gpt-5.6-sol", effort: "ultra", serviceTier: "priority", catalogGeneration: 17, label: "Ultra", effect: "ultra" },
  ]);
  assert.equal(Object.isFrozen(stops), true);
  assert.equal(stops.every(Object.isFrozen), true);
});

test("Power preserves the selected advertised speed across compatible effort stops", () => {
  const tier = { id: "priority", name: "Fast", description: "1.5x speed" };
  const catalog = [
    {
      model: "gpt-5.6-terra", provider: "openai-codex", efforts: ["low"],
      defaultServiceTier: null, serviceTiers: [tier], catalogGeneration: 18,
    },
    {
      model: "gpt-5.6-sol", provider: "openai-codex", efforts: ["low", "medium", "high"],
      defaultServiceTier: null, serviceTiers: [tier], catalogGeneration: 18, isDefault: true,
    },
  ];
  const standard = controls.buildPowerStops(catalog, {
    provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium",
    serviceTier: null, catalogGeneration: 18,
  });
  const fast = controls.buildPowerStops(catalog, {
    provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium",
    serviceTier: "priority", catalogGeneration: 18,
  });
  assert.equal(standard.some((stop) => stop.effect === "fast"), false);
  assert.equal(fast.every((stop) => stop.serviceTier === "priority"), true);
  assert.equal(fast.some((stop) => stop.effect === "fast"), true);
  assert.equal(controls.closestPowerStop(fast, {
    provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium",
    serviceTier: "priority", catalogGeneration: 18,
  }), 2);
  assert.notDeepEqual(standard, fast);
});

test("Fast classification matches native priority and fast aliases without treating ultrafast as Fast", () => {
  const candidates = [
    { serviceTier: "ultrafast", label: "Ultra fast" },
    { serviceTier: "flex", label: "Flexible" },
    { serviceTier: "custom", label: "Priority" },
    { serviceTier: "fast", label: "Anything" },
    { serviceTier: "priority", label: "Fast" },
  ];
  assert.equal(controls.findFastServiceTier(candidates), "priority");
  assert.equal(controls.findFastServiceTier([{ serviceTier: "custom", label: "Priority" }]), "custom");
  assert.equal(controls.findFastServiceTier([{ serviceTier: "fast", label: "Priority" }]), "fast");
  assert.equal(controls.findFastServiceTier([{ serviceTier: "priority", label: "Other" }]), "priority");
  assert.equal(controls.findFastServiceTier([{ serviceTier: "ultrafast", label: "Ultra fast" }]), null);
  assert.equal(controls.findFastServiceTier([{ serviceTier: "flex", label: "Flex" }]), null);
});

test("Power stop fallback never invents a missing preferred model or unsupported capability", () => {
  const catalog = [{
    model: "gpt-live-luna",
    label: "Live Luna",
    provider: "openai-codex",
    efforts: ["low", "medium", "max"],
    defaultServiceTier: null,
    serviceTiers: [],
    catalogGeneration: 9,
    isDefault: true,
  }];
  assert.deepEqual(
    controls.buildPowerStops(catalog).map(({ model, effort, label }) => ({ model, effort, label })),
    [
      { model: "gpt-live-luna", effort: "low", label: "Light" },
      { model: "gpt-live-luna", effort: "medium", label: "Standard" },
      { model: "gpt-live-luna", effort: "max", label: "Max" },
    ],
  );
  assert.equal(controls.buildPowerStops([]).length, 0);
});

test("optional Fable Power keeps Ultra Code identity while reusing the Ultra effect", () => {
  const catalog = [{
    model: "claude-fable-5",
    label: "Claude Fable 5",
    provider: "cliproxy-anthropic",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra-code"],
    defaultServiceTier: null,
    serviceTiers: [],
    catalogGeneration: 1,
  }];
  const stops = controls.buildPowerStops(catalog, { model: "claude-fable-5" });
  assert.deepEqual(stops.map(({ effort, label, effect }) => [effort, label, effect]), [
    ["low", "Light", "ordinary"],
    ["medium", "Standard", "ordinary"],
    ["high", "Extended", "ordinary"],
    ["xhigh", "Extra High", "ordinary"],
    ["max", "Max", "max"],
    ["ultra-code", "Ultra Code", "ultra"],
  ]);
});

test("Advanced controls expose exact Model Effort and Speed tuples and round-trip to Power", () => {
  const catalog = [{
    model: "gpt-live-sol",
    label: "GPT Live Sol",
    provider: "openai-codex",
    efforts: ["low", "medium", "ultra"],
    defaultServiceTier: null,
    serviceTiers: [
      { id: "priority", name: "Fast", description: "1.5x speed" },
      { id: "ultrafast", name: "Ultra fast", description: "Fastest" },
    ],
    catalogGeneration: 3,
    isDefault: true,
  }];
  const advanced = controls.buildAdvancedOptions(catalog, {
    provider: "openai-codex",
    model: "gpt-live-sol",
  });
  assert.deepEqual(advanced.models, [{
    key: JSON.stringify(["openai-codex", "gpt-live-sol"]),
    model: "gpt-live-sol",
    label: "GPT Live Sol",
    provider: "openai-codex",
    providerLabel: null,
  }]);
  assert.deepEqual(advanced.efforts, [
    { effort: "low", label: "Light", description: "" },
    { effort: "medium", label: "Medium", description: "" },
    { effort: "ultra", label: "Ultra", description: "Consumes usage limits faster" },
  ]);
  assert.deepEqual(advanced.speeds, [
    { serviceTier: null, label: "Standard", description: "Default speed" },
    { serviceTier: "priority", label: "Fast", description: "1.5x speed, more usage" },
    { serviceTier: "ultrafast", label: "Ultra fast", description: "Fastest" },
  ]);
  assert.equal(Object.isFrozen(advanced), true);
  for (const values of [advanced.models, advanced.efforts, advanced.speeds]) {
    assert.equal(Object.isFrozen(values), true);
    assert.equal(values.every(Object.isFrozen), true);
  }
  const exact = controls.resolveAdvancedSelection(catalog, {
    provider: "openai-codex",
    model: "gpt-live-sol",
    effort: "ultra",
    serviceTier: "ultrafast",
  });
  assert.deepEqual(exact, {
    provider: "openai-codex",
    model: "gpt-live-sol",
    effort: "ultra",
    serviceTier: "ultrafast",
    catalogGeneration: 3,
  });
  assert.equal(controls.closestPowerStop(controls.buildPowerStops(catalog), exact), 2);
  assert.equal(controls.resolveAdvancedSelection(catalog, {
    provider: "openai-codex",
    model: "gpt-live-sol",
    effort: "max",
    serviceTier: null,
  }), null);
});

test("Power and Advanced preserve provider identity when providers share one visible model", () => {
  const catalog = [
    {
      model: "claude-fable-5",
      label: "Claude Fable 5",
      provider: "openai-codex",
      efforts: ["medium", "high"],
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: [],
      catalogGeneration: 23,
      isDefault: true,
    },
    {
      model: "claude-fable-5",
      label: "Claude Fable 5",
      provider: "cliproxy-anthropic",
      efforts: ["medium", "ultra-code"],
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: [],
      catalogGeneration: 1,
      isDefault: false,
    },
  ];
  const optional = {
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    effort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
  };
  const stops = controls.buildPowerStops(catalog, optional);
  assert.equal(stops.every((stop) => stop.provider === "cliproxy-anthropic"), true);
  assert.equal(stops.at(-1).effort, "ultra-code");

  const advanced = controls.buildAdvancedOptions(catalog, optional);
  assert.deepEqual(advanced.models, [
    {
      key: JSON.stringify(["openai-codex", "claude-fable-5"]),
      model: "claude-fable-5",
      label: "Claude Fable 5",
      provider: "openai-codex",
      providerLabel: "Direct Codex",
    },
    {
      key: JSON.stringify(["cliproxy-anthropic", "claude-fable-5"]),
      model: "claude-fable-5",
      label: "Claude Fable 5",
      provider: "cliproxy-anthropic",
      providerLabel: "CLIProxy",
    },
  ]);
  assert.deepEqual(advanced.efforts.map(({ effort }) => effort), ["medium", "ultra-code"]);
  assert.deepEqual(controls.resolveAdvancedSelection(catalog, optional), optional);
  assert.deepEqual(controls.resolveAdvancedSelection(catalog, {
    provider: "openai-codex",
    model: "claude-fable-5",
    effort: "high",
    serviceTier: null,
  }), {
    provider: "openai-codex",
    model: "claude-fable-5",
    effort: "high",
    serviceTier: null,
    catalogGeneration: 23,
  });
  assert.equal(controls.resolveAdvancedSelection(catalog, {
    model: "claude-fable-5",
    effort: "medium",
    serviceTier: null,
  }), null, "an ambiguous raw model id cannot silently choose a provider");
});
