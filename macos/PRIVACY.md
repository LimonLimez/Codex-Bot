# Privacy on macOS

OpenBot for macOS keeps its application state in the current macOS user's
private `OpenBot` Electron user-data directory, under the legacy-compatible
`codex-bot` subdirectory. That
state can include bot records, conversation bindings, selected models, official
Codex account status, and optional CLIProxyAPI provider authorization. The
embedded official Codex runtime uses the current user's standard `~/.codex`
directory for Codex account authorization. Do not upload or share either
location.

The official Codex account uses the verified OpenAI Codex runtime and a private
authenticated loopback channel; its prompts and model requests are processed by
OpenAI under the user's account and OpenAI's terms and privacy policy. It does
not require ChatGPT.app or CLIProxyAPI to be running.

The bundled CLIProxyAPI sidecar is optional and is used only for separately
configured providers. It listens only on `127.0.0.1`, uses a fresh random local
credential, disables its remote management panel, file logging, plugins,
profiling, and usage statistics, and stores its configuration and provider
authorization with user-only filesystem permissions. Connecting a reviewed
optional provider opens CLIProxyAPI's provider-specific authorization flow.
Those providers process the prompts and model requests sent to them under their
own terms and privacy policies.

Computer access is selected explicitly for each bot. If Free Local Desktop is
selected, OpenBot creates a dedicated Electron Chromium desktop, private
per-bot browser partition, and bot-scoped task workspaces on this Mac. It does
not open a normal Chrome or Safari profile. Browser cookies and site state may
be retained in that private OpenBot partition until the bot's local data is
removed. The requesting bot must use OpenBot's permission flow for brokered
file, shell, and other local actions; those actions can affect files or apps the
user permits. Free Local Desktop is local ownership isolation, not a cloud VM
or a security boundary for untrusted code.

If a remote runtime is selected, prompts, requested tool actions, computer
frames, keyboard or pointer input, and data entered into websites may be
processed by that remote-runtime provider and by the websites used inside the
runtime. If that provider is unavailable, OpenBot fails closed. It never
silently switches the bot to Free Local Desktop, a shared computer, or an xAI
inference fallback.

OpenBot does not add project telemetry. Runtime errors and public events are
sanitized to remove authorization values, endpoints, provider diagnostics, and
other private session material. The app cannot control or make privacy promises
for the upstream model providers, remote-runtime provider, vendor shell, or
websites selected by the user.

The installer reads a user-owned, exact Grok Bot 0.20.0 application and creates
a separate OpenBot application. It does not modify the source Grok Bot app.
On first launch, a legacy Codex Bot profile is copied atomically into OpenBot;
the legacy application and profile are retained for compatibility and rollback.
The OpenBot DMG contains no Grok Bot application, user profile, local permission
grant or bookmark, Free Local Desktop workspace or browser partition,
standalone conversation, cookie, browser history, development log, screenshot,
captured frame, credential, or personal absolute path. A mounted-image audit
enforces that release boundary.

The unmodified, integrity-pinned Codex and CLIProxyAPI executables can contain
public upstream CI source paths recorded by their compilers. The audit permits
only the enumerated `/Users/runner` Cargo, Rust toolchain, Go module cache, and
official project-workspace roots inside those two exact installer members. It
still rejects every other absolute home path, every such path in any other
member, and all detected credential material.
