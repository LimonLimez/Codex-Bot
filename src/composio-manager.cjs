"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCHEMA_VERSION = 1;
const MAX_API_KEY_CHARS = 512;
const MAX_QUERY_CHARS = 500;
const MAX_TOOL_SLUG_CHARS = 160;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const TOOLKIT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const TOOL_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,159}$/;
const CONNECT_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.)*composio\.dev\//i;

class ComposioError extends Error {
  constructor(message, code = "COMPOSIO_ERROR", status = 400) {
    super(message);
    this.name = "ComposioError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stateDirectory() {
  const root = String(process.env.GROK_BOT_STATE_ROOT || "").trim();
  if (!path.isAbsolute(root))
    throw new ComposioError(
      "Open Bot's protected state directory is unavailable.",
      "COMPOSIO_STATE_UNAVAILABLE",
      503,
    );
  return path.join(root, "composio");
}

function runDpapi(script, input) {
  const result = spawnSync(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 },
  );
  if (result.status !== 0)
    throw new ComposioError(
      "Windows could not protect the Composio project key.",
      "COMPOSIO_KEY_PROTECTION_FAILED",
      500,
    );
  return String(result.stdout || "").trim();
}

function protectSecret(secret) {
  return runDpapi(
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))",
    secret,
  );
}

function unprotectSecret(protectedSecret) {
  return runDpapi(
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))",
    protectedSecret,
  );
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, filename);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
}

function normalizeStoredConfig(candidate) {
  if (
    !isPlainObject(candidate) ||
    candidate.schemaVersion !== SCHEMA_VERSION ||
    typeof candidate.userId !== "string" ||
    !/^openbot_[a-f0-9]{32}$/.test(candidate.userId) ||
    typeof candidate.protectedApiKey !== "string" ||
    candidate.protectedApiKey.length < 16 ||
    candidate.protectedApiKey.length > 4096
  )
    return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    userId: candidate.userId,
    protectedApiKey: candidate.protectedApiKey,
    sessionId:
      typeof candidate.sessionId === "string" &&
      /^[A-Za-z0-9_-]{8,160}$/.test(candidate.sessionId)
        ? candidate.sessionId
        : null,
  };
}

function readConfig() {
  try {
    return normalizeStoredConfig(
      JSON.parse(
        fs.readFileSync(path.join(stateDirectory(), "config.json"), "utf8"),
      ),
    );
  } catch {
    return null;
  }
}

function publicError(error) {
  if (error instanceof ComposioError) return error;
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 401 || status === 403)
    return new ComposioError(
      "That Composio project key was rejected.",
      "COMPOSIO_AUTH_FAILED",
      401,
    );
  return new ComposioError(
    "Composio is temporarily unavailable. Try again shortly.",
    "COMPOSIO_UNAVAILABLE",
    502,
  );
}

function boundedJson(value, maximum = MAX_RESULT_BYTES) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > maximum)
    throw new ComposioError(
      "The connected app returned too much data.",
      "COMPOSIO_RESULT_TOO_LARGE",
      502,
    );
  return JSON.parse(text);
}

