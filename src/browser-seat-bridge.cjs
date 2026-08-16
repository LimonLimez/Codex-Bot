"use strict";

const fs = require("node:fs");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const manager = require(
  path.join(__dirname, "browser-seats", "browser-seat-manager.cjs"),
);
const connectionManager = require(path.join(__dirname, "codex-connection.cjs"));
const officialComputer = require(
  path.join(__dirname, "official-computer-client.cjs"),
);

const STATE_ROOT =
  process.env.CODEX_BOT_STATE_ROOT ||
  path.join(process.env.LOCALAPPDATA || __dirname, "Open Bot");
const LOG_PATH = path.join(STATE_ROOT, "logs", "browser-seats.jsonl");

function log(event, detail = {}) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ time: new Date().toISOString(), event, ...connectionManager.redactLogDetails(detail) })}\n`,
    );
  } catch {}
}

function coordinate(value) {
  if (!value) return undefined;
  return { x: Number(value.x || 0), y: Number(value.y || 0) };
}

function serializeAction(item) {
  const action = item?.action;
  const kind = action?.case;
  const value = action?.value || {};
  switch (kind) {
    case "click":
      return {
        kind,
        coordinate: coordinate(value.coordinate),
        button: value.button,
        count: value.count || 1,
      };
    case "mouseMove":
      return { kind, coordinate: coordinate(value.coordinate) };
    case "drag":
      return {
        kind,
        path: (value.path || []).map(coordinate),
        button: value.button,
      };
    case "type":
      return { kind, text: value.text || "" };
    case "key":
      return { kind, key: value.key || "" };
    case "scroll":
      return {
        kind,
        coordinate: coordinate(value.coordinate),
        direction: value.direction,
        amount: value.amount || 3,
      };
    case "wait":
      return {
        kind,
        durationMs: Number(
          value.durationMs || (value.seconds ? value.seconds * 1000 : 1000),
        ),
      };
    case "screenshot":
      return { kind };
    default:
      return { kind: String(kind || "unknown") };
  }
}

const VIEW_PORT = Math.max(
  1024,
  Math.min(65535, Number(process.env.GROK_BOT_BROWSER_VIEW_PORT || 18318)),
);
const VIEW_TOKEN = process.env.GROK_BOT_BROWSER_VIEW_TOKEN;
if (!VIEW_TOKEN || VIEW_TOKEN.length < 24)
  throw new Error("GROK_BOT_BROWSER_VIEW_TOKEN must be a per-install secret.");
const VIEW_SERVER_KEY = Symbol.for("codexbot.browserSeatViewServer");

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const MAX_JSON_BODY_BYTES = 1_000_000;

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireExactBodyKeys(body, expected) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw requestError("The request body must be a JSON object.", 400);
  }
  const actual = Object.keys(body).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    throw requestError("The request contained unsupported fields.", 400);
  }
}

function requireNoQuery(
  url,
  message = "This endpoint does not accept query fields.",
) {
  if ([...url.searchParams].length !== 0) throw requestError(message, 400);
}

function safePublicText(value, maxLength = 1000) {
  return connectionManager
    .redactSensitiveText(String(value == null ? "" : value))
    .slice(0, maxLength);
}

function normalizeOfficialLoginResult(value) {
  let url;
  try {
    url = new URL(String(value?.loginUrl || ""));
  } catch {
    throw requestError(
      "The official-computer helper returned an invalid sign-in link.",
      502,
    );
  }
  const expectedKeys = ["challenge", "mode", "redirectTarget", "uuid"];
  const actualKeys = [...url.searchParams.keys()].sort();
  if (
    url.origin !== "https://cursor.com" ||
    url.pathname !== "/loginDeepControl" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("challenge") || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      url.searchParams.get("uuid") || "",
    ) ||
    url.searchParams.get("mode") !== "login" ||
    url.searchParams.get("redirectTarget") !== "sand"
  ) {
    throw requestError(
      "The official-computer helper returned an invalid sign-in link.",
      502,
    );
  }
  return Object.freeze({ loginUrl: url.href, state: "signing-in" });
}

function openOfficialLoginInDefaultBrowser(loginUrl) {
  const safe = normalizeOfficialLoginResult({ loginUrl }).loginUrl;
  if (process.platform !== "win32")
    throw requestError("Open Bot could not open the Cursor sign-in page.", 503);
  const launcher = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "rundll32.exe",
  );
  if (!fs.existsSync(launcher))
    throw requestError("Open Bot could not open the Cursor sign-in page.", 503);
  return new Promise((resolve, reject) => {
    const processHandle = childProcess.spawn(
      launcher,
      ["url.dll,FileProtocolHandler", safe],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    processHandle.once("spawn", () => {
      processHandle.unref();
      resolve(safe);
    });
    processHandle.once("error", () =>
      reject(
        requestError("Open Bot could not open the Cursor sign-in page.", 503),
      ),
    );
  });
}

function normalizeCursor(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return {
    x: Number.isFinite(x) ? Math.max(0, Math.min(manager.WIDTH, x)) : 0,
    y: Number.isFinite(y) ? Math.max(0, Math.min(manager.HEIGHT, y)) : 0,
  };
}

function normalizeProviderMetadata(value, provider) {
  if (provider === officialComputer) {
    return Object.freeze({
      url: "official-computer://shared-primary",
      title: "Official vendor cloud computer",
      profileId: "official-cloud-primary",
      activeSeatCount: 1,
      provider: "official",
      shared: true,
    });
  }
  const activeSeatCount = Number(value?.activeSeatCount);
  return Object.freeze({
    url: safePublicText(value?.url, 8192),
    title: safePublicText(value?.title || "Untitled", 1000),
    profileId: safePublicText(value?.profileId, 200),
    activeSeatCount:
      Number.isSafeInteger(activeSeatCount) && activeSeatCount >= 0
        ? activeSeatCount
        : 0,
    provider: "private",
    shared: false,
  });
}

function normalizePageState(value) {
  const state = String(value || "unavailable");
  return new Set([
    "loaded",
    "loading",
    "blank",
    "empty",
    "error",
    "challenge",
    "unavailable",
  ]).has(state)
    ? state
    : "unavailable";
}

function normalizePngBase64(value, message) {
  const screenshotBase64 = String(value || "");
  if (
    screenshotBase64.length < 12 ||
    screenshotBase64.length > 32 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(screenshotBase64)
  ) {
    throw requestError(message, 502);
  }
  let signature;
  try {
    signature = Buffer.from(screenshotBase64.slice(0, 24), "base64").subarray(
      0,
      8,
    );
  } catch {
    signature = Buffer.alloc(0);
  }
  if (!signature.equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw requestError(message, 502);
  }
  return screenshotBase64;
}

function normalizeFrame(value, provider) {
  const screenshotBase64 = normalizePngBase64(
    value?.screenshotBase64,
    "The computer provider returned an invalid PNG frame.",
  );
  const metadata = normalizeProviderMetadata(value, provider);
  const generation = Number(value?.generation);
  return Object.freeze({
    screenshotBase64,
    mimeType: "image/png",
    width: manager.WIDTH,
    height: manager.HEIGHT,
    cursorPosition: normalizeCursor(value?.cursorPosition),
    ...metadata,
    pageState: normalizePageState(value?.pageState),
    generation:
      Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
  });
}

function normalizeActionOutput(value, provider) {
  return Object.freeze({
    ...normalizeProviderMetadata(value, provider),
    pageState: normalizePageState(value?.pageState),
  });
}

function normalizeControlStatus(value) {
  const expiresAt = Number(value?.expiresAt);
  return Object.freeze({
    controlled: value?.controlled === true,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
  });
}

function normalizeApprovalPresentation(value) {
  const source = Array.isArray(value?.actions) ? value.actions : [];
  return {
    actions: source.slice(0, 64).map((action) => ({
      kind: safePublicText(action?.kind || "interactive action", 80),
      ...(action?.destination
        ? { destination: safePublicText(action.destination, 1000) }
        : {}),
      ...(action?.target && typeof action.target === "object"
        ? {
            target: {
              ...(action.target.name
                ? { name: safePublicText(action.target.name, 200) }
                : {}),
              ...(action.target.role
                ? { role: safePublicText(action.target.role, 80) }
                : {}),
              ...(action.target.fieldType
                ? { fieldType: safePublicText(action.target.fieldType, 80) }
                : {}),
            },
          }
        : {}),
      ...(action?.form && typeof action.form === "object"
        ? {
            form: {
              ...(action.form.method
                ? { method: safePublicText(action.form.method, 20) }
                : {}),
              ...(action.form.destination
                ? { destination: safePublicText(action.form.destination, 1000) }
                : {}),
            },
          }
        : {}),
      ...(action?.typedContent && typeof action.typedContent === "object"
        ? {
            typedContent: {
              category: safePublicText(action.typedContent.category, 80),
              length: Math.max(
                0,
                Math.min(20000, Number(action.typedContent.length) || 0),
              ),
            },
          }
        : {}),
    })),
  };
}

function normalizeApprovalFrame(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw requestError(
      "The official computer returned an invalid approval frame.",
      502,
    );
  const generation = Number(value.generation);
  const sequence = Number(value.sequence);
  const sha256 = String(value.sha256 || "");
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    throw requestError(
      "The official computer returned an invalid approval frame binding.",
      502,
    );
  const screenshotBase64 = normalizePngBase64(
    value.screenshotBase64,
    "The official computer returned an invalid approval PNG.",
  );
  const screenshotHash = crypto
    .createHash("sha256")
    .update(Buffer.from(screenshotBase64, "base64"))
    .digest("hex");
  if (screenshotHash !== sha256)
    throw requestError(
      "The official computer returned a mismatched approval frame.",
      502,
    );
  return Object.freeze({
    generation,
    sequence,
    sha256,
    screenshotBase64,
    mimeType: "image/png",
  });
}

function normalizePendingApproval(value, provider) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(
      "The computer provider returned an invalid approval.",
      502,
    );
  }
  const expiresAt = Number(value.expiresAt);
  return Object.freeze({
    requestId: safePublicText(value.requestId, 200),
    seatId: safePublicText(value.seatId, 200),
    origin: safePublicText(value.origin, 1000),
    actionDigest: safePublicText(value.actionDigest, 200),
    riskClass: safePublicText(value.riskClass, 80),
    summary: safePublicText(value.summary, 1000),
    presentation: normalizeApprovalPresentation(value.presentation),
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0,
    siteLeaseAvailable: false,
    ...(provider === officialComputer
      ? { frame: normalizeApprovalFrame(value.frame) }
      : {}),
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      size += bytes.length;
      if (size > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        chunks = [];
        reject(requestError("Seat-control request is too large.", 413));
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        const body = chunks.length
          ? Buffer.concat(chunks, size).toString("utf8")
          : "";
        chunks = [];
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(requestError("Seat-control request is not valid JSON.", 400));
      }
    });
    request.on("error", reject);
  });
}

const OFFICIAL_STATES = new Set([
  "disconnected",
  "signed-in",
  "signing-in",
  "sign-in-error",
  "sign-in-blocked",
  "checking-access",
  "provisioning",
  "connecting-view",
  "ready",
  "payment-required",
  "unavailable",
]);
let providerEpoch = 0;
let providerTransition = false;
let activeProviderMutations = 0;

function normalizeOfficialPermissions(value) {
  return Object.freeze({
    provider: "official-grok-cloud",
    alwaysAllowComputerActions:
      value?.provider === "official-grok-cloud" &&
      value?.alwaysAllowComputerActions === true,
  });
}

function normalizeOfficialStatus(value) {
  const mode = value?.mode;
  if (mode !== "private" && mode !== "official") {
    throw requestError(
      "The official-computer helper returned an invalid provider mode.",
      503,
    );
  }
  const state = String(value?.state || "disconnected");
  const generation = Number(value?.generation);
  const retryAfterMs = Number(value?.retryAfterMs);
  const retryAttempt = Number(value?.retryAttempt);
  const retryStage = new Set(["access", "provision", "viewer"]).has(
    String(value?.retryStage || ""),
  )
    ? String(value.retryStage)
    : null;
  const retrying =
    mode === "official" &&
    value?.retrying === true &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0;
  return Object.freeze({
    mode,
    connected: value?.connected === true,
    state: OFFICIAL_STATES.has(state) ? state : "unavailable",
    ready: mode === "official" && value?.ready === true,
    generation:
      Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    shared: true,
    provider: "official-grok-cloud",
    experimental: true,
    billingPossible: true,
    permissions: normalizeOfficialPermissions(value?.permissions),
    retrying,
    retryAfterMs: retrying
      ? Math.min(300_000, Math.max(1, Math.ceil(retryAfterMs)))
      : 0,
    retryAttempt:
      retrying && Number.isSafeInteger(retryAttempt)
        ? Math.min(32, Math.max(1, retryAttempt))
        : 0,
    retryStage: retrying ? retryStage : null,
    lastError: value?.lastError
      ? connectionManager
          .redactSensitiveText(String(value.lastError))
          .slice(0, 1000)
      : null,
  });
}

async function publicOfficialStatus() {
  try {
    return normalizeOfficialStatus(await officialComputer.status());
  } catch (error) {
    return {
      mode: "unknown",
      connected: false,
      state: "helper-unavailable",
      ready: false,
      shared: true,
      provider: "official-grok-cloud",
      experimental: true,
      billingPossible: true,
      permissions: Object.freeze({
        provider: "official-grok-cloud",
        alwaysAllowComputerActions: false,
      }),
      retrying: false,
      retryAfterMs: 0,
      retryAttempt: 0,
      retryStage: null,
      lastError: connectionManager.redactError(error).message,
    };
  }
}

async function computerProvider() {
  const status = normalizeOfficialStatus(await officialComputer.status());
  if (status.mode === "official") return officialComputer;
  if (status.mode === "private") return manager;
  throw requestError("The computer provider is unavailable.", 503);
}

function assertProviderStable(epoch) {
  if (providerTransition || epoch !== providerEpoch) {
    throw requestError(
      "The computer provider changed while this operation was running.",
      409,
    );
  }
}

async function withProviderRead(operation) {
  if (providerTransition)
    throw requestError("The computer provider is changing. Try again.", 409);
  const epoch = providerEpoch;
  const provider = await computerProvider();
  assertProviderStable(epoch);
  const result = await operation(provider);
  assertProviderStable(epoch);
  return result;
}

async function withProviderMutation(operation) {
  if (providerTransition)
    throw requestError("The computer provider is changing. Try again.", 409);
  const epoch = providerEpoch;
  activeProviderMutations += 1;
  try {
    const provider = await computerProvider();
    assertProviderStable(epoch);
    const result = await operation(provider);
    assertProviderStable(epoch);
    return result;
  } finally {
    activeProviderMutations -= 1;
  }
}

async function changeOfficialComputerState(operation) {
  if (providerTransition || activeProviderMutations !== 0) {
    throw requestError(
      "Finish or deny the current computer action before changing providers.",
      409,
    );
  }
  providerTransition = true;
  providerEpoch += 1;
  try {
    return await operation();
  } finally {
    providerTransition = false;
  }
}

const providerManager = Object.freeze({
  async ensureSeat(seatKey) {
    return withProviderRead(async (provider) => {
      if (provider === manager) return manager.ensureSeat(seatKey);
      return true;
    });
  },
  async closeSeatForKey(seatKey, reason) {
    return withProviderMutation((provider) =>
      provider === manager
        ? manager.closeSeatForKey(seatKey, reason)
        : officialComputer.closeSeatForKey(seatKey),
    );
  },
});

function startViewServer({
  openOfficialLogin = openOfficialLoginInDefaultBrowser,
} = {}) {
  if (globalThis[VIEW_SERVER_KEY]) return globalThis[VIEW_SERVER_KEY];
  const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Codex-Seat-Token",
    );
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${VIEW_PORT}`);
    if (request.method === "GET" && url.pathname === "/api/identity") {
      const nonce = url.searchParams.get("nonce") || "";
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
        sendJson(response, 400, { error: "A valid client nonce is required." });
        return;
      }
      const proof = crypto
        .createHmac("sha256", VIEW_TOKEN)
        .update(`codex-bot-view:${nonce}`)
        .digest("base64url");
      sendJson(response, 200, { proof });
      return;
    }
    if (request.headers["x-codex-seat-token"] !== VIEW_TOKEN) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/codex/status") {
        for (const key of url.searchParams.keys()) {
          if (key !== "agentId")
            throw new connectionManager.SettingsValidationError(
              `Unknown status query field: ${key}.`,
            );
        }
        const agentIds = url.searchParams.getAll("agentId");
        if (agentIds.length > 1)
          throw new connectionManager.SettingsValidationError(
            "Only one agentId may be requested.",
          );
        sendJson(response, 200, {
          ...connectionManager.publicStatus(
            agentIds.length ? agentIds[0] : null,
          ),
          officialComputer: await publicOfficialStatus(),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/codex/settings") {
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            String(request.headers["content-type"] || ""),
          )
        ) {
          throw new connectionManager.SettingsValidationError(
            "Codex settings require an application/json request.",
          );
        }
        const result = connectionManager.applySettingsUpdate(
          await readJson(request),
        );
        sendJson(response, 200, {
          ok: true,
          operation: result.operation,
          status: connectionManager.publicStatus(result.preferences.agentId),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/codex/auth") {
        const body = await readJson(request);
        const action = String(body.action || "");
        if (action === "provider-login") {
          requireExactBodyKeys(body, ["action", "provider"]);
          const login = await connectionManager.beginProviderLogin(
            body.provider,
          );
          sendJson(response, 202, { ok: true, ...login });
          return;
        }
        if (action === "cancel-provider-login") {
          requireExactBodyKeys(body, ["action", "provider"]);
          const result = connectionManager.cancelProviderLogin(body.provider);
          sendJson(response, 200, { ok: true, ...result });
          return;
        }
        if (action === "use-provider") {
          requireExactBodyKeys(body, ["action", "provider"]);
          sendJson(response, 200, {
            ok: true,
            status: connectionManager.useProvider(body.provider),
          });
          return;
        }
        if (action === "local-connect") {
          requireExactBodyKeys(body, ["action", "baseUrl", "apiKey"]);
          const status = await connectionManager.configureLocalProvider({
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
          });
          sendJson(response, 200, { ok: true, status });
          return;
        }
        if (action === "vertex-import") {
          requireExactBodyKeys(body, ["action", "provider", "serviceAccount"]);
          if (body.provider !== "vertex")
            throw new connectionManager.SettingsValidationError(
              'Vertex imports require provider "vertex".',
            );
          const status = await connectionManager.importVertexServiceAccount(
            body.serviceAccount,
          );
          sendJson(response, 200, { ok: true, status });
          return;
        }
        if (action === "oauth") {
          requireExactBodyKeys(body, ["action"]);
          const device = await connectionManager.beginCodexOAuth();
          sendJson(response, 202, { ok: true, ...device });
          return;
        }
        if (action === "use-oauth") {
          requireExactBodyKeys(body, ["action"]);
          sendJson(response, 200, {
            ok: true,
            status: connectionManager.useProvider("codex"),
          });
          return;
        }
        if (action === "api-key") {
          requireExactBodyKeys(body, ["action", "apiKey"]);
          const key = String(body.apiKey || "").trim();
          await connectionManager.verifyApiKey(key);
          connectionManager.setApiKey(key);
          sendJson(response, 200, {
            ok: true,
            status: connectionManager.publicStatus(),
          });
          return;
        }
        throw new Error("Unknown Codex connection action.");
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/official-computer"
      ) {
        requireNoQuery(url);
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            String(request.headers["content-type"] || ""),
          )
        ) {
          throw requestError(
            "Official computer requests require application/json.",
            400,
          );
        }
        const body = await readJson(request);
        const action = String(body.action || "");
        let result = Object.freeze({ completed: true });
        if (action === "login") {
          requireExactBodyKeys(body, ["action"]);
          result = await changeOfficialComputerState(async () => {
            const login = normalizeOfficialLoginResult(
              await officialComputer.startLogin(),
            );
            try {
              await openOfficialLogin(login.loginUrl);
            } catch (error) {
              await Promise.resolve(officialComputer.cancelLogin()).catch(
                () => {},
              );
              throw error;
            }
            return login;
          });
        } else if (action === "cancel-login") {
          requireExactBodyKeys(body, ["action"]);
          await changeOfficialComputerState(() =>
            officialComputer.cancelLogin(),
          );
        } else if (action === "disconnect") {
          requireExactBodyKeys(body, ["action"]);
          await changeOfficialComputerState(() => officialComputer.logout());
        } else if (action === "mode") {
          requireExactBodyKeys(
            body,
            body.mode === "official"
              ? ["acknowledged", "action", "mode"]
              : ["action", "mode"],
          );
          await changeOfficialComputerState(() =>
            officialComputer.setMode(
              String(body.mode || ""),
              body.acknowledged === true,
            ),
          );
        } else if (action === "permissions") {
          requireExactBodyKeys(body, [
            "acknowledged",
            "action",
            "alwaysAllowComputerActions",
            "provider",
          ]);
          if (
            typeof body.alwaysAllowComputerActions !== "boolean" ||
            body.provider !== "official-grok-cloud" ||
            typeof body.acknowledged !== "boolean"
          )
            throw requestError(
              "The vendor computer permission request is invalid.",
              400,
            );
          result = normalizeOfficialPermissions(
            await officialComputer.setComputerPermissions(
              body.alwaysAllowComputerActions,
              body.acknowledged,
              body.provider,
            ),
          );
        } else throw requestError("Unknown official computer action.", 400);
        sendJson(response, 200, {
          ok: true,
          result,
          status: await publicOfficialStatus(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/frame") {
        for (const key of url.searchParams.keys()) {
          if (key !== "seatKey")
            throw requestError("Unknown frame query field.", 400);
        }
        if (url.searchParams.getAll("seatKey").length !== 1)
          throw requestError("One employee seat key is required.", 400);
        const seatKey = String(url.searchParams.get("seatKey") || "");
        if (!seatKey || seatKey.length > 200)
          throw new Error("A valid employee seat key is required.");
        const frame = await withProviderRead(async (provider) =>
          normalizeFrame(await provider.captureSeat(seatKey), provider),
        );
        sendJson(response, 200, frame);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/input") {
        requireNoQuery(url);
        const body = await readJson(request);
        const seatKey = String(body.seatKey || "");
        const actions = Array.isArray(body.actions)
          ? body.actions
          : body.action
            ? [body.action]
            : [];
        if (!seatKey || seatKey.length > 200)
          throw new Error("A valid employee seat key is required.");
        if (actions.length === 0 || actions.length > 64)
          throw new Error("One to 64 input actions are required.");
        const output = await withProviderMutation(async (provider) =>
          normalizeActionOutput(
            await provider.executeSeatActions(seatKey, actions, {
              actor: "user",
              controlId: String(body.controlId || ""),
            }),
            provider,
          ),
        );
        sendJson(response, 200, {
          ok: true,
          url: output.url,
          title: output.title,
          pageState: output.pageState,
          profileId: output.profileId,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/control") {
        for (const key of url.searchParams.keys()) {
          if (key !== "seatKey")
            throw requestError("Unknown control query field.", 400);
        }
        if (url.searchParams.getAll("seatKey").length !== 1)
          throw requestError("One employee seat key is required.", 400);
        const seatKey = String(url.searchParams.get("seatKey") || "");
        if (!seatKey || seatKey.length > 200)
          throw new Error("A valid employee seat key is required.");
        const control = await withProviderRead(async (provider) =>
          normalizeControlStatus(await provider.controlStatusForSeat(seatKey)),
        );
        sendJson(response, 200, control);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/control") {
        requireNoQuery(url);
        const body = await readJson(request);
        const seatKey = String(body.seatKey || "");
        const controlId = String(body.controlId || "");
        const action = String(body.action || "");
        if (!seatKey || seatKey.length > 200)
          throw new Error("A valid employee seat key is required.");
        if (action === "acquire") {
          const control = await withProviderMutation(async (provider) =>
            normalizeControlStatus(
              await provider.acquireUserControl(seatKey, controlId),
            ),
          );
          sendJson(response, 200, {
            ok: true,
            ...control,
          });
          return;
        }
        if (action === "heartbeat") {
          const control = await withProviderMutation(async (provider) =>
            normalizeControlStatus(
              await provider.heartbeatUserControl(seatKey, controlId),
            ),
          );
          sendJson(response, 200, {
            ok: true,
            ...control,
          });
          return;
        }
        if (action === "release") {
          const released = await withProviderMutation((provider) =>
            provider.releaseUserControl(seatKey, controlId),
          );
          sendJson(response, 200, {
            ok: released === true,
          });
          return;
        }
        throw new Error("Unknown browser control action.");
      }
      if (request.method === "GET" && url.pathname === "/api/approval") {
        for (const key of url.searchParams.keys()) {
          if (key !== "seatKey")
            throw requestError("Unknown approval query field.", 400);
        }
        if (url.searchParams.getAll("seatKey").length !== 1)
          throw requestError("One employee seat key is required.", 400);
        const seatKey = String(url.searchParams.get("seatKey") || "");
        if (!seatKey || seatKey.length > 200)
          throw new Error("A valid employee seat key is required.");
        const pending = await withProviderRead(async (provider) =>
          normalizePendingApproval(
            await provider.pendingApprovalForSeat(seatKey),
            provider,
          ),
        );
        sendJson(response, 200, {
          pending,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/approvals") {
        requireNoQuery(url);
        const pending = await withProviderRead(async (provider) => {
          const values = await provider.pendingApprovals();
          if (!Array.isArray(values)) return [];
          return values
            .slice(0, 16)
            .map((value) => normalizePendingApproval(value, provider))
            .filter(Boolean);
        });
        sendJson(response, 200, { pending });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/approval") {
        requireNoQuery(url);
        const body = await readJson(request);
        const seatKey = String(body.seatKey || "");
        const decision = String(body.decision || "");
        if (!seatKey || seatKey.length > 200)
          throw new Error("A valid employee seat key is required.");
        const accepted = await withProviderMutation((provider) =>
          provider.decidePendingApproval(seatKey, decision, body.binding),
        );
        const ok = accepted === true;
        sendJson(response, ok ? 200 : 409, { ok });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        requireNoQuery(url);
        sendJson(response, 200, {
          seats: manager.status(),
          maxActive: manager.MAX_ACTIVE,
          officialComputer: await publicOfficialStatus(),
        });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const requestedStatus = Number(error?.statusCode);
      const statusCode =
        Number.isInteger(requestedStatus) &&
        requestedStatus >= 400 &&
        requestedStatus < 600
          ? requestedStatus
          : 500;
      const message = connectionManager.redactError(error).message;
      log("view_server_error", { error: message });
      sendJson(response, statusCode, { error: message });
    }
  });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      log("view_server_port_conflict", { port: VIEW_PORT });
      throw new Error(
        `Refusing to trust an existing browser-view listener on port ${VIEW_PORT}.`,
      );
    }
    log("view_server_listen_error", {
      port: VIEW_PORT,
      error: connectionManager.redactError(error).message,
    });
    throw error;
  });
  server.listen(VIEW_PORT, "127.0.0.1", () =>
    log("view_server_ready", { port: VIEW_PORT }),
  );
  server.unref();
  globalThis[VIEW_SERVER_KEY] = server;
  return server;
}

