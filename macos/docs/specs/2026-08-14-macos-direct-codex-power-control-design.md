# OpenBot macOS Direct Codex and Native Power Control Design

**Status:** Approved for implementation on `macos/codex-bot`

**Date:** 2026-08-14

**Platform:** macOS Apple Silicon only

**Extends:**
`../../../docs/superpowers/specs/2026-08-14-macos-grok-020-preserve-patch-design.md`

## Decision

OpenBot keeps the exact verified Grok Bot 0.20 shell and the already approved
bot-scoped remote Work runtime. It replaces the current approximate model
dropdown plus effort-only slider with the native compact Codex Power control,
and it replaces the mandatory CLIProxyAPI dependency for OpenAI models with a
pinned official Codex app-server process.

The default OpenAI path reuses the user's official Codex login in `~/.codex`.
If that login is absent, OpenBot starts the official ChatGPT browser or device
login flow through app-server. The ChatGPT desktop application is not a runtime
or packaging dependency. CLIProxyAPI remains an optional, explicitly connected
provider for reviewed non-Codex models such as Claude Fable 5. It is not started
for a Codex-only session.

This document supersedes the older design wherever that document describes
CLIProxyAPI as the mandatory Codex transport or describes the current slider as
the final visual contract. All Grok-shell preservation, persistent bot,
remote-runtime, privacy, and Windows-isolation requirements remain unchanged.

## Audited reference and current gap

The reference is the current installed ChatGPT/Codex renderer, inspected
read-only from its signed application bundle. The compact reference control is
one Power slider whose stops combine model, reasoning effort, and speed. It is
not a model dropdown beside an independent reasoning slider.

The reference behavior includes:

- a closed ghost trigger in the composer containing the current model, compact
  effort label, optional Fast mark, and chevron, with no permanently visible
  full-width model dock;
- a 224-pixel popover above that trigger; its compact rail occupies the upper
  32 pixels and the `Advanced` / Fast controls occupy the lower row;
- an Advanced state that replaces the compact rail in the same popover with
  Model, Effort, and Speed controls instead of appending a second panel;
- a 32-pixel compact container, 28-pixel control root, 24-pixel track,
  28-pixel thumb, and 4-pixel tick marks;
- a blue selected range in ordinary states;
- pointer preview and commit, drag, wheel snapping, arrow-key navigation,
  focus, hover growth, and spring thumb movement;
- delayed endpoint labels while holding the pointer;
- compact labels `Light`, `Standard`, `Extended`, `Extra High`, `Max`, and
  `Ultra` where supported;
- an Advanced view with independent Model, Effort, and Speed controls;
- Fast mode track/tick transitions and particles;
- a stable blue Max state;
- an animated purple/blue Ultra field, reveal, track particles, and entry burst;
- the same Ultra effect for provider-specific `Ultra Code`, while retaining the
  exact `Ultra Code` label and upstream mapping;
- a static purple/blue equivalent with no particles or spring animation when
  reduced motion is requested;
- a screen-reader live value and interaction instructions.

The current custom control is close but materially different. It has a separate
model dropdown, an effort-only slider, a gray ordinary fill, permanently
separate label, simplified Ultra gradient, and incomplete pointer, wheel,
endpoint, spring, Fast, and Advanced semantics. These differences are defects,
not optional polish.

## Native capability-aware Power model

### Catalog authority

The official Codex app-server `model/list` result is authoritative for Codex
model visibility, display name, default effort, supported efforts, modalities,
and default status. The renderer never hardcodes a Codex capability catalog.
Only validated, picker-visible entries cross the main/renderer boundary.

The current local account advertises these picker models at design time:

- `gpt-5.6-sol`: low, medium, high, xhigh, max, ultra;
- `gpt-5.6-terra`: low, medium, high, xhigh, max, ultra;
- `gpt-5.6-luna`: low, medium, high, xhigh, max;
- `gpt-5.5`: low, medium, high, xhigh;
- `gpt-5.4`: low, medium, high, xhigh;
- `gpt-5.4-mini`: low, medium, high, xhigh;
- `gpt-5.3-codex-spark`: low, medium, high, xhigh.

That observation is test input, not a permanent allowlist. Future valid models
appear only when the pinned app-server advertises them. Hidden, malformed,
duplicate, oversized, accessor-backed, proxy, or unsupported entries are
rejected before publication.

Reviewed optional-provider catalog entries remain separately identified by
provider. Fable/Opus/Sonnet `Ultra Code` is stored as `ultra-code`, renders the
Ultra effect, and maps to upstream `max`; it is never relabeled as OpenAI Ultra.

