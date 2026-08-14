"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const proxyModule = require(
  path.resolve(__dirname, "..", "src", "browser-seats", "public-web-proxy.cjs"),
);

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function connectRequest(endpoint, authority, authorization) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: endpoint.host,
      port: endpoint.port,
    });
    let response = "";
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("proxy test timed out")),
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      const authLine = authorization
        ? `Proxy-Authorization: ${authorization}\r\n`
        : "";
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authLine}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
  });
}

function rawProxyRequest(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: endpoint.host,
      port: endpoint.port,
    });
    let response = "";
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("raw proxy test timed out")),
    );
    socket.once("error", reject);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    socket.once("close", () => resolve(response));
  });
}

test("public address policy accepts public A/AAAA answers and rejects private or reserved ranges", async () => {
  const accepted = await proxyModule.resolvePublicAddresses("public.example", {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ],
  });
  assert.deepEqual(accepted.selected, { address: "93.184.216.34", family: 4 });
  assert.equal(proxyModule.isPublicAddress("8.8.8.8"), true);
  assert.equal(proxyModule.isPublicAddress("2606:4700:4700::1111"), true);

  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.1",
    "::1",
    "64:ff9b::7f00:1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
  ]) {
    await assert.rejects(
      proxyModule.resolvePublicAddresses("private.example", {
        lookup: async () => [{ address, family: net.isIP(address) }],
      }),
      (error) => error.code === "ERR_PRIVATE_ADDRESS",
      address,
    );
  }
});

