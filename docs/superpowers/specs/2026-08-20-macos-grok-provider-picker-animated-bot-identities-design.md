# Grok-native provider picker and animated bot identities

**Status:** Approved in chat on 2026-08-20

**Product:** OpenBot for macOS

**Reference:** `/Applications/Grok Bot original 20260811.app`, Grok Bot 0.20.0

**Reference ASAR SHA-256:**
`1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997`

## Goal

Make OpenBot's required first-provider chooser visibly belong to the preserved
Grok 0.20 product, then extend Grok's normal animated avatar choices so every
new bot receives a persistent, editable identity from abstract, animal,
creature, or computer-related families.

The work must preserve the native Grok New Bot route. It must not add a second
pet system, a replacement shell, a parallel avatar renderer, or an extra bot
creation workflow.

## User decisions

- Provider setup remains mandatory before New Bot creation and has no Skip.
- The provider chooser should use Grok's Sand UI grammar rather than OpenBot's
  current settings-card presentation.
- Animated identities extend the default choices used by normal Grok bots.
- The first expanded catalog includes basic animals and creatures such as cat,
  dog, wolf, and bunny, plus computer-related identities.
- Existing bots keep their current appearance.
- New identities remain editable later through the normal Character controls.

## Source authority and first divergences

### Provider chooser

The reference application has no eight-provider chooser. The relevant visual
authority is its Sand setup and picker grammar:

- shared heading/body typography;
- compact selectable surfaces;
- restrained secondary fills and hairline borders;
- stock focus treatment and shared buttons;
- progressive disclosure instead of showing every form simultaneously; and
- the preserved native shell and New Bot route.

OpenBot currently renders eight bordered settings rows with provider forms
expanded together inside a custom centered dialog. The earliest visual and
structural divergence is therefore the chooser component anatomy, not the
provider authority state machine.

### Bot appearance

Grok 0.20 uses one shared procedural Sand avatar renderer across setup, roster,
chat, and profile surfaces. It derives missing shape and color values
deterministically from the stable agent ID, persists the chosen shape and
color, and applies state-aware animation centrally.

OpenBot already persists `appearance.shape` and `appearance.color` and maps
them to native `avatarShape` and `avatarColor`. Its first divergence is that
native creation replaces omitted values with `blob` and `blue`, collapsing the
reference's deterministic variety.

## Design principles

1. **One native flow.** Provider setup hands off to the existing Grok New Bot
   picker; identity selection remains part of that native picker.
2. **One avatar engine.** New shapes use the same Sand geometry, face, state,
   animation, theme, and Reduced Motion machinery as stock shapes.
3. **Progressive disclosure.** Provider choices stay compact; only the selected
   provider exposes controls.
4. **Stable identity.** A bot's durable ID determines any omitted default once,
   and the selected shape/color are saved in its first commit.
5. **Truthful states.** Unavailable providers remain visible with an explicit
   reason; broken actions are not presented as usable.

Anti-principles:

- no dashboard-like grid with glow-heavy cards;
- no provider forms expanded in all cards;
- no image-generated or separately animated pet assets;
- no random appearance change on relaunch;
- no color-only identity or status meaning; and
- no replacement for the native New Bot setup.

## Provider-first chooser

### Surface

The chooser remains a blocking modal because OpenBot requires a durable first
connection before bot creation. It cannot close through Escape, backdrop,
window dismissal, or a Skip action. The preserved shell remains visible below
the scrim.

The modal uses Sand-compatible semantic tokens with fixture-safe fallbacks:

- primary, secondary, and tertiary text;
- secondary solid and hover fills;
- subtle, default, and focus borders;
- the reference spacing rhythm of 4, 8, 12, 16, and 20 pixels; and
- the reference shared button geometry and typography.

The header remains stable while the choice area scrolls. At normal widths the
choice area uses two equal columns with a 12-pixel gap. Below the narrow
breakpoint it becomes one column without horizontal scrolling or clipped
content.

### Provider choice cards

All eight canonical provider families remain visible in descriptor order:

1. OpenAI Codex
2. Anthropic Claude
3. Google Antigravity
4. Moonshot Kimi
5. xAI
6. Google Vertex AI
7. OpenAI API key
8. Local models

Each choice is a real button inside a list item and contains:

- a restrained neutral provider mark;
- provider name;
- one short route description;
- redundant text connection state; and
- an optional Recommended label for OpenAI Codex.

