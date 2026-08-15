# Codex Bot macOS 0.20 Preserve-and-Patch Implementation Plan

> Execute this plan only on `macos/codex-bot`. Keep the Windows root unchanged.

**Goal:** Ship a macOS Apple Silicon installer DMG that converts an independently
verified, user-owned Grok Bot 0.20.0 shell into Codex Bot while preserving every
stock function, applying the approved Codex model/reasoning UI, using persistent
main-owned bots and one explicitly authorized remote runtime per bot, and
containing no vendor binary, personal state, credential, or development residue.

**Architecture:** A native Swift installer verifies and copies the exact official
Grok app, then uses the verified vendor Electron executable in Node mode to run a
bundled open-source ASAR patcher. The patcher makes a reviewed allowlist of
changes to a staging copy, adds an authenticated loopback Codex bridge backed by
the pinned MIT-licensed CLIProxyAPI `7.2.130` macOS arm64 sidecar, and re-signs
the separate Codex Bot app. The public DMG contains the installer and reviewed
open-source resources only. Stock shell contracts are guarded by a generated
metadata inventory plus live exact-input integration tests.

**Primary stack:** Node.js 22, `@electron/asar`, Prettier, native `node:test`,
Swift 6/SwiftPM, AppKit/SwiftUI installer UI, macOS `hdiutil`, `codesign`,
`spctl`, `notarytool`, and GitHub Actions/Releases.

**Design:**
`docs/superpowers/specs/2026-08-14-macos-grok-020-preserve-patch-design.md`

> **Continuation:** The direct Codex runtime, optional-provider split, final
> native Power control, and public signing work continue in
> `2026-08-14-macos-direct-codex-power-control.md`. That plan supersedes any
> remaining task here that assumes CLIProxyAPI is mandatory for Codex.

## Global rules

- Use test-driven development for every behavior change: capture a focused RED,
  implement the minimum production change, and capture the focused GREEN.
- Never modify an existing Windows file merely to make a macOS command pass.
- Never commit or package a vendor app, extracted ASAR, patched ASAR, user state,
  credential, screenshot, or absolute personal path.
- Use synthetic fixtures for normal CI and a separate exact-vendor integration
  lane that is skipped unless the reviewed 0.20.0 app is provided.
- Keep vendor download/mount/extraction paths inside one task-owned temporary
  directory and detach mounts before cleanup.
- Do not install over `/Applications/Codex Bot.app`, publish a final release, or
  upload a DMG until every release blocker in the design is clear.
- An absent live remote provider is a truthful blocker; it is not permission to
  use the Mac, a local browser, a shared vendor box, or a mock as release proof.

## Task 1: Add a macOS-only package and cross-platform command boundary

**Files:**

- Create: `macos/package.json`
- Create: `macos/package-lock.json`
- Create: `macos/README.md`
- Create: `macos/.gitignore`
- Create: `macos/test/platform-boundary.test.cjs`
- Modify: root `package.json` only if a platform-neutral command can dispatch
  without changing Windows dependency versions or existing scripts

**RED:** Assert that the macOS package exists under `macos/`, has a mac-specific
pre-release version, exposes check/test/audit/package commands, and that no
tracked Windows path differs from base commit `129bc098...`.

```bash
node --test macos/test/platform-boundary.test.cjs
```

**GREEN:** Add an independent Node package with pinned dependencies. Prefer
running commands from `macos/`; do not make the Windows root install mac-only
tools. Record the immutable base-tree path/hash inventory used by the boundary
test.

**Verify:**

```bash
npm --prefix macos ci
npm --prefix macos run check
node --test macos/test/platform-boundary.test.cjs
git diff --check
```

**Commit:** `build(mac): isolate the macOS release line`

## Task 2: Generate and audit the exact Grok 0.20.0 macOS manifest

**Files:**

- Create: `macos/scripts/generate-vendor-manifest.cjs`
- Create: `macos/scripts/verify-vendor-app.cjs`
- Create: `macos/assets/grok-bot-0.20.0-darwin-arm64.manifest.json`
- Create: `macos/test/vendor-integrity.test.cjs`

