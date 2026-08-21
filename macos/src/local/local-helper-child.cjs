"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { normalizeRequest } = require("./local-helper-protocol.cjs");

const MAX_FILE_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 8192;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PATH_BYTES = 1024;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/;
const STARTUP_NONCE_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_SHELL_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";

class LocalHelperChildError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalHelperChildError";
    this.code = code;
  }
}

function childError(message, code) {
  return new LocalHelperChildError(message, code);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw childError(`${label} is invalid.`, "OPENBOT_LOCAL_ARGUMENTS_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string"
    || !fields.includes(key) || !("value" in descriptors[key]))) {
    throw childError(`${label} is invalid.`, "OPENBOT_LOCAL_ARGUMENTS_INVALID");
  }
  const copy = {};
  for (const field of fields) {
    if (!descriptors[field]) throw childError(`${label} is invalid.`, "OPENBOT_LOCAL_ARGUMENTS_INVALID");
    copy[field] = descriptors[field].value;
  }
  return copy;
}

function safeWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw childError("Local workspace is unavailable.", "OPENBOT_LOCAL_WORKSPACE_INVALID");
  }
  return path.resolve(value);
}

async function privateTaskDirectory(target) {
  let created = false;
  try {
    await fs.mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw childError("Local task workspace is unavailable.", "OPENBOT_LOCAL_WORKSPACE_INVALID");
    }
  }
  if (created) {
    try { await fs.chmod(target, 0o700); } catch {
      throw childError("Local task workspace is unavailable.", "OPENBOT_LOCAL_WORKSPACE_INVALID");
    }
  }
  let stat;
  try { stat = await fs.lstat(target); } catch {
    throw childError("Local task workspace is unavailable.", "OPENBOT_LOCAL_WORKSPACE_INVALID");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw childError("Local task workspace is unavailable.", "OPENBOT_LOCAL_WORKSPACE_INVALID");
  }
  return target;
}

async function taskWorkspace(workspacePath, taskId) {
  const tasksPath = await privateTaskDirectory(path.join(workspacePath, "tasks"));
  return privateTaskDirectory(path.join(tasksPath, taskId));
}

function taskTempDirectory(workspacePath) {
  return privateTaskDirectory(path.join(workspacePath, "tmp"));
}

function confinedPath(workspacePath, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || path.isAbsolute(value) || value.includes("\\") || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw childError("Local resource is invalid.", "OPENBOT_LOCAL_RESOURCE_INVALID");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw childError("Local resource is invalid.", "OPENBOT_LOCAL_RESOURCE_INVALID");
  }
  const resolved = path.resolve(workspacePath, ...segments);
  if (resolved === workspacePath || !resolved.startsWith(`${workspacePath}${path.sep}`)) {
    throw childError("Local resource is invalid.", "OPENBOT_LOCAL_RESOURCE_INVALID");
  }
  return resolved;
}

async function rejectSymlinks(workspacePath, target, includeTarget) {
  const relative = path.relative(workspacePath, target);
  const segments = relative.split(path.sep);
  let current = workspacePath;
  const limit = includeTarget ? segments.length : segments.length - 1;
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error?.code === "ENOENT") break;
      throw childError("Local resource is unavailable.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
    }
    if (stat.isSymbolicLink()) {
      throw childError("Local resource is invalid.", "OPENBOT_LOCAL_RESOURCE_INVALID");
    }
  }
}

function cancellationError() {
  return childError("Local operation was cancelled.", "OPENBOT_LOCAL_CANCELLED");
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError();
}

