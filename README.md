# Codex Bot Bridge

Codex Bot Bridge turns a **user-owned local Grok Bot 0.18.0 installation** into a Codex-powered digital-coworker app. It keeps the installed frontend, customizable blob avatars, conversations, routines, and computer preview while routing new model requests through the user's own Codex OAuth account or optional OpenAI API key.

This is an independent community project. It is not an official xAI or OpenAI product.

## What works

- The real locally installed Grok Bot frontend; this project does not recreate or redistribute it.
- User-owned Codex OAuth through the local CLIProxyAPI sidecar, or an optional OpenAI API key protected with Windows DPAPI.
- Chat and planning requests have no xAI fallback: they use the selected Codex OAuth or OpenAI API-key route and fail closed when that route is unavailable. This does not describe the internals of the optional vendor-managed computer below.
- Workspace-wide model, reasoning, and Fast-mode defaults, plus an optional override on each employee's composer. Fast uses the local proxy's reviewed priority mapping for Codex OAuth and OpenAI's Fast service tier for API keys.
- Original per-bot blob avatar shapes and colors.
- A persistent, isolated Chrome or Edge profile for each bot.
- Up to three active browser seats at once. If a fourth is needed, the least-recently-used idle seat closes while its profile and sessions remain saved.
- A live browser view inside the bot's existing computer pane.
- **Take control / Release control** with independent virtual mouse and keyboard input. It does not move the physical mouse or type into the user's current app.
- Saved schedule-based routines and a background worker that survives closing the app window.
- A per-user Windows installer and uninstaller.

## Computer modes

Private browser seats remain the default. They run locally in isolated Chrome or Edge profiles, keep Codex as the only reasoning model, and never select a vendor cloud computer automatically or as a fallback.

An **Experimental vendor cloud computer** is available only after a fresh, direct Cursor web sign-in for this add-on and an explicit billing/background-services acknowledgement. It does not read or import a Grok Bot or Cursor desktop profile or saved sign-in. It reconnects to one persistent account box shared by all employees in this app; it does not create an independent VM for each employee. Actions are serialized through the shared primary display.

Codex remains the local chat and planning model in this mode. The helper sends only the vendor authentication, access check, provisioning, and remote-frame/input traffic needed to operate that display; it does not send Codex credentials, prompts, conversation history, or model requests to the vendor control plane. However, the computer is managed by the vendor and may contain vendor inference, telemetry, transcript, or other background services that this project cannot inspect or disable. **Zero vendor inference, telemetry, or charges cannot be guaranteed.** Provisioning or using the computer may consume included allowance, banked credits, or on-demand usage. Billing is possible.

Vendor OAuth credentials are kept separately under the current user's Local AppData state and protected with Windows DPAPI for that Windows user. Signing out closes the view, removes those local credentials, and clears any saved **Always allow** choice. It does not delete the persistent remote computer, revoke every remote session, or provide verified remote deletion; manage the remote account and computer with the vendor.

## Private-browser safety

Each browser seat forces browser-originated HTTP(S) and WebSocket traffic through its own authenticated local proxy. The proxy rejects any destination whose literal address or any DNS answer is local, private, link-local, reserved, or a cloud-metadata address, then connects to the checked public address without resolving it again. These controls block ordinary browser-originated access and DNS-rebinding attempts to those non-public address ranges.

Page viewing, scrolling, pointer movement, and waiting can proceed automatically. By default, agent-driven navigation, typing, clicks, drags, key activation, form controls, sensitive fields, submissions, and other mutating actions pause for an exact one-use **Allow once** or **Deny** decision. Private-browser decisions remain in the live view; Experimental vendor-computer decisions appear as a chat card with the exact screen the action will use. The approval is invalidated if the page, destination, or live control changes before execution.

Settings includes a clearly labeled **Permissions** section for the Experimental vendor computer. After a separate warning acknowledgement, the Windows user can enable **Always allow computer actions** for that provider only. While it is on, employees may click, drag, type, press keys, submit forms, and navigate on the shared vendor computer without a per-action approval card. It does not apply to Private browser seats or other tools. The choice defaults off, is protected with current-user Windows DPAPI, and is cleared by vendor sign-out or starting a different vendor sign-in. Takeover leases, provider/session generation checks, action deadlines, stale-frame checks, and uncertain-outcome stops still apply.

For the Experimental vendor cloud computer, clicks and drags remain bound to an identical displayed frame. Keyboard-only actions may continue across only a same-session, tightly bounded caret-width or unchanged-cursor-local pixel change; any broader visual change presents a fresh frame and asks again.

**Take control** expands the computer into a full-window control surface and acquires an exclusive, short-lived backend lease: while it is active, the bot cannot interact with that browser. Releasing control, pressing Escape, losing the lease, or changing providers returns to the small preview. Direct user actions do not show a second approval prompt. Page WebRTC APIs, non-proxied WebRTC UDP, Chromium QUIC, browser permission prompts, page clipboard access, and automatic downloads are disabled to close common routes around the public-web or approval boundaries.

## Requirements

- Windows 10/11 x64.
- A legitimate **Grok Bot 0.18.0** Windows x64 installation. Setup can reuse an exact installed tree or, with explicit authorization, obtain the separate per-user app from the vendor-hosted version-pinned URL. Its `resources/app.asar` SHA-256 is:

  `38E85C0E5042C0257DB7925E1E55709D6D155D90D92FE26AD654127D509766E0`

