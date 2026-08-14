"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");

test("local browser mode keeps host tool approval enabled", () => {
  const patcher = read("scripts/patch-app.cjs");
  assert.doesNotMatch(patcher, /isLocalUseBlocked/);
  assert.doesNotMatch(patcher, /localBypass/);
  assert.doesNotMatch(
    patcher,
    /local tool gate|local undescribed approval|local approval id|local permission controller/,
  );

  for (const relativePath of [
    "src/runtime/Launch-Codex-Bot.ps1",
    "src/runtime/CodexBot-Watchdog.ps1",
  ]) {
    const script = read(relativePath);
    assert.match(script, /localToolPermission\s*=\s*'ask'/);
    assert.doesNotMatch(script, /localToolPermission\s*=\s*'always'/);
  }
});

test("isolated Computer and Screenshot remain automatic only through employee-scoped host executors", () => {
  const patcher = read("scripts/patch-app.cjs");
  assert.doesNotMatch(
    patcher,
    /registry3\.register\(\s*computerUseExecutorResource,\s*windowsComputerBridge\.createExecutor\(\{ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate \}\)/s,
  );
  assert.match(
    patcher,
    /if \(useLocalComputer && \(!bridgePath \|\| !seatKey\)\)/,
  );
  assert.match(patcher, /seatKey: host\.resolveBoxId\(\)/);
  assert.match(patcher, /stable employee Screenshot seat key/);
});

test("approval gating preserves legitimate local coworker tools", () => {
  const bridge = require(path.join(root, "src", "bridge.cjs"));
  const names = [
    "Computer",
    "Shell",
    "Read",
    "ExternalShell",
    "ExternalRead",
    "CopyToBox",
    "CopyFromBox",
  ];
  const tools = names.map((name) => ({
    name,
    description: name,
    parameters: { type: "object" },
  }));
  assert.deepEqual(
    bridge.convertTools(tools).map((tool) => tool.function.name),
    names,
  );
});
