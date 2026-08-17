"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATE_ROOT =
  process.env.CODEX_BOT_STATE_ROOT ||
  path.join(process.env.LOCALAPPDATA || __dirname, "Open Bot");
const TRACKER_PATH = path.join(STATE_ROOT, "group-task-tracker.json");
const MAX_GROUPS = 24;
const MAX_MEMBERS = 16;

function safeText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TRACKER_PATH, "utf8"));
    return parsed?.version === 1 &&
      parsed?.groups &&
      typeof parsed.groups === "object"
      ? parsed
      : { version: 1, groups: {} };
  } catch {
    return { version: 1, groups: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(TRACKER_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${TRACKER_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, TRACKER_PATH);
  fs.chmodSync(TRACKER_PATH, 0o600);
}

function publicTask(task) {
  if (!task || typeof task !== "object") return null;
  const members = Array.isArray(task.members)
    ? task.members
        .map((member) => {
          const id = safeId(member?.id);
          if (!id) return null;
          const status = [
            "queued",
            "working",
            "complete",
            "passed",
            "blocked",
          ].includes(member?.status)
            ? member.status
            : "queued";
          return Object.freeze({
            id,
            name: safeText(member?.name, 80) || "Teammate",
            status,
            updatedAt: Number.isSafeInteger(member?.updatedAt)
              ? member.updatedAt
              : 0,
          });
        })
        .filter(Boolean)
        .slice(0, MAX_MEMBERS)
    : [];
  return Object.freeze({
    id: safeId(task.id) || "",
    groupId: safeId(task.groupId) || "",
    groupName: safeText(task.groupName, 120) || "Group work",
    summary:
      safeText(task.summary, 240) || "Working on the latest group request",
    state: task.state === "complete" ? "complete" : "active",
    createdAt: Number.isSafeInteger(task.createdAt) ? task.createdAt : 0,
    updatedAt: Number.isSafeInteger(task.updatedAt) ? task.updatedAt : 0,
    members,
  });
}

function latestTask(groupId) {
  const id = safeId(groupId);
  if (!id) return null;
  return publicTask(readState().groups[id]);
}

function begin({ groupId, groupName, summary, members }) {
  const id = safeId(groupId);
  if (!id) return null;
  const now = Date.now();
  const task = {
    id: crypto.randomUUID(),
    groupId: id,
    groupName: safeText(groupName, 120) || "Group work",
    summary: safeText(summary, 240) || "Working on the latest group request",
    state: "active",
    createdAt: now,
    updatedAt: now,
    members: (Array.isArray(members) ? members : [])
      .map((member) => {
        const memberId = safeId(member?.id);
        if (!memberId) return null;
        return {
          id: memberId,
          name: safeText(member?.name, 80) || "Teammate",
          status: "queued",
          updatedAt: now,
        };
      })
      .filter(Boolean)
      .slice(0, MAX_MEMBERS),
  };
  try {
    const state = readState();
    state.groups[id] = task;
    const groups = Object.entries(state.groups)
      .sort(
        ([, left], [, right]) =>
          (right?.updatedAt || 0) - (left?.updatedAt || 0),
      )
      .slice(0, MAX_GROUPS);
    state.groups = Object.fromEntries(groups);
    writeState(state);
    return publicTask(task);
  } catch {
    return null;
  }
}

function updateMember(groupId, taskId, memberId, status) {
  const id = safeId(groupId);
  const taskKey = safeId(taskId);
  const memberKey = safeId(memberId);
  if (!id || !taskKey || !memberKey) return null;
  if (!new Set(["working", "complete", "passed", "blocked"]).has(status))
    return null;
  try {
    const state = readState();
    const task = state.groups[id];
    if (!task || task.id !== taskKey) return null;
    const member = task.members?.find(
      (candidate) => candidate?.id === memberKey,
    );
    if (!member) return null;
    member.status = status;
    member.updatedAt = Date.now();
    task.updatedAt = member.updatedAt;
    writeState(state);
    return publicTask(task);
  } catch {
    return null;
  }
}

function complete(groupId, taskId) {
  const id = safeId(groupId);
  const taskKey = safeId(taskId);
  if (!id || !taskKey) return null;
  try {
    const state = readState();
    const task = state.groups[id];
    if (!task || task.id !== taskKey) return null;
    task.state = "complete";
    task.updatedAt = Date.now();
    writeState(state);
    return publicTask(task);
  } catch {
    return null;
  }
}

function clear(groupId) {
  const id = safeId(groupId);
  if (!id) return false;
  try {
    const state = readState();
    if (!Object.hasOwn(state.groups, id)) return false;
    delete state.groups[id];
    writeState(state);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  TRACKER_PATH,
  begin,
  clear,
  complete,
  latestTask,
  updateMember,
};
