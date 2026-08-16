"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const {
  patchHostAgentIdentitySource,
  patchRendererComposerIdentitySource,
  patchSettingsViewSource,
  replaceFunction,
  verifyBrowserSeatLifecycleSource,
  verifyHostComputerSeatRoutingSource,
  verifyHostAgentIdentitySource,
  verifyLocalExecComputerIsolationSource,
  verifyRendererComposerIdentitySource,
  verifyRendererRuntimeBindingsSource,
  verifySettingsViewSource,
} = require(path.join(root, "scripts", "patch-app.cjs"));

function browserSeatLifecycleFixture() {
  return `function createHostGatewayApi(deps) {
  const manager = deps.extensions.api("transcript");
  const mintAgent = async (args) => {
    const result = await manager.createAgent(args);
    try {
      const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
      if (process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && seatBridgePath) {
        await require(seatBridgePath).manager.ensureSeat(result.agent.id);
      }
    } catch (error) {
      console.error("seat provision failed", error);
    }
    return result;
  };
  return {
    deleteAgent: async (args) => {
      const result = await manager.deleteAgent(args.id);
      try {
        const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
        if (seatBridgePath) await require(seatBridgePath).manager.closeSeatForKey(args.id);
      } catch (error) {
        console.error("seat close failed", error);
      }
      return result;
    },
    deleteAgents: async (args) => {
      const result = await manager.deleteAgents(args.ids);
      for (const id of args.ids) {
        await deps.releaseAgentBox(id);
        try {
          const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
          if (seatBridgePath) await require(seatBridgePath).manager.closeSeatForKey(id);
        } catch (error) {
          console.error("batch seat close failed", error);
        }
      }
      return result;
    },
    duplicateAgent: (args) => manager.cloneAgent(args.id),
  };
}
function afterGatewayApi() {}
`;
}

function computerSeatRoutingFixture() {
  return `async function executeAndPersistComputerUse(ctx, resourceAccessor, deps, args) {
  const bridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE?.trim();
  const useLocalComputer = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1";
  const seatKey = typeof deps.seatKey === "string" ? deps.seatKey.trim() : "";
  if (useLocalComputer && (!bridgePath || !seatKey)) {
    throw new Error("A stable employee browser-seat key is required in local computer mode.");
  }
  const computerUse = useLocalComputer
    ? require(bridgePath).createExecutor({ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate, seatKey })
    : resourceAccessor.get(computerUseExecutorResource);
  return await computerUse.execute(ctx, args);
}
function createScreenshotArgs(toolCallId) {
  return new ComputerUseArgs({ toolCallId });
}
function buildTurnTools(host, turn, props) {
  const tools = [];
  if ((host.isComputerUseSubagent || (!host.isSubagentRunner && !host.isSharedRoomRunner && process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1")) && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {
    tools.push(
      createComputerTool(remoteBoxResourceAccessor, {
        getPersistImage: () => host.persistImage,
        seatKey: host.resolveBoxId(),
        isUnicodeTypingEnabled: host.isUnicodeTypingEnabled,
      }),
    );
  }
  if (host.isBrowserUseSubagent) {
    tools.push(...createSandBrowserTools({ resourceAccessor: remoteBoxResourceAccessor }));
  }
  tools.push(
    createScreenshotTool(remoteBoxResourceAccessor, {
      getPersistImage: () => host.persistImage,
      seatKey: host.resolveBoxId(),
    }),
  );
  if (!host.isSubagentRunner && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable() && host.boxHandoff != null) {
    tools.push(createRequestBoxHelpTool({}));
  }
  return tools;
}
function afterBuildTurnTools() {}
function buildBoxDesktopPrompt(host) {
  const directLocalComputerOffered = process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable();
  return directLocalComputerOffered ? [
    "Use Computer directly for browser and desktop work",
    "A denied Shell call does not mean browser access is blocked",
    "Show the real Computer approval card",
  ].join("\n") : "fallback";
}
`;
}

function localExecFixture() {
  return `function buildLocalExecManager(root, maxFileBytes) {
  const registry3 = new RegistryResourceAccessor();
  registry3.register(shellStreamExecutorResource, shellStreamExecutor);
  return SimpleControlledExecManager.fromResources(registry3);
}
function afterBuildLocalExecManager() {}
`;
}

