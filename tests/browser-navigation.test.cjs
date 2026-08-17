"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manager = require(
  path.resolve(
    __dirname,
    "..",
    "src",
    "browser-seats",
    "browser-seat-manager.cjs",
  ),
);

test("ordinary GitHub repository copy is not mistaken for a verification challenge", () => {
  assert.equal(
    manager.pageLooksLikeChallenge({
      url: "https://github.com/sitesbyleons/sites-by-leon",
      title: "sitesbyleons/sites-by-leon: Bold, cinematic websites",
      bodyPreview: [
        "Code Issues Pull requests Actions Projects Security and quality Insights",
        "Add staging Hermes identity verification",
        "Required checks and architecture documentation",
        "Security check configuration",
        "README Contributors Languages",
      ].join("\n"),
    }),
    false,
  );
});

test("browser verification detection requires a concrete challenge signal", () => {
  assert.equal(
    manager.pageLooksLikeChallenge({
      url: "https://example.com/cdn-cgi/challenge-platform/h/g/orchestrate",
    }),
    true,
  );
  assert.equal(
    manager.pageLooksLikeChallenge({
      url: "https://example.com/",
      title: "Just a moment...",
    }),
    true,
  );
  assert.equal(
    manager.pageLooksLikeChallenge({
      url: "https://example.com/",
      hasChallengeSurface: true,
    }),
    true,
  );
  assert.equal(
    manager.pageLooksLikeChallenge({
      url: "https://example.com/",
      title: "Example Domain",
      bodyPreview: "Verify that you are human before continuing.",
    }),
    true,
  );
});

test("isolated browser navigation preserves public HTTP and HTTPS destinations", () => {
  for (const target of [
    "https://www.canva.com/design/",
    "http://example.com/path?query=value#result",
    "https://93.184.216.34/resource",
    "https://[2606:4700:4700::1111]/dns-query",
  ]) {
    assert.equal(manager.publicWebUrl(target), new URL(target).href);
  }
});

test("isolated browser navigation rejects privileged schemes and local network literals", () => {
  const blocked = [
    "file:///C:/Users/example/AppData/Local/Codex%20Bot%20Bridge/runtime.json",
    "data:text/html,private",
    "javascript://example.com/%0Aalert(1)",
    "chrome://settings/",
    "devtools://devtools/bundled/inspector.html",
    "custom://example.com/resource",
    "http://localhost:3000/",
    "http://worker.localhost/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://example.com@127.0.0.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
  ];

  for (const target of blocked) {
    assert.throws(
      () => manager.publicWebUrl(target),
      /public HTTP\(S\)/,
      target,
    );
  }
});

test("session restoration uses the same public-web navigation policy", () => {
  assert.deepEqual(
    manager.normalizeSessionState({
      version: 1,
      tabs: [
        "https://www.canva.com/",
        "file:///C:/private.txt",
        "http://127.0.0.1:8317/v1/models",
        "https://example.com/",
      ],
      activeIndex: 3,
    }),
    {
      version: 1,
      tabs: ["https://www.canva.com/", "https://example.com/"],
      activeIndex: 1,
    },
  );
});

test("session restoration retains only each public origin and path", () => {
  const sensitive = new URL(
    "https://example.com/work?code=SECRET&project=42&access_token=NOPE#private",
  );
  sensitive.username = "user";
  sensitive.password = "secret";
  assert.deepEqual(
    manager.normalizeSessionState({
      version: 1,
      tabs: [sensitive.href],
      activeIndex: 0,
    }),
    {
      version: 1,
      tabs: ["https://example.com/work"],
      activeIndex: 0,
    },
  );
});

test("live session snapshots persist only sanitized public tab URLs by default", () => {
  const sensitive = new URL(
    "https://example.com/private?code=SECRET&project=42#fragment",
  );
  sensitive.username = "user";
  sensitive.password = "secret";
  const page = {
    isClosed: () => false,
    url: () => sensitive.href,
  };
  assert.deepEqual(manager.createSessionStateSnapshot([page], page), {
    version: 1,
    tabs: ["https://example.com/private"],
    activeIndex: 0,
  });
  assert.equal(manager.createSessionStateSnapshot([page], page, false), null);
});