**RED:** Synthetic app fixtures must fail on missing/extra/hash-mismatched files,
unexpected symlinks, traversal, alternate bundle/version/architecture, wrong
signer/team/CDHash, invalid signature, and missing Gatekeeper/notarization proof.
The exact manifest must contain canonical sorted relative paths and no personal
or mounted-volume path.

**GREEN:** Generate the reviewed manifest from the read-only mounted official
DMG, including file types and hashes. The verifier uses argument arrays, never
shell interpolation; bounds all subprocess output; and checks DMG size/hash,
Info.plist, `file`, `codesign`, and `spctl` before accepting the tree.

**Verify:**

```bash
node --test macos/test/vendor-integrity.test.cjs
node macos/scripts/verify-vendor-app.cjs --app "$GROK_BOT_020_APP"
git grep -n '/Users/\|/private/tmp/\|Bearer \|sk-' -- macos/assets
```

**Commit:** `feat(mac): pin the Grok Bot 0.20 runtime`

## Task 3: Record and enforce stock 0.20 capability parity

**Files:**

- Create: `macos/scripts/audit-grok-contract.cjs`
- Create: `macos/assets/grok-bot-0.20.0-contract.json`
- Create: `macos/test/grok-contract-parity.test.cjs`
- Create: `macos/docs/grok-0.20-parity.md`

**RED:** A synthetic patched preload missing any of the 130 reviewed methods, a
stock event, or an inventoried feature literal must fail. Added unreviewed
methods and changes outside the patch allowlist must also fail.

**GREEN:** Build a metadata-only contract from the exact vendor input. Include
the 117 inherited methods plus the 13 0.20 additions:
`attachProdBoxStatus`, `devRestart`, `getHardwareAcceleration`,
`listClientPersistenceKeys`, `migrateClientPersistence`,
`noteSentryConversation`, `readClientPersistence`, `relaunchDesktop`,
`removeClientPersistence`, `reportHeapMetrics`, `setAttachProdBoxEnabled`,
`setHardwareAccelerationEnabled`, and `writeClientPersistence`. Record stock
event channels and the feature inventory from the design. Do not store vendor
source or long proprietary strings.

**Verify:**

```bash
node --test macos/test/grok-contract-parity.test.cjs
node macos/scripts/audit-grok-contract.cjs --app "$GROK_BOT_020_APP"
```

**Commit:** `test(mac): enforce Grok 0.20 function parity`

## Task 4: Port the patch engine to the 0.20 macOS shell

**Files:**

- Create: `macos/scripts/patch-app.cjs`
- Create: `macos/src/patch/anchors.cjs`
- Create: `macos/src/patch/diff-audit.cjs`
- Create: `macos/test/patch-app.test.cjs`
- Create: `macos/test/patch-diff.test.cjs`

**RED:** Synthetic 0.20 fixtures must prove exact unique anchors, formatting
normalization, ASAR unpack preservation, abort-before-output on ambiguity, and an
exact post-patch changed-file/region allowlist. A 0.18 ASAR or wrong 0.20 hash
must fail before extraction.

**GREEN:** Reuse only generic reviewed utilities from the Windows patcher. Write
new 0.20 anchors after formatting disposable extracted JavaScript with the
pinned Prettier version. The patcher operates only on a staging ASAR, preserves
the `dist/deps` and `dist/native` unpack layout, emits a structured patch receipt,
and removes its exact temporary directory in `finally`.

**Verify:**

```bash
node --test macos/test/patch-app.test.cjs macos/test/patch-diff.test.cjs
node macos/scripts/patch-app.cjs \
  --source-asar "$GROK_BOT_020_ASAR" \
  --target-asar "$TASK_TEMP/patched.asar" \
  --runtime-config "$TASK_TEMP/runtime.json"
node macos/scripts/audit-grok-contract.cjs --asar "$TASK_TEMP/patched.asar"
```

**Commit:** `feat(mac): patch the verified Grok 0.20 shell`

## Task 5: Add the authenticated Codex bridge without stock-feature removal

