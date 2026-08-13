"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const manager = require(path.join(__dirname, "browser-seats", "browser-seat-manager.cjs"));
const connectionManager = require(path.join(__dirname, "codex-connection.cjs"));

const STATE_ROOT = process.env.CODEX_BOT_STATE_ROOT || path.join(process.env.LOCALAPPDATA || __dirname, "Codex Bot Bridge");
const LOG_PATH = path.join(STATE_ROOT, "logs", "browser-seats.jsonl");

function log(event, detail = {}) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), event, ...connectionManager.redactLogDetails(detail) })}\n`);
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
      return { kind, coordinate: coordinate(value.coordinate), button: value.button, count: value.count || 1 };
    case "mouseMove":
      return { kind, coordinate: coordinate(value.coordinate) };
    case "drag":
      return { kind, path: (value.path || []).map(coordinate), button: value.button };
    case "type":
      return { kind, text: value.text || "" };
    case "key":
      return { kind, key: value.key || "" };
    case "scroll":
      return { kind, coordinate: coordinate(value.coordinate), direction: value.direction, amount: value.amount || 3 };
    case "wait":
      return { kind, durationMs: Number(value.durationMs || (value.seconds ? value.seconds * 1000 : 1000)) };
    case "screenshot":
      return { kind };
    default:
      return { kind: String(kind || "unknown") };
  }
}

const VIEW_PORT = Math.max(1024, Math.min(65535, Number(process.env.GROK_BOT_BROWSER_VIEW_PORT || 18318)));
const VIEW_TOKEN = process.env.GROK_BOT_BROWSER_VIEW_TOKEN;
if (!VIEW_TOKEN || VIEW_TOKEN.length < 24) throw new Error("GROK_BOT_BROWSER_VIEW_TOKEN must be a per-install secret.");
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

function readJson(request) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      size += bytes.length;
      if (size > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        chunks = [];
        reject(new Error("Seat-control request is too large."));
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        const body = chunks.length ? Buffer.concat(chunks, size).toString("utf8") : "";
        chunks = [];
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Seat-control request is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function startViewServer() {
  if (globalThis[VIEW_SERVER_KEY]) return globalThis[VIEW_SERVER_KEY];
  const server = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Codex-Seat-Token");
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
      const proof = crypto.createHmac("sha256", VIEW_TOKEN).update(`codex-bot-view:${nonce}`).digest("base64url");
      sendJson(response, 200, { proof });
      return;
    }
    if (request.headers["x-codex-seat-token"] !== VIEW_TOKEN) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/codex/status") {
        sendJson(response, 200, connectionManager.publicStatus());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/codex/auth") {
        const body = await readJson(request);
        const action = String(body.action || "");
        if (action === "oauth") {
          const device = await connectionManager.beginCodexOAuth();
          sendJson(response, 202, { ok: true, ...device });
          return;
        }
        if (action === "use-oauth") {
          connectionManager.setMode("codex-oauth");
          sendJson(response, 200, { ok: true, status: connectionManager.publicStatus() });
          return;
        }
        if (action === "api-key") {
          const key = String(body.apiKey || "").trim();
          await connectionManager.verifyApiKey(key);
          connectionManager.setApiKey(key);
          sendJson(response, 200, { ok: true, status: connectionManager.publicStatus() });
          return;
        }
        throw new Error("Unknown Codex connection action.");
      }
      if (request.method === "GET" && url.pathname === "/api/frame") {
        const seatKey = String(url.searchParams.get("seatKey") || "");
        if (!seatKey || seatKey.length > 200) throw new Error("A valid employee seat key is required.");
        const frame = await manager.captureSeat(seatKey);
        sendJson(response, 200, { ...frame, width: manager.WIDTH, height: manager.HEIGHT });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/input") {
        const body = await readJson(request);
        const seatKey = String(body.seatKey || "");
        const actions = Array.isArray(body.actions) ? body.actions : body.action ? [body.action] : [];
        if (!seatKey || seatKey.length > 200) throw new Error("A valid employee seat key is required.");
        if (actions.length === 0 || actions.length > 64) throw new Error("One to 64 input actions are required.");
        const output = await manager.executeSeatActions(seatKey, actions, {
          actor: "user",
          controlId: String(body.controlId || ""),
        });
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
        const seatKey = String(url.searchParams.get("seatKey") || "");
        if (!seatKey || seatKey.length > 200) throw new Error("A valid employee seat key is required.");
        sendJson(response, 200, manager.controlStatusForSeat(seatKey));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/control") {
        const body = await readJson(request);
        const seatKey = String(body.seatKey || "");
        const controlId = String(body.controlId || "");
        const action = String(body.action || "");
        if (!seatKey || seatKey.length > 200) throw new Error("A valid employee seat key is required.");
        if (action === "acquire") {
          sendJson(response, 200, { ok: true, ...await manager.acquireUserControl(seatKey, controlId) });
          return;
        }
        if (action === "heartbeat") {
          sendJson(response, 200, { ok: true, ...manager.heartbeatUserControl(seatKey, controlId) });
          return;
        }
        if (action === "release") {
          sendJson(response, 200, { ok: manager.releaseUserControl(seatKey, controlId) });
          return;
        }
        throw new Error("Unknown browser control action.");
      }
      if (request.method === "GET" && url.pathname === "/api/approval") {
        const seatKey = String(url.searchParams.get("seatKey") || "");
        if (!seatKey || seatKey.length > 200) throw new Error("A valid employee seat key is required.");
        sendJson(response, 200, { pending: manager.pendingApprovalForSeat(seatKey) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/approval") {
        const body = await readJson(request);
        const seatKey = String(body.seatKey || "");
        const decision = String(body.decision || "");
        if (!seatKey || seatKey.length > 200) throw new Error("A valid employee seat key is required.");
        const accepted = manager.decidePendingApproval(seatKey, decision, body.binding);
        sendJson(response, accepted ? 200 : 409, { ok: accepted });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, { seats: manager.status(), maxActive: manager.MAX_ACTIVE });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = connectionManager.redactError(error).message;
      log("view_server_error", { error: message });
      sendJson(response, 500, { error: message });
    }
  });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      log("view_server_port_conflict", { port: VIEW_PORT });
      throw new Error(`Refusing to trust an existing browser-view listener on port ${VIEW_PORT}.`);
    }
    log("view_server_listen_error", { port: VIEW_PORT, error: connectionManager.redactError(error).message });
    throw error;
  });
  server.listen(VIEW_PORT, "127.0.0.1", () => log("view_server_ready", { port: VIEW_PORT }));
  server.unref();
  globalThis[VIEW_SERVER_KEY] = server;
  return server;
}

function createExecutor(types) {
  const { ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate } = types;
  const seatKey = String(types.seatKey || "default-seat");
  return {
    async execute(_ctx, args) {
      const started = Date.now();
      try {
        const actions = (args.actions || []).map(serializeAction);
        log("execute", { seatKeyHash: manager.profileIdFor(seatKey), toolCallId: args.toolCallId, actions: actions.map((action) => action.kind) });
        const output = await manager.executeSeatActions(seatKey, actions, { actor: "agent" });
        const stateGuidance = output.pageState === "challenge"
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
              cursorPosition: new Coordinate(output.cursorPosition || { x: 0, y: 0 }),
              log: `Private browser seat ${output.profileId.slice(0, 8)} · ${connectionManager.redactSensitiveText(output.title || "Untitled")} · ${connectionManager.publicOriginForLog(output.url)} · ${stateGuidance} · persistent profile enabled · ${output.activeSeatCount}/${manager.MAX_ACTIVE} seats active`,
            }),
          },
        });
      } catch (error) {
        const message = connectionManager.redactError(error).message;
        log("error", { seatKeyHash: manager.profileIdFor(seatKey), toolCallId: args.toolCallId, error: message });
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

module.exports = { createExecutor, serializeAction, manager, startViewServer, readJson, MAX_JSON_BODY_BYTES };