function hostFixture() {
  return `function createCursorSandInference(options2) {
  return {
    createSession(onRequestId, sessionOptions) {
      const requestedModel = resolveSandRequestedModel({ sessionOptions });
      const session = createCursorInferencePromptSession({
        getAccessToken: options2.getAccessToken,
        getMachineId: options2.getMachineId,
        requestedModel,
        onRequestId,
      });
      return session;
    },
  };
}
const main = true;
        const mainSessionOptions = {
          modelId: host.subagentModelId,
          inferenceReason: host.inferenceReason,
        };
const session = mainSessionOptions;
`;
}

function composerFixture() {
  const composerProps = `      hve,
      {
        attachmentNotice: t.attachmentNoticeMessage,
      },`;
  return `function renamedComposerOwner(n) {
  return {
    composer: p.jsx(
${composerProps}
    ),
    newChatComposer: p.jsx(
${composerProps}
    ),
    heroComposer: p.jsx(
${composerProps}
    ),
  };
}
const kOn = 20,
  Ees = 3e4;
function hve(n) {}
function renamedComposerForm(n) {
  const e = he.c(215),
    {
      isSendingPaused: t,
      isCursorSignedIn: s,
    } = n;
  let $a;
  return (
    e[211] !== ts || e[212] !== ks || e[213] !== za
      ? (($a = p.jsx("form", { className: ts, onSubmit: ks, children: za })),
        (e[211] = ts),
        (e[212] = ks),
        (e[213] = za),
        (e[214] = $a))
      : ($a = e[214]),
    $a
  );
}
function afterComposer(n) {}
`;
}

function settingsFixture() {
  return `function pa() {
  return appearance;
}
function Sa(s) {
  const e = H.c(9),
    { auth: t } = s;
  let n = k("sand-settings-general", "stock"), d, l, r, i, o, c;
  d = a.jsx(re, { title: "Account", children: a.jsx(Vs, { auth: t }) });
  l = a.jsx(pa, {});
  r = null;
  i = a.jsx(oa, {});
  o = a.jsx(va, {});
  return (c = a.jsxs("div", { className: n, children: [d, l, r, i, o] }), c);
}
function Ta(s) {
  return dialog;
}
`;
}

test("host patch carries the stable current bot id into the main inference session", () => {
  const patched = patchHostAgentIdentitySource(hostFixture());
  assert.doesNotThrow(() => verifyHostAgentIdentitySource(patched));
  const agentId = patched.indexOf("agentId: host.resolveBoxId(),");
  const modelId = patched.indexOf("modelId: host.subagentModelId,");
  assert.ok(agentId >= 0 && agentId < modelId);
  assert.match(
    patched,
    /getMachineId: options2\.getMachineId,\n        agentId: sessionOptions\?\.agentId,\n        requestedModel,/,
  );
  assert.throws(
    () => patchHostAgentIdentitySource(patched),
    /ambiguous|not found/,
  );
  assert.throws(
    () =>
      verifyHostAgentIdentitySource(
        patched.replace("host.resolveBoxId()", "host.getConversationId()"),
      ),
    /current bot id/,
  );
});

test("host verifier rejects dropping the bot id at the inference bridge boundary", () => {
  const patched = patchHostAgentIdentitySource(hostFixture());
  const mutated = patched.replace(
    "        agentId: sessionOptions?.agentId,\n",
    "",
  );
  assert.throws(
    () => verifyHostAgentIdentitySource(mutated),
    /local inference bridge receives the bot id/,
  );
});