**Files:**

- Create: `macos/src/bridge/server.cjs`
- Create: `macos/src/bridge/codex-client.cjs`
- Create: `macos/src/bridge/message-codec.cjs`
- Create: `macos/src/bridge/redaction.cjs`
- Create: `macos/src/bridge/runtime-config.cjs`
- Create: `macos/assets/cliproxyapi-7.2.130-darwin-aarch64.json`
- Create: `macos/test/bridge-*.test.cjs`
- Modify: `macos/scripts/patch-app.cjs`

**RED:** Cover loopback-only binding, fresh random credential, exact header,
message/tool/attachment conversion, bounded frames, JSON-RPC request ownership,
approval exact-once semantics, secret redaction, stale generations, shutdown,
and no vendor inference/auth/usage fallback. A stock feature call outside Codex
substitution paths must still reach the original stock bridge.

**GREEN:** Adapt reviewed bridge components from the Windows and prior macOS
implementation, removing Windows-only/local-browser logic and private Companion
dependencies. Pin CLIProxyAPI `7.2.130` to upstream asset
`CLIProxyAPI_7.2.130_darwin_aarch64.tar.gz` and SHA-256
`a644a75f70cbd045b9f7caa9ff3866353448a7ed67ef8472eacc11c48b1c86f0`;
verify its published checksum, arm64 executable, version, and MIT license before
packaging. Use a random loopback port and credential, the supported Codex OAuth
device route, and pinned `ws`; keep auth state, provider/account diagnostics,
and any optional Keychain-stored API key private and fail closed.

**Verify:**

```bash
node --test macos/test/bridge-*.test.cjs
node --check macos/src/bridge/*.cjs
```

**Commit:** `feat(mac): route Grok conversations through Codex`

## Task 6: Port persistent bot ownership and remote runtime reconciliation

**Files:**

- Create: `macos/src/bots/bot-store.cjs`
- Create: `macos/src/bots/runtime-provider.cjs`
- Create: `macos/src/bots/runtime-controller.cjs`
- Create: `macos/src/bots/remote-app-server-client.cjs`
- Create: `macos/src/bots/conversation-router.cjs`
- Create: `macos/test/bot-*.test.cjs`
- Create: `macos/test/runtime-*.test.cjs`
- Create: `macos/test/conversation-router.test.cjs`

**RED:** Port the approved adversarial tests for literal zero-argument `New Bot`,
atomic main-owned persistence, canonical UUIDs, unique conversation ownership,
one runtime per bot, authoritative retirement proof, candidates, terminal events,
generation/receipt/disposal/cross-store races, sanitized public state, hostile
objects, listener isolation, and bot-scoped conversation routing. Add an explicit
test that no local/shared runtime provider exists.

**GREEN:** Port the already reviewed Task 1-5 implementations from the prior
macOS worktree into the new namespace. Remove the old injected-only provider
claim unless a real explicitly authorized provider adapter is configured.
Unconfigured provider state is `unavailable`, never `ready`.

**Verify:**

```bash
node --test macos/test/bot-*.test.cjs macos/test/runtime-*.test.cjs \
  macos/test/conversation-router.test.cjs
```

**Commit:** `feat(mac): isolate one remote runtime per bot`

## Task 7: Apply the approved model and reasoning controls inside stock 0.20 UI

**Files:**

- Create: `macos/src/renderer/model-controls.js`
- Create: `macos/src/renderer/reasoning-control.js`
- Create: `macos/src/renderer/bot-runtime-ui.js`
- Create: `macos/src/renderer/codex-ui.css`
- Create: `macos/test/model-controls.test.cjs`
- Create: `macos/test/renderer-integration.test.cjs`
- Modify: `macos/scripts/patch-app.cjs`

**RED:** Port capability matrices, direct-child topology/mutation probes, send
transaction snapshots, Chat/Work bot scoping, literal New Bot/explicit rename,
all runtime states/Retry, stale frame clearing, reduced motion, keyboard/focus,
and 1024x680/1920x1080 layout assertions. Add parity checks that stock plugin,
skill, routine, connector, settings, group-chat, attachment, and approval
navigation remains reachable.

