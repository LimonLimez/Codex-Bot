# Open Bot

Open Bot turns a **user-owned Grok Bot 0.18.0 installation** into a local, always-on digital-coworker app powered by the AI provider you choose. It preserves the original desktop experience—blob avatars, conversations, routines, and computer preview—while replacing model routing and computer controls with reviewed local components.

This is an independent community project. It is not affiliated with, endorsed by, or supported by xAI, OpenAI, Anthropic, Google, or Moonshot AI.

## At a glance

- Choose **OpenAI Codex, Anthropic Claude, Google Antigravity, Moonshot Kimi, xAI, or Google Vertex AI** through the bundled local CLIProxyAPI sidecar.
- Keep a direct OpenAI API key as an optional route; it is protected with Windows DPAPI for the current Windows user.
- Connect a local OpenAI-compatible server such as **Ollama, LM Studio, or vLLM** through a loopback-only endpoint and discover its models automatically.
- Pick a workspace model and reasoning level, then override either choice for an individual employee.
- Set reasoning with a real stepped slider from the employee composer or Settings.
- Give every employee a persistent, isolated Chrome or Edge browser profile.
- Use the local Private browser by default, or explicitly opt into the Experimental vendor cloud computer.
- Approve vendor-computer actions in chat, enable provider-scoped **Always allow**, or take over in a full-window control surface.
- Keep schedules running in the background while that Windows user remains signed in and the PC stays awake.

## Quick start

