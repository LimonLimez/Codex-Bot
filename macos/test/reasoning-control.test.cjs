const assert = require("node:assert/strict");
const test = require("node:test");

const { PowerControlState, ReasoningControlState } = require("../src/renderer/reasoning-control.js");

function powerStops(generation = 4) {
  return [
    { provider: "openai-codex", model: "terra", effort: "low", serviceTier: null, catalogGeneration: generation, label: "Light", effect: "ordinary" },
    { provider: "openai-codex", model: "sol", effort: "medium", serviceTier: null, catalogGeneration: generation, label: "Standard", effect: "ordinary" },
    { provider: "openai-codex", model: "sol", effort: "max", serviceTier: "priority", catalogGeneration: generation, label: "Max", effect: "max" },
    { provider: "openai-codex", model: "sol", effort: "ultra", serviceTier: "priority", catalogGeneration: generation, label: "Ultra", effect: "ultra" },
  ];
}

test("Ultra enters once and pointer jitter is a no-op", () => {
  const control = new ReasoningControlState(["low", "medium", "high", "xhigh", "max", "ultra"], "max");
  const options = ["low", "medium", "high", "xhigh", "max", "ultra"];

  assert.deepEqual(control.selectIndex(5), { options, effort: "ultra", index: 5, changed: true, enteredUltra: true });
  assert.deepEqual(control.selectIndex(5), { options, effort: "ultra", index: 5, changed: false, enteredUltra: false });
});

test("shrinking options removes unsupported Ultra and uses the preferred supported effort", () => {
  const control = new ReasoningControlState(["low", "medium", "high", "xhigh", "max", "ultra"], "ultra");
  const result = control.setOptions(["low", "medium", "high", "xhigh"], "high");

  assert.equal(result.effort, "high");
  assert.equal(result.options.includes("ultra"), false);
  assert.equal(result.enteredUltra, false);
});

test("options and snapshots are immutable independent copies", () => {
  const supplied = ["low", "medium", "ultra"];
  const control = new ReasoningControlState(supplied, "medium");
  supplied[1] = "max";
  const snapshot = control.selectIndex(2);

  assert.deepEqual(snapshot.options, ["low", "medium", "ultra"]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.options), true);
  assert.equal(Reflect.set(snapshot.options, 0, "bad"), false);
  assert.equal(Reflect.set(snapshot, "effort", "bad"), false);
  assert.deepEqual(control.selectIndex(0), { options: ["low", "medium", "ultra"], effort: "low", index: 0, changed: true, enteredUltra: false });
});

test("selection clamps indices and does not report Ultra entry when forced without changing effort", () => {
  const control = new ReasoningControlState(["low", "ultra"], "low");

  assert.deepEqual(control.selectIndex(99), { options: ["low", "ultra"], effort: "ultra", index: 1, changed: true, enteredUltra: true });
  assert.deepEqual(control.selectIndex(1, { force: true }), { options: ["low", "ultra"], effort: "ultra", index: 1, changed: false, enteredUltra: false });
});

test("Ultra does not enter from an empty selection", () => {
  const control = new ReasoningControlState([], null);

  assert.deepEqual(control.setOptions(["ultra"], "ultra"), { options: ["ultra"], effort: "ultra", index: 0, changed: true, enteredUltra: false });
});

test("Ultra Code reuses the Ultra transition without changing its provider-specific identity", () => {
  const control = new ReasoningControlState(
    ["low", "medium", "high", "xhigh", "max", "ultra-code"],
    "max",
  );
  const selected = control.selectIndex(5);
  assert.equal(selected.effort, "ultra-code");
  assert.equal(selected.enteredUltra, true);
});

test("Power pointer interaction previews without committing then commits once on release", () => {
  const supplied = powerStops();
  const control = new PowerControlState(supplied, supplied[1], { ownerKey: "bot-a:4" });
  supplied[1].label = "mutated";
  assert.equal(control.snapshot().label, "Standard");
  assert.equal(Object.isFrozen(control.snapshot().stops), true);
  assert.equal(Object.isFrozen(control.snapshot().stops[0]), true);

  let preview = control.pointerDown(0, 100);
  assert.equal(preview.committedIndex, 1);
  assert.equal(preview.previewIndex, 0);
  assert.equal(preview.label, "Light");
  assert.equal(preview.changed, false);
  preview = control.pointerMove(3);
  assert.equal(preview.committedIndex, 1);
  assert.equal(preview.previewIndex, 3);
  assert.equal(preview.endpointLabelsVisible, false);
  assert.equal(control.tick(549).endpointLabelsVisible, false);
  assert.equal(control.tick(550).endpointLabelsVisible, true);

  const committed = control.pointerUp(3);
  assert.equal(committed.committedIndex, 3);
  assert.equal(committed.previewIndex, 3);
  assert.equal(committed.changed, true);
  assert.equal(committed.enteredUltra, true);
  assert.equal(committed.endpointLabelsVisible, false);
});