test("mixed DNS answers and a later rebinding answer fail closed", async () => {
  await assert.rejects(
    proxyModule.resolvePublicAddresses("mixed.example", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
    (error) => error.code === "ERR_PRIVATE_ADDRESS",
  );

  let lookupCount = 0;
  const rebindingLookup = async () => {
    lookupCount += 1;
    return lookupCount === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  assert.equal(
    (
      await proxyModule.resolvePublicAddresses("rebind.example", {
        lookup: rebindingLookup,
      })
    ).selected.address,
    "93.184.216.34",
  );
  await assert.rejects(
    proxyModule.resolvePublicAddresses("rebind.example", {
      lookup: rebindingLookup,
    }),
    (error) => error.code === "ERR_PRIVATE_ADDRESS",
  );
});

test("authenticated CONNECT pins the validated IP and transparently carries a WebSocket handshake", async (t) => {
  let lookupCount = 0;
  let connectOptions;
  let tunneled = "";
  const upstream = new PassThrough();
  upstream.on("data", (chunk) => {
    tunneled += chunk.toString("latin1");
  });
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    lookup: async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    connect: (options) => {
      connectOptions = options;
      queueMicrotask(() => upstream.emit("connect"));
      return upstream;
    },
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());

  const socket = net.createConnection({
    host: endpoint.host,
    port: endpoint.port,
  });
  t.after(() => socket.destroy());
  const authorization = proxyModule.expectedAuthorization(
    endpoint.username,
    endpoint.password,
  );
  const websocketHandshake =
    "GET /socket HTTP/1.1\r\nHost: rebind.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  let response = "";
  await new Promise((resolve, reject) => {
    socket.setTimeout(3000, () =>
      reject(new Error("CONNECT tunnel test timed out")),
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        "CONNECT rebind.example:443 HTTP/1.1\r\n" +
          "Host: rebind.example:443\r\n" +
          `Proxy-Authorization: ${authorization}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (
        response.includes("\r\n\r\n") &&
        !response.includes(websocketHandshake)
      ) {
        socket.write(websocketHandshake);
      }
      if (tunneled.includes(websocketHandshake)) resolve();
    });
    upstream.on("data", () => {
      if (tunneled.includes(websocketHandshake)) resolve();
    });
  });

  assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
  assert.deepEqual(connectOptions, {
    host: "93.184.216.34",
    family: 4,
    port: 443,
  });
  assert.equal(
    lookupCount,
    1,
    "the connector must not perform a second hostname lookup",
  );
  assert.ok(
    tunneled.includes(websocketHandshake),
    "CONNECT must not rewrite Host or WebSocket bytes",
  );
});

test("an established CONNECT tunnel remains usable after the connection deadline", async (t) => {
  const destinationSockets = new Set();
  const destination = net.createServer((socket) => {
    destinationSockets.add(socket);
    socket.once("close", () => destinationSockets.delete(socket));
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const destinationAddress = await listen(destination);
  t.after(async () => {
    for (const socket of destinationSockets) socket.destroy();
    await closeServer(destination);
  });

  const connectTimeoutMs = 40;
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    connectTimeoutMs,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    // The injected connector lets the test exercise a real socket without
    // weakening the production destination validation path.
    connect: () =>
      net.createConnection({
        host: "127.0.0.1",
        port: destinationAddress.port,
      }),
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());

  const client = net.createConnection({
    host: endpoint.host,
    port: endpoint.port,
  });
  t.after(() => client.destroy());
  const authorization = proxyModule.expectedAuthorization(
    endpoint.username,
    endpoint.password,
  );
  let received = "";
  await new Promise((resolve, reject) => {
    client.setTimeout(3000, () =>
      reject(new Error("established tunnel test timed out")),
    );
    client.once("error", reject);
    client.once("connect", () =>
      client.write(
        "CONNECT idle.example:443 HTTP/1.1\r\n" +
          "Host: idle.example:443\r\n" +
          `Proxy-Authorization: ${authorization}\r\n\r\n`,
      ),
    );
    const onHeaderData = (chunk) => {
      received += chunk.toString("latin1");
      if (!received.includes("\r\n\r\n")) return;
      client.off("data", onHeaderData);
      resolve();
    };
    client.on("data", onHeaderData);
  });
  assert.match(received, /^HTTP\/1\.1 200 Connection Established/);

  await new Promise((resolve) => setTimeout(resolve, connectTimeoutMs * 3));
  assert.equal(
    client.destroyed,
    false,
    "an established idle tunnel must not inherit the connect timeout",
  );

  received = "";
  client.write("post-timeout-ping");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the established tunnel stopped forwarding")),
      1000,
    );
    const onData = (chunk) => {
      received += chunk.toString("latin1");
      if (!received.includes("post-timeout-ping")) return;
      clearTimeout(timer);
      client.off("data", onData);
      resolve();
    };
    client.on("data", onData);
  });
  assert.equal(received, "post-timeout-ping");
});

test("per-seat proxy rejects excess aggregate client connections without disturbing an accepted connection", async (t) => {
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    maxClientConnections: 1,
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());

  const accepted = net.createConnection({
    host: endpoint.host,
    port: endpoint.port,
  });
  t.after(() => accepted.destroy());
  await new Promise((resolve, reject) => {
    accepted.once("connect", resolve);
    accepted.once("error", reject);
  });

  const rejected = await rawProxyRequest(
    endpoint,
    "GET / HTTP/1.1\r\nHost: example.test\r\n\r\n",
  );
  assert.match(rejected, /^HTTP\/1\.1 503 Service Unavailable/);
  assert.equal(
    accepted.destroyed,
    false,
    "the connection already inside the seat ceiling must remain open",
  );
});

test("per-seat pending-upstream ceiling rejects excess work and releases capacity after establishment", async (t) => {
  let lookupCalls = 0;
  let releaseFirstLookup;
  const firstLookup = new Promise((resolve) => {
    releaseFirstLookup = resolve;
  });
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    maxPendingUpstreams: 1,
    lookup: async () => {
      lookupCalls += 1;
      if (lookupCalls === 1) return await firstLookup;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    connect: () => {
      const upstream = new PassThrough();
      queueMicrotask(() => upstream.emit("connect"));
      return upstream;
    },
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());
  const authorization = proxyModule.expectedAuthorization(
    endpoint.username,
    endpoint.password,
  );

  const first = connectRequest(endpoint, "first.example:443", authorization);
  while (lookupCalls === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const excess = await connectRequest(
    endpoint,
    "excess.example:443",
    authorization,
  );
  assert.match(excess, /^HTTP\/1\.1 503 Service Unavailable/);
  assert.equal(
    lookupCalls,
    1,
    "capacity must be checked before another DNS lookup or connection attempt",
  );

  releaseFirstLookup([{ address: "93.184.216.34", family: 4 }]);
  assert.match(await first, /^HTTP\/1\.1 200 Connection Established/);
  assert.match(
    await connectRequest(endpoint, "after-release.example:443", authorization),
    /^HTTP\/1\.1 200 Connection Established/,
  );
  assert.equal(lookupCalls, 2);
});

test("proxy rejects excessive header count and bytes before resolving an upstream", async (t) => {
  let lookupCalls = 0;
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    maxHeaderCount: 4,
    maxHeaderBytes: 1024,
    lookup: async () => {
      lookupCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());
  const authorization = proxyModule.expectedAuthorization(
    endpoint.username,
    endpoint.password,
  );

  const tooMany = await rawProxyRequest(
    endpoint,
    "CONNECT public.example:443 HTTP/1.1\r\n" +
      "Host: public.example:443\r\n" +
      `Proxy-Authorization: ${authorization}\r\n` +
      "X-One: 1\r\nX-Two: 2\r\nX-Three: 3\r\n\r\n",
  );
  assert.match(tooMany, /^HTTP\/1\.1 431 Request Header Fields Too Large/);

  const tooLarge = await rawProxyRequest(
    endpoint,
    "GET http://public.example/ HTTP/1.1\r\n" +
      "Host: public.example\r\n" +
      `Proxy-Authorization: ${authorization}\r\n` +
      `X-Large: ${"x".repeat(1500)}\r\n\r\n`,
  );
  assert.match(tooLarge, /^HTTP\/1\.1 431 Request Header Fields Too Large/);
  assert.equal(lookupCalls, 0);
});

test("an unestablished CONNECT destination is terminated at the connection deadline", async (t) => {
  let connectorCalls = 0;
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    connectTimeoutMs: 40,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: () => {
      connectorCalls += 1;
      return new net.Socket();
    },
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());
  const authorization = proxyModule.expectedAuthorization(
    endpoint.username,
    endpoint.password,
  );

  const startedAt = Date.now();
  const response = await connectRequest(
    endpoint,
    "stalled.example:443",
    authorization,
  );
  const elapsedMs = Date.now() - startedAt;

  assert.match(response, /^HTTP\/1\.1 502 Bad Gateway/);
  assert.equal(connectorCalls, 1);
  assert.ok(
    elapsedMs >= 20,
    `the stalled connector failed before its timeout (${elapsedMs} ms)`,
  );
  assert.ok(
    elapsedMs < 1000,
    `the stalled connector exceeded its bounded timeout (${elapsedMs} ms)`,
  );
});

test("private CONNECT is rejected without reaching the destination", async (t) => {
  let destinationConnections = 0;
  const destination = net.createServer((socket) => {
    destinationConnections += 1;
    socket.destroy();
  });
  const destinationAddress = await listen(destination);
  t.after(() => closeServer(destination));

  let connectorCalls = 0;
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    connect: (options) => {
      connectorCalls += 1;
      return net.createConnection(options);
    },
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());
  const authorization = proxyModule.expectedAuthorization(
    endpoint.username,
    endpoint.password,
  );
  const response = await connectRequest(
    endpoint,
    `private.example:${destinationAddress.port}`,
    authorization,
  );

  assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(connectorCalls, 0);
  assert.equal(destinationConnections, 0);
});

test("proxy authentication is required before DNS resolution or connection", async (t) => {
  let lookupCalls = 0;
  let connectorCalls = 0;
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
    lookup: async () => {
      lookupCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    connect: () => {
      connectorCalls += 1;
      return new PassThrough();
    },
  });
  const endpoint = await proxy.listen();
  t.after(() => proxy.close());

  const response = await connectRequest(endpoint, "public.example:443", null);
  assert.match(response, /^HTTP\/1\.1 407 Proxy Authentication Required/);
  assert.match(
    response,
    /Proxy-Authenticate: Basic realm="Codex Bot Public Web"/i,
  );
  const httpStatus = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: "http://public.example/",
        headers: { Host: "public.example" },
      },
      (httpResponse) => {
        httpResponse.resume();
        httpResponse.once("end", () => resolve(httpResponse.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
  assert.equal(httpStatus, 407);
  assert.equal(lookupCalls, 0);
  assert.equal(connectorCalls, 0);
});

test("proxy lifecycle is loopback-only and safely idempotent", async () => {
  assert.throws(
    () => proxyModule.createPublicWebProxy({ host: "0.0.0.0" }),
    /only on an explicit loopback address/,
  );
  const proxy = proxyModule.createPublicWebProxy({
    password: "test-password-that-is-long-enough-123",
  });
  const endpoint = await proxy.listen();
  assert.equal(endpoint.host, "127.0.0.1");
  await Promise.all([proxy.close(), proxy.close()]);
  await proxy.close();
});

test("HTTP forwarding keeps the original target Host and strips proxy credentials", () => {
  const target = proxyModule.parseHttpProxyTarget({
    url: "http://public.example:8080/path?q=1",
    headers: {
      host: "ignored.example",
      "proxy-authorization": "secret",
      "x-test": "kept",
    },
  });
  const headers = proxyModule.removeHopByHopHeaders({
    host: "ignored.example",
    "proxy-authorization": "secret",
    "proxy-connection": "keep-alive",
    "x-test": "kept",
  });
  headers.host = target.hostHeader;

  assert.equal(target.hostname, "public.example");
  assert.equal(target.port, 8080);
  assert.equal(target.path, "/path?q=1");
  assert.equal(headers.host, "public.example:8080");
  assert.equal(headers["proxy-authorization"], undefined);
  assert.equal(headers["proxy-connection"], undefined);
  assert.equal(headers["x-test"], "kept");
});
