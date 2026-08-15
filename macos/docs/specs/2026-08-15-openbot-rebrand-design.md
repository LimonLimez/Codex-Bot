# OpenBot macOS Product Identity and Migration Design

**Status:** Approved direction for implementation on `macos/codex-bot`

**Date:** 2026-08-15

**Platform:** macOS Apple Silicon only

**Extends:**
`2026-08-14-macos-direct-codex-power-control-design.md`

## Decision

The macOS product is renamed from **Codex Bot** to **OpenBot** because its
reviewed inference surface is no longer limited to OpenAI models. The release
version becomes `0.2.0-macos.1`. The pinned, separately verified Grok Bot shell
remains vendor version `0.20.0`; the rename does not weaken byte-preservation or
Grok parity checks.

Every user-visible product and release identity becomes OpenBot: application,
installer, Finder name, window title, DMG, volume, documentation, bundle IDs,
client titles, reports, and product accessibility labels. Provider-specific
copy remains truthful: **OpenAI Codex** names the official direct provider,
Claude names reviewed optional Anthropic models, and Kimi remains account-only
until a reviewed selectable model catalog is implemented.

Legacy `codex-*` IPC channels, `CODEX_BOT_*` environment variables, internal
module paths, package receipt fields, and Swift target names remain compatibility
interfaces. They are not displayed as the product name and are documented as
legacy implementation identifiers. Renaming these interfaces would add risk
without improving the user-visible rebrand.

## Provider truth

OpenBot exposes two reviewed inference routes:

- `openai-codex`: the packaged official Codex app-server and the user's Codex
  account. It works without ChatGPT.app running and never starts or requires
  CLIProxyAPI.
- `cliproxy-anthropic`: a separately connected optional CLIProxyAPI sidecar for
  the pinned Claude Fable 5, Opus 5, and Sonnet 5 catalog. `Ultra Code` maps to
  upstream `max` and uses the same animated purple/blue Ultra presentation.

Unknown providers and unreviewed Kimi model selections fail closed. No provider
silently falls back to another provider, the local Mac, ChatGPT.app, or a shared
runtime. Passing fixture tests is not a live-provider claim.

## Existing-user migration

OpenBot owns `~/Library/Application Support/OpenBot`. On first launch, before
creating runtime dependencies, it performs a one-time migration from the legacy
`~/Library/Application Support/Codex Bot` profile.

The transaction is deliberately conservative:

1. Resolve both paths beneath Electron's `appData` directory; neither path is
   accepted through a symlink.
2. If the OpenBot profile already exists as a real directory, use it unchanged.
3. If neither profile exists, create a private OpenBot directory.
4. If only the legacy profile exists, copy the complete real directory tree to
   a private sibling temporary directory, rejecting symlinks and special files.
5. Apply owner-only permissions and atomically rename the completed temporary
   copy to `OpenBot`.
6. Retain the legacy profile and legacy application. No destructive move,
   merge, or deletion occurs.
7. On any validation, copy, fsync, or rename failure, remove only the transaction's
   exact temporary directory and fail closed with sanitized migration copy. Do
   not launch with a blank profile.

This preserves Grok/Codex shell settings, conversation history, persistent bot
records, model selections, official Codex account configuration, and optional
provider state without packaging any of those files. A target directory is the
idempotency marker; OpenBot never overwrites or merges an existing target.

## Release identity

- application: `OpenBot.app`
- application bundle ID: `com.limonlimez.openbot`
- installer: `Install OpenBot.app`
- installer bundle ID: `com.limonlimez.openbot.installer`
- DMG: `dist/0.2.0-macos.1/OpenBot-0.2.0-macos.1.dmg`
- release volume: `OpenBot Installer`
- development names retain an explicit `DEVELOPMENT` suffix

The DMG continues to contain only the installer and its sealed, exact inputs.
It contains no source checkout, `.git`, test data, developer paths, logs,
credentials, profiles, conversations, environment files, signing identities,
or local runtime state. Signing and notarization use the configured macOS
Developer ID outside the distributable artifact.

## Visual contract

The rebrand changes identity copy, not the approved Grok shell or compact Power
control geometry. Max remains blue. Ultra and provider-specific Ultra Code keep
the animated purple/blue effect, with the approved static reduced-motion
equivalent. Fast, focus, hover, disabled, light, dark, narrow, and Advanced
states remain distinct.

Fresh evidence must cover the window title/sidebar/product copy and installer at
1024x680 and 1920x1080, plus light/dark/narrow Power states. Accessibility labels
use OpenBot for product ownership and OpenAI Codex only for the provider.

## Acceptance gates

1. Exact Grok Bot 0.20.0 parity and preserved-byte contracts pass.
2. Existing Codex Bot profile migration is atomic, idempotent, non-destructive,
   symlink-safe, and failure-closed.
3. Direct Codex works with ChatGPT.app closed and no CLIProxyAPI process.
4. Optional Anthropic tuples preserve exact provider/model/effort/tier semantics.
5. A reviewed real provider provisions two distinct bots with distinct runtime
   IDs, endpoints, auth tokens, generations, and event streams.
6. Each remote bot opens Chrome inside its own VM and reaches
   `https://www.youtube.com/`; local Chrome, SSH aliases, shared containers, and
   local Codex results are forbidden substitutes.
7. The signed/notarized DMG passes the exact manifest and privacy audit, installs
   OpenBot independently, and survives a fresh launch Reality Check.
8. Only the macOS branch is pushed. Windows paths and the collaborator's work are
   not modified, rebased away, force-pushed, or merged.

The real-provider, signing, notarization, installed-app, and push gates remain
blocked until their required inputs are present and the preceding gates pass.
