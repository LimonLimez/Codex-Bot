"use strict";

async function main() {
  const executable = process.argv[2];
  const icon = process.argv[3];
  if (!executable)
    throw new Error("Usage: brand-executable.cjs <Open Bot.exe>");
  const imported = await import("rcedit");
  const rcedit = imported.rcedit || imported.default;
  if (typeof rcedit !== "function")
    throw new Error("The installed rcedit package did not expose its API.");
  await rcedit(executable, {
    "file-version": "0.1.7.0",
    "product-version": "0.1.7.0",
    "version-string": {
      CompanyName: "Open Bot contributors",
      FileDescription: "Open Bot",
      InternalName: "Open Bot",
      LegalCopyright: "Open Bot contributors",
      OriginalFilename: "Open Bot.exe",
      ProductName: "Open Bot",
    },
    ...(icon ? { icon } : {}),
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
