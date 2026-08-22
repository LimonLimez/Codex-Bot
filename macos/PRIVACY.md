# Privacy on macOS

OpenBot for macOS keeps its application state in the current macOS user's
private `OpenBot` Electron user-data directory, under the legacy-compatible
`codex-bot` subdirectory. That
state can include bot records, conversation bindings, selected models, official
Codex account status, and optional CLIProxyAPI provider authorization. The
embedded official Codex runtime uses a private `CODEX_HOME` inside that OpenBot
state directory for account authorization. OpenBot does not read or import the
user's standard Codex profile, conversations, configuration, or rollout
history. The account credential is scoped to OpenBot's private Codex home,
whether the packaged runtime stores it in a file or a namespaced macOS
credential entry. Do not upload or share the OpenBot state directory.

The official Codex account uses the verified OpenAI Codex runtime and a private
authenticated loopback channel; its prompts and model requests are processed by
OpenAI under the user's account and OpenAI's terms and privacy policy. It does
not require ChatGPT.app or CLIProxyAPI to be running. A user signs in to the
official Codex account through OpenBot itself; signing in to another Codex app
does not silently authorize OpenBot.

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

The installer reads an exact Grok Bot 0.20.0 application and creates a separate
OpenBot application. The user may select an existing app or explicitly choose
the pinned official vendor download. That download is kept in a private
temporary directory, bounded and SHA-256 verified before a read-only mount,
then detached and removed after installation. The installer does not modify an
existing source Grok Bot app.
On first launch, a legacy Codex Bot profile is copied atomically into OpenBot;
the legacy application and profile are retained for compatibility and rollback.
The OpenBot DMG contains no Grok Bot application, user profile, local permission
grant or bookmark, Free Local Desktop workspace or browser partition,
standalone conversation, cookie, browser history, development log, screenshot,
captured frame, credential, or personal absolute path. A mounted-image audit
enforces that release boundary.

The unmodified, integrity-pinned Codex and CLIProxyAPI executables can contain
public upstream CI source paths recorded by their compilers. The audit permits
only the enumerated public GitHub Actions Cargo registry, Rust toolchain, Go
module cache, and official project-workspace roots inside those two exact
installer members. It still rejects every other absolute home path, every such
path in any other member, and all detected credential material.
