"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshotTree(rootPath) {
  const root = path.resolve(rootPath);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Patch diff root must be a real directory");
  }
  const snapshot = Object.create(null);
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    const absolute = directory === "" ? root : path.join(root, ...directory.split("/"));
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (
        relative.includes("\\") ||
        path.posix.isAbsolute(relative) ||
        path.posix.normalize(relative) !== relative
      ) {
        throw new Error(`Unsafe patch tree path: ${relative}`);
      }
      const target = path.join(root, ...relative.split("/"));
      const targetStat = fs.lstatSync(target);
      if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
        pending.push(relative);
      } else if (targetStat.isFile()) {
        snapshot[relative] = {
          type: "file",
          bytes: targetStat.size,
          mode: targetStat.mode & 0o777,
          sha256: hashFile(target),
        };
      } else if (targetStat.isSymbolicLink()) {
        snapshot[relative] = {
          type: "symlink",
          mode: targetStat.mode & 0o777,
          target: fs.readlinkSync(target),
        };
      } else {
        throw new Error(`Unsupported patch tree entry: ${relative}`);
      }
    }
  }
  return Object.freeze(snapshot);
}

function auditTreeDiff(before, after, allowedMutations) {
  if (
    before == null ||
    typeof before !== "object" ||
    after == null ||
    typeof after !== "object" ||
    !Array.isArray(allowedMutations)
  ) {
    throw new TypeError("auditTreeDiff requires two snapshots and an allowlist");
  }
  const allowed = new Set(allowedMutations);
  if (allowed.size !== allowedMutations.length) {
    throw new Error("Patch mutation allowlist contains duplicates");
  }
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const mutations = paths.filter(
    (relative) => JSON.stringify(before[relative]) !== JSON.stringify(after[relative]),
  );
  const unreviewed = mutations.filter((relative) => !allowed.has(relative));
  if (unreviewed.length > 0) {
    throw new Error(`Unreviewed patch mutation: ${unreviewed.join(", ")}`);
  }
  const missing = allowedMutations.filter((relative) => !mutations.includes(relative));
  if (missing.length > 0) {
    throw new Error(`Expected patch mutation did not occur: ${missing.join(", ")}`);
  }
  return mutations;
}

module.exports = { auditTreeDiff, snapshotTree };