function runFile(file, args, options, signal) {
  return new Promise((resolve, reject) => {
    const outputLimit = Number.isSafeInteger(options.maxBuffer)
      && options.maxBuffer > 0 && options.maxBuffer <= MAX_OUTPUT_BYTES
      ? options.maxBuffer
      : MAX_OUTPUT_BYTES;
    const timeoutMs = Number.isSafeInteger(options.timeout) && options.timeout > 0
      ? options.timeout
      : 0;
    let child;
    let settled = false;
    let termination = null;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let timeoutTimer = null;
    let killTimer = null;
    let forceTimer = null;

    const signalGroup = (name) => {
      if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1) return;
      try { process.kill(-child.pid, name); }
      catch {
        try { child.kill(name); } catch {}
      }
    };
    const cleanup = () => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      try { signal?.removeEventListener?.("abort", abort); } catch {}
    };
    const finish = (outcome, failed) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failed) reject(outcome);
      else resolve(outcome);
    };
    const terminationFailure = () => {
      if (termination === "cancel") return cancellationError();
      if (termination === "output") {
        return childError("Local command output is unavailable.", "OPENBOT_LOCAL_OUTPUT_LIMIT");
      }
      return childError("Local command failed.", "OPENBOT_LOCAL_COMMAND_FAILED");
    };
    const terminate = (reason) => {
      if (settled || termination !== null) return;
      termination = reason;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 50);
      killTimer.unref?.();
      forceTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        finish(terminationFailure(), true);
      }, 500);
      forceTimer.unref?.();
    };
    const abort = () => terminate("cancel");
    const collect = (chunk, target) => {
      if (settled || termination !== null) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > outputLimit) {
        terminate("output");
        return;
      }
      target.push(bytes);
    };

    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: options.windowsHide === true,
      });
    } catch {
      finish(childError("Local command failed.", "OPENBOT_LOCAL_COMMAND_FAILED"), true);
      return;
    }
    child.stdout.on("data", (chunk) => collect(chunk, stdout));
    child.stderr.on("data", (chunk) => collect(chunk, stderr));
    child.once("error", () => {
      signalGroup("SIGKILL");
      finish(termination === null
        ? childError("Local command failed.", "OPENBOT_LOCAL_COMMAND_FAILED")
        : terminationFailure(), true);
    });
    child.once("close", (code, closeSignal) => {
      // A shell can exit while detached descendants remain. Kill the whole group
      // before making completion or cancellation observable to the parent.
      signalGroup("SIGKILL");
      if (termination !== null) {
        finish(terminationFailure(), true);
        return;
      }
      if (!Number.isSafeInteger(code) || code < 0 || code > 255 || closeSignal !== null) {
        finish(childError("Local command failed.", "OPENBOT_LOCAL_COMMAND_FAILED"), true);
        return;
      }
      finish({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }, false);
    });
    try { signal?.addEventListener?.("abort", abort, { once: true }); } catch {
      terminate("cancel");
    }
    if (signal?.aborted) terminate("cancel");
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
      timeoutTimer.unref?.();
    }
  });
}

