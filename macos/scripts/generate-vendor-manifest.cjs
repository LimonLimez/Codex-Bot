"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  SUPPORTED,
  inventoryApp,
  probeVendorIdentity,
  validateManifest,
  verifyIdentity,
} = require("./verify-vendor-app.cjs");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${key}`);
    }
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function generateManifest(appPath) {
  const identity = await probeVendorIdentity(appPath);
  verifyIdentity(identity, SUPPORTED.identity);
  const manifest = {
    schemaVersion: SUPPORTED.schemaVersion,
    product: SUPPORTED.product,
    version: SUPPORTED.version,
    platform: SUPPORTED.platform,
    artifact: { ...SUPPORTED.artifact },
    identity: { ...SUPPORTED.identity },
    files: inventoryApp(appPath),
  };
  validateManifest(manifest);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app || !args.output) {
    throw new Error("Usage: generate-vendor-manifest.cjs --app <Grok Bot.app> --output <manifest.json>");
  }
  const output = path.resolve(args.output);
  const manifest = await generateManifest(path.resolve(args.app));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, product: manifest.product, version: manifest.version, files: manifest.files.length })}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { generateManifest };