test("persistent Chrome starts from the app snapshot without deleting profile state", () => {
  const profileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-profile-startup-"),
  );
  const chromeProfileDir = path.join(profileDir, "Default");
  const sessionsDir = path.join(chromeProfileDir, "Sessions");
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(chromeProfileDir, "Preferences"),
      JSON.stringify({
        custom: { preserved: true },
        profile: { exit_type: "Crashed", exited_cleanly: false },
        session: {
          restore_on_startup: 1,
          startup_urls: ["https://untrusted.example/early"],
        },
      }),
    );
    for (const name of ["Session_123", "Tabs_456", "Session_corrupt.tmp"])
      fs.writeFileSync(path.join(sessionsDir, name), "unsafe");
    for (const name of [
      "Current Session",
      "Current Tabs",
      "Last Session",
      "Last Tabs",
    ])
      fs.writeFileSync(path.join(chromeProfileDir, name), "unsafe");
    fs.writeFileSync(path.join(sessionsDir, "unrelated-state"), "keep");
    fs.writeFileSync(
      path.join(chromeProfileDir, "Cookies"),
      "keep-cookie-store",
    );

    manager.preparePersistentProfileForSafeLaunch(profileDir);

    const preferences = JSON.parse(
      fs.readFileSync(path.join(chromeProfileDir, "Preferences"), "utf8"),
    );
    assert.deepEqual(preferences.custom, { preserved: true });
    assert.deepEqual(preferences.profile, {
      exit_type: "Normal",
      exited_cleanly: true,
    });
    assert.deepEqual(preferences.session, {
      restore_on_startup: 5,
      startup_urls: [],
    });
    assert.deepEqual(fs.readdirSync(sessionsDir), ["unrelated-state"]);
    assert.equal(
      fs.readFileSync(path.join(chromeProfileDir, "Cookies"), "utf8"),
      "keep-cookie-store",
    );
    for (const name of [
      "Current Session",
      "Current Tabs",
      "Last Session",
      "Last Tabs",
    ])
      assert.equal(fs.existsSync(path.join(chromeProfileDir, name)), false);
  } finally {
    fs.rmSync(profileDir, { force: true, recursive: true });
  }
});

test("an unreadable persistent profile fails closed before browser launch", () => {
  const profileDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-profile-invalid-"),
  );
  const chromeProfileDir = path.join(profileDir, "Default");
  try {
    fs.mkdirSync(chromeProfileDir, { recursive: true });
    fs.writeFileSync(path.join(chromeProfileDir, "Preferences"), "{invalid");
    assert.throws(
      () => manager.preparePersistentProfileForSafeLaunch(profileDir),
      /refusing an unsafe startup/,
    );
  } finally {
    fs.rmSync(profileDir, { force: true, recursive: true });
  }
});

test("the startup-page quarantine preserves one inert anchor and closes every extra target", async () => {
  const calls = [];
  const navigations = [];
  const pages = [
    {
      closed: false,
      currentUrl: "https://restored.example/",
      isClosed() {
        return this.closed;
      },
      url() {
        return this.currentUrl;
      },
      async goto(url, options) {
        navigations.push({ url, options });
        this.currentUrl = url;
      },
      async close(options) {
        calls.push(options);
        this.closed = true;
      },
    },
    {
      closed: false,
      currentUrl: "https://extra.example/",
      isClosed() {
        return this.closed;
      },
      url() {
        return this.currentUrl;
      },
      async goto(url) {
        this.currentUrl = url;
      },
      async close(options) {
        calls.push(options);
        this.closed = true;
      },
    },
  ];
  const anchor = await manager.quarantinePersistentStartupPages({
    pages: () => pages,
  });
  assert.equal(anchor, pages[0]);
  assert.deepEqual(navigations, [
    {
      url: "about:blank",
      options: { waitUntil: "commit", timeout: 10000 },
    },
  ]);
  assert.deepEqual(calls, [{ runBeforeUnload: false }]);
  assert.equal(pages[0].isClosed(), false);
  assert.equal(pages[1].isClosed(), true);
});