function createComposioManager(options = {}) {
  const protect = options.protectSecret || protectSecret;
  const unprotect = options.unprotectSecret || unprotectSecret;
  const loadSdk =
    options.loadSdk ||
    (async () => {
      const { Composio } = await import("@composio/core");
      return { Composio };
    });
  let clientCache = null;
  let sessionCache = null;

  async function clientAndConfig() {
    const config = readConfig();
    if (!config)
      throw new ComposioError(
        "Connect a Composio project before using connected apps.",
        "COMPOSIO_NOT_CONFIGURED",
        409,
      );
    let apiKey;
    try {
      apiKey = unprotect(config.protectedApiKey);
    } catch {
      throw new ComposioError(
        "The protected Composio project key could not be read.",
        "COMPOSIO_KEY_UNREADABLE",
        409,
      );
    }
    if (
      typeof apiKey !== "string" ||
      apiKey.length < 8 ||
      apiKey.length > MAX_API_KEY_CHARS
    )
      throw new ComposioError(
        "The protected Composio project key is invalid.",
        "COMPOSIO_KEY_UNREADABLE",
        409,
      );
    if (!clientCache || clientCache.apiKey !== apiKey) {
      const { Composio } = await loadSdk();
      clientCache = {
        apiKey,
        client: new Composio({
          apiKey,
          allowTracking: false,
          dangerouslyAllowAutoUploadDownloadFiles: false,
          allowSensitiveFileUploads: false,
        }),
      };
      sessionCache = null;
    }
    return { config, client: clientCache.client };
  }

  async function session() {
    const { config, client } = await clientAndConfig();
    if (sessionCache?.id === config.sessionId && sessionCache.session)
      return sessionCache.session;
    try {
      let current = null;
      if (config.sessionId) {
        try {
          current = await client.sessions.use(config.sessionId);
        } catch {}
      }
      if (!current) {
        current = await client.sessions.create(config.userId, {
          manageConnections: false,
          sandbox: { enable: false, enableProxyExecution: false },
          multiAccount: { enable: true, requireExplicitSelection: true },
        });
        config.sessionId = current.sessionId;
        atomicWriteJson(path.join(stateDirectory(), "config.json"), config);
      }
      sessionCache = { id: current.sessionId, session: current };
      return current;
    } catch (error) {
      throw publicError(error);
    }
  }

  async function configure(apiKey) {
    const normalized = typeof apiKey === "string" ? apiKey.trim() : "";
    if (normalized.length < 8 || normalized.length > MAX_API_KEY_CHARS)
      throw new ComposioError(
        "Enter a valid Composio project key.",
        "COMPOSIO_INVALID_KEY",
      );
    const prior = readConfig();
    const config = {
      schemaVersion: SCHEMA_VERSION,
      userId:
        prior?.userId || `openbot_${crypto.randomBytes(16).toString("hex")}`,
      protectedApiKey: protect(normalized),
      sessionId: null,
    };
    atomicWriteJson(path.join(stateDirectory(), "config.json"), config);
    clientCache = null;
    sessionCache = null;
    await session();
    return status();
  }

  function disconnect() {
    clientCache = null;
    sessionCache = null;
    try {
      fs.rmSync(path.join(stateDirectory(), "config.json"), { force: true });
    } catch {
      throw new ComposioError(
        "Open Bot could not remove the protected Composio configuration.",
        "COMPOSIO_DISCONNECT_FAILED",
        500,
      );
    }
    return { configured: false };
  }

  function status() {
    return { configured: readConfig() != null };
  }

  async function listToolkits(options = {}) {
    const cursor =
      typeof options.cursor === "string" ? options.cursor : undefined;
    const query =
      typeof options.query === "string"
        ? options.query.trim().slice(0, 100)
        : "";
    try {
      const result = await (
        await session()
      ).toolkits({
        limit: 30,
        ...(cursor ? { cursor } : {}),
        ...(query ? { search: query } : {}),
      });
      return {
        items: (result.items || []).slice(0, 30).map((item) => ({
          slug: String(item.slug || "").slice(0, 80),
          name: String(item.name || item.slug || "").slice(0, 100),
          logo:
            typeof item.logo === "string" && /^https:\/\//i.test(item.logo)
              ? item.logo.slice(0, 2048)
              : null,
          connected: item.connection?.isActive === true,
          accountId:
            item.connection?.isActive === true &&
            typeof item.connection?.connectedAccount?.id === "string"
              ? item.connection.connectedAccount.id.slice(0, 160)
              : null,
        })),
        cursor:
          typeof result.cursor === "string"
            ? result.cursor.slice(0, 256)
            : null,
      };
    } catch (error) {
      throw publicError(error);
    }
  }

  async function authorize(toolkit) {
    if (!TOOLKIT_PATTERN.test(toolkit || ""))
      throw new ComposioError(
        "Choose a valid connected app.",
        "COMPOSIO_INVALID_TOOLKIT",
      );
    try {
      const request = await (await session()).authorize(toolkit);
      if (
        typeof request?.redirectUrl !== "string" ||
        !CONNECT_URL_PATTERN.test(request.redirectUrl)
      )
        throw new ComposioError(
          "Composio returned an unsafe connection address.",
          "COMPOSIO_UNSAFE_CONNECT_URL",
          502,
        );
      return {
        toolkit,
        connectedAccountId:
          typeof request.connectedAccountId === "string"
            ? request.connectedAccountId.slice(0, 160)
            : null,
        redirectUrl: request.redirectUrl,
      };
    } catch (error) {
      throw publicError(error);
    }
  }

  async function search(query, toolkits) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_CHARS)
      throw new ComposioError(
        "Describe the connected-app action to find.",
        "COMPOSIO_INVALID_QUERY",
      );
    const normalizedToolkits = Array.isArray(toolkits)
      ? toolkits.filter((value) => TOOLKIT_PATTERN.test(value)).slice(0, 8)
      : undefined;
    try {
      return boundedJson(
        await (
          await session()
        ).search({
          query: normalizedQuery,
          ...(normalizedToolkits?.length
            ? { toolkits: normalizedToolkits }
            : {}),
        }),
      );
    } catch (error) {
      throw publicError(error);
    }
  }

  async function execute(toolSlug, arguments_) {
    if (
      !TOOL_PATTERN.test(toolSlug || "") ||
      toolSlug.length > MAX_TOOL_SLUG_CHARS
    )
      throw new ComposioError(
        "Choose a valid connected-app action.",
        "COMPOSIO_INVALID_TOOL",
      );
    if (!isPlainObject(arguments_))
      throw new ComposioError(
        "Connected-app arguments must be an object.",
        "COMPOSIO_INVALID_ARGUMENTS",
      );
    if (
      Buffer.byteLength(JSON.stringify(arguments_), "utf8") > MAX_ARGUMENT_BYTES
    )
      throw new ComposioError(
        "Connected-app arguments are too large.",
        "COMPOSIO_ARGUMENTS_TOO_LARGE",
      );
    try {
      return boundedJson(await (await session()).execute(toolSlug, arguments_));
    } catch (error) {
      throw publicError(error);
    }
  }

  return Object.freeze({
    authorize,
    configure,
    disconnect,
    execute,
    listToolkits,
    search,
    status,
  });
}

const manager = createComposioManager();

module.exports = {
  ComposioError,
  createComposioManager,
  manager,
};