### Compact stop construction

The compact Power sequence is a list of immutable selections, not effort names.
Each stop owns the exact tuple:

`{ provider, model, effort, serviceTier, label, effect }`

For the native default Codex sequence, stops are formed from the live catalog:

1. Terra Light when Terra advertises low;
2. Sol Light when Sol advertises low;
3. Sol Standard when Sol advertises medium;
4. Sol Extended when Sol advertises high;
5. Sol Extra High when Sol advertises xhigh;
6. Sol Max when Sol advertises max;
7. Sol Ultra when Sol advertises ultra.

A missing capability removes only its stop. A missing preferred model uses the
advertised default model without inventing an unsupported effort. Advanced
selection may choose any advertised model/effort/tier tuple. Returning to
compact Power selects the closest exact advertised tuple deterministically.

The persisted selection remains bot and runtime-generation scoped. A send
captures provider, model, effort, tier, bot, thread, and generation once. Later
UI changes cannot mutate an in-flight request.

## Direct Codex runtime

### Pinned binary

The installer pins official Codex `0.147.0` for Apple Silicon from the OpenAI
GitHub release:

- asset: `codex-aarch64-apple-darwin.tar.gz`;
- bytes: `87984231`;
- SHA-256: `75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358`;
- release: `rust-v0.147.0`, published 2026-08-07;
- license: Apache-2.0;
- expected signer: OpenAI's valid Developer ID signature after extraction.

The installer downloads or uses a separately provided exact archive, verifies
the published digest, archive shape, single executable, architecture, version,
signature, signer/team, and absence of unexpected files before staging it. The
repository and public DMG do not contain a developer-machine copy, Codex auth
state, `~/.codex`, logs, rollouts, configuration, or caches.

The installed path is inside the signed OpenBot resources. Runtime resolution
accepts only that verified packaged path in production. `CODEX_BINARY` and a
developer-installed CLI are test/development inputs and cannot silently replace
the production binary.

### Account ownership

OpenBot launches:

`<packaged-codex> app-server --stdio`

The process inherits the standard official Codex home so it can use the user's
existing ChatGPT-plan login. It never reads, copies, logs, serializes, displays,
or packages token files. Only sanitized account mode, plan type, and login state
may cross IPC.

Startup performs the required `initialize` / `initialized` handshake, then
`account/read` and paginated `model/list`. If no account is present, the UI
offers Sign in and main invokes `account/login/start` with `type: "chatgpt"` or
the device-code flow. Browser URLs and user codes are shown only for the current
login generation. Cancel, completion, logout, process exit, restart, and stale
notification races are bounded and generation checked.

OpenBot does not import ChatGPT desktop tokens, depend on ChatGPT.app's
embedded `codex`, or require the ChatGPT GUI to be running. The standalone
binary and account protocol are the only supported Codex dependency.

### Local inference boundary

The local app-server supplies:

- authenticated account and rate-limit status;
- the live Codex model/capability catalog;
- inference-only sessions required by the preserved Grok shell where no
  bot-scoped Work runtime is involved.

It is not a local Computer or Work fallback. The manager launches an
inference-only process configuration that disables local shell, unified exec,
browser, computer, apps, MCP, plugins, and other tool surfaces. Its session root
is an empty app-owned directory, and the client rejects every command, file,
approval, MCP, dynamic-tool, browser, computer, or process request. Tests must
prove that no such event can execute or be forwarded. If the pinned Codex
version cannot enforce that boundary, the local host-inference path is marked
unavailable rather than weakening the no-local-fallback rule.

Work status, catalog confirmation, threads, turns, approvals, and Computer
remain routed through the current bot-scoped remote app-server. Each call still
requires the selected bot's current runtime ID and generation. Missing remote
provider, unavailable runtime, or stale generation keeps Work and Computer
disabled even when local account authentication is healthy.

### Provider split and CLIProxyAPI

Codex model tuples use only the direct official app-server transport. Starting,
signing in to, or sending with Codex must not start CLIProxyAPI or require its
configuration.

CLIProxyAPI is created lazily only after an explicit non-Codex provider connect
or a send whose already-selected provider requires it. Its loopback credential,
receipt validation, provider login, and shutdown behavior remain private and
bounded. A failed optional provider never changes the active Codex account or
silently reroutes a Codex request.

Provider routing is exact and fail closed:

- `openai-codex` -> packaged Codex app-server;
- reviewed optional providers -> pinned CLIProxyAPI sidecar;
- unknown, missing, or mismatched provider -> sanitized unavailable error;
- no xAI/Cursor/ChatGPT-desktop/local-machine fallback.

