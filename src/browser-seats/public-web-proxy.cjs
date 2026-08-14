"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns");
const http = require("node:http");
const net = require("node:net");
const { domainToASCII } = require("node:url");

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_HEADER_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CLIENT_CONNECTIONS = 128;
const DEFAULT_MAX_PENDING_UPSTREAMS = 32;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_HEADER_COUNT = 128;
const PROXY_AUTH_REALM = "Codex Bot Public Web";

const BLOCKED_IPV4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");

const BLOCKED_IPV6 = new net.BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
])
  BLOCKED_IPV6.addSubnet(network, prefix, "ipv6");

class PublicWebProxyError extends Error {
  constructor(message, code, statusCode = 403) {
    super(message);
    this.name = "PublicWebProxyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeHostname(value) {
  let hostname = String(value || "").trim();
  if (hostname.startsWith("[") && hostname.endsWith("]"))
    hostname = hostname.slice(1, -1);
  hostname = hostname.replace(/\.$/, "").toLowerCase();
  if (!hostname || /[\0\s/?#@]/.test(hostname)) {
    throw new PublicWebProxyError(
      "The proxy target hostname is invalid.",
      "ERR_INVALID_HOST",
      400,
    );
  }
  if (net.isIP(hostname)) return hostname;
  const ascii = domainToASCII(hostname);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split(".").some((label) => !label || label.length > 63)
  ) {
    throw new PublicWebProxyError(
      "The proxy target hostname is invalid.",
      "ERR_INVALID_HOST",
      400,
    );
  }
  return ascii.toLowerCase();
}

function ipv4FromMappedIpv6(value) {
  const address = String(value || "").toLowerCase();
  const match = address.match(
    /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i,
  );
  if (!match) return null;
  if (match[1]) return net.isIP(match[1]) === 4 ? match[1] : null;
  const high = Number.parseInt(match[2], 16);
  const low = Number.parseInt(match[3], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isPublicAddress(value) {
  const address = normalizeHostname(value);
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED_IPV4.check(address, "ipv4");
  if (family !== 6) return false;

  const mapped = ipv4FromMappedIpv6(address);
  if (mapped) return !BLOCKED_IPV4.check(mapped, "ipv4");

  // Currently allocated public unicast IPv6 space is inside 2000::/3. Treat
  // every other range as reserved unless this policy is deliberately updated.
  if (!/^[23][0-9a-f]{3}:/i.test(address)) return false;
  return !BLOCKED_IPV6.check(address, "ipv6");
}

function normalizeLookupResults(results) {
  const entries = Array.isArray(results) ? results : [results];
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const rawAddress = typeof entry === "string" ? entry : entry?.address;
    let address;
    try {
      address = normalizeHostname(rawAddress);
    } catch {
      throw new PublicWebProxyError(
        "DNS returned an invalid address.",
        "ERR_INVALID_DNS_ANSWER",
        502,
      );
    }
    const family = net.isIP(address);
    if (!family || (entry?.family != null && Number(entry.family) !== family)) {
      throw new PublicWebProxyError(
        "DNS returned an invalid address.",
        "ERR_INVALID_DNS_ANSWER",
        502,
      );
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ address, family });
    }
  }
  if (normalized.length === 0) {
    throw new PublicWebProxyError(
      "DNS returned no usable addresses.",
      "ERR_EMPTY_DNS_ANSWER",
      502,
    );
  }
  return normalized;
}

async function defaultLookup(hostname, options) {
  return await dns.promises.lookup(hostname, options);
}

async function resolvePublicAddresses(
  hostnameValue,
  { lookup = defaultLookup } = {},
) {
  const hostname = normalizeHostname(hostnameValue);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain"
  ) {
    throw new PublicWebProxyError(
      "Private and local network destinations are blocked.",
      "ERR_PRIVATE_ADDRESS",
    );
  }

  const literalFamily = net.isIP(hostname);
  let addresses;
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : normalizeLookupResults(
          await lookup(hostname, { all: true, verbatim: true }),
        );
  } catch (error) {
    if (error instanceof PublicWebProxyError) throw error;
    throw new PublicWebProxyError(
      "The public destination could not be resolved.",
      "ERR_DNS_LOOKUP",
      502,
    );
  }

  const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
  if (blocked) {
    throw new PublicWebProxyError(
      "Private and local network destinations are blocked.",
      "ERR_PRIVATE_ADDRESS",
    );
  }
  return { hostname, addresses, selected: addresses[0] };
}

