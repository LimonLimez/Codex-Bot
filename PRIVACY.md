# Privacy

Codex Bot Bridge is local-first. Its services listen only on `127.0.0.1`, use fresh random local credentials, and store each bot's browser profile separately under the current Windows user's Local AppData folder.

The project does not collect telemetry. Operational logs stay on the PC. Browser and bridge diagnostics remove URL paths, credentials, queries and fragments, plus bearer tokens, API keys, JWTs, and device codes before writing. API keys entered in the app are protected with Windows DPAPI for the current user. Codex OAuth files are managed by CLIProxyAPI in the user's private local state directory.

Prompts, conversation context, and requested tool results - including page text or screenshots when the computer tool is used - are sent to OpenAI through the selected Codex OAuth or OpenAI API-key route. The patched app does not send model requests to xAI and has no xAI vendor-backend fallback. Websites opened in a browser seat receive the normal data needed to use those sites.

Browser seats can connect only to public HTTP(S) destinations through authenticated per-seat proxies. Localhost, private networks, link-local targets, reserved addresses, cloud metadata endpoints, non-proxied WebRTC, and QUIC are blocked. Page clipboard access, permission prompts, and automatic downloads are disabled. This network boundary does not replace the privacy policies or security practices of public sites.

Never upload `%LOCALAPPDATA%\Codex Bot Bridge`. It may contain OAuth credentials, conversations, attachments, downloads, logs, browser cookies, browsing history, routines, and active login sessions. The repository's ignore rules and release audit block that state and common credential patterns.

The interactive uninstaller asks whether to preserve the state directory for a future reinstall or permanently wipe it. Choosing **No** at the wipe prompt preserves the directory, and silent uninstall always preserves it. Choosing **Yes** deletes conversations, OAuth state, downloads, settings, logs, routines, and signed-in browser profiles from this PC. That deletion cannot be undone by Codex Bot and does not revoke credentials or sessions already stored by remote services.
