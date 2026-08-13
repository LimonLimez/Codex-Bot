# Security policy

## Supported release

Security fixes are provided for the latest tagged Codex Bot Bridge release and the exact Grok Bot version and archive hash listed in the README.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, browser data, private conversations, or a working exploit.

## Security boundaries

- Model requests use the user's Codex OAuth account through CLIProxyAPI or their optional OpenAI API key. The patched app has no xAI inference, vendor-backend fallback, or Grok Bot usage-credit route.
- All local bridge services bind to loopback. Their control and data endpoints require fresh, installer-generated random credentials, and the live-view identity check uses a nonce-bound proof.
- Every browser seat uses a separate persistent profile and an authenticated per-seat proxy. The proxy resolves all destination addresses, rejects the whole destination if any answer is local, private, link-local, or reserved, and connects to a checked public address without resolving it again.
- Browser seats can reach public HTTP(S) sites, but not the PC's loopback services, private network, or cloud metadata addresses.
- Only non-mutating viewing, scrolling, pointer movement, focus, and waiting run automatically. Agent-driven navigation, typing, clicks, drags, key activation, controls, sensitive data entry, submissions, and unknown or consequential actions require an exact one-use decision from the trusted live-view approval panel. The decision is bound to the seat, origin, action, live DOM context, and navigation epoch.
- **Take control** acquires an exclusive backend lease, cancels pending bot action approval, and blocks new bot input until release or expiry. It sends direct user actions through the seat's virtual input without moving the physical mouse or typing into another application.
- Browser WebRTC, QUIC, page clipboard access, permission prompts, and automatic downloads are disabled. This prevents common browser APIs from bypassing the public-web proxy or action boundary.
- Browser and bridge diagnostics retain at most a public URL origin and redact credential-shaped values; tab snapshots retain only each public origin and path, never URL credentials, queries, or fragments.
- Login, CAPTCHA, purchases, deletion, credentials, external sends, and other user-judgment boundaries are not bypassed.
- The patcher verifies the complete supported vendor installation and rejects unknown or modified archives.
- The public build contains no vendor application binary, user data, credentials, screenshots, or signed-in browser profile.

The public-web proxy limits browser-originated network access; it is not a content filter and does not make public websites trustworthy. Review each requested action and the destination site before approving it.
