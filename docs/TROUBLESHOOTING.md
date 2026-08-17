# Troubleshooting

## Provider sign-in finishes in the browser but not in Open Bot

Keep Open Bot running until the local callback completes. If the browser reports that localhost refused the connection, return to Settings and start Connect again; an expired callback cannot be reused. Check that security software is not blocking loopback listeners. Open Bot does not import sessions from unrelated provider desktop apps.

## The selected model fails immediately

Confirm the provider still shows connected, refresh its catalog, and reselect an available model. A login can succeed while the account lacks the required product entitlement—for example, a Kimi account may not include a usable coding credential. Open Bot intentionally does not route the request to another provider.

Local models must support the OpenAI-compatible request shape used by the selected tools. Errors mentioning `tools.function.parameters` usually mean the server or model cannot accept that JSON schema; try a tool-capable model or Chat mode without tools.

## A message keeps loading

Open Settings and confirm the effective provider, model, and reasoning choice. Restart Open Bot if a provider helper exited during authorization. Preserve the timestamp and visible error before filing a bug; do not attach credential, OAuth, database, or browser-profile files.

## Browser work is blocked

“Always allow vendor computer actions” applies only to the experimental vendor computer. It does not approve Shell execution or change Private-browser policy. For web work, ask the coworker to use Computer, not Shell. Takeover temporarily blocks agent input until control is released.

## A local page opens but the coworker cannot read it

Some pages render data inside complex canvases or accessibility-poor widgets. The coworker should capture a fresh screenshot, zoom or scroll to the relevant panel, and read the visible result rather than switching to Shell. Never infer a number that is not visible.

## Setup cannot close applications

Exit Open Bot, its browser windows, and any installer still using the application directory, then choose **Try again**. Avoid **Ignore and continue** for an upgrade because locked files can leave a mixed installation.

## Routines do not run

The configured Windows user must remain signed in and the PC must stay awake. Verify the Open Bot bridge scheduled task is running. Routines are not a system service and do not run through a signed-out or sleeping session.

## Reporting a useful bug

Include the Open Bot version, Windows version, provider route, selected model, exact steps, visible error, and whether it reproduces in a new conversation. Redact account identifiers. Never post tokens, keys, OAuth files, service-account JSON, logs containing private prompts, databases, or browser profiles.
