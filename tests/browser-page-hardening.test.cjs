"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  CHROMIUM_HARDENING_ARGS,
  browserPageHardeningInitScript,
  installBrowserPageHardening,
  resolveSafeDownloadPath,
  sanitizeDownloadFilename,
} = require("../src/browser-seats/browser-page-hardening.cjs");

function createFakePageRealm() {
  const realm = vm.createContext({
    DOMException,
    queueMicrotask,
  });

  vm.runInContext(
    `
      class FakeMediaDevices {
        getUserMedia() { return Promise.resolve("camera-stream"); }
        getDisplayMedia() { return Promise.resolve("display-stream"); }
        enumerateDevices() { return Promise.resolve(["camera"]); }
      }

      class FakeGeolocation {
        getCurrentPosition(success) { success({ coords: { latitude: 1 } }); }
        watchPosition(success) { success({ coords: { latitude: 1 } }); return 7; }
        clearWatch() {}
      }

      class FakeClipboard {
        read() { return Promise.resolve(["secret"]); }
        readText() { return Promise.resolve("secret"); }
        write() { return Promise.resolve(); }
        writeText() { return Promise.resolve(); }
      }

      class FakePermissions {
        query(descriptor) {
          globalThis.permissionQueries.push(descriptor.name);
          return Promise.resolve({ state: "prompt", name: descriptor.name });
        }
      }

      class FakeNavigator {
        constructor() {
          this.mediaDevices = new FakeMediaDevices();
          this.geolocation = new FakeGeolocation();
          this.clipboard = new FakeClipboard();
          this.permissions = new FakePermissions();
        }

        getUserMedia() { return Promise.resolve("legacy-stream"); }
        webkitGetUserMedia() { return Promise.resolve("legacy-stream"); }
        mozGetUserMedia() { return Promise.resolve("legacy-stream"); }
      }

      class FakeDocument {
        execCommand(command) { return "original:" + command; }
        queryCommandSupported(command) { return command === "bold"; }
        queryCommandEnabled(command) { return command === "bold"; }
      }

      function OriginalNotification() {}
      OriginalNotification.permission = "granted";
      OriginalNotification.requestPermission = () => Promise.resolve("granted");

      globalThis.MediaDevices = FakeMediaDevices;
      globalThis.Geolocation = FakeGeolocation;
      globalThis.Clipboard = FakeClipboard;
      globalThis.Permissions = FakePermissions;
      globalThis.Navigator = FakeNavigator;
      globalThis.Document = FakeDocument;
      globalThis.navigator = new FakeNavigator();
      globalThis.document = new FakeDocument();
      globalThis.originalClipboard = globalThis.navigator.clipboard;
      globalThis.permissionQueries = [];
      globalThis.Notification = OriginalNotification;
      globalThis.RTCPeerConnection = function RTCPeerConnection() {};
      globalThis.webkitRTCPeerConnection = function webkitRTCPeerConnection() {};
    `,
    realm,
  );

  return realm;
}

function installInRealm(realm) {
  vm.runInContext(`(${browserPageHardeningInitScript.toString()})();`, realm);
}

function evaluate(realm, source) {
  return vm.runInContext(source, realm);
}

test("the exported init function can be registered directly on a Playwright context", async () => {
  const registrations = [];
  const context = {
    async addInitScript(script) {
      registrations.push(script);
    },
  };

  await installBrowserPageHardening(context);

  assert.deepEqual(registrations, [browserPageHardeningInitScript]);
  await assert.rejects(installBrowserPageHardening({}), /addInitScript/);
});

test("the init script disables page network, permission, location, notification, and clipboard APIs in every realm", async () => {
  const frameRealm = createFakePageRealm();
  const popupRealm = createFakePageRealm();

  for (const realm of [frameRealm, popupRealm]) {
    installInRealm(realm);

    assert.equal(evaluate(realm, "typeof RTCPeerConnection"), "undefined");
    assert.equal(
      evaluate(realm, "typeof webkitRTCPeerConnection"),
      "undefined",
    );

    await assert.rejects(
      evaluate(realm, "navigator.mediaDevices.getUserMedia()"),
      (error) => error?.name === "NotAllowedError",
    );
    await assert.rejects(
      evaluate(realm, "navigator.mediaDevices.getDisplayMedia()"),
      (error) => error?.name === "NotAllowedError",
    );
    await assert.rejects(
      evaluate(realm, "navigator.getUserMedia()"),
      (error) => error?.name === "NotAllowedError",
    );
    assert.deepEqual(
      Array.from(
        await evaluate(realm, "navigator.mediaDevices.enumerateDevices()"),
      ),
      ["camera"],
    );

    const locationError = await evaluate(
      realm,
      `new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(null),
          (error) => resolve({ name: error.name, code: error.code }),
        );
      })`,
    );
    assert.deepEqual(
      { name: locationError.name, code: locationError.code },
      { name: "NotAllowedError", code: 1 },
    );
    assert.equal(
      evaluate(
        realm,
        "navigator.geolocation.watchPosition(() => {}, () => {})",
      ),
      0,
    );

    const deniedPermission = await evaluate(
      realm,
      "navigator.permissions.query({ name: 'geolocation' })",
    );
    assert.equal(deniedPermission.state, "denied");
    assert.equal(Object.isFrozen(deniedPermission), true);

    const unrelatedPermission = await evaluate(
      realm,
      "navigator.permissions.query({ name: 'accelerometer' })",
    );
    assert.equal(unrelatedPermission.state, "prompt");
    assert.deepEqual(Array.from(evaluate(realm, "permissionQueries")), [
      "accelerometer",
    ]);

    assert.equal(evaluate(realm, "Notification.permission"), "denied");
    assert.equal(
      await evaluate(realm, "Notification.requestPermission()"),
      "denied",
    );
    assert.throws(
      () => evaluate(realm, "new Notification('blocked')"),
      (error) => error?.name === "NotAllowedError",
    );

    assert.equal(evaluate(realm, "navigator.clipboard"), undefined);
    await assert.rejects(
      evaluate(realm, "originalClipboard.readText()"),
      (error) => error?.name === "NotAllowedError",
    );
    await assert.rejects(
      evaluate(realm, "originalClipboard.writeText('secret')"),
      (error) => error?.name === "NotAllowedError",
    );
    assert.equal(evaluate(realm, "document.execCommand('copy')"), false);
    assert.equal(
      evaluate(realm, "document.execCommand('bold')"),
      "original:bold",
    );
    assert.equal(
      evaluate(realm, "document.queryCommandSupported('paste')"),
      false,
    );
    assert.equal(
      evaluate(realm, "document.queryCommandSupported('bold')"),
      true,
    );
  }
});