test("browser request interception blocks top-level and subresource private literals", async () => {
  function request(url, { navigation = true, topLevel = true } = {}) {
    return {
      url: () => url,
      isNavigationRequest: () => navigation,
      frame: () => ({ parentFrame: () => (topLevel ? null : {}) }),
    };
  }

  async function outcome(url, options) {
    const calls = [];
    const route = {
      abort: async (reason) => calls.push(["abort", reason]),
      continue: async () => calls.push(["continue"]),
    };
    await manager.enforceNavigationRoute(route, request(url, options));
    return calls;
  }

  assert.deepEqual(await outcome("https://www.canva.com/design/"), [
    ["continue"],
  ]);
  assert.deepEqual(await outcome("file:///C:/private.txt"), [
    ["abort", "blockedbyclient"],
  ]);
  assert.deepEqual(await outcome("http://169.254.169.254/latest/meta-data/"), [
    ["abort", "blockedbyclient"],
  ]);
  assert.deepEqual(
    await outcome("http://127.0.0.1/private", {
      navigation: false,
      topLevel: false,
    }),
    [["abort", "blockedbyclient"]],
  );
  assert.deepEqual(
    await outcome("https://static.canva.com/asset.js", {
      navigation: false,
      topLevel: false,
    }),
    [["continue"]],
  );
});

test("approval action batches are immutable plain-data snapshots", () => {
  const source = [{ kind: "click", coordinate: { x: 12, y: 34 } }];
  const snapshot = manager.immutableActionSnapshot(source);
  source[0].coordinate.x = 999;
  source.push({ kind: "type", text: "changed later" });

  assert.deepEqual(snapshot, [{ kind: "click", coordinate: { x: 12, y: 34 } }]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.equal(Object.isFrozen(snapshot[0].coordinate), true);

  const circular = [];
  circular.push(circular);
  assert.throws(
    () => manager.immutableActionSnapshot(circular),
    /circular data/,
  );
  assert.throws(
    () => manager.immutableActionSnapshot([new Date()]),
    /plain data objects/,
  );
});

test("approval origins bind public pages and safely represent browser-owned blank pages", () => {
  assert.equal(
    manager.approvalOriginForPage({
      url: () => "https://www.canva.com/design/abc?secret=no",
    }),
    "https://www.canva.com",
  );
  assert.equal(
    manager.approvalOriginForPage({ url: () => "about:blank" }),
    "https://browser-seat.invalid",
  );
  assert.equal(
    manager.approvalOriginForPage({
      url: () => "chrome-error://chromewebdata/",
    }),
    "https://browser-seat.invalid",
  );
});

test("trusted approval context uses hit-tested and focused live DOM metadata", async () => {
  const hitTarget = {
    tagName: "input",
    inputType: "text",
    role: "textbox",
    accessibleName: "Search",
  };
  const focusedTarget = {
    tagName: "textarea",
    role: "textbox",
    accessibleName: "Draft",
  };
  const calls = [];
  const page = {
    evaluate: async (_fn, value) => {
      calls.push(value);
      return value.useActive ? focusedTarget : hitTarget;
    },
  };

  const clickThenType = await manager.approvalContextForActions(page, [
    { kind: "click", coordinate: { x: 10, y: 20 } },
    { kind: "type", text: "hello" },
  ]);
  assert.deepEqual(clickThenType.actions[0].target, hitTarget);
  assert.deepEqual(clickThenType.actions[1].target, hitTarget);

  const typeOnly = await manager.approvalContextForActions(page, [
    { kind: "type", text: "hello" },
  ]);
  assert.deepEqual(typeOnly.actions[0].target, focusedTarget);
  assert.equal(
    calls.some((call) => call.useActive === true),
    true,
  );

  const pendingAddressEnter = await manager.approvalContextForActions(
    page,
    [{ kind: "key", key: "ENTER" }],
    {
      addressMode: true,
      addressText: "https://example.com/work?secret=no",
      addressSelected: true,
    },
  );
  assert.equal(pendingAddressEnter.actions[0].surface, "address");
  assert.deepEqual(pendingAddressEnter.actions[0].target, {
    surface: "address",
    href: "https://example.com/work?secret=no",
    selected: true,
  });
});