test("browser-seat verifier binds provisioning to mint and cleanup to delete", () => {
  const source = browserSeatLifecycleFixture();
  assert.doesNotThrow(() => verifyBrowserSeatLifecycleSource(source));

  const provisionBlock = `    try {
      const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
      if (process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1" && seatBridgePath) {
        await require(seatBridgePath).manager.ensureSeat(result.agent.id);
      }
    } catch (error) {
      console.error("seat provision failed", error);
    }
`;
  const oldFalsePass = source.replace(provisionBlock, "").replace(
    `      return result;
    },
    deleteAgents:`,
    `${provisionBlock.replaceAll("    ", "      ")}      return result;
    },
    deleteAgents:`,
  );
  assert.match(oldFalsePass, /manager\.ensureSeat\(result\.agent\.id\)/);
  assert.match(oldFalsePass, /manager\.closeSeatForKey\(args\.id\)/);
  assert.throws(
    () => verifyBrowserSeatLifecycleSource(oldFalsePass),
    /successfully minted bot provisions its browser seat before returning|agent deletion cannot provision/,
  );

  const missingBatchCleanup = source.replace(
    `        try {
          const seatBridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
          if (seatBridgePath) await require(seatBridgePath).manager.closeSeatForKey(id);
        } catch (error) {
          console.error("batch seat close failed", error);
        }
`,
    "",
  );
  assert.throws(
    () => verifyBrowserSeatLifecycleSource(missingBatchCleanup),
    /each successfully batch-deleted bot closes its browser seat before returning/,
  );
});

test("computer-seat verifier scopes Computer and Screenshot and fails closed", () => {
  const source = computerSeatRoutingFixture();
  assert.doesNotThrow(() => verifyHostComputerSeatRoutingSource(source));

  const screenshotWithoutSeat = source
    .replace(
      `      getPersistImage: () => host.persistImage,
      seatKey: host.resolveBoxId(),
    }),
  );
  if (!host.isSubagentRunner`,
      `      getPersistImage: () => host.persistImage,
    }),
  );
  if (!host.isSubagentRunner`,
    )
    .concat("\nconst misplacedSeatKey = { seatKey: host.resolveBoxId(), };\n");
  assert.throws(
    () => verifyHostComputerSeatRoutingSource(screenshotWithoutSeat),
    /Screenshot receives the stable current bot id/,
  );

  const sharedFallback = source.replace(
    `  if (useLocalComputer && (!bridgePath || !seatKey)) {
    throw new Error("A stable employee browser-seat key is required in local computer mode.");
  }
`,
    "",
  );
  assert.throws(
    () => verifyHostComputerSeatRoutingSource(sharedFallback),
    /fails closed before creating an employee-scoped executor/,
  );

  const subagentOnly = source.replace(
    'if ((host.isComputerUseSubagent || (!host.isSubagentRunner && !host.isSharedRoomRunner && process.env.GROK_BOT_USE_LOCAL_COMPUTER === "1")) && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {',
    "if (host.isComputerUseSubagent && host.remoteBoxHasDesktop && host.getRemoteBoxAvailable()) {",
  );
  assert.throws(
    () => verifyHostComputerSeatRoutingSource(subagentOnly),
    /local private and same-user group turns receive the direct employee-scoped Computer tool/,
  );
});

test("local-exec verifier rejects a shared computer executor without bot context", () => {
  const source = localExecFixture();
  assert.doesNotThrow(() => verifyLocalExecComputerIsolationSource(source));

  const unscoped = source.replace(
    "  return SimpleControlledExecManager.fromResources(registry3);",
    `  const bridgePath = process.env.GROK_BOT_WINDOWS_COMPUTER_BRIDGE;
  registry3.register(
    computerUseExecutorResource,
    require(bridgePath).createExecutor({ ComputerUseResult, ComputerUseSuccess, ComputerUseError, Coordinate }),
  );
  return SimpleControlledExecManager.fromResources(registry3);`,
  );
  assert.throws(
    () => verifyLocalExecComputerIsolationSource(unscoped),
    /shared local-exec daemon cannot expose an unscoped computer executor/,
  );
});

test("renderer patch tags every composer form with its owning bot id", () => {
  const patched = patchRendererComposerIdentitySource(composerFixture());
  assert.doesNotThrow(() => verifyRendererComposerIdentitySource(patched));
  assert.equal(patched.split("codexAgentId: n.currentAgentId,").length - 1, 3);
  assert.match(patched, /const e = he\.c\(216\),/);
  assert.match(patched, /"data-codex-agent-id": codexAgentId2/);
  assert.match(patched, /e\[214\] !== codexAgentId2/);
  assert.match(patched, /\(e\[215\] = \$a\)/);
  assert.doesNotMatch(patched, /\be\[216\]/);
});

