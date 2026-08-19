# macOS native onboarding and Computer placement

## Goal

Preserve Grok Bot 0.20's native renderer while making OpenBot's first-run and bot-specific controls appear in their correct product surfaces.

## Product contract

- Before the first bot can be created, require an AI connection choice. Offer Direct Codex as the recommended option and Claude through CLIProxyAPI. Do not offer a skip action.
- Expose additional connection actions later in General Settings under an OpenBot-owned AI Connections section.
- Route the stock Create new Bot action into Grok's existing "Meet a future teammate" picker and setup form. Do not display OpenBot's legacy custom New Bot dialog in native mode.
- Keep the compact Codex-style model Power control next to the composer. Its popover must contain only model, effort, Advanced, and Fast controls.
- Put runtime status, Computer selection, per-bot grants, and Free Local Desktop inside Grok's View Bot settings surface.
- A local Computer selection must select the active bot in the existing local desktop viewer; changing away from local must clear it.
- Keep connection state, model selection, and Computer selection as separate authorities. The onboarding completion flag is non-secret UI state only.

## Implementation sequence

1. Add strict renderer transform tests for the stock New Bot routing plus exact bot-settings and General Settings hosts, including the lazy settings asset hash.
2. Add mounted UI regressions proving the model popover excludes Computer rows, View Bot owns Computer/local desktop, and first-run connection setup gates bot creation with no skip.
3. Add coordinator coverage proving stock template-backed creation is accepted without treating the template identifier as trusted runtime state.
4. Implement the minimal hash-pinned renderer transforms and host mounting.
5. Run focused and adjacent suites, package a fresh isolated app, and visually verify the installed candidate against the exact Grok 0.20 source app.
6. Commit and push only the verified source state; keep installer/public-release work as a separate gate.

## Acceptance

- A clean profile sees connection setup before any bot creation path.
- Choosing Direct Codex waits for authoritative account readiness; choosing Claude delegates only to the reviewed provider facade.
- Create new Bot opens Grok's original setup chat/picker.
- View Bot contains Computer status, Change, grants, and the local desktop surface for local bots.
- Opening the model picker does not show runtime or Computer controls and retains its compact measured layout.
- Focused, adjacent, package, and installed visual checks all pass on the same source revision.
