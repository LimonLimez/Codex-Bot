"use strict";

async function main() {
  const executable = process.argv[2];
  const icon = process.argv[3];
  if (!executable) throw new Error("Usage: brand-executable.cjs <Codex Bot.exe>");
  const imported = await import("rcedit");
  const rcedit = imported.rcedit || imported.default;
  if (typeof rcedit !== "function") throw new Error("The installed rcedit package did not expose its API.");
  await rcedit(executable, {
    "file-version": "0.1.1.0",
    "product-version": "0.1.1.0",
    "version-string": {
      CompanyName: "Codex Bot contributors",
      FileDescription: "Codex Bot",
      InternalName: "Codex Bot",
      LegalCopyright: "Codex Bot Bridge contributors",
      OriginalFilename: "Codex Bot.exe",
      ProductName: "Codex Bot",
    },
    ...(icon ? { icon } : {}),
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
