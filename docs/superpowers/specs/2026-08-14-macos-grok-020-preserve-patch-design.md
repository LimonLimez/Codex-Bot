# Codex Bot macOS 0.20 Preserve-and-Patch Design

**Status:** Approved for implementation on `macos/codex-bot`

**Date:** 2026-08-14

**Platform:** macOS Apple Silicon (`darwin-arm64`) only

**Windows boundary:** the repository root and Windows release line remain unchanged

> **2026-08-14 amendment:** Direct Codex account/runtime and the final native
> Power-control contract are defined by
> `macos/docs/specs/2026-08-14-macos-direct-codex-power-control-design.md`.
> That document
> supersedes this file wherever this file makes CLIProxyAPI mandatory for Codex
> or treats the earlier approximate control as final. Preservation, bot,
> remote-runtime, privacy, installer, and Windows-isolation requirements here
> remain authoritative.

## Product decision

The macOS edition is a verified preserve-and-patch conversion of the official,
user-owned Grok Bot 0.20.0 application. It is not a visual approximation of the
Grok shell and it is not a repackaged copy of the proprietary vendor app.

The public Codex Bot DMG contains only the open-source installer, patch logic,
Codex bridge/runtime components, icons, notices, and verification data. The
installer obtains Grok Bot separately only after explicit user authorization,
or uses an already installed exact supported copy. It verifies that copy before
reading or copying it. The original Grok Bot installation is never modified.

The installer creates a separate `Codex Bot.app`, applies small reviewable
transformations to a copy of the exact supported shell, installs the open-source
Codex bridge, and signs the resulting local copy. The patched app uses Codex for
conversation inference and must not silently route inference, credentials,
usage credits, or chat history to xAI, Cursor, or another fallback.

## Repository and release isolation

- All macOS implementation files live under `macos/`, except shared
  documentation and top-level notices that are explicitly platform-neutral.
- No existing Windows source, tests, installer files, package metadata, or
  release artifacts are edited by the macOS implementation.
- Development happens only on `macos/codex-bot`, branched from Windows release
  commit `129bc098ec1a8152c11b99e205eb87220603e268`.
- The first macOS artifact uses tag `v0.1.4-macos.1` and asset name
  `Codex-Bot-0.1.4-macos.1-arm64.dmg`. It does not replace or retag the Windows
  `v0.1.4` release.
- The DMG is a GitHub Release asset, not a tracked Git blob.
- A macOS change may be merged later without forcing a Windows product-version
  change; platform release notes state the exact Windows base commit.

## Exact supported vendor input

The macOS installer supports exactly this input and rejects every other build:

| Field | Required value |
| --- | --- |
| Product | Grok Bot |
| Version | 0.20.0 |
| Platform | darwin-arm64 |
| Official DMG URL | `https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.20.0/Grok_Bot_0.20.0.dmg` |
| DMG bytes | `151151794` |
| DMG SHA-256 | `73dfc1656a0e122a9a98bdcf1f49da5ec5475e156977c8730d207bfe01281a42` |
| Bundle identifier | `com.anysphere.sand` |
| Bundle version | `0.20.0` |
| Architecture | arm64 |
| Signer | `Developer ID Application: Anysphere Incorporated (DCNK4UB866)` |
| Team identifier | `DCNK4UB866` |
| Vendor CDHash | `b6086bbb8fee0954c596997c2f20630be79d8417` |
| Vendor notarization | stapled and accepted by Gatekeeper |
| `resources/app.asar` SHA-256 | `1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997` |

Implementation adds a canonical manifest of every regular file, symlink,
bundle location, and SHA-256 value in the accepted vendor application. Before
patching, verification rejects missing files, extra files, hash changes,
unexpected symlinks, path traversal, alternate bundle identifiers, signer or
team mismatches, invalid signatures, missing notarization, and non-arm64 code.

When the supported app is absent, the installer presents the official URL,
version, hash, size, signer, and vendor-host disclosure before offering a
download. It never follows an unpinned update feed or substitutes a newer
version. A partial, older, newer, or modified Grok Bot installation blocks
patching instead of being repaired or overwritten silently.

## What changed in Grok Bot 0.20.0

The 0.18.0 and 0.20.0 official macOS archives were downloaded from the vendor,
mounted read-only, signature-checked, extracted only into an owned temporary
directory, and compared.

- The preload contract grows from 117 to 130 RPC methods; no 0.18 method is
  removed.
- New methods cover main-process client persistence, hardware acceleration and
  relaunch, production-box attachment state, heap metrics, Sentry conversation
  diagnostics, and a development restart hook.
- `@lingui/core` and `@lingui/react` 5.9.5 are added, establishing localization
  infrastructure.
- Electron main, host, local-exec, preload, renderer JavaScript, and renderer CSS
  all changed. Patch anchors and output hashes from 0.18 are not reusable.
- Bundle-size reductions are treated as build/minification changes, not proof
  that features were removed.

The macOS patcher is therefore implemented against 0.20.0 from new anchors and
new golden fixtures. It never accepts the 0.18 archive under a compatibility
flag.