1. Download `OpenBot-Setup-0.1.5.exe` from [Releases](https://github.com/LimonLimez/Open-Bot/releases).
2. Let Setup reuse an exact Grok Bot 0.18.0 tree, or explicitly authorize the separate vendor-hosted download.
3. Launch Open Bot and choose an AI provider from the connection list.
4. Finish that provider's official sign-in, import a Google Vertex service-account JSON key, or connect a local model server at `http://127.0.0.1:<port>/v1`.
5. Choose a model and reasoning level. Your workspace is ready when the selected account is connected.

The app never asks for a provider password. OAuth and device flows open only reviewed official authorization pages.

## AI providers

| Route              | Connection method                   | Models shown in the app                | Fast mode                                           |
| ------------------ | ----------------------------------- | -------------------------------------- | --------------------------------------------------- |
| OpenAI Codex       | ChatGPT/Codex device authorization  | Sol, Terra, Luna                       | Supported through the reviewed CLIProxy model alias |
| Anthropic Claude   | Anthropic OAuth                     | Opus, Sonnet, Fable                    | Not exposed by this route                           |
| Google Antigravity | Google OAuth                        | Gemini and reviewed Antigravity models | Not exposed by this route                           |
| Moonshot Kimi      | Kimi device authorization           | Kimi K3 and coding variants            | Not exposed by this route                           |
| xAI                | xAI device authorization            | Grok and Grok Build                    | Not exposed by this route                           |
| Google Vertex AI   | Service-account JSON import         | Gemini through Vertex AI               | Not exposed by this route                           |
| OpenAI API key     | Direct key verification             | Sol, Terra, Luna                       | OpenAI Fast service tier; premium pricing may apply |
| Local models       | Loopback OpenAI-compatible endpoint | Models discovered from `/v1/models`    | Not exposed; reasoning fields are omitted           |

The hosted-provider list is pinned to the reviewed CLIProxyAPI version bundled with the release. Account, plan, region, provider-side availability, and local model capabilities can still limit which models actually run. Requests fail closed if the selected route is unavailable; there is no silent fallback to another model provider.

Provider choices keep independent workspace and per-employee model preferences. Switching from Claude to Kimi and back, for example, restores the saved Claude model instead of forcing one provider's model ID onto another.

CLIProxy OAuth and imported provider credentials remain in this installation's private local auth directory. A Vertex upload is written to a private temporary file only long enough for the local CLIProxy importer to validate and store it, then the upload is deleted. Never upload the local state directory or provider auth files.

Local model setup accepts only a literal `http://127.0.0.1:<port>` endpoint, normalizes it to `/v1`, blocks Open Bot's own internal service ports, and never follows discovery redirects. Model discovery is time- and size-bounded. An optional local-server API key is protected with Windows DPAPI and is never returned to the renderer or written to logs. The selected model must implement OpenAI-compatible streaming chat completions and tool calling; a model appearing in `/v1/models` alone does not prove those capabilities. Open Bot sends local-model requests only to the configured loopback service, but that independently installed service may itself download models, contact a remote backend, or retain data according to its own configuration.

## Models and reasoning

Settings contains the workspace default model, a stepped reasoning slider, and Fast mode when the selected route supports it. Each employee composer has the same model and reasoning controls immediately beside the stock action cluster.

Per-employee overrides are partial. An employee can keep a custom model while inheriting future workspace reasoning changes, or return to all workspace defaults with one action.

Fast mode is deliberately provider-aware:

- Codex OAuth uses CLIProxyAPI's reviewed `-fast` model mapping.
- A direct OpenAI API key sends `service_tier: "fast"`; turning Fast off explicitly pins the standard/default tier.
- Other provider routes keep Fast disabled instead of pretending the setting is supported.
- Local routes keep Fast disabled and omit `reasoning_effort` for broad server compatibility.

## Computer modes

### Private browser

Private browser seats remain the default. Each employee receives a persistent local Chrome or Edge profile. Up to three seats stay active; when a fourth is needed, the least-recently-used idle seat closes while its profile and sessions remain saved.

Browser-originated HTTP(S) and WebSocket traffic is forced through an authenticated local proxy. It rejects literal or DNS-resolved local, private, link-local, reserved, and cloud-metadata addresses, then connects to the already-checked public address. Page WebRTC APIs, non-proxied WebRTC UDP, QUIC, permission prompts, page clipboard access, and automatic downloads are disabled.

Viewing, scrolling, pointer movement, and waiting can proceed automatically. Navigation, typing, clicks, drags, key activation, submissions, sensitive fields, and other mutating actions pause for an exact one-use **Allow once** or **Deny** decision. The approval expires if the page, destination, control lease, or live context changes.

### Experimental vendor cloud computer

The optional vendor computer requires a fresh direct Cursor web sign-in for this add-on plus an explicit billing/background-services acknowledgement. It does not read or import a Grok Bot or Cursor desktop profile. It reconnects to **one persistent account box shared by all employees**, not a separate VM for each employee.

The selected AI provider remains the local chat and planning model. The isolated helper receives no model-provider credentials, prompts, or conversation history. It sends only the vendor authentication, access-check, provisioning, remote-frame, and input traffic needed to operate the display.

The remote computer is vendor managed and may contain services this project cannot inspect or disable. **Zero vendor inference, telemetry, or charges cannot be guaranteed.** Provisioning or use may consume allowance, banked credits, or on-demand usage. **Billing is possible.**

Vendor-computer OAuth credentials are stored separately with current-user Windows DPAPI. Signing out closes the view, removes those local credentials, and clears **Always allow**. It does not delete the remote computer, revoke every remote session, or provide verified remote deletion.

Vendor actions appear as chat-adjacent approval cards containing the exact screen used for the decision. Settings also provides a warned, provider-scoped **Always allow computer actions** option. Always allow bypasses only per-action prompts; takeover leases, session generation, screen freshness, deadlines, and uncertain-outcome stops remain enforced.

**Take control** expands either computer provider into a full-window control surface with an exclusive backend lease. Releasing control, pressing Escape, losing the lease, or changing providers returns to the compact preview. Direct control does not move the physical mouse or type into the user's current app.

## Requirements

- Windows 10 or 11 x64.
- Google Chrome or Microsoft Edge.
- Internet access during setup and provider sign-in.
- An account with access to at least one listed provider, a Google Vertex service account, an OpenAI API key, or a compatible local model server.
- A legitimate Grok Bot 0.18.0 Windows x64 installation. Setup can reuse one or—with explicit authorization—obtain the separate per-user installer directly from the vendor-hosted, version-pinned URL.

The only supported Grok Bot `resources/app.asar` SHA-256 is:

`38E85C0E5042C0257DB7925E1E55709D6D155D90D92FE26AD654127D509766E0`

The patcher rejects every unknown vendor archive. A new Grok Bot release requires a reviewed compatibility update.

## Installer behavior

The setup wizard makes dependency download an explicit choice. If authorized, it downloads the 125,825,552-byte Grok Bot 0.18.0 installer directly from `downloads.cursor.com`, checks SHA-256 `464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E`, verifies the reviewed Authenticode identity, runs the separate vendor installer, and fully verifies all 657 installed files before copying anything.

Open Bot copies the verified tree into `%LOCALAPPDATA%\Programs\Open Bot` and patches only that copy. It never modifies an existing Grok Bot installation. The proprietary installer is not embedded in the Open Bot artifact.

If Setup installs Grok Bot first, that separate app remains installed if Open Bot Setup is canceled, fails, or is later uninstalled. Setup refuses to run the vendor installer over an existing non-matching per-user Grok Bot folder.

Silent Setup never downloads implicitly. Use:

```powershell
OpenBot-Setup-0.1.5.exe /VERYSILENT /BOOTSTRAPGROKBOT=1
```

Or select an exact existing tree:

```powershell
OpenBot-Setup-0.1.5.exe /VERYSILENT /GROKBOTDIR="C:\Path\To\Grok Bot"
```

## Local data and uninstall

Per-user state lives under `%LOCALAPPDATA%\Open Bot`. It can include provider auth files, API settings, conversations, attachments, downloads, logs, routines, browser profiles, and sanitized open-tab snapshots. Snapshots retain only public origin and path; URL credentials, query strings, and fragments are removed.

All bridge services bind to `127.0.0.1` and require installer-generated random credentials. Hosted-model traffic leaves the PC only for the provider explicitly selected by the user; local-model traffic is sent only to the configured loopback endpoint. A local server can still relay or retain requests independently. Website traffic leaves through the browser seat's checked public-web proxy. The optional vendor computer has the separate boundary described above.

The interactive uninstaller asks whether to preserve state for a future reinstall or permanently wipe it. Silent uninstall preserves state. A wipe cannot revoke credentials or sessions already held by remote services, delete the vendor cloud computer, or verify remote deletion. If Windows cannot remove every local file, the uninstaller reports the remaining path.

## Always-on behavior

Schedules continue after the window closes only while that Windows user is signed in and the PC is running, awake, and online. They do not run while the PC is powered off, sleeping, or signed out. True 24/7 operation requires an always-on Windows PC or VM with an interactive desktop session.

Websites may still require login, CAPTCHA, approval, or human judgment. The app preserves state and asks for takeover instead of bypassing those checks.

## Build from source

Install Node.js 22+ and Inno Setup 6, then run:

```powershell
npm ci
npm run check
npm test
npm run audit:release
npm run build:installer
```

The build downloads CLIProxyAPI 7.2.130 Windows x64, verifies its source-pinned SHA-256 and published checksum file, and bundles that reviewed MIT-licensed binary. It does not download, stage, or package Grok Bot. The separate vendor download can occur only later, during Setup and after explicit user authorization.

Canonical builds require a clean Git worktree. `-AllowDirtyDevelopmentBuild` creates a clearly marked local test installer that must not be published. Finished installers and SHA-256 sidecars are written to ignored `artifacts/`.

## Project map

- `src/codex-connection.cjs` — provider accounts, model preferences, credential handoff, and safe public status.
- `src/bridge.cjs` — OpenAI-compatible model/tool protocol bridge and coworker policy.
- `src/browser-seats/` — persistent private browsers, public-web proxy, control leases, and approvals.
- `src/browser-seat-bridge.cjs` — authenticated loopback API for settings, live view, input, and provider connection.
- `src/official-computer-client.cjs` and `src/official-computer-helper.cjs` — isolated opt-in vendor authentication, provisioning, and display relay.
- `src/renderer/` — local UI injected into the verified frontend.
- `scripts/patch-app.cjs` — exact-hash compatibility patcher.
- `src/runtime/` — launcher, watchdog, background worker, and scheduled-task helpers.
- `installer/` — Inno Setup definition and explicit vendor bootstrap flow.
- `tests/` and `scripts/security-audit.cjs` — behavior, privacy, and release gates.

## Compatibility and terms

Provider support comes from the third-party CLIProxyAPI project and can change when provider services change. Every provider, Grok Bot, and any website used through a computer seat remains governed by its owner's terms of service, subscription, billing, privacy, and acceptable-use policies.

Grok Bot is a separate proprietary application. Open Bot does not redistribute it, grant a license to it, or manage its uninstall. See [NOTICE.md](NOTICE.md), [PRIVACY.md](PRIVACY.md), and [SECURITY.md](SECURITY.md).