test("composer verifier rejects a stale React compiler cache mutation", () => {
  const patched = patchRendererComposerIdentitySource(composerFixture());
  const mutated = patched.replace("e[214] !== codexAgentId2", "false");
  assert.throws(
    () => verifyRendererComposerIdentitySource(mutated),
    /memoization and DOM identity/,
  );
});

test("settings patch retains only account and appearance cards", () => {
  const patched = patchSettingsViewSource(settingsFixture());
  assert.doesNotThrow(() => verifySettingsViewSource(patched));
  const general = patched.slice(
    patched.indexOf("function Sa(s)"),
    patched.indexOf("function Ta(s)"),
  );
  assert.match(general, /title: "Account"/);
  assert.match(general, /a\.jsx\(pa, \{\}\)/);
  assert.doesNotMatch(general, /a\.jsx\((?:oa|va), \{\}\)/);
});

test("settings verifier rejects a reintroduced vendor settings card", () => {
  const patched = patchSettingsViewSource(settingsFixture());
  assert.throws(
    () =>
      verifySettingsViewSource(
        patched.replace("a.jsx(pa, {})", "a.jsx(va, {})"),
      ),
    /account and appearance/,
  );
});

test("function replacement recognizes async declarations without swallowing its neighbor", () => {
  const source = `function fUn(n) {
  return n;
}
async function hUn(n) {
  const [e, t, s] = await Promise.all([
    n.isOnboardingSeen(),
    n.isSignedIn(),
    n.countAgents(),
  ]);
  return { kind: "landed", gate: "onboarding", e, t, s };
}
function onboardingOwner() {
  return hUn({});
}
`;
  const patched = replaceFunction(
    source,
    ["isOnboardingSeen()", "isSignedIn()", "countAgents()"],
    `async function hUn(n) {
  if (await n.countAgents() > 0) n.markOnboardingSeen();
  return { kind: "landed", gate: "shell" };
}`,
    "local onboarding gate fixture",
  );

  assert.match(patched, /^function fUn\(n\)/m);
  assert.match(patched, /^async function hUn\(n\)/m);
  assert.match(patched, /return hUn\(\{\}\);/);
  assert.doesNotMatch(patched, /n\.isSignedIn\(\)/);
});

test("function replacement preserves trailing renderer aliases and verifies their uses", () => {
  const source = `function RRn(n, e) {
  n.startsWith("mcp-install:")
    ? DRn(e ?? n.slice(12))
    : n.startsWith("mcp:")
      ? jRn(n.slice(4))
      : A0t(n);
}
const FRn = Dme().actions,
  RWe = na.orgChart;
function zRn(n) {
  return [
    ((oe) => yPe(oe, n).kind === "available")(RWe),
    { id: RWe },
    { palette: FRn },
  ];
}
async function hUn(n) {
  return n;
}
function onboardingOwner() {
  return hUn({});
}
`;
  const patched = replaceFunction(
    source,
    ['n.startsWith("mcp-install:")', 'n.startsWith("mcp:")'],
    `function RRn(n, e) {
  void n;
  void e;
}`,
    "plugin reference router fixture",
  );

  assert.match(
    patched,
    /^const FRn = Dme\(\)\.actions,\n  RWe = na\.orgChart;$/m,
  );
  assert.doesNotThrow(() => verifyRendererRuntimeBindingsSource(patched));
  assert.throws(
    () =>
      verifyRendererRuntimeBindingsSource(
        patched.replace("  RWe = na.orgChart;\n", ""),
      ),
    /FRn\/RWe declarations/,
  );
  assert.throws(
    () =>
      verifyRendererRuntimeBindingsSource(
        patched.replace("async function hUn", "async function removedHUn"),
      ),
    /hUn declaration/,
  );
  assert.throws(
    () =>
      verifyRendererRuntimeBindingsSource(
        patched.replace("return hUn({});", "return null;"),
      ),
    /hUn declaration/,
  );
});
