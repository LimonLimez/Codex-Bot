# macOS notices and trademarks

Codex Bot for macOS is an independent community project. It is not affiliated
with, endorsed by, or supported by Anysphere, xAI, or OpenAI.

The installer verifies a user-owned Grok Bot 0.20.0 application and creates a
separate Codex Bot copy. Neither the repository nor the DMG redistributes the
Grok Bot application, its `app.asar`, proprietary vendor assets, user profiles,
conversations, cookies, credentials, or patched application archives. Grok Bot
remains governed by the vendor's terms and privacy policy.

The installer bundles the unmodified official Codex 0.147.0 macOS arm64
executable from the OpenAI Codex project, preserving OpenAI's Developer ID
signature. Codex is licensed under the Apache License 2.0; its bundled license
and upstream source are available from <https://github.com/openai/codex>.

The installer also bundles the byte-verified CLIProxyAPI 7.2.132 macOS arm64
executable for optional provider connections and re-signs that executable as
part of the Codex Bot distribution. CLIProxyAPI is licensed under the MIT
License; its bundled license and upstream source are available from
<https://github.com/router-for-me/CLIProxyAPI>.

The packaged patcher includes the exact npm dependency closure for
`@electron/asar`, `balanced-match`, `brace-expansion`, `glob`, `lru-cache`,
`minimatch`, `minipass`, `path-scurry`, `prettier`, and `ws` 8.21.3. Their
license files and package metadata remain bundled with their source; upstream
locations are recorded in those package manifests.

"Grok," "Grok Bot," and related marks belong to their respective owner.
"OpenAI," "ChatGPT," "Codex," and related marks belong to OpenAI. These names
are used only to describe compatibility and the origin of unmodified upstream
components.