test("security-critical replacements have immutable descriptors", () => {
  const realm = createFakePageRealm();
  installInRealm(realm);

  const descriptors = evaluate(
    realm,
    `[
      Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection"),
      Object.getOwnPropertyDescriptor(globalThis, "webkitRTCPeerConnection"),
      Object.getOwnPropertyDescriptor(globalThis, "Notification"),
      Object.getOwnPropertyDescriptor(MediaDevices.prototype, "getUserMedia"),
      Object.getOwnPropertyDescriptor(Permissions.prototype, "query"),
      Object.getOwnPropertyDescriptor(Navigator.prototype, "geolocation"),
      Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard"),
      Object.getOwnPropertyDescriptor(Document.prototype, "execCommand"),
    ].map(({ configurable, writable }) => ({ configurable, writable }))`,
  );

  for (const descriptor of descriptors) {
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.writable, false);
  }

  assert.throws(
    () =>
      evaluate(
        realm,
        'Object.defineProperty(globalThis, "RTCPeerConnection", { value() {} })',
      ),
    /redefine|configurable/i,
  );
});

test("Chromium hardening arguments are frozen and disable QUIC and permission prompts", () => {
  assert.equal(Object.isFrozen(CHROMIUM_HARDENING_ARGS), true);
  assert.equal(CHROMIUM_HARDENING_ARGS.includes("--disable-quic"), true);
  assert.equal(
    CHROMIUM_HARDENING_ARGS.includes("--deny-permission-prompts"),
    true,
  );
  assert.equal(
    new Set(CHROMIUM_HARDENING_ARGS).size,
    CHROMIUM_HARDENING_ARGS.length,
  );
  assert.throws(() => CHROMIUM_HARDENING_ARGS.push("--unsafe"), TypeError);
});

test("download names are reduced to safe direct-child filenames", () => {
  const root = path.join(process.cwd(), "downloads root");
  const hostileNames = [
    "../../outside.txt",
    "..\\..\\evil.txt",
    "/absolute/path.txt",
    "C:\\Windows\\secret.txt",
    "\\\\server\\share\\remote.txt",
    "report.txt:alternate-stream",
    "..",
    ".",
    "folder/",
    "CON.txt",
    "LPT9",
    "nul\u0000byte.txt",
    "\u202esecret.txt",
    "fullwidth\uff0fescape.txt",
  ];

  for (const hostileName of hostileNames) {
    const filename = sanitizeDownloadFilename(hostileName);
    const destination = resolveSafeDownloadPath(root, hostileName);

    assert.ok(filename.length > 0);
    assert.equal(filename.includes("/"), false);
    assert.equal(filename.includes("\\"), false);
    assert.equal(/[<>:"|?*\u0000-\u001f]/u.test(filename), false);
    assert.equal(path.dirname(destination), path.resolve(root));
    assert.equal(path.basename(destination), filename);
  }

  assert.equal(sanitizeDownloadFilename("../../outside.txt"), "outside.txt");
  assert.equal(sanitizeDownloadFilename("CON.txt"), "_CON.txt");
  assert.equal(
    sanitizeDownloadFilename("report.txt:stream"),
    "report.txt_stream",
  );
  assert.equal(
    sanitizeDownloadFilename("  vacation photo.jpg  "),
    "vacation photo.jpg",
  );
  assert.equal(sanitizeDownloadFilename("../.."), "download");
  assert.ok(sanitizeDownloadFilename("a".repeat(1_000) + ".txt").length <= 200);

  assert.throws(
    () => resolveSafeDownloadPath("", "file.txt"),
    /downloads root/i,
  );
  assert.throws(
    () => resolveSafeDownloadPath(null, "file.txt"),
    /downloads root/i,
  );
});
