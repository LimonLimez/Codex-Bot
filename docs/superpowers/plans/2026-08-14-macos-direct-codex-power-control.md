# Codex Bot macOS Direct Codex and Native Power Control Implementation Plan

> Execute only on `macos/codex-bot`. Use TDD for every behavior change. Keep
> Windows paths unchanged and do not publish or install a public artifact until
> every release gate is proven.

**Goal:** Finish the native capability-aware Power control, make official Codex
account/model operation independent of ChatGPT.app and CLIProxyAPI, preserve
optional providers and the Grok 0.20 shell, then sign, notarize, privacy-audit,
install, and push the isolated macOS release.

**Design:**
`docs/superpowers/specs/2026-08-14-macos-direct-codex-power-control-design.md`

## Task 1: Pin and verify official Codex 0.147.0

**Files:**

- Create `macos/assets/codex-0.147.0-darwin-arm64.json`
- Create `macos/scripts/verify-codex-runtime.cjs`
- Create `macos/test/codex-runtime-integrity.test.cjs`
- Modify installer/package/audit scripts only as required by the verified
  runtime receipt

**RED:** Synthetic archives fail on wrong digest, bytes, version, architecture,
signature, signer/team, multiple members, traversal, symlinks, extra files,
unsigned/ad-hoc executable, or developer path. Production runtime resolution
fails if the packaged receipt or executable differs.

**GREEN:** Pin the official release URL, size, digest, version, license, expected
signer/team, executable bytes, and CDHash. Verify into owned staging and create a
small non-secret receipt used by the installer.

**Verify:** focused integrity test, exact official artifact verification,
signature/Gatekeeper inspection, path/secret scan, diff check.

**Commit:** `build(mac): pin the official Codex app server`

## Task 2: Add the bounded direct app-server manager

**Files:**

- Create `macos/src/desktop/codex-app-server-manager.cjs`
- Create `macos/test/codex-app-server-manager.test.cjs`
- Modify `macos/src/desktop/runtime.cjs`
- Modify `macos/test/desktop-runtime.test.cjs`

**RED:** Cover packaged-path-only production resolution, receipt verification,
one-flight startup, initialize/initialized ordering, bounded JSONL frames,
request IDs, timeouts, stdout/stderr caps, process exit, dispose races, stale
callbacks, restart generation, listener isolation, and sanitized errors. Prove
that ChatGPT.app and user-installed Codex paths are not consulted in production.

**RED security:** Assert exact launch overrides disable local tool surfaces; all
command/file/approval/MCP/app/plugin/browser/computer/process/dynamic-tool
requests are denied without execution; no local working directory is exposed.

**GREEN:** Implement a private stdio app-server manager around the verified
packaged binary. Keep raw child/process/session state non-enumerable and out of
IPC. Use shared official Codex home only for official account handling.

**Commit:** `feat(mac): run Codex directly from the signed app`

## Task 3: Add account and dynamic catalog state

**Files:**

- Create `macos/src/desktop/codex-account-controller.cjs`
- Create `macos/test/codex-account-controller.test.cjs`
- Modify desktop/preload patch files and tests needed for the exact IPC facade
- Modify `macos/src/renderer/bot-runtime-ui.js`
- Modify renderer integration tests

**RED:** Cover account/read, ChatGPT browser and device-code login, cancellation,
completion, logout, rate-limit state, stale login generations, malformed URLs,
hostile payloads, process replacement, and secret stripping. Cover paginated
`model/list`, dedupe, ordering, hidden entries, malformed capabilities, catalog
generation, and no hardcoded current catalog.

**GREEN:** Publish only frozen sanitized account/catalog state. Expose sign-in,
cancel, logout, retry, and catalog operations through exact renderer IPC.

**Live proof:** with the standalone binary and existing official login, record
only auth mode/plan and sanitized model IDs/efforts. Never print account ID,
email, tokens, auth files, or URLs containing credentials.

**Commit:** `feat(mac): use the official Codex account and catalog`

## Task 4: Split direct Codex from optional CLIProxy providers

**Files:**

- Create `macos/src/desktop/inference-provider-router.cjs`
- Create `macos/test/inference-provider-router.test.cjs`
- Modify `macos/src/desktop/runtime.cjs`
- Modify `macos/src/bridge/server.cjs`
- Modify `macos/src/bridge/codex-client.cjs` or replace it with an exact
  app-server adapter
- Modify CLIProxy manager/config tests

**RED:** Starting, signing in, listing, or sending Codex causes zero CLIProxy
processes/config writes. Fable selection starts exactly one verified sidecar on
demand. Unknown providers, provider changes during a send, startup failures,
stale sidecars, and cross-provider replies fail closed. Codex and optional
provider credentials/catalogs never cross.

