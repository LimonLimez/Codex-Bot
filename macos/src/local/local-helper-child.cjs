"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { normalizeRequest } = require("./local-helper-protocol.cjs");

const MAX_FILE_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 8192;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PATH_BYTES = 1024;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/;

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

function runFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout = "", stderr = "") => {
      const outputBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES || error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        reject(childError("Local command output is unavailable.", "OPENBOT_LOCAL_OUTPUT_LIMIT"));
        return;
      }
      if (error && !Number.isSafeInteger(error.code)) {
        reject(childError("Local command failed.", "OPENBOT_LOCAL_COMMAND_FAILED"));
        return;
      }
      resolve({
        exitCode: error && Number.isSafeInteger(error.code) ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function executeRequest(rawRequest, { workspacePath: rawWorkspacePath } = {}) {
  const request = normalizeRequest(rawRequest);
  const workspacePath = safeWorkspace(rawWorkspacePath);
  let value;
  if (request.operation === "shell.execute") {
    const input = exactObject(request.arguments, ["command"], "Shell command");
    if (typeof input.command !== "string" || input.command.length === 0
      || input.command.includes("\0") || Buffer.byteLength(input.command, "utf8") > MAX_COMMAND_BYTES) {
      throw childError("Shell command is invalid.", "OPENBOT_LOCAL_ARGUMENTS_INVALID");
    }
    value = await runFile("/bin/zsh", ["-f", "-c", input.command], {
      cwd: workspacePath,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
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
    });
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
  port.on("message", async (event) => {
    const message = event?.data ?? event;
    if (message?.type === "authorize") return;
    if (!message || message.type !== "run") {
      port.postMessage({ type: "fatal" });
      return;
    }
    try {
      port.postMessage({ type: "reply", reply: await executeRequest(message.request, { workspacePath }) });
    } catch (error) {
      const requestId = typeof message.request?.requestId === "string" ? message.request.requestId : "";
      port.postMessage({
        type: "reply",
        reply: {
          requestId,
          ok: false,
          errorCode: error instanceof LocalHelperChildError
            ? error.code
            : "OPENBOT_LOCAL_OPERATION_FAILED",
        },
      });
    }
  });
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
