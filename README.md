# Codex Bot Bridge

Codex Bot Bridge turns a **user-owned local Grok Bot 0.16.0 installation** into a Codex-powered digital-coworker app. It keeps the installed frontend, customizable blob avatars, conversations, routines, and computer preview while routing new model requests through the user's own Codex OAuth account or optional OpenAI API key.

This is an independent community project. It is not an official xAI or OpenAI product.

## What works

- The real locally installed Grok Bot frontend; this project does not recreate or redistribute it.
- User-owned Codex OAuth through the local CLIProxyAPI sidecar, or an optional OpenAI API key protected with Windows DPAPI.
- No xAI inference, vendor-backend fallback, or Grok Bot usage-credit route. If the selected OpenAI route is unavailable, the request fails instead of switching to xAI.
- Original per-bot blob avatar shapes and colors.
- A persistent, isolated Chrome or Edge profile for each bot.
- Up to three active browser seats at once. If a fourth is needed, the least-recently-used idle seat closes while its profile and sessions remain saved.
- A live browser view inside the bot's existing computer pane.
- **Take control / Release control** with independent virtual mouse and keyboard input. It does not move the physical mouse or type into the user's current app.
- Saved schedule-based routines and a background worker that survives closing the app window.
- A per-user Windows installer and uninstaller.

## Browser safety

Each browser seat is forced through its own authenticated local proxy. The proxy permits public HTTP(S) destinations only, rejects local, private, link-local, and reserved addresses, and pins each connection to the public address it checked. This prevents a website or DNS change from turning a bot into a path to services on the PC or local network.

Page viewing, scrolling, pointer movement, and waiting can proceed automatically. Agent-driven navigation, typing, clicks, drags, key activation, form controls, sensitive fields, submissions, and other mutating actions pause for an exact one-use **Allow once** or **Deny** decision in the live view. The approval is invalidated if the page, destination, or live control changes before execution.

**Take control** is an exclusive, short-lived backend lease: while it is active, the bot cannot interact with that browser. Direct user actions do not show a second approval prompt. WebRTC/QUIC bypasses, browser permission prompts, page clipboard access, and automatic downloads are disabled so sites cannot route around the public-web or approval boundaries.

## Requirements

- Windows 10/11 x64.
- A legitimate local installation of **Grok Bot 0.16.0** whose `resources/app.asar` SHA-256 is:

  `955FB24E72EC85729CAC2F921758A93A85089A0FC659E712125D6650B364D20E`

- Google Chrome or Microsoft Edge.
- Internet access during setup and Codex sign-in.
- A ChatGPT account with Codex access, or an OpenAI API key.

The patcher deliberately rejects every unknown vendor archive. New Grok Bot releases require a reviewed compatibility update.

## Install

1. Download `CodexBot-Setup-0.1.0.exe` from this repository's Releases page.
2. Keep Grok Bot installed. The setup wizard asks for its installation folder, normally `C:\Program Files\Grok Bot`.
3. Launch Codex Bot.
4. Open the account panel and choose **Connect Codex account**, then complete sign-in in the browser. An OpenAI API key can be selected instead.

The installer copies the user's local app into `%LOCALAPPDATA%\Programs\Codex Bot` and patches only that copy. The original Grok Bot installation is never modified.

## Local always-on behavior

The background worker and schedules continue when the Codex Bot window is closed. They run only while that Windows user is signed in and the PC is running and awake. They cannot run while the PC is powered off, sleeping, or signed out, and online work requires internet access. True 24/7 operation requires an always-on Windows machine or VM with an interactive desktop session.

Websites can still require login, CAPTCHA, approval, or human judgment. The bot preserves the current state and asks for takeover instead of bypassing those checks.

## Local data and uninstall

Per-user state lives under `%LOCALAPPDATA%\Codex Bot Bridge` and can include OAuth files, conversations, attachments, downloads, logs, settings, routines, sanitized open-tab URLs, and separate signed-in browser profiles. Each bot restores its public tabs and signed-in browser profile after a restart. The separate tab snapshot retains only each public origin and path; URL credentials, all query strings, and fragments are removed before it is written. Do not upload that folder.

The interactive uninstaller asks whether to preserve that state for a future reinstall or permanently wipe it from this PC. Choosing **No** at the wipe prompt preserves it. Silent uninstall preserves it. A wipe deletes the complete local state directory and cannot be undone by Codex Bot; it does not revoke credentials or sessions already held by remote services.

All bridge services bind to `127.0.0.1`; their control and data endpoints require installer-generated random credentials. No token, API key, OAuth file, browser profile, conversation database, screenshot, vendor archive, or vendor executable belongs in this repository. `npm run audit:release` enforces that boundary.

## Build from source

Install Node.js 22+ and Inno Setup 6, then run:

```powershell
npm ci
npm run check
npm test
npm run audit:release
npm run build:installer
```

The build downloads the reviewed, pinned CLIProxyAPI 7.2.130 Windows x64 release, verifies both its source-pinned SHA-256 and that release's published `checksums.txt`, and bundles the verified MIT-licensed binary. It does not download or package Grok Bot.

The finished installer and SHA-256 are written to `artifacts/` (ignored by Git).

## Project layout

- `src/bridge.cjs` - model/tool protocol bridge and digital-coworker policy.
- `src/browser-seats/` - persistent browser seats, public-web proxy, and action approvals.
- `src/browser-seat-bridge.cjs` - authenticated loopback live-view/input service.
- `src/renderer/` - code injected into the user's local frontend; no vendor bundle is stored here.
- `scripts/patch-app.cjs` - exact-hash patcher.
- `src/runtime/` - launcher, background worker, and scheduled-task helpers.
- `installer/` - Inno Setup definition.
- `tests/` and `scripts/security-audit.cjs` - release and privacy gates.

## Compatibility and terms

Codex OAuth support is provided by the third-party CLIProxyAPI project and can change when providers change their services. Users are responsible for their accounts, subscriptions, site permissions, and compliance with applicable terms and law.

See [NOTICE.md](NOTICE.md), [PRIVACY.md](PRIVACY.md), and [SECURITY.md](SECURITY.md).
