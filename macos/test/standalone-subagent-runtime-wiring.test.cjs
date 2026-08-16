"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createInferenceBridgeRuntime } = require("../src/desktop/runtime.cjs");

test("the standalone runtime owns one subagent runner over the same inference router and Computer bridge", () => {
  const constructed = [];
  class DirectTransportFixture {
    constructor(options) { this.options = options; constructed.push(["direct", this]); }
  }
  class RouterFixture {
    constructor(options) { this.options = options; constructed.push(["router", this]); }
    stream() {}
  }
  class StoreFixture {
    constructor(options) { this.options = options; constructed.push(["store", this]); }
  }
  class SubagentRunnerFixture {
    constructor(options) { this.options = options; constructed.push(["subagent", this]); }
    open() {}
    dispose() {}
  }
  class StandaloneFixture {
    constructor(options) { this.options = options; constructed.push(["standalone", this]); }
    dispose() {}
  }
  class BridgeFixture {
    constructor(options) { this.options = options; constructed.push(["bridge", this]); }
  }
  const toolBridge = Object.freeze({ open() {} });
  const computerTargetRouter = Object.freeze({ async resolve() {} });
  const stateRoot = "/tmp/openbot-standalone-subagent-wiring";
  const bridge = createInferenceBridgeRuntime({
    codexManager: {},
    selectionStore: { async read() { return null; } },
    sidecarManager: { async start() {} },
    stateRoot,
    toolBridge,
    computerTargetRouter,
    capability: "a".repeat(64),
    DirectTransportClass: DirectTransportFixture,
    RouterClass: RouterFixture,
    StandaloneControllerClass: StandaloneFixture,
    StandaloneStoreClass: StoreFixture,
    StandaloneSubagentRunnerClass: SubagentRunnerFixture,
    BridgeClass: BridgeFixture,
    OptionalTransportClass: class OptionalTransportFixture {},
  });

  assert.deepEqual(constructed.map(([name]) => name), [
    "direct", "router", "store", "subagent", "standalone", "bridge",
  ]);
  const router = constructed[1][1];
  const subagent = constructed[3][1];
  const standalone = constructed[4][1];
  assert.equal(subagent.options.router, router);
  assert.equal(subagent.options.readSelection, router.options.readSelection);
  assert.equal(subagent.options.toolBridge, toolBridge);
  assert.equal(standalone.options.subagentRunner, subagent);
  assert.equal(standalone.options.router, router);
  assert.equal(standalone.options.readSelection, router.options.readSelection);
  assert.equal(standalone.options.store.options.filePath, path.join(stateRoot, "standalone-conversations.v1.json"));
  assert.equal(bridge.conversations, standalone);
});
