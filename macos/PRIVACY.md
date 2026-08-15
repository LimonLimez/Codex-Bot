# Privacy on macOS

Codex Bot for macOS keeps its application state in the current macOS user's
private Electron user-data directory, under the `codex-bot` subdirectory. That
state can include bot records, conversation bindings, selected models, and
CLIProxyAPI account authorization. Do not upload or share that directory.

The bundled CLIProxyAPI sidecar listens only on `127.0.0.1`, uses a fresh random
local credential, disables its remote management panel, file logging, plugins,
profiling, and usage statistics, and stores its configuration and provider
authorization with user-only filesystem permissions. Connecting a Codex,
Claude, or Kimi account opens CLIProxyAPI's provider-specific authorization
flow. Those providers process the prompts and model requests sent to them under
their own terms and privacy policies.

Each Work bot is assigned its own explicitly configured remote runtime. Prompts,
requested tool actions, computer frames, keyboard or pointer input, and data
entered into websites may be processed by that remote-runtime provider and by
the websites used inside the runtime. If the remote provider is unavailable,
Codex Bot fails closed; it does not silently use this Mac, a shared computer, or
an xAI inference fallback.

Codex Bot does not add project telemetry. Runtime errors and public events are
sanitized to remove authorization values, endpoints, provider diagnostics, and
other private session material. The app cannot control or make privacy promises
for the upstream model providers, remote-runtime provider, vendor shell, or
websites selected by the user.

The installer reads a user-owned, exact Grok Bot 0.20.0 application and creates
a separate Codex Bot application. It does not modify the source Grok Bot app.
The Codex Bot DMG contains no Grok Bot application, user profile, conversation,
cookie, browser history, development log, screenshot, credential, or personal
absolute path. A mounted-image audit enforces that release boundary.