## State and IPC

Main owns account, catalog, provider, model, effort, service-tier, bot, runtime,
and generation state. Renderer state is presentation-only.

New exact IPC operations are bounded and frozen:

- read sanitized Codex account state;
- start/cancel Codex login and log out;
- list the sanitized Codex and optional-provider catalog;
- read/select a complete provider/model/effort/tier tuple.

No IPC result or event may contain auth tokens, endpoint queries, local paths,
environment variables, provider diagnostics, raw app-server errors, archive
paths, or runtime credentials. Events carry a monotonically increasing catalog
or account generation so late processes and login attempts cannot overwrite a
newer state.

## Failure behavior

- Missing or invalid packaged Codex binary: Codex unavailable; no ChatGPT-app or
  CLIProxy fallback.
- Missing login: show Sign in; no provider process is started implicitly.
- App-server exit or malformed frame: fail current requests, clear private
  sessions, publish sanitized offline state, and allow a bounded retry.
- Empty or malformed catalog: keep the last generation-scoped selection hidden
  and disable send; never invent models.
- Unsupported saved tuple: choose the model's advertised default once and
  persist that exact replacement before enabling send.
- Optional provider failure: only its catalog and requests become unavailable.
- Remote runtime failure: Work and Computer stay fail closed; local Codex
  account health does not override the remote-runtime gate.

## Visual acceptance

Acceptance is based on fresh exact-source Electron captures, not CSS inspection
alone. Required 1024x680 and 1920x1080 evidence includes:

- every compact stop, including ordinary blue, Max blue, Ultra entry, Ultra
  steady, and Ultra Code entry/steady;
- pointer hold with endpoint labels, drag preview, wheel, arrows, focus, hover,
  disabled, and reduced-motion states;
- Fast entry/steady/exit;
- Advanced Model/Effort/Speed with capability changes and invalid-selection
  recovery;
- long model names, minimal catalog, seven-stop catalog, narrow composer,
  light/dark themes, and 200% bitmap scale;
- two bots with different selections and a bot switch during an in-flight send.

Rendered frames must be compared with the inspected native reference for
geometry, alignment, color, hierarchy, motion timing, clipping, and copy.

## Signing, notarization, installation, and privacy

The available Apple Development identity is suitable for development builds,
not public distribution. A public DMG requires a Developer ID Application
identity for the paid team. Creating or installing that persistent certificate
requires explicit user confirmation at action time and may require user-owned
Apple ID or 2FA interaction in Xcode.

Release order:

1. build and verify the installer and staged OpenBot app;
2. sign every changed nested executable and bundle in dependency order with
   hardened runtime and timestamp;
3. validate the packaged OpenAI binary and resulting outer signature;
4. notarize with `notarytool`, staple, and validate app and DMG;
5. run `codesign --verify --deep --strict`, Gatekeeper assessment, staple
   validation, clean-machine launch, account login, direct Codex send, optional
   provider send, bot switch, remote Computer, and rollback tests;
6. mount the final DMG read-only and run the release privacy allowlist and
   secret/path scans against every file and archive member;
7. install only the verified OpenBot app, never modify Grok Bot;
8. publish only the macOS versioned asset on `macos/codex-bot` after all gates
   pass.

The DMG must contain no personal account data, Codex home, conversations,
rollouts, logs, screenshots, test artifacts, developer paths, API keys, OAuth
state, provider credentials, remote-runtime credentials, source checkout, Git
metadata, or vendor app bytes.

## Completion gates

This design is complete only when all of the following are proven:

- the compact Power control matches native geometry, behavior, labels, colors,
  Max, Ultra, Ultra Code, Fast, Advanced, accessibility, and reduced motion;
- the catalog is from the active app-server/provider and no Codex capability is
  hardcoded as current truth;
- Codex account login and a real Codex-model turn work from the packaged binary
  with ChatGPT.app closed and CLIProxyAPI absent;
- optional Fable provider and Ultra Code work without affecting Codex login;
- preserved Grok functions and composer transactions still pass;
- persistent New Bot identity, bot-scoped selection, and in-flight tuple
  ownership pass restart and race tests;
- Work and Computer use one authorized remote runtime per bot, with no local
  fallback and no cross-bot frames/events;
- a Developer-ID-signed, notarized, stapled DMG passes privacy and clean-install
  gates;
- the Windows base and the friend's Windows work remain byte-for-byte outside
  this macOS branch's changes;
- the exact branch, commits, artifact version, digest, and pushed remote state
  are recorded.
