"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const diffAuditPath = path.join(macRoot, "src", "patch", "diff-audit.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-mac-diff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = path.join(root, "before");
  const after = path.join(root, "after");
  for (const directory of [before, after]) {
    fs.mkdirSync(path.join(directory, "dist", "native"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), '{"productName":"Grok Bot"}\n');
    fs.writeFileSync(path.join(directory, "dist", "stock.cjs"), "stock bytes\n");
    fs.writeFileSync(path.join(directory, "dist", "native", "helper"), "native\n", {
      mode: 0o755,
    });
    fs.symlinkSync("stock.cjs", path.join(directory, "dist", "current.cjs"));
  }
  return { root, before, after };
}

test("the tree diff accepts only the explicit reviewed mutation allowlist", (t) => {
  const { auditTreeDiff, snapshotTree } = require(diffAuditPath);
  const trees = fixture(t);
  fs.writeFileSync(trees.after + "/package.json", '{"productName":"Codex Bot"}\n');
  const before = snapshotTree(trees.before);
  const after = snapshotTree(trees.after);
  assert.deepEqual(auditTreeDiff(before, after, ["package.json"]), ["package.json"]);

  fs.writeFileSync(path.join(trees.after, "dist", "stock.cjs"), "changed stock\n");
  assert.throws(
    () => auditTreeDiff(before, snapshotTree(trees.after), ["package.json"]),
    /unreviewed.*dist\/stock\.cjs|dist\/stock\.cjs.*unreviewed/i,
  );
});

test("the tree diff detects additions, removals, modes, and symlink targets", async (t) => {
  const { auditTreeDiff, snapshotTree } = require(diffAuditPath);
  for (const [name, mutate, expected] of [
    [
      "addition",
      ({ after }) => fs.writeFileSync(path.join(after, "poison.js"), "poison\n"),
      /poison\.js/,
    ],
    [
      "removal",
      ({ after }) => fs.rmSync(path.join(after, "dist", "stock.cjs")),
      /dist\/stock\.cjs/,
    ],
    [
      "mode",
      ({ after }) => fs.chmodSync(path.join(after, "dist", "native", "helper"), 0o644),
      /dist\/native\/helper/,
    ],
    [
      "symlink",
      ({ after }) => {
        fs.unlinkSync(path.join(after, "dist", "current.cjs"));
        fs.symlinkSync("native/helper", path.join(after, "dist", "current.cjs"));
      },
      /dist\/current\.cjs/,
    ],
  ]) {
    await t.test(name, () => {
      const trees = fixture(t);
      const before = snapshotTree(trees.before);
      mutate(trees);
      assert.throws(() => auditTreeDiff(before, snapshotTree(trees.after), []), expected);
    });
  }
});