OpenAI Codex starts selected so the details panel has a useful first state, but
selection is ephemeral UI state only. It does not connect, create a receipt,
or create a bot.

Cards expose `aria-pressed`, `aria-controls`, a visible focus ring, and state
text that does not rely on color. Unavailable cards remain readable. They may
be selected to reveal the reason, but their connect action is disabled.

### Selected-provider panel

Only one details panel is mounted or visible. It owns the selected provider's:

- account-mode selection;
- API-key input;
- local base URL and optional key;
- device-code instructions;
- service-account/file instructions;
- primary connection action;
- sanitized error and recovery message;
- pending state and progress text;
- login code; and
- legacy Finish setup recovery action.

The primary button names the provider. Connecting sets `aria-busy`, disables
conflicting actions, and preserves the selected card. Failure restores focus
to the action and keeps entered non-secret values where safe. Secret inputs
are cleared after submission or cancellation according to the existing
security contract.

The existing connect -> authoritative snapshot -> connected model -> durable
onboarding receipt -> authoritative reread sequence remains unchanged.

### Truthful Vertex state

The current renderer sends no `sourcePath` for Google Vertex even though the
main process requires one. Until a reviewed file-picker bridge exists, the
Vertex card remains visible but its action is disabled with a concise
explanation. This design does not silently send an incomplete request.

### Settings reuse

General Settings uses the same provider-card and disclosure anatomy, including
status, connect, disconnect, retry, login prompt, and errors. Settings is not
modal and does not apply the first-connection no-dismiss rule.

## Animated bot identities

### Shared Sand engine

The reference avatar renderer and its wrappers remain authoritative. New
identities extend the exact hash-bound shape registry and visible Character
picker. The existing state mapping, face placement, theme behavior, lifecycle,
and animation functions are not replaced.

Animation remains shared behavior rather than persisted data. A bot record
continues to store only its shape and color. The engine supplies idle,
thinking, working, sending, orbit, spin, and morph behavior as appropriate for
the active runtime state.

### Catalog

Keep every currently exposed stock abstract shape. Add these safe identifiers:

Animals and creatures:

- `cat`
- `dog`
- `wolf`
- `bunny`
- `fox`
- `bear`
- `owl`
- `jelly`

Computer-related:

- `terminal`
- `robot`
- `microchip`
- `drone`

Each new geometry must be a compound, recognizable silhouette designed around
the Sand face and motion center. Basic construction primitives may guide the
work but must not remain as pasted circles, triangles, ears, or antennae.

At 16 pixels the family must remain distinguishable. At 36 pixels the specific
animal, creature, or machine must be recognizable without its label. Dog and
wolf require materially different muzzle, ear, cheek, and silhouette language;
terminal, microchip, robot, and drone require distinct machine geometry rather
than decorative badges on one base shape.

### Sizes and motion

New shapes must render correctly at the reference sizes used by native
surfaces: 16, 22, 28, 36, 64, 72, and 96 pixels.

For every shape:

- face placement remains readable and stable;
- appendages do not clip during a complete loop;
- the baseline and optical center remain stable;
- fills and outlines work in light and dark themes;
- idle and working loops close without a seam; and
- Reduced Motion produces a stable, recognizable still with no spin, travel,
  orbit, or morph.

The implementation uses deterministic code-native geometry. It adds no remote
generation, raster download, external license dependency, or independently
generated animation frames.

### Creation and persistence

Creation keeps the stock `createAgent` path and the existing provider gate.

1. If the user explicitly chooses a shape and color, those values win.
2. If either value is omitted, BotStore generates the normal stable bot ID.
3. BotStore hashes that ID with separate versioned shape and color salts.
4. The omitted values are selected from the approved visible catalog and
   palette.
5. The resulting shape and color are written in the bot's first durable commit.
6. No asynchronous generation or second appearance write occurs.

The native coordinator must stop forcing `blob`/`blue` when the stock request
omits appearance. It forwards explicit values only and lets BotStore own the
deterministic default.

The identity contract guarantees:

- same bot ID and same catalog version produce the same default;
- explicit user choices are never overwritten;
- relaunch and restart preserve the persisted choice;
- deletion removes identity with the normal bot record;
- existing records require no migration and keep their current appearance;
- later Character edits update the existing shape/color fields and
  `avatarVersion`; and
- older renderers fall back without corrupting the record.