## Stock function preservation contract

Codex Bot must retain the complete Grok 0.20 shell and behavior outside the
explicit Codex substitutions below. Preservation is enforced at three levels:

1. **Contract inventory:** all 130 stock preload RPC methods and every stock
   event channel remain present after patching. The test records arguments,
   return shapes, subscription cleanup, and error behavior without invoking
   external services.
2. **Feature inventory:** the converted shell retains bot creation, literal
   `New Bot` identity, explicit rename/profile/avatar editing, one-to-one and
   group chat, attachments, routines, skills, plugins, MCP/connectors, secrets,
   computer view/control, approvals, audio transcription, models, usage,
   settings, theme, updates, feedback, onboarding, keyboard/window controls,
   teammate/subagent coordination, background tasks, and workspace/repository
   flows.
3. **Mutation boundary:** a post-patch file diff must match the reviewed allowlist
   exactly. Unrelated renderer, host, native helper, dependency, or asset bytes
   cannot change.

The patch may replace only:

- product name, icon, bundle identifier, update channel, and truthful Codex
  privacy/help copy;
- vendor sign-in/inference/account usage routes with the local authenticated
  Codex bridge;
- model and reasoning controls with the approved capability-aware Codex control;
- bot runtime ownership and Computer transport with the per-bot authorized
  remote-runtime controller;
- vendor telemetry/export paths with inert local-only implementations;
- vendor auto-update with the independent Codex Bot macOS release channel.

The patch must not remove plugin, skill, routine, connector, team, group-chat,
attachment, approval, settings, or computer surfaces merely because a Codex
backend capability is temporarily unavailable. Such a surface stays visible
and reports a bounded, truthful unavailable state. There is no fake success.

## Codex inference and authentication

- The reviewed bridge transport is CLIProxyAPI `7.2.130`, pinned to the
  upstream `darwin_aarch64` release archive and SHA-256
  `a644a75f70cbd045b9f7caa9ff3866353448a7ed67ef8472eacc11c48b1c86f0`.
  This is the same protocol baseline as the Windows edition, but uses the
  platform-specific macOS binary and lifecycle implementation.
- The public DMG may contain that MIT-licensed CLIProxyAPI binary only after its
  archive, published checksum, executable architecture, version, and license
  are independently verified. It may not contain its build cache, auth state,
  config, logs, or any developer-downloaded archive.
- The bridge binds only to loopback and uses a fresh installer-generated random
  credential.
- Codex authentication uses the user's supported Codex/OpenAI login route. No
  token is embedded in the app, installer, DMG, repository, logs, or manifest.
- The host passes canonical `botId`, model, reasoning effort, thread identity,
  attachments, tool calls, and approvals across the bridge.
- Every bridge response is bot/runtime/generation scoped. Late or mismatched
  replies are discarded.
- Any missing bridge, failed authentication, unsupported model, malformed
  session, or transport error is fail-closed and sanitized.
- No xAI/Cursor inference, usage-credit, telemetry, or chat-history endpoint is
  a fallback.
- Stock functions that truly require a vendor account are either rerouted to an
  approved Codex equivalent or remain visible as unavailable with an explicit
  explanation. They are never silently simulated.

## Persistent bot and remote-runtime contract

- Creating a bot produces the literal name `New Bot`; creation accepts no name
  argument. Rename is a separate explicit action.
- Bot records and profile/appearance data are owned by the main process and
  persisted atomically. Renderer localStorage values are migration input only,
  never an authority after migration.
- Every Work conversation reference includes a canonical bot UUID. Chat remains
  a distinct Chat route and carries no bot identifier.
- Each bot owns at most one active remote runtime and each runtime ID has at most
  one bot owner.
- Runtime sessions are private, immutable, generation-scoped, and contain the
  exact endpoint/token only in non-public fields.
- Provider inspection must prove current owner, provider, endpoint, and lifecycle
  before activation or retirement.
- Provisioning, retries, terminal events, disposal, restart recovery, and
  cross-controller operations are serialized and fail closed.
- Computer frames/events are bot/runtime/generation scoped. Switching bots
  clears the previous frame synchronously before any new frame can render.
- A remote provider must be explicitly configured and authorized. If it is not,
  Computer shows `Remote computer unavailable` and Work send remains disabled.
- There is no local-browser, on-device shell, local Electron computer, or shared
  vendor-computer fallback.

## Model selector and reasoning UI contract

The approved controls are preserved exactly at both 1024x680 and 1920x1080:

- The model picker contains the capability-aware Codex catalog only.
- GPT-5.6 Sol and GPT-5.6 Terra expose six reasoning positions.
- GPT-5.5 exposes four positions.
- Reviewed CLIProxyAPI models Claude Fable 5, Claude Opus 5, and Claude Sonnet
  5 expose their published low/medium/high/xhigh/max reasoning levels plus an
  `Ultra Code` client mode that maps to upstream `max`.
- Max is a stable blue state.
- Ultra uses the accepted animated purple/blue state and its established warning
  and steady transitions.
