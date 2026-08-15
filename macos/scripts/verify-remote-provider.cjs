#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  loadLiveGateDependencies,
  runRemoteProviderLiveGate,
} = require("../src/bots/remote-provider-live-gate.cjs");
const {
  publicGateReport,
  writeGateReport,
} = require("../src/bots/remote-provider-live-report.cjs");

const BLOCKED_CODE = "REMOTE_PROVIDER_GATE_BLOCKED";

async function privateTemporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(directory, 0o700);
  return directory;
}

async function createPrivateWorkspace() {
  return privateTemporaryDirectory("codex-bot-remote-gate-");
}

async function resolveOutputDirectory(env) {
  const configured = env.CODEX_BOT_REMOTE_GATE_OUTPUT_DIR;
  if (configured === undefined) {
    return privateTemporaryDirectory("codex-bot-remote-report-");
  }
  if (typeof configured !== "string" || !path.isAbsolute(configured)) {
    throw new TypeError("Invalid remote provider report directory.");
  }
  const stat = await fs.lstat(configured);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new TypeError("Invalid remote provider report directory.");
  }
  return configured;
}

async function removePrivateWorkspace(workspacePath) {
  await fs.rmdir(workspacePath);
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  signal,
  loadDependencies = loadLiveGateDependencies,
  runGate = runRemoteProviderLiveGate,
  buildReport = publicGateReport,
  writeReport = writeGateReport,
  createWorkspace = createPrivateWorkspace,
  resolveOutputDirectory: outputDirectory = resolveOutputDirectory,
  removeWorkspace = removePrivateWorkspace,
} = {}) {
  void stderr;
  let dependencies = null;
  let workspacePath = null;
  let gateStarted = false;
  let status = "FAIL";
  let code = 1;

  try {
    if (!Array.isArray(argv) || argv.length !== 0) {
      throw new TypeError("Remote provider verification accepts no arguments.");
    }
    dependencies = loadDependencies({
      providerModulePath: env.CODEX_BOT_REMOTE_PROVIDER_MODULE,
      exerciseModulePath: env.CODEX_BOT_REMOTE_EXERCISE_MODULE,
    });
    workspacePath = await createWorkspace();
    const reportDirectory = await outputDirectory(env);
    gateStarted = true;
    const result = await runGate({
      provider: dependencies.provider,
      exercise: dependencies.exercise,
      workspacePath,
      ...(signal === undefined ? {} : { signal }),
    });
    const report = buildReport(result);
    await writeReport({ report, outputDirectory: reportDirectory });
    await removeWorkspace(workspacePath);
    workspacePath = null;
    status = "PASS";
    code = 0;
  } catch (error) {
    if (error?.code === BLOCKED_CODE) {
      status = "BLOCKED";
      code = 2;
    }
  } finally {
    if (workspacePath !== null) {
      try {
        await removeWorkspace(workspacePath);
      } catch {
        status = "FAIL";
        code = 1;
      }
    }
    if (dependencies && !gateStarted) {
      try {
        await dependencies.exercise?.dispose?.();
      } catch {
        status = "FAIL";
        code = 1;
      }
    }
  }

  stdout.write(`REMOTE_PROVIDER_GATE=${status}\n`);
  return code;
}

async function runFromShell() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    process.exitCode = await main({ signal: controller.signal });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (require.main === module) {
  runFromShell().catch(() => {
    process.stdout.write("REMOTE_PROVIDER_GATE=FAIL\n");
    process.exitCode = 1;
  });
}

module.exports = { main };