test("Power wheel and keyboard operations snap exact stops with native Home End and arrow semantics", () => {
  const stops = powerStops();
  const control = new PowerControlState(stops, stops[1], { ownerKey: "bot-a:4" });
  assert.equal(control.wheel(7).committedIndex, 2);
  assert.equal(control.keyDown("ArrowLeft").committedIndex, 1);
  assert.equal(control.keyDown("ArrowUp").committedIndex, 2);
  const keyboardUltra = control.keyDown("End");
  assert.equal(keyboardUltra.committedIndex, 3);
  assert.equal(keyboardUltra.enteredUltra, false, "keyboard selection must not replay the pointer-only Ultra burst");
  assert.equal(control.keyDown("Home").committedIndex, 0);
  assert.equal(control.keyDown("PageDown").changed, false);
  assert.match(control.snapshot().liveText, /Light.*Terra/i);
});

test("Power focus hover and disabled state are explicit and disabled input is inert", () => {
  const stops = powerStops();
  const control = new PowerControlState(stops, stops[1], { ownerKey: "bot-a:4" });
  assert.equal(control.setFocus(true).focused, true);
  assert.equal(control.setHover(true).hovered, true);
  const disabled = control.setDisabled(true);
  assert.equal(disabled.disabled, true);
  assert.equal(control.pointerDown(3, 0).committedIndex, 1);
  assert.equal(control.wheel(8).committedIndex, 1);
  assert.equal(control.keyDown("End").committedIndex, 1);
  assert.equal(control.setDisabled(false).disabled, false);
  assert.equal(control.keyDown("End").committedIndex, 3);
});

test("Power catalog or bot ownership replacement cancels stale preview and keeps only an exact current tuple", () => {
  const stops = powerStops();
  const control = new PowerControlState(stops, stops[2], { ownerKey: "bot-a:4" });
  control.pointerDown(3, 0);
  const replacement = powerStops(5).slice(0, 3);
  const reset = control.setStops(replacement, replacement[1], { ownerKey: "bot-b:5" });
  assert.equal(reset.ownerKey, "bot-b:5");
  assert.equal(reset.committedIndex, 1);
  assert.equal(reset.previewIndex, 1);
  assert.equal(reset.pointerActive, false);
  assert.equal(reset.endpointLabelsVisible, false);
  assert.equal(reset.changed, true);
  assert.equal(control.pointerUp(2).committedIndex, 1, "a stale pointer release must be inert");
});

test("Power preserves provider-specific Ultra Code in live text and transition identity", () => {
  const stops = [{ provider: "cliproxy-anthropic", model: "claude-fable-5", effort: "max", serviceTier: null, catalogGeneration: 1, label: "Max", effect: "max" },
    { provider: "cliproxy-anthropic", model: "claude-fable-5", effort: "ultra-code", serviceTier: null, catalogGeneration: 1, label: "Ultra Code", effect: "ultra" }];
  const control = new PowerControlState(stops, stops[0], { ownerKey: "bot-fable:1" });
  const result = control.keyDown("End");
  assert.equal(result.enteredUltra, false);
  assert.equal(result.selection.effort, "ultra-code");
  assert.match(result.liveText, /Ultra Code.*Claude Fable 5/i);
});

test("Power Ultra entry requires a genuine pointer drag to the maximum stop", () => {
  const stops = powerStops();
  const click = new PowerControlState(stops, stops[1], { ownerKey: "bot-a:4" });
  click.pointerDown(3, 0);
  assert.equal(click.pointerUp(3).enteredUltra, false, "a pointer click at max is not a drag entry");

  const drag = new PowerControlState(stops, stops[1], { ownerKey: "bot-a:4" });
  drag.pointerDown(1, 0);
  drag.pointerMove(3);
  assert.equal(drag.pointerUp(3).enteredUltra, true);
  assert.equal(drag.pointerUp(3).enteredUltra, false, "a stale release cannot replay entry");
});