function createExecutor(types) {
  const {
    ComputerUseResult,
    ComputerUseSuccess,
    ComputerUseError,
    Coordinate,
  } = types;
  const seatKey = String(types.seatKey || "default-seat");
  return {
    async execute(_ctx, args) {
      const started = Date.now();
      try {
        const actions = (args.actions || []).map(serializeAction);
        log("execute", {
          seatKeyHash: manager.profileIdFor(seatKey),
          toolCallId: args.toolCallId,
          actions: actions.map((action) => action.kind),
        });
        const output = await withProviderMutation(async (provider) =>
          normalizeFrame(
            await provider.executeSeatActions(seatKey, actions, {
              actor: "agent",
            }),
            provider,
          ),
        );
        const stateGuidance =
          output.pageState === "challenge"
            ? "BLOCKED: a verification/CAPTCHA challenge is visible. Do not claim the target page loaded; ask the user to open this employee's browser profile and complete the challenge."
            : output.pageState === "blank" || output.pageState === "empty"
              ? "NOT LOADED: the page is blank/empty. Do not infer its content; navigate again and verify a non-empty screenshot."
              : output.pageState === "error"
                ? "LOAD ERROR: Chrome is showing an error page. Do not claim success."
                : "VERIFIED NON-EMPTY PAGE";
        return new ComputerUseResult({
          result: {
            case: "success",
            value: new ComputerUseSuccess({
              actionCount: actions.length,
              durationMs: Date.now() - started,
              screenshot: output.screenshotBase64,
              cursorPosition: new Coordinate(
                output.cursorPosition || { x: 0, y: 0 },
              ),
              log:
                output.provider === "official"
                  ? `Official vendor cloud computer | shared primary screen | experimental | billing possible | ${stateGuidance}`
                  : `Private browser seat ${output.profileId.slice(0, 8)} | ${connectionManager.redactSensitiveText(output.title || "Untitled")} | ${connectionManager.publicOriginForLog(output.url)} | ${stateGuidance} | persistent profile enabled | ${output.activeSeatCount}/${manager.MAX_ACTIVE} seats active`,
            }),
          },
        });
      } catch (error) {
        const message = connectionManager.redactError(error).message;
        log("error", {
          seatKeyHash: manager.profileIdFor(seatKey),
          toolCallId: args.toolCallId,
          error: message,
        });
        return new ComputerUseResult({
          result: {
            case: "error",
            value: new ComputerUseError({
              error: message,
              actionCount: args.actions?.length || 0,
              durationMs: Date.now() - started,
            }),
          },
        });
      }
    },
  };
}

module.exports = {
  createExecutor,
  serializeAction,
  manager: providerManager,
  privateManager: manager,
  officialComputer,
  openOfficialLoginInDefaultBrowser,
  startViewServer,
  readJson,
  MAX_JSON_BODY_BYTES,
};
