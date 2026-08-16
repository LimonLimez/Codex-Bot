# OpenBot for macOS

This directory is the macOS Apple Silicon release line for OpenBot. The
existing Windows implementation at the repository root remains unchanged and
continues to be owned, tested, packaged, and released independently.

OpenBot preserves the verified Grok Bot 0.20.0 shell and replaces only
the reviewed authentication, inference, product identity, model controls, and
remote-runtime boundaries needed for Codex. It is not a standalone imitation of
the Grok interface.

## Vendor application boundary

The OpenBot DMG does not contain Grok Bot, its `app.asar`, an
extracted frontend, or any other proprietary vendor binary or asset. The
repository keeps the same boundary.
The installer uses an already installed or mounted, user-owned exact Grok Bot
0.20.0 application selected by the user. It verifies the complete input before
creating a separate OpenBot application. The original Grok Bot app is never
modified, and the installer does not download vendor software on the user's
behalf.

## Runtime boundary

Official Codex conversations use the verified, unmodified Codex 0.147.0 macOS
arm64 runtime and its authenticated private loopback bridge. The official Codex
account and live model catalog work without ChatGPT.app being open and without
CLIProxyAPI. OpenBot owns a private Codex home and its own official account
sign-in; it does not import a user's Codex CLI conversations, configuration, or
rollout history. There is no xAI/Cursor inference fallback.

CLIProxyAPI 7.2.132 is bundled only for reviewed optional providers. Its
catalog can expose Claude Fable 5, Claude Opus 5, Claude Sonnet 5, and other
reviewed models when the user's configured account actually supports them. The
Claude choices add a local `Ultra Code` presentation mode that reuses the
approved Ultra animation and maps explicitly to the upstream `max` reasoning
level; it is not sent as an invented provider value.

Computer access is an explicit per-bot choice during normal bot setup. A user
can choose Free Local Desktop, configure a supported remote runtime, or choose
Not Now. Free Local Desktop creates a dedicated Electron Chromium desktop and
private browser partition for that bot on this Mac; it does not use a normal
Chrome or Safari profile and is not represented as a cloud VM. File, shell, and
other local actions go through the requesting bot's permission prompts and
bot-scoped task workspace.

A remote bot still requires its own explicitly configured and authorized
remote runtime. When that provider is unavailable, the app reports that state
and disables the affected action. OpenBot never silently substitutes Free
Local Desktop, a shared machine, or another provider for the computer choice
the user made.

## Compatibility and migration

OpenBot is the user-visible product name. Legacy `codex-*` IPC channels,
`CODEX_BOT_*` environment variables, internal `codex` module paths, and the
`InstallCodexBot` Swift target remain compatibility identifiers and are not
provider or product claims. On first launch, OpenBot atomically copies a valid
legacy `Codex Bot` Electron profile into its private `OpenBot` profile, retains
the source, and refuses unsafe or partial migration rather than launching blank.

## Development

Run macOS commands from the repository root:

```bash
npm --prefix macos ci
npm --prefix macos test
npm --prefix macos run check
```

The full design and gated implementation plan are in:

- `docs/superpowers/specs/2026-08-14-macos-grok-020-preserve-patch-design.md`
- `docs/superpowers/plans/2026-08-14-macos-grok-020-preserve-patch.md`

Do not commit DMGs, application bundles, ASARs, mounted vendor contents, user
profiles, credentials, conversations, screenshots, logs, or absolute personal
paths. A final release additionally requires stock-function parity, real
two-bot remote-runtime acceptance, fresh visual review, Developer ID signing,
notarization, and a clean mounted-DMG privacy audit.