**GREEN:** Integrate the prior accepted controls as small injected modules/styles
using 0.20-specific unique anchors. Preserve Max blue, Ultra animated
purple/blue, Sol/Terra six positions, GPT-5.5 four positions, compact dimensions,
truthful unavailable copy, and the reviewed CLIProxyAPI Fable/Opus/Sonnet 5
catalog. `Ultra Code` reuses the Ultra effect but maps to the provider-supported
`max` effort. Do not replace the stock renderer wholesale.

**Verify:**

```bash
node --test macos/test/model-controls.test.cjs \
  macos/test/renderer-integration.test.cjs
```

**Commit:** `feat(mac): integrate native Codex bot controls`

## Task 8: Implement the native transactional installer

**Files:**

- Create: `macos/installer/Package.swift`
- Create: `macos/installer/Sources/InstallCodexBot/main.swift`
- Create: `macos/installer/Sources/InstallerCore/*.swift`
- Create: `macos/installer/Tests/InstallerCoreTests/*.swift`
- Create: `macos/scripts/build-installer-app.cjs`
- Create: `macos/test/installer-bundle.test.cjs`

**RED:** Test exact discovery, explicit download consent, pinned URL, no redirect
substitution, single lock, safe mount/detach, staging, no original modification,
rollback, exact replacement target, cancellation, subprocess bounds, no shell
injection, and no broad deletion. Simulate every failure boundary.

**GREEN:** Build a small native macOS installer. Bundle open-source patcher
resources and production dependencies only. Invoke the verified vendor Electron
executable with `ELECTRON_RUN_AS_NODE=1` for ASAR work. Re-sign changed nested
code then the app. Keep ad-hoc signing development-only; require Developer ID
configuration for a release build.

**Verify:**

```bash
swift test --package-path macos/installer
node --test macos/test/installer-bundle.test.cjs
npm --prefix macos run build:installer
codesign --verify --deep --strict "$TASK_TEMP/Install Codex Bot.app"
```

**Commit:** `feat(mac): add the transactional macOS installer`

## Task 9: Build and enforce a privacy-clean DMG

**Files:**

- Create: `macos/scripts/package-dmg.cjs`
- Create: `macos/scripts/audit-release.cjs`
- Create: `macos/test/release-audit.test.cjs`
- Create: `macos/PRIVACY.md`
- Create: `macos/NOTICE.md`
- Create: `macos/README-INSTALLER.md`
- Create: `.github/workflows/macos-release.yml`

**RED:** Synthetic DMGs must fail on vendor binaries, extracted/patch ASAR,
credentials, profiles, databases, logs, screenshots, absolute home/temp/volume
paths, `.git`, source maps, private Companion artifacts, unsigned nested code,
wrong version/tag/architecture, extra files, or unexpected symlinks.

**GREEN:** Create a deterministic read-only UDIF with the exact allowlist from
the design. Use an owned clean staging directory, normalized timestamps where
compatible with signing, no Finder metadata, and an audit receipt containing
only public hashes/versions. The workflow signs and notarizes using GitHub
secrets without printing them, staples the ticket, audits the final DMG, and
uploads it only for a matching macOS tag.

**Verify:**

```bash
node --test macos/test/release-audit.test.cjs
npm --prefix macos run package:dmg
node macos/scripts/audit-release.cjs --dmg "$DMG_PATH"
codesign --verify --deep --strict "$MOUNT/Install Codex Bot.app"
spctl -a -vv --type execute "$MOUNT/Install Codex Bot.app"
xcrun stapler validate "$MOUNT/Install Codex Bot.app"
```

**Commit:** `build(mac): package a privacy-clean installer DMG`

## Task 10: Run stock function, installed app, remote runtime, and visual acceptance

**Files:**

- Create: `macos/test/acceptance/stock-capabilities.test.cjs`
- Create: `macos/test/acceptance/installed-app.test.cjs`
- Create: `macos/test/acceptance/remote-two-bot.test.cjs`
- Create: `macos/test/acceptance/visual-runtime.cjs`
- Create: `macos/docs/acceptance-report.md`