- Google Chrome or Microsoft Edge.
- Internet access during setup and Codex sign-in.
- A ChatGPT account with Codex access, or an OpenAI API key.

The patcher deliberately rejects every unknown vendor archive. New Grok Bot releases require a reviewed compatibility update.

## Install

1. Download `CodexBot-Setup-0.1.4.exe` from this repository's Releases page.
2. On the **Grok Bot frontend** page, allow Setup to reuse an exact 0.18.0 installation or download the official 0.18.0 per-user installer directly from `downloads.cursor.com`. The 125,825,552-byte download is checked against SHA-256 `464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E` and the exact reviewed Authenticode signer before it can run. It is not embedded in Codex Bot.
3. Launch Codex Bot.
4. On a fresh install, the blocking **Codex connection** dialog appears automatically. Choose **Use Codex OAuth** and complete sign-in in the browser, or choose **Use OpenAI API key** instead.
5. Optional: in Settings, acknowledge the Experimental vendor-computer warning and choose **Sign in to Cursor and enable vendor computer**. This starts a separate Cursor PKCE web sign-in; it does not require or reuse a Grok Bot or Cursor desktop login.

The installer copies the fully verified vendor tree into `%LOCALAPPDATA%\Programs\Codex Bot` and patches only that copy. An exact pre-existing Grok Bot installation is never modified. If Setup installs Grok Bot first, that is a separate vendor application: it remains installed if Codex Bot Setup is canceled, fails, or is later uninstalled. Setup refuses to run the vendor installer over an existing non-matching per-user Grok Bot installation or folder.

Silent Setup never downloads or installs Grok Bot implicitly. Supply `/BOOTSTRAPGROKBOT=1` to authorize the pinned vendor-hosted bootstrap, or `/GROKBOTDIR="C:\path\to\exact\Grok Bot"` to select an exact existing tree.

## Local always-on behavior

The background worker and schedules continue when the Codex Bot window is closed. They run only while that Windows user is signed in and the PC is running and awake. They cannot run while the PC is powered off, sleeping, or signed out, and online work requires internet access. True 24/7 operation requires an always-on Windows machine or VM with an interactive desktop session.

Websites can still require login, CAPTCHA, approval, or human judgment. The bot preserves the current state and asks for takeover instead of bypassing those checks.

## Local data and uninstall

Per-user state lives under `%LOCALAPPDATA%\Codex Bot Bridge` and can include OAuth files, conversations, attachments, downloads, logs, settings, routines, sanitized open-tab URLs, and separate signed-in browser profiles. Each bot restores its public tabs and signed-in browser profile after a restart. The separate tab snapshot retains only each public origin and path; URL credentials, all query strings, and fragments are removed before it is written. Do not upload that folder.

The interactive uninstaller asks whether to preserve that state for a future reinstall or permanently wipe it from this PC. Choosing **No** at the wipe prompt preserves it. Silent uninstall preserves it. A wipe deletes the complete local state directory and cannot be undone by Codex Bot; it does not revoke credentials or sessions already held by remote services, delete the vendor cloud computer, or verify remote deletion. If Windows cannot remove every local file, the uninstaller reports the remaining folder instead of claiming the wipe succeeded.

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

The build downloads the reviewed, pinned CLIProxyAPI 7.2.130 Windows x64 release, verifies both its source-pinned SHA-256 and that release's published `checksums.txt`, and bundles the verified MIT-licensed binary. It does not download, stage, or package Grok Bot. At install time only, the setup wizard can download the pinned official Grok Bot installer directly from the vendor after the user authorizes it.

Release builds require a clean Git worktree so every packaged source file is committed. Developers may explicitly pass `-AllowDirtyDevelopmentBuild` to `scripts/build-installer.ps1` for a local test installer, but that build is not suitable for publication.

The finished installer and SHA-256 are written to `artifacts/` (ignored by Git).

## Project layout

- `src/bridge.cjs` - model/tool protocol bridge and digital-coworker policy.
- `src/browser-seats/` - persistent browser seats, public-web proxy, and action approvals.
- `src/browser-seat-bridge.cjs` - authenticated loopback live-view/input service.
- `src/official-computer-client.cjs` and `src/official-computer-helper.cjs` - isolated, opt-in vendor authentication/provisioning and primary-display relay.
- `src/renderer/` - code injected into the user's local frontend; no vendor bundle is stored here.
- `scripts/patch-app.cjs` - exact-hash patcher.
- `src/runtime/` - launcher, background worker, and scheduled-task helpers.
- `installer/` - Inno Setup definition.
- `tests/` and `scripts/security-audit.cjs` - release and privacy gates.

## Compatibility and terms

Codex OAuth support is provided by the third-party CLIProxyAPI project and can change when providers change their services. Grok Bot is a separate vendor application governed by the vendor's [terms of service](https://cursor.com/terms-of-service) and [privacy policy](https://cursor.com/privacy); Codex Bot does not grant a license to it or manage its uninstall. Users are responsible for their accounts, subscriptions, site permissions, and compliance with applicable terms and law.

See [NOTICE.md](NOTICE.md), [PRIVACY.md](PRIVACY.md), and [SECURITY.md](SECURITY.md).
