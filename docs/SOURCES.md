# Sources and provenance

This page distinguishes Open Bot's implementation claims from upstream product documentation. The repository source, tests, manifests, and hash pins define what a specific Open Bot release actually supports. Upstream links explain the external systems it integrates with.

## Upstream projects

| Component       | Purpose                                  | Source                                                                    |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| Grok Bot 0.18.0 | User-supplied compatible desktop runtime | [Official Grok Bot page](https://x.ai/bot)                                |
| CLIProxyAPI     | Local multi-provider routing sidecar     | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| noVNC           | RFB viewer used by the vendor computer   | [noVNC repository](https://github.com/novnc/noVNC)                        |
| Playwright      | Private Chromium automation              | [Playwright documentation](https://playwright.dev/docs/intro)             |
| Inno Setup      | Windows installer compiler               | [Inno Setup](https://jrsoftware.org/isinfo.php)                           |

Exact versions, hashes, signer identities, file inventories, and licenses are recorded in `package-lock.json`, `assets/*.manifest.json`, installer constants, and [NOTICE.md](../NOTICE.md). Builds fail closed when pinned input changes.

## Provider documentation

- [OpenAI Codex authentication](https://developers.openai.com/codex/auth)
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)
- [Anthropic Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)
- [Google Vertex AI authentication](https://cloud.google.com/vertex-ai/docs/authentication)
- [Moonshot AI platform](https://platform.moonshot.ai/docs/)
- [xAI API documentation](https://docs.x.ai/)

## Trademark and licensing note

Provider names and marks identify compatibility only. Their inclusion does not imply endorsement. The MIT license covers Open Bot source, not third-party applications, services, models, or marks. A public download and valid signature establish provenance, not redistribution permission; Open Bot therefore does not embed the vendor application.
