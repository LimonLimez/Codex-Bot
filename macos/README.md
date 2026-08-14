# Codex Bot for macOS

This directory is the macOS Apple Silicon release line for Codex Bot. The
existing Windows implementation at the repository root remains unchanged and
continues to be owned, tested, packaged, and released independently.

The macOS product preserves the verified Grok Bot 0.20.0 shell and replaces only
the reviewed authentication, inference, product identity, model controls, and
remote-runtime boundaries needed for Codex. It is not a standalone imitation of
the Grok interface.

## Vendor application boundary

The Codex Bot DMG does not contain Grok Bot, its `app.asar`, an
extracted frontend, or any other proprietary vendor binary or asset. The
repository keeps the same boundary.
The installer uses an already installed, user-owned exact Grok Bot 0.20.0 copy or,
after explicit authorization, downloads the version-pinned official macOS DMG
directly from the vendor. It verifies the complete input before creating a
separate Codex Bot application. The original Grok Bot app is never modified.

## Runtime boundary

Codex conversations use an authenticated loopback bridge and have no xAI/Cursor
inference fallback. Every Work bot requires its own explicitly configured and
authorized remote runtime. When that provider is unavailable, the app reports
that state and disables the affected action; there is no local computer,
on-device browser, or shared-machine fallback.

The bridge uses the pinned macOS arm64 CLIProxyAPI sidecar. Its reviewed model
catalog includes the Codex models plus Claude Fable 5, Claude Opus 5, and Claude
Sonnet 5 when the user's CLIProxyAPI provider/account actually exposes them.
The Claude choices add a local `Ultra Code` presentation mode that reuses the
approved Ultra animation and maps explicitly to the upstream `max` reasoning
level; it is not sent as an invented provider value.

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
