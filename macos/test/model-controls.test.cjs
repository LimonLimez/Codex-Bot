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