function parsePort(value, fallback) {
  const port = value === "" || value == null ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PublicWebProxyError(
      "The proxy target port is invalid.",
      "ERR_INVALID_PORT",
      400,
    );
  }
  return port;
}

function parseConnectAuthority(value) {
  const authority = String(value || "").trim();
  if (!authority || /[\s/?#@]/.test(authority)) {
    throw new PublicWebProxyError(
      "The CONNECT authority is invalid.",
      "ERR_INVALID_AUTHORITY",
      400,
    );
  }
  let parsed;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new PublicWebProxyError(
      "The CONNECT authority is invalid.",
      "ERR_INVALID_AUTHORITY",
      400,
    );
  }
  const hostname = normalizeHostname(parsed.hostname);
  const port = parsePort(parsed.port, 443);
  return { hostname, port, authority };
}

function parseHttpProxyTarget(request) {
  const rawTarget = String(request.url || "");
  let parsed;
  try {
    if (/^https?:\/\//i.test(rawTarget)) parsed = new URL(rawTarget);
    else {
      const host = String(request.headers.host || "").trim();
      if (!host) throw new Error("missing host");
      parsed = new URL(rawTarget || "/", `http://${host}`);
    }
  } catch {
    throw new PublicWebProxyError(
      "The HTTP proxy target is invalid.",
      "ERR_INVALID_TARGET",
      400,
    );
  }
  if (parsed.protocol !== "http:") {
    throw new PublicWebProxyError(
      "HTTPS destinations must use CONNECT.",
      "ERR_CONNECT_REQUIRED",
      400,
    );
  }
  const hostname = normalizeHostname(parsed.hostname);
  const port = parsePort(parsed.port, 80);
  return {
    hostname,
    port,
    hostHeader: parsed.host,
    path: `${parsed.pathname || "/"}${parsed.search}`,
  };
}

function removeHopByHopHeaders(headers, { preserveUpgrade = false } = {}) {
  const output = { ...headers };
  const connectionTokens = String(output.connection || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    ...connectionTokens,
  ])
    delete output[name];
  if (!preserveUpgrade) {
    delete output.connection;
    delete output.upgrade;
  }
  return output;
}

function expectedAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function constantTimeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isProxyAuthorized(headers, credentials) {
  return constantTimeStringEqual(
    headers?.["proxy-authorization"],
    expectedAuthorization(credentials.username, credentials.password),
  );
}

function writeProxyAuthenticationRequired(response) {
  const body = "Proxy authentication required.\n";
  response.writeHead(407, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Proxy-Authenticate": `Basic realm="${PROXY_AUTH_REALM}"`,
    Connection: "close",
  });
  response.end(body);
}

function writeSocketResponse(socket, statusCode, reason) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n",
  );
}

function publicErrorStatus(error) {
  return error instanceof PublicWebProxyError ? error.statusCode : 502;
}

function publicErrorReason(error) {
  const status = publicErrorStatus(error);
  if (status === 400) return "Bad Request";
  if (status === 403) return "Forbidden";
  if (status === 503) return "Service Unavailable";
  return "Bad Gateway";
}

function boundedIntegerOption(
  value,
  fallback,
  name,
  { min = 1, max = 1048576 } = {},
) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(
      `The public-web proxy ${name} must be an integer from ${min} through ${max}.`,
    );
  }
  return candidate;
}

function hasTooManyHeaders(request, maxHeaderCount) {
  return Math.floor((request.rawHeaders?.length || 0) / 2) > maxHeaderCount;
}

