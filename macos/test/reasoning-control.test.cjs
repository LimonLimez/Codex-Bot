const assert = require("node:assert/strict");
const test = require("node:test");

const { ReasoningControlState } = require("../src/renderer/reasoning-control.js");

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
