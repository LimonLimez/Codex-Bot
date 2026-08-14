# Security policy

## Supported release

Security fixes are provided for the latest tagged Codex Bot Bridge release and the exact Grok Bot version and archive hash listed in the README.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, browser data, private conversations, or a working exploit.

## Security boundaries

- Private browser seats remain the default. Model requests use the user's Codex OAuth account through CLIProxyAPI or their optional OpenAI API key, with no xAI inference fallback or vendor usage-credit route.
- All local bridge services bind to loopback. Their control and data endpoints require fresh, installer-generated random credentials, and the live-view identity check uses a nonce-bound proof.
- Every browser seat uses a separate persistent profile and an authenticated per-seat proxy. The proxy resolves all destination addresses, rejects the whole destination if any answer is local, private, link-local, or reserved, and connects to a checked public address without resolving it again.
- Browser-originated HTTP(S) and WebSocket traffic can reach publicly routed destinations; the proxy rejects loopback, private, link-local, reserved, and cloud-metadata address ranges.
- Only non-mutating viewing, scrolling, pointer movement, focus, and waiting run automatically by default. Agent-driven navigation, typing, clicks, drags, key activation, controls, sensitive data entry, submissions, and unknown or consequential actions require an exact one-use decision from a trusted approval surface. Private-browser decisions are bound to the seat, origin, action, live DOM context, and navigation epoch.
- **Take control** acquires an exclusive backend lease, cancels pending bot action approval, and blocks new bot input until release or expiry. It sends direct user actions through the seat's virtual input without moving the physical mouse or typing into another application.
- Page WebRTC APIs, non-proxied WebRTC UDP, Chromium QUIC, page clipboard access, permission prompts, and automatic downloads are disabled. This blocks common browser APIs from bypassing the public-web proxy or action boundary.
- Browser and bridge diagnostics retain at most a public URL origin and redact credential-shaped values; tab snapshots retain only each public origin and path, never URL credentials, queries, or fragments.
- Login, CAPTCHA, purchases, deletion, credentials, external sends, and other user-judgment boundaries are not bypassed.
- Before any vendor files are copied or executed by the Codex Bot patch step, Setup verifies every file in the supported Grok Bot 0.18.0 tree against the reviewed 657-file manifest and checks the signed executable identity. Unknown, incomplete, modified, extra-file, and reparse-point trees are rejected.
- The public build contains no vendor application binary, user data, credentials, screenshots, or signed-in browser profile. If authorized, Setup downloads the official 125,825,552-byte Grok Bot 0.18.0 installer from its version-pinned `downloads.cursor.com` URL and independently rechecks SHA-256 `464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E`, version metadata, signature validity, signer subject, issuer, and artifact leaf thumbprint before execution.
- Silent Setup requires `/BOOTSTRAPGROKBOT=1` before it may download or run the separate vendor installer. After exact-tree discovery fails, any registered or default-path per-user Grok Bot tree blocks bootstrap so Setup cannot silently repair, overwrite, update, or downgrade it. A system-wide older tree can coexist with a fresh exact per-user 0.18.0 installation.
- The separate vendor install is not part of the Codex Bot rollback boundary. If the outer setup is canceled or fails after vendor installation, Grok Bot remains installed; the Codex Bot uninstaller does not remove it.

The public-web proxy limits browser-originated network access; it is an application-layer control, not an OS firewall or network namespace. It is not a content filter and does not make public websites trustworthy. Review each requested action and the destination site before approving it.

## Experimental vendor cloud computer

The official cloud-computer add-on is opt-in, never an automatic fallback, and requires a fresh direct Cursor PKCE web sign-in plus an explicit warning acknowledgement. It does not read or import a Grok Bot or Cursor desktop profile or saved sign-in. It reconnects to one persistent account box shared by every employee in the app. It is not a separate security boundary or VM per employee.

Codex remains the local chat and planning model. A separate helper process receives neither Codex/OpenAI credentials nor conversation history. Its environment is allowlisted, and its vendor API policy is limited to exact authentication, access-check, and provisioning endpoints. Its RFB relay accepts only the public primary-display endpoint returned by provisioning, rejects private or reserved address answers, and pins the checked address. It serves a pinned local noVNC client instead of vendor-hosted viewer JavaScript and decodes only the provisioning response's primary VNC URL and network token; gateway, exec-daemon, and fork-display credentials are not retained. Vendor OAuth credentials are stored separately with current-user Windows DPAPI. Provisioning credentials stay in helper memory and are discarded when the view closes.

The main coordinator does not route chat or planning inference to the vendor. That local property does not attest the remote computer: the vendor-managed box may run its own inference, telemetry, transcript, credential-renewal, or other background services. Zero vendor inference, telemetry, or charges cannot be guaranteed. Provisioning and use may consume included allowance, banked credits, or on-demand usage, so billing is possible.

Remote frames and input are untrusted. The helper bounds response sizes, framebuffer dimensions, WebSocket payloads, and clipboard data; rejects redirects, unexpected origins, private addresses, and unsupported RFB routes; and keeps the exclusive takeover lease. In the default ask mode, each mutating vendor action is bound to a one-use chat approval containing the exact trusted frame. Pointer actions require the exact displayed frame at execution. Keyboard actions may accept only a same-generation, tightly bounded caret-width or unchanged-cursor-local pixel delta; every other frame change requires a fresh approval.

The Windows user may separately enable **Always allow computer actions** for the Experimental vendor provider after an explicit warning acknowledgement. This provider-only choice defaults off and is DPAPI-protected. While enabled, it deliberately removes the per-action user-decision boundary for that shared vendor computer, but it does not grant access to Private browser seats or other tools. The helper still captures and rechecks the trusted frame and enforces provider/session generation, takeover, queue, deadline, stale-frame, and uncertain-outcome fences. Starting a new vendor sign-in or signing out clears the choice. These controls reduce local exposure but cannot verify or constrain activity performed by the vendor inside its cloud environment.

Signing out or wiping local state closes the local connection and removes the locally protected vendor credentials. There is no deletion receipt or verified remote deletion. It does not prove that the persistent cloud computer, its data, or server-side sessions were deleted; use the vendor's account controls for remote management and revocation.