function createPublicWebProxy(options = {}) {
  const listenHost = String(options.host || "127.0.0.1");
  if (listenHost !== "127.0.0.1" && listenHost !== "::1") {
    throw new Error(
      "The public-web proxy can listen only on an explicit loopback address.",
    );
  }
  const listenPort = options.port == null ? 0 : parsePort(options.port, 0);
  const username = String(options.username || "codex-bot");
  const password = String(
    options.password ||
      options.token ||
      crypto.randomBytes(32).toString("base64url"),
  );
  if (!username || username.includes(":") || password.length < 24) {
    throw new Error(
      "The public-web proxy requires a username and a random password of at least 24 characters.",
    );
  }
  const credentials = Object.freeze({ username, password });
  const lookup = options.lookup || defaultLookup;
  const connect =
    options.connect ||
    ((connectOptions) => net.createConnection(connectOptions));
  const requestedConnectTimeoutMs = Number(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  if (
    !Number.isFinite(requestedConnectTimeoutMs) ||
    requestedConnectTimeoutMs <= 0
  ) {
    throw new Error(
      "The public-web proxy connection timeout must be a positive number.",
    );
  }
  const connectTimeoutMs = Math.max(
    25,
    Math.min(120000, requestedConnectTimeoutMs),
  );
  const headerTimeoutMs = boundedIntegerOption(
    options.headerTimeoutMs,
    DEFAULT_HEADER_TIMEOUT_MS,
    "header timeout",
    { min: 1000, max: 120000 },
  );
  const maxClientConnections = boundedIntegerOption(
    options.maxClientConnections,
    DEFAULT_MAX_CLIENT_CONNECTIONS,
    "aggregate connection ceiling",
    { max: 4096 },
  );
  const maxPendingUpstreams = boundedIntegerOption(
    options.maxPendingUpstreams,
    DEFAULT_MAX_PENDING_UPSTREAMS,
    "pending upstream ceiling",
    { max: 1024 },
  );
  const maxHeaderBytes = boundedIntegerOption(
    options.maxHeaderBytes,
    DEFAULT_MAX_HEADER_BYTES,
    "header byte ceiling",
    { min: 1024, max: 1024 * 1024 },
  );
  const maxHeaderCount = boundedIntegerOption(
    options.maxHeaderCount,
    DEFAULT_MAX_HEADER_COUNT,
    "header count ceiling",
    { max: 2048 },
  );
  const sockets = new Set();
  const rejectedSockets = new WeakSet();
  let pendingUpstreams = 0;
  let listening = false;
  let listenPromise = null;
  let closePromise = null;

  function acquirePendingUpstream() {
    if (pendingUpstreams >= maxPendingUpstreams) {
      throw new PublicWebProxyError(
        "This browser seat has too many destinations still connecting.",
        "ERR_PROXY_CAPACITY",
        503,
      );
    }
    pendingUpstreams += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingUpstreams -= 1;
    };
  }

  const server = http.createServer(
    { maxHeaderSize: maxHeaderBytes },
    async (request, response) => {
      if (rejectedSockets.has(request.socket)) {
        response.destroy();
        return;
      }
      if (hasTooManyHeaders(request, maxHeaderCount)) {
        response.writeHead(431, { Connection: "close", "Content-Length": "0" });
        response.end();
        return;
      }
      if (!isProxyAuthorized(request.headers, credentials)) {
        writeProxyAuthenticationRequired(response);
        return;
      }

      let releasePending = null;
      let upstream = null;
      try {
        releasePending = acquirePendingUpstream();
        const target = parseHttpProxyTarget(request);
        const resolution = await resolvePublicAddresses(target.hostname, {
          lookup,
        });
        if (request.destroyed || response.destroyed) {
          releasePending();
          return;
        }
        const headers = removeHopByHopHeaders(request.headers);
        headers.host = target.hostHeader;
        upstream = http.request(
          {
            host: resolution.selected.address,
            family: resolution.selected.family,
            port: target.port,
            method: request.method,
            path: target.path,
            headers,
            agent: false,
          },
          (upstreamResponse) => {
            releasePending();
            response.writeHead(
              upstreamResponse.statusCode || 502,
              removeHopByHopHeaders(upstreamResponse.headers),
            );
            upstreamResponse.pipe(response);
          },
        );
        upstream.once("socket", (socket) => {
          if (!socket.connecting) releasePending();
          else {
            socket.once("connect", releasePending);
            socket.once("error", releasePending);
          }
        });
        upstream.setTimeout(connectTimeoutMs, () =>
          upstream.destroy(new Error("Public destination timed out.")),
        );
        upstream.once("error", () => {
          releasePending();
          if (!response.headersSent)
            response.writeHead(502, {
              Connection: "close",
              "Content-Length": "0",
            });
          response.end();
        });
        request.once("aborted", () => {
          releasePending();
          upstream.destroy();
        });
        request.pipe(upstream);
      } catch (error) {
        releasePending?.();
        if (!response.headersSent) {
          response.writeHead(publicErrorStatus(error), {
            Connection: "close",
            "Content-Length": "0",
          });
        }
        response.end();
      }
    },
  );

  server.on("connect", async (request, clientSocket, head) => {
    if (rejectedSockets.has(clientSocket)) return;
    if (hasTooManyHeaders(request, maxHeaderCount)) {
      writeSocketResponse(clientSocket, 431, "Request Header Fields Too Large");
      return;
    }
    if (!isProxyAuthorized(request.headers, credentials)) {
      if (!clientSocket.destroyed) {
        clientSocket.end(
          "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            `Proxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\n` +
            "Connection: close\r\n" +
            "Content-Length: 0\r\n\r\n",
        );
      }
      return;
    }

    let upstream;
    let established = false;
    let releasePending = null;
    try {
      releasePending = acquirePendingUpstream();
      const target = parseConnectAuthority(request.url);
      const resolution = await resolvePublicAddresses(target.hostname, {
        lookup,
      });
      if (clientSocket.destroyed) {
        releasePending();
        return;
      }
      // Connecting by the chosen address, rather than the hostname, is the
      // critical DNS-rebinding boundary. CONNECT remains an opaque tunnel, so
      // the browser's TLS handshake keeps the original hostname in SNI and the
      // encrypted HTTP/WebSocket request keeps its original Host header.
      upstream = connect({
        host: resolution.selected.address,
        family: resolution.selected.family,
        port: target.port,
      });
      upstream.setTimeout?.(connectTimeoutMs, () =>
        upstream.destroy(new Error("Public destination timed out.")),
      );
      upstream.setNoDelay?.(true);
      upstream.once("connect", () => {
        releasePending();
        // This timer protects only connection establishment. Leaving it armed
        // would terminate legitimate idle TLS and WebSocket tunnels after the
        // connect deadline even though the destination is already established.
        upstream.setTimeout?.(0);
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        established = true;
        clientSocket.write(
          "HTTP/1.1 200 Connection Established\r\nProxy-Agent: Codex-Bot-Public-Web\r\n\r\n",
        );
        if (head?.length) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.once("error", () => {
        releasePending();
        if (clientSocket.destroyed) return;
        if (established) clientSocket.destroy();
        else writeSocketResponse(clientSocket, 502, "Bad Gateway");
      });
      clientSocket.once("error", () => {
        releasePending();
        upstream.destroy();
      });
      clientSocket.once("close", () => {
        releasePending();
        upstream.destroy();
      });
    } catch (error) {
      releasePending?.();
      if (upstream) upstream.destroy();
      writeSocketResponse(
        clientSocket,
        publicErrorStatus(error),
        publicErrorReason(error),
      );
    }
  });

  server.headersTimeout = headerTimeoutMs;
  server.maxHeadersCount = maxHeaderCount;
  server.on("clientError", (error, socket) => {
    if (rejectedSockets.has(socket)) return;
    const headerOverflow = error?.code === "HPE_HEADER_OVERFLOW";
    writeSocketResponse(
      socket,
      headerOverflow ? 431 : 400,
      headerOverflow ? "Request Header Fields Too Large" : "Bad Request",
    );
  });
  server.on("connection", (socket) => {
    if (sockets.size >= maxClientConnections) {
      rejectedSockets.add(socket);
      writeSocketResponse(socket, 503, "Service Unavailable");
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    server,
    credentials,
    async listen() {
      if (!listening) {
        if (!listenPromise) {
          listenPromise = new Promise((resolve, reject) => {
            const onError = (error) => {
              server.off("listening", onListening);
              listenPromise = null;
              reject(error);
            };
            const onListening = () => {
              server.off("error", onError);
              listening = true;
              resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(listenPort, listenHost);
          });
        }
        await listenPromise;
      }
      const address = server.address();
      const hostForUrl =
        address.family === "IPv6" ? `[${address.address}]` : address.address;
      return Object.freeze({
        server: `http://${hostForUrl}:${address.port}`,
        host: address.address,
        port: address.port,
        username,
        password,
      });
    },
    async close() {
      if (closePromise) return await closePromise;
      closePromise = (async () => {
        for (const socket of sockets) socket.destroy();
        if (!listening) return;
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        listening = false;
        listenPromise = null;
      })();
      try {
        return await closePromise;
      } finally {
        closePromise = null;
      }
    },
  };
}

module.exports = {
  DEFAULT_HEADER_TIMEOUT_MS,
  DEFAULT_MAX_CLIENT_CONNECTIONS,
  DEFAULT_MAX_HEADER_BYTES,
  DEFAULT_MAX_HEADER_COUNT,
  DEFAULT_MAX_PENDING_UPSTREAMS,
  PublicWebProxyError,
  createPublicWebProxy,
  expectedAuthorization,
  isProxyAuthorized,
  isPublicAddress,
  normalizeHostname,
  normalizeLookupResults,
  parseConnectAuthority,
  parseHttpProxyTarget,
  removeHopByHopHeaders,
  resolvePublicAddresses,
};