**RED before fixes:** Run each acceptance group against the first staged build and
record every genuine mismatch. Do not weaken the test to fit implementation.

**GREEN criteria:**

- Every stock capability and all 130 methods remain present.
- Codex login/inference/models/tools/approvals work without vendor inference.
- Two separately created `New Bot` records persist, rename independently, and
  retain independent conversation ownership across restart.
- An explicitly authorized provider provisions two distinct remote runtimes;
  each bot receives only its own frames/events; switching clears stale frames;
  retry/terminal/dispose/restart recovery passes; provider absence is
  unavailable with no local/shared fallback.
- Fresh 1024x680 and 1920x1080 full-frame/detail captures match the approved
  hierarchy, model slider states, runtime copy, Retry behavior, and motion.
- A fresh installed app starts with no user account, bot, conversation, log,
  profile, or development path from the build machine.
- Rollback restores the previous Codex Bot only; Grok Bot remains untouched.

**Verify:**

```bash
node --test macos/test/acceptance/*.test.cjs
npm --prefix macos test
npm --prefix macos run check
npm --prefix macos run audit:release -- --dmg "$DMG_PATH"
```

Use the visual evidence skill for fresh full-frame/detail/motion inspection. The
remote acceptance must use a real authorized provider; fixtures are not live
proof.

**Commit:** `test(mac): verify the installed Codex Bot release`

## Task 11: Independent review and release publication

**Files:**

- Modify: `macos/docs/acceptance-report.md`
- Create: `macos/docs/release-notes-v0.1.4-macos.1.md`

**Review gates:**

1. Independent code review: patch anchors, stock parity, bot/runtime races.
2. Independent security/privacy review: downloader, verifier, bridge, DMG.
3. Independent packaging/signing review: nested signing, hardened runtime,
   notarization, stapling, Gatekeeper.
4. Independent visual review: both target viewports, motion/reduced motion,
   transient stale-frame/Retry states.

Address every Critical/Important finding RED-first and re-run all affected and
aggregate gates. Run final verification from a clean checkout of the branch.

**Final branch checks:**

```bash
git fetch origin
git merge-base --is-ancestor origin/main HEAD
git diff --name-only 129bc098ec1a8152c11b99e205eb87220603e268..HEAD
git diff --check 129bc098ec1a8152c11b99e205eb87220603e268..HEAD
npm --prefix macos ci
npm --prefix macos test
npm --prefix macos run check
npm --prefix macos run audit:release -- --dmg "$DMG_PATH"
git status --short
```

The path diff must contain only `macos/`, the two design/plan documents, the
macOS release workflow, and explicitly approved platform-neutral notice changes.

**Publish only after all gates are green:**

```bash
git push origin macos/codex-bot
gh release create v0.1.4-macos.1 "$DMG_PATH" \
  --repo LimonLimez/Codex-Bot \
  --title "Codex Bot 0.1.4 macOS 1" \
  --notes-file macos/docs/release-notes-v0.1.4-macos.1.md
gh release view v0.1.4-macos.1 --repo LimonLimez/Codex-Bot
```

Download the published asset into a new owned temporary directory, verify its
GitHub-reported and local SHA-256, rerun the release audit, and perform one final
fresh-install smoke test before declaring the release complete.

**Commit:** `docs(mac): record the verified macOS release`

## Expected blocker handling

- **No remote-provider authorization:** continue source/fixture/package candidate
  work, but do not call the app functional, do not install it over the accepted
  app, and do not publish a final release asset.
- **No Developer ID/notarization credentials:** produce only a labeled local
  development DMG for audit; do not publish it as the final installer.
- **Vendor releases 0.21+ during implementation:** finish or abandon the pinned
  0.20 work explicitly. Never retarget mid-build without a new audit, design
  amendment, manifest, RED suite, and user-visible release decision.
- **Windows main moves:** fetch and inspect; do not merge/rebase blindly over the
  friend's work. Keep mac changes path-isolated and resolve only after reviewing
  the exact main diff.