async function executeRequest(rawRequest, { workspacePath: rawWorkspacePath, signal } = {}) {
  const request = normalizeRequest(rawRequest);
  throwIfCancelled(signal);
  const workspacePath = await taskWorkspace(safeWorkspace(rawWorkspacePath), request.taskId);
  throwIfCancelled(signal);
  let value;
  if (request.operation === "shell.execute") {
    const input = exactObject(request.arguments, ["command"], "Shell command");
    if (typeof input.command !== "string" || input.command.length === 0
      || input.command.includes("\0") || Buffer.byteLength(input.command, "utf8") > MAX_COMMAND_BYTES) {
      throw childError("Shell command is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
    }
    const tempDirectory = await taskTempDirectory(workspacePath);
    value = await runFile("/bin/zsh", ["-f", "-c", input.command], {
      cwd: workspacePath,
      env: {
        PATH: LOCAL_SHELL_PATH,
        HOME: workspacePath,
        ZDOTDIR: workspacePath,
        TMPDIR: tempDirectory,
        SHELL: "/bin/zsh",
        LANG: "C.UTF-8",
      },
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, signal);
  } else if (request.operation === "filesystem.read") {
    const input = exactObject(request.arguments, ["relativePath"], "Read request");
    const file = confinedPath(workspacePath, input.relativePath);
    await rejectSymlinks(workspacePath, file, true);
    let stat;
    let content;
    try {
      stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("invalid");
      content = await fs.readFile(file, "utf8");
    } catch {
      throw childError("Local resource is unavailable.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES || content.includes("\0")) {
      throw childError("Local resource is unavailable.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
    }
    value = { content, bytesRead: Buffer.byteLength(content, "utf8") };
  } else if (request.operation === "filesystem.write") {
    const input = exactObject(request.arguments, ["relativePath", "content"], "Write request");
    if (typeof input.content !== "string" || input.content.includes("\0")
      || Buffer.byteLength(input.content, "utf8") > MAX_FILE_BYTES) {
      throw childError("Write request is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
    }
    const file = confinedPath(workspacePath, input.relativePath);
    await rejectSymlinks(workspacePath, file, false);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await rejectSymlinks(workspacePath, file, false);
      await fs.writeFile(file, input.content, { encoding: "utf8", mode: 0o600, flag: "w" });
      await fs.chmod(file, 0o600);
    } catch (error) {
      if (error instanceof LocalHelperChildError) throw error;
      throw childError("Local resource could not be written.", "OPENBOT_LOCAL_RESOURCE_WRITE_FAILED");
    }
    value = { bytesWritten: Buffer.byteLength(input.content, "utf8") };
  } else if (request.operation === "application.open") {
    const input = exactObject(request.arguments, ["bundleId"], "Application request");
    if (typeof input.bundleId !== "string" || !BUNDLE_ID_PATTERN.test(input.bundleId)) {
      throw childError("Application request is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
    }
    const result = await runFile("/usr/bin/open", ["-b", input.bundleId], {
      cwd: workspacePath,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4096,
      windowsHide: true,
    }, signal);
    if (result.exitCode !== 0) throw childError("Application could not be opened.", "OPENBOT_LOCAL_APPLICATION_FAILED");
    value = { opened: true, bundleId: input.bundleId };
  } else {
    throw childError("Local operation is unavailable.", "OPENBOT_LOCAL_OPERATION_UNAVAILABLE");
  }
  return { requestId: request.requestId, ok: true, value };
}

function installParentPort(port, workspacePath) {
  if (!port || typeof port.on !== "function" || typeof port.postMessage !== "function") {
    throw new TypeError("Local helper parent port is unavailable.");
  }
  const active = new Map();
  let started = false;
  let failed = false;
  const post = (value) => {
    try {
      port.postMessage(value);
      return true;
    } catch {
      return false;
    }
  };
  const fatal = () => {
    if (failed) return;
    failed = true;
    for (const controller of active.values()) {
      try { controller.abort(); } catch {}
    }
    post({ type: "fatal" });
  };
  const handleMessage = async (event) => {
    if (failed) return;
    const message = event?.data ?? event;
    if (!started) {
      let input;
      try {
        input = exactObject(message, ["type", "nonce"], "Startup challenge");
        if (input.type !== "startup-challenge" || typeof input.nonce !== "string"
          || !STARTUP_NONCE_PATTERN.test(input.nonce)) {
          throw childError("Startup challenge is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
        }
      } catch {
        fatal();
        return;
      }
      started = true;
      if (!post({ type: "startup-ack", nonce: input.nonce })) fatal();
      return;
    }
    if (message?.type === "authorize") return;
    if (message?.type === "cancel") {
      let input;
      try {
        input = exactObject(message, ["type", "requestId"], "Cancellation request");
        if (input.type !== "cancel" || typeof input.requestId !== "string"
          || !/^request-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
          throw childError("Cancellation request is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
        }
      } catch {
        fatal();
        return;
      }
      active.get(input.requestId.toLowerCase())?.abort();
      return;
    }
    if (!message || message.type !== "run") {
      fatal();
      return;
    }
    let request;
    let requestId = "";
    let controller;
    try {
      const input = exactObject(message, ["type", "request"], "Run request");
      if (input.type !== "run") throw childError("Run request is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
      request = normalizeRequest(input.request);
      requestId = request.requestId;
      if (active.has(requestId)) {
        fatal();
        return;
      }
      controller = new AbortController();
      active.set(requestId, controller);
      if (!post({
        type: "reply",
        reply: await executeRequest(request, { workspacePath, signal: controller.signal }),
      })) fatal();
    } catch (error) {
      if (!post({
        type: "reply",
        reply: {
          requestId,
          ok: false,
          errorCode: error instanceof LocalHelperChildError
            ? error.code
            : "OPENBOT_LOCAL_OPERATION_FAILED",
        },
      })) fatal();
    } finally {
      if (requestId !== "" && active.get(requestId) === controller) active.delete(requestId);
    }
  };
  port.on("message", (event) => handleMessage(event).catch(fatal));
  if (!post({ type: "ready" })) fatal();
}

if (require.main === module) {
  const port = process.parentPort;
  try { installParentPort(port, process.argv[2]); } catch {
    try { port?.postMessage?.({ type: "fatal" }); } catch {}
    process.exitCode = 1;
  }
}

module.exports = {
  LocalHelperChildError,
  executeRequest,
  installParentPort,
};