- Ultra Code reuses the same Ultra visual effect while retaining its distinct
  selected-mode label in main-owned state.
- Changing model recomputes the valid effort set and never retains an invalid
  hidden value.
- In-flight sends remain bound to their captured model/effort/bot/thread tuple.
- Model and effort mutations never cross from Chat to Work or between bots.
- The controls retain the existing compact dimensions, focus rings, keyboard
  behavior, reduced-motion behavior, and no-clipping layout.

Remaining UI differences are resolved by comparing the patched 0.20 shell,
the prior agreed controls, and fresh rendered evidence. Tests alone are not a
visual acceptance gate.

## Installer and application transaction

The installer performs a recoverable transaction:

1. Acquire a single installer lock.
2. Discover an exact installed Grok Bot 0.20.0 or request explicit authorization
   to download the pinned official DMG.
3. Verify download bytes, hash, mounted volume, complete app manifest, code
   signature, notarization, identifier, version, and architecture.
4. Copy the vendor app into an owned staging directory without user data,
   extended-attribute state, logs, caches, or profiles.
5. Extract and patch only `app.asar`; add only reviewed open-source resources.
6. Change product metadata and bundle identity to Codex Bot.
7. Re-sign every changed nested executable and the outer app in dependency
   order. Developer ID signing and notarization are release gates when the
   required credentials are available; ad-hoc signing is labeled development
   only and cannot be published as the final release.
8. Run static, signature, launch, bridge, capability, UI, privacy, and remote
   runtime acceptance against the staged copy.
9. Atomically replace only a prior Codex Bot app after preserving a rollback
   copy. Never overwrite Grok Bot.
10. On failure, restore the previous Codex Bot app and leave Grok Bot unchanged.

The installer never clears quarantine, disables Gatekeeper, asks for a password
in chat, or invokes an interactive security bypass. Missing release signing or
notarization credentials is a release blocker, not permission to weaken checks.

## DMG contents and privacy audit

The final DMG allowlist is small and exact:

- `Install Codex Bot.app`
- `Applications` symlink if the chosen layout needs it
- `README.html` or `README.txt`
- `LICENSE`, `NOTICE`, `PRIVACY`, and third-party notices
- the pinned CLIProxyAPI `7.2.130` macOS arm64 executable and its MIT license,
  nested only inside the signed installer application's resources

It must not contain:

- Grok Bot binaries, `app.asar`, extracted vendor source, or vendor assets;
- a built Codex Bot application copied from a developer machine;
- OAuth files, API keys, bearer tokens, cookies, browser profiles, databases,
  conversations, attachments, downloads, logs, crash dumps, screenshots,
  recordings, update caches, or remote-runtime credentials;
- absolute home paths, volume names, developer usernames, build-workspace paths,
  temp directories, shell history, `.git`, source maps containing local paths,
  test fixtures with credentials, or Finder metadata;
- the private ChatGPT Companion/Lab relay or any artifact from a personal volume.

The release audit mounts the DMG read-only, inventories every path, scans text
and binary strings for personal paths and credential patterns, validates plist
metadata and architectures, verifies signatures/notarization, launches with a
fresh empty profile, confirms no preexisting accounts/conversations/bots, and
then removes only the audit-owned profile.

## Verification lanes

Completion requires distinct evidence for:

- source tests and exact patch-diff invariants;
- staged installer and staged application;
- signed/notarized DMG;
- fresh install into an isolated destination and first launch with empty state;
- stock 0.20 function/parity smoke tests;
- Codex inference/model/reasoning/approval flows;
- two persistent `New Bot` identities and independent profile changes;
- two authorized remote runtimes, one per bot, with switch-frame isolation;
- restart/retry/terminal/dispose/cross-controller runtime races;
- fresh 1024x680 and 1920x1080 full-frame/detail evidence, normal motion and
  reduced motion;
- no local computer fallback when the provider is absent;
- rollback and uninstall preservation/wipe boundaries;
- release asset download and hash verification from the GitHub release.

Passing source tests does not prove packaging, installed behavior, remote
provider acceptance, visual parity, or distribution signing. Each lane is
reported separately.

## Release blockers

The DMG may not be pushed as a final GitHub Release asset while any of these are
unresolved:

- the official 0.20.0 complete manifest or patch output allowlist is incomplete;
- any stock capability or one of the 130 preload methods is missing;
- a known agreed UI difference remains;
- the remote provider gate is blocked or uses a local/shared fallback;
- the app or DMG lacks release signing/notarization;
- the privacy audit finds personal/private/development material;
- fresh-install, rollback, or uninstall verification fails;
- independent code, security, packaging, or visual review requests changes.

## Rollback

The previous installed Codex Bot app and its hash are recorded before replacement.
Rollback restores only that Codex Bot copy. User state is never silently deleted.
An uninstall offers separate preserve-state and wipe-state actions; a wipe names
the exact local Codex Bot directory and cannot target Grok Bot, the repository,
the user's home directory, or a broad container. Remote deletion is not claimed
without a provider receipt.
