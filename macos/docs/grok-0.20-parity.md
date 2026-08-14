# Grok Bot 0.20.0 macOS parity inventory

This document records the public metadata contract used to prevent the macOS
Codex conversion from dropping stock Grok Bot functions. It contains no vendor
source or executable content.

## Release comparison

The exact official 0.18.0 and 0.20.0 Apple Silicon applications were mounted
read-only and their signed ASARs were inspected locally.

- Grok Bot 0.18.0 exposes 117 main preload RPC methods.
- Grok Bot 0.20.0 exposes 130 main preload RPC methods.
- No 0.18 method is absent from 0.20.
- 0.20 adds 13 methods for main-owned client persistence, hardware acceleration
  and relaunch, production-box attachment state, heap metrics, diagnostics, and
  development restart.
- Event subscriptions grow from 19 to 22 with MCP authentication completion,
  computer-update dispatch acknowledgement, and widget-gallery events.
- Direct preload IPC channels shrink from 52 to 7 because the remaining calls
  moved behind the typed main RPC table; this is a transport refactor, not a
  capability removal.
- The package adds `@lingui/core` and `@lingui/react` 5.9.5.

The machine-readable inventory is
`assets/grok-bot-0.20.0-contract.json`. Its preload SHA-256 binds it to the exact
reviewed 0.20.0 input. `scripts/audit-grok-contract.cjs` fails on any missing,
renamed, or unreviewed method/event/channel before patching.

## Required functional smoke groups

Metadata parity is necessary but not sufficient. Installed-app acceptance must
exercise all of these stock groups after the Codex patch:

- bot creation, profile, explicit rename, title, description, and avatar;
- one-to-one, bot-to-bot, and group conversations;
- attachments and audio transcription;
- background tasks, teammates/subagents, and workspace/repository tasks;
- routines, skills, plugins, MCP servers, connectors, and secrets;
- remote Computer view/control, update/recovery, and approval flows;
- model preferences and the approved Codex reasoning control;
- usage, settings, theme, onboarding, feedback, updates, and window controls.

A visible unavailable state is acceptable only when its backend is truly absent
and the state is truthful. Removing the surface, fabricating success, or routing
to local/shared/vendor inference as a fallback is not parity.
