# OpenBot macOS Rebrand Implementation Plan

> Execute with test-driven development, systematic debugging, visual review,
> independent code review, and verification before completion.

**Goal:** Rename the macOS product to OpenBot without breaking Grok 0.20 parity,
provider routing, or existing Codex Bot user data, then prepare the exact
versioned release boundary without touching Windows work.

**Architecture:** Keep legacy internal compatibility identifiers. Introduce a
small production user-data migration module that runs before desktop dependency
construction. Change only visible/release identities and their exact tests.

## Task 1: Product identity RED/GREEN

- Add exact source and behavior assertions for OpenBot package metadata, window
  title, desktop app name, client titles, reports, accessibility labels, and the
  `0.2.0-macos.1` release version.
- Record RED against the current Codex Bot strings.
- Change the minimum product-facing sources; retain provider-specific Codex copy.
- Run the focused identity tests GREEN.

## Task 2: Atomic legacy-profile migration RED/GREEN

- Add `test/openbot-user-data.test.cjs` covering fresh creation, atomic legacy
  copy, full nested state preservation, legacy retention, existing-target
  idempotency, permissions, symlink/special-file rejection, injected copy/rename
  failure cleanup, and sanitized failure.
- Record RED before the module exists.
- Implement `src/desktop/openbot-user-data.cjs` with dependency injection for
  deterministic failures and no ambient home-directory reads in tests.
- Compile and bundle the reviewed macOS `RENAME_EXCL` publisher, pin its exact
  installer receipt, copy it into the installed app, and sign it before the
  outer app so publication cannot overwrite a concurrent target.
- Wire it only into production desktop startup before dependency construction;
  keep injected unit-test startup unchanged.
- Add the module to patch staging and exact mutation tests.

## Task 3: Installer and DMG identity RED/GREEN

- Change test expectations first for OpenBot app/installer names, bundle IDs,
  version, volume, and `dist/0.2.0-macos.1/OpenBot-0.2.0-macos.1.dmg`.
- Update Swift installer destination/plist/copy and Node builder/package scripts.
- Preserve the old app and profile; update installer copy truthfully.
- Run Swift transaction, installer bundle, release package, and audit tests.

## Task 4: Documentation and provider truth

- Update README, PRIVACY, NOTICE, reports, and visible provider copy.
- Preserve legacy IPC/env/module identifiers and document why.
- Assert direct Codex never starts CLIProxyAPI; Anthropic catalog remains exact;
  Kimi is not advertised as selectable until reviewed.
- Run provider/router/renderer/Grok parity suites.

## Task 5: Visual evidence and regression review

- Capture the exact renderer and installer at 1024x680 and 1920x1080.
- Inspect OpenBot identity, light/dark/narrow, Fast, Max, Ultra, Ultra Code,
  reduced motion, focus/hover/disabled, and Advanced states.
- Compare hashes/DOM traces so renamed captures do not mask control regressions.
- Request an independent read-only code and visual review; resolve findings with
  one deterministic RED per confirmed defect.

## Task 6: Full verification and live gates

- Run focused macOS suites, full `npm test`, Swift tests/build, syntax checks,
  diff check, exact scope audit, secret/path scan, and Grok contract parity.
- Run official direct-Codex acceptance with ChatGPT.app closed and CLIProxyAPI
  absent.
- If and only if the reviewed provider env is configured, run the two-bot remote
  acceptance and prove remote Chrome opens YouTube in both distinct VMs.
- Stop and report `REMOTE_PROVIDER_GATE=BLOCKED` if it is not configured; never
  substitute local or shared execution.

## Task 7: Release, install, and publish

- Verify the Developer ID identity without embedding it.
- Build, sign, notarize, staple, mount, and privacy-audit the versioned DMG.
- Install OpenBot on a fresh test profile, run project Reality Check, and verify
  migration separately from a synthetic legacy profile.
- Commit only macOS paths, push `macos/codex-bot` without force, and place the
  DMG only in the approved versioned release area.
- Do not publish when any live, signing, notarization, audit, or install gate is
  blocked or failing.