No provider call, new preload method, new native RPC, animation DTO, asset
store, or BotStore schema bump is introduced.

## Accessibility

- Provider choice order is deterministic and keyboard reachable.
- Cards have accessible names, states, descriptions, and visible focus.
- Status, pending, unavailable, selected, and error states use text plus visual
  treatment rather than color alone.
- Provider details are associated through `aria-controls` and labelled regions.
- Focus enters the first enabled card, moves predictably to the details panel,
  returns after failed actions, and restores to the native shell after success.
- Avatar labels expose the same shape names used by the Character picker.
- Animation never communicates operational state without existing textual
  status, and Reduced Motion preserves static identity.

## State, error, and race behavior

The redesign must not weaken existing provider authority rules:

- late lower-generation events cannot reopen a completed gate;
- failed refresh cannot invent a connection or receipt;
- cancellation leaves the chooser usable;
- disconnect affects only the selected provider;
- one provider operation cannot overwrite another provider's state;
- successful onboarding never creates a bot by itself; and
- bot creation remains fenced by the durable provider receipt.

Identity selection must not add a failure point after bot creation. Default
selection is synchronous and deterministic inside the first BotStore commit.
If exact renderer patch anchors do not match the pinned reference, packaging
fails closed instead of shipping a partial catalog.

## Ownership boundaries

Provider presentation:

- `macos/src/renderer/bot-runtime-ui.js`
- `macos/src/renderer/codex-ui.css`
- provider DOM/visual fixture tests

Identity and persistence:

- `macos/src/bots/bot-store.cjs`
- `macos/src/desktop/openbot-native-coordinator.cjs`
- their focused tests

Reference renderer extension:

- `macos/src/patch/renderer.cjs`
- renderer patch, contract, packaging, and mutation tests

No runtime-provider, inference, conversation, Computer, automation, or remote
runtime ownership is added to this feature.

## Automated acceptance

Provider chooser tests must prove:

- eight cards in canonical order;
- one selected provider and one disclosed details panel;
- wide two-column and narrow one-column structure;
- keyboard selection, focus movement, and focus restoration;
- pending, connected, unavailable, error, retry, and device-code states;
- no Skip, Escape dismissal, backdrop dismissal, or bot creation;
- authoritative receipt closure and stale-event fencing;
- secrets clear under the existing contract; and
- light/dark semantic token resolution with Reduced Motion.

Identity tests must prove:

- the full safe unique catalog;
- deterministic same-ID defaults and varied fixture IDs;
- explicit shape/color values win;
- omitted defaults are present in the first durable commit;
- existing bots retain their exact appearance values through load;
- restart preserves identity and deletion removes it;
- every new shape round-trips through native roster and avatar methods;
- exact renderer patch anchors occur once and reverse to the pinned source;
- stock New Bot creation and Character edits use the same registry;
- Reduced Motion freezes the shared engine; and
- provider gating still occurs before creation.

Verification closes with focused renderer/store/coordinator/provider suites,
full `npm test`, source checks, package closure, installer tests, release audit,
and `git diff --check`.

## Visual acceptance

The exact freshly built and installed OpenBot must be inspected after the last
visual change.

Provider captures:

- wide and narrow windows;
- light and dark appearance;
- pointer and keyboard focus;
- selected, connecting, connected, unavailable, error, retry, and device-code
  states.

Avatar captures:

- every new identity at 16, 22, 28, 36, 64, 72, and 96 pixels;
- light and dark backgrounds;
- native New Bot picker, sidebar, chat, and Character editor;
- idle and working loops for every identity;
- every runtime animation state for at least one abstract, animal, creature,
  and computer representative; and
- the Reduced Motion still for every identity.

Review animation over at least two complete cycles. Inspect full-frame and
detail crops for silhouette recognition, clipping, face displacement,
baseline drift, contour seams, flicker, and loop continuity. Use an independent
blind A/B comparison against Grok 0.20 for provider UI fit and avatar motion.
Technical export or test success alone does not clear the visual gate.

## Release boundaries

This feature does not authorize a fake remote provider, Cursor fallback, vendor
asset redistribution, notarization claim, or self-contained public installer
claim. Those remain separate release gates.

The final handoff records the source commit, pushed branch, test outputs,
package hashes, installed ASAR hash, running executable, screenshots,
recordings, independent review, and all unverified external provider rows.
