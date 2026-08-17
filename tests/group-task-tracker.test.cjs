"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const stateRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "open-bot-group-task-test-"),
);
process.env.CODEX_BOT_STATE_ROOT = stateRoot;
const tracker = require(path.join(root, "src", "group-task-tracker.cjs"));

test.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));

test("group task tracker persists bounded, public teammate progress", () => {
  const task = tracker.begin({
    groupId: "group-01",
    groupName: "Research crew",
    summary: "Compare launch options for the next release.",
    members: [
      { id: "scout", name: "Scout" },
      { id: "writer", name: "Writer" },
    ],
  });
  assert.equal(task.groupId, "group-01");
  assert.equal(task.state, "active");
  assert.deepEqual(
    task.members.map((member) => member.status),
    ["queued", "queued"],
  );

  tracker.updateMember("group-01", task.id, "scout", "working");
  tracker.updateMember("group-01", task.id, "scout", "complete");
  tracker.updateMember("group-01", task.id, "writer", "passed");
  const complete = tracker.complete("group-01", task.id);
  assert.equal(complete.state, "complete");
  assert.deepEqual(
    complete.members.map((member) => member.status),
    ["complete", "passed"],
  );
  assert.deepEqual(tracker.latestTask("group-01"), complete);
  if (process.platform !== "win32") {
    const mode = fs.statSync(tracker.TRACKER_PATH).mode & 0o777;
    assert.equal(mode & 0o077, 0);
  }
});

test("group task tracker rejects unsafe identifiers and stale task updates", () => {
  assert.equal(tracker.begin({ groupId: "../unsafe", members: [] }), null);
  const task = tracker.begin({
    groupId: "group-02",
    groupName: "Safe group",
    summary: "A safe task",
    members: [{ id: "member-02", name: "Member" }],
  });
  assert.equal(
    tracker.updateMember(
      "group-02",
      "not-the-current-task",
      "member-02",
      "working",
    ),
    null,
  );
  assert.equal(
    tracker.updateMember("group-02", task.id, "member-02", "unknown"),
    null,
  );
  assert.equal(tracker.clear("group-02"), true);
  assert.equal(tracker.latestTask("group-02"), null);
});