**GREEN:** Route OpenAI tuples to the app-server adapter and reviewed optional
tuples to lazily started CLIProxyAPI. Remove unconditional sidecar startup and
global CLIProxy environment as the Codex default.

**Commit:** `feat(mac): make CLIProxy an optional provider`

## Task 5: Implement the native compact Power control

**Files:**

- Modify `macos/src/renderer/model-controls.js`
- Modify `macos/src/renderer/reasoning-control.js`
- Modify `macos/src/renderer/bot-runtime-ui.js`
- Modify `macos/src/renderer/codex-ui.css`
- Modify focused unit/integration/visual harness tests

**RED model:** Exact immutable stop tuples, native labels, live capability
filtering, preferred Terra/Sol construction, default fallback, Advanced
round-trip, service tier, Fable Ultra Code mapping, no invalid hidden selection,
and per-bot/runtime generation ownership.

**RED interaction:** Pointer preview/commit, drag, wheel snap, arrows, Home/End,
focus, hover, held endpoint labels, screen-reader live text, Fast transitions,
Max blue, Ultra entry/steady/burst, Ultra Code identity/effect, reduced motion,
disabled state, and stale interaction cancellation.

**GREEN:** Replace the independent model/effort presentation with the compact
Power control plus native Advanced Model/Effort/Speed view. Ordinary selection
is blue. Max remains blue. Ultra/Ultra Code use the reviewed animated
purple/blue effect.

**Visual proof:** fresh 1024x680 and 1920x1080 exact-source captures for every
required state, interaction traces, bitmap dimensions, reduced motion, and
independent full-frame/detail review against the installed native reference.

**Commit:** `feat(mac): match the native Codex Power control`

## Task 6: Preserve composer, bot, and remote-runtime transactions

**Files:**

- Modify only focused router/runtime/store/renderer tests or production files
  exposed by a failing requirement

**RED:** Add adversarial tests for sends across provider/model/effort/tier/bot/
thread/generation changes; selection during runtime retry; account loss; catalog
replacement; optional-provider failure; bot switch; frame switch; restart;
first `New Bot`; rename/profile; remote unavailability; and disposal.

**GREEN:** Fix only proven transaction gaps. Work and Computer remain remote and
fail closed. Chat and local inference never obtain remote credentials. No local
Computer/browser/shell fallback is introduced.

**Verify:** preserved Grok 130-method contract, full composer transaction suite,
bot persistence, runtime ownership, event/frame scoping, restart, and two-bot
race matrix.

**Commit:** `fix(mac): preserve bot scoped Codex transactions`

## Task 7: Extend installer, DMG, and privacy gates

**Files:**

- Modify installer Swift sources/tests
- Modify package/build/audit scripts and release tests
- Modify README/NOTICE/PRIVACY/third-party notices

**RED:** Package fails without exact Codex receipt, license, signature, or
runtime. Audit rejects Codex home, auth, rollouts, logs, configuration, caches,
personal paths, source checkout, test evidence, vendor app bytes, credentials,
or unexpected archive members. Rollback preserves Grok and the prior Codex Bot.

**GREEN:** Stage only reviewed installer resources and the verified official
Codex runtime/license. Keep CLIProxy only as the reviewed optional provider.
Update versioned artifact naming without touching the Windows release line.

**Commit:** `build(mac): package the direct Codex runtime`

## Task 8: Sign, notarize, install, and publish

**Precondition:** Ask for explicit confirmation before creating/installing a
Developer ID Application certificate or storing notarization credentials. User
owns all Apple ID/2FA interaction.

**Actions:**

1. Select Xcode Beta per command with `DEVELOPER_DIR`; do not change the global
   developer directory.
2. Create/import the paid-team Developer ID Application identity after approval.
3. Build cleanly, sign nested code and app with hardened runtime/timestamp,
   package DMG, sign DMG, notarize, staple, and validate.
4. Run signature, Gatekeeper, staple, privacy, archive allowlist, launch, direct
   login/catalog/send, optional Fable/Ultra Code, bot persistence, remote Work/
   Computer, no-fallback, rollback, and clean-install acceptance.
5. Quit ChatGPT.app for the independent direct-Codex launch proof, then confirm
   no ChatGPT process or CLIProxy process is required for a Codex turn.
6. Hash the final DMG and place it only in the matching macOS version directory.
7. Re-audit the Windows tree read-only and prove no Windows files changed.
8. Commit documentation/evidence, push `macos/codex-bot`, and publish the DMG
   only after every gate is green.

**Commit:** `release(mac): ship signed direct Codex Bot`

## Final requirement ledger

Before completion, record one authoritative evidence source for every explicit
design completion gate. A skipped live provider, unsigned development build,
focused test, or static screenshot cannot prove the broader release requirement.
