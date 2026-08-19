# macOS provider, Desktop, onboarding, and compact Power design

## Status

Approved in chat on 2026-08-18, with one correction: the composer model
trigger is correctly placed, but the simple reasoning view must not reserve
empty space for the taller Advanced view.

The source of truth for native bot creation and surrounding layout is the
verified Grok Bot 0.20 application at
`/Applications/Grok Bot original 20260811.app`. The provider contract is the
full Open Bot provider matrix already documented in the repository. The
candidate acceptance surface is the installed
`/Users/harlin/Applications/OpenBot.app` generated from the macOS source tree.

## Problem statement

The current installed application exposes only Direct Codex and Anthropic
Claude even though Open Bot documents additional hosted, API-key, and local
routes. Its first-connection dialog is renderer-local state and appears only
when the bot roster is empty, so a legacy profile with bots can bypass it.

Free Local Desktop persists a ready bot record and opens a hidden Electron
window, but the window remains at `about:blank`. Display capture rejects every
URL except a public HTTPS URL, and the periodic frame bridge swallows capture
errors. The renderer therefore stays at “Connecting to local desktop” while
the stock preview eventually reports that it cannot reach the bot screen.

The compact Power popover also has an avoidable layout defect. The simple
panel forces a 121-pixel minimum height and 55 pixels of bottom padding around
a 32-pixel slider, leaving a large empty region. The existing measured
simple-to-Advanced transition is otherwise the correct interaction model.

The installed New Bot path now reaches Grok's native “Meet a future teammate”
picker and its native name and description form. That path must be preserved,
not replaced with an OpenBot-specific setup form.

## Goals

1. Expose the complete documented provider set on macOS:
   - OpenAI Codex;
   - Anthropic Claude;
   - Google Antigravity;
   - Moonshot Kimi;
   - xAI;
   - Google Vertex AI;
   - OpenAI API key; and
   - a loopback OpenAI-compatible server such as Ollama, LM Studio, or vLLM.
2. Require one authoritative AI connection before New Bot creation, including
   legacy profiles that already contain bots but have no onboarding receipt.
3. Let users connect and manage additional providers later in General
   Settings.
4. Keep provider connection, per-bot model selection, and per-bot Computer
   selection separate authorities.
5. Make Free Local Desktop produce an immediate, safe frame and surface
   failures with a retry path.
6. Keep Computer and remote-desktop controls in View Bot settings.
7. Keep the compact model trigger inside the composer near the send control.
8. Make the simple Power view hug its real content; expand only for Advanced.
9. Avoid macOS password prompts merely from launching OpenBot. Secret access
   occurs only after an explicit connection or inference action and remains in
   the main process.

## Non-goals

- Replacing Grok's native New Bot picker or profile form.
- Adding a provider selector beside the reasoning slider.
- Moving Computer controls back into the Power popover.
- Showing provider models as usable before their route is connected and
  healthy.
- Silently falling back to another provider, model, or Computer.
- Treating a UI tile as proof that authentication or inference works.
- Implementing or pretending that the unavailable remote-Computer provider is
  ready.

## Product and visual contract

OpenBot is a compact desktop coworker. The composer remains the primary work
surface; connection management and Computer configuration are progressive
disclosures rather than permanent composer chrome.

Observable layout rules:

- The model trigger remains inside the composer action row immediately before
  the send or voice action.
- The simple Power popover contains one reasoning slider followed immediately
  by a divider and the 36-pixel Advanced/Fast footer.
- The simple panel has content-driven height. It has normal compact insets and
  no minimum height or bottom spacer derived from the Advanced panel.
- Opening Advanced animates the already-existing measured height and horizontal
  track from the compact height to the Advanced height. Closing reverses the
  transition without jumping the anchored popover.
- Model, Effort, and Speed remain Advanced rows. Provider identity appears only
  as secondary disambiguation when two visible model names collide.
- Reduced-motion mode changes state without spatial travel while retaining the
  same final geometry and focus order.
- Pointer, keyboard, Home/End, arrow-key, scroll-wheel, rapid Fast toggles,
  focus restoration, and Escape behavior remain supported.

The compact state is accepted only when a fresh screenshot shows no visually
unused band between the slider and footer at the installed app's normal window
size. The Advanced state may be taller because it contains three rows.

## Provider architecture

### Shared descriptors

Create one platform-neutral provider descriptor module for provider IDs,
labels, login kinds, model descriptors, reasoning capabilities, Fast support,
and selection identity. macOS and the existing Windows connection code consume
the same semantic catalog without sharing platform credential code.

Canonical provider IDs remain opaque runtime identities. Display labels never
become storage keys. Model-selection keys contain both provider and model so a
same-named model from two routes cannot collide.

### macOS provider controller

Add a main-process provider controller with a narrow public contract:

- `listConnections()` returns sanitized provider status and capabilities;
- `connect(request)` performs the exact provider's reviewed flow;
- `disconnect(providerId)` removes only that provider's local authorization;
- `catalog()` returns models for connected, healthy routes;
- `readOnboarding()` returns the durable first-connection receipt; and
- `completeOnboarding(providerId)` commits only after authoritative connection
  readiness.

Direct Codex continues through the existing Codex account controller. Hosted
CLIProxy routes use the bundled, integrity-checked CLIProxy executable and its
provider-specific login commands. Vertex uses an explicit file picker and a
private temporary import file that is removed after the CLIProxy importer
settles. The OpenAI API key is stored in macOS Keychain and never returned to
the renderer. A local route accepts only a literal loopback HTTP endpoint,
discovers `/v1/models` with strict time and size bounds, and stores an optional
key in Keychain.

Provider authentication files remain in the app's private CLIProxy auth
directory. Renderer DTOs expose status, labels, capabilities, and sanitized
errors only. Opening OpenBot does not proactively fetch a protected secret.

### Runtime and model routing

Replace the two-provider allowlists in model storage, runtime configuration,
the inference router, and native-model projection with validation against the
shared provider descriptors.

Every inference request resolves the exact stored provider/model identity and
chooses only that provider's transport. Unsupported Fast or reasoning fields
are omitted rather than translated into invented provider values. A disconnected
route remains unavailable and never falls back to Direct Codex.

The native model picker shows models from connected, healthy provider catalogs.
General Settings always shows the complete provider connection list so another
route can be added later.

## First-connection onboarding

Replace `openbot.first-connection.v1` renderer local storage with a durable,
main-process onboarding receipt tied to an authoritative connected provider.

On startup:

1. read provider connection state and the onboarding receipt;
2. if no valid receipt exists, show the connection chooser before normal bot
   creation regardless of existing bot count;
3. preserve existing bots and conversations during this legacy-profile gate;
4. disable every New Bot entry point until one provider is connected and the
   receipt commits; and
5. after completion, restore the user's prior active bot or the native empty
   state.

The chooser contains all provider routes, not only Codex and Claude. It has no
skip action. Cancellation of an external login leaves the chooser usable and
does not create a receipt. Settings uses the same provider controller and can
connect or disconnect additional routes later.

## Free Local Desktop

### Safe initial document

The Local Desktop manager owns one exact built-in start document with a strict
Content Security Policy, no scripts, no external resources, no forms, and no
network access. It loads that document after securing the session/window and
before publishing the session as open.

Display capture permits either that exact manager-owned start document or a
validated public HTTPS page. Public navigation retains the existing public
HTTPS and private-address checks. Arbitrary `file:`, `data:`, `about:`, custom,
loopback, private-network, credential-bearing, and malformed URLs remain
rejected; the built-in start document is an exact-identity exception, not a new
general navigation class.

### Frame and error flow

The initial frame subscription awaits one capture attempt before reporting
selection success. Periodic captures remain throttled and non-overlapping.

Introduce a bounded, sanitized frame-status event scoped by bot, target
generation, view generation, and sender frame. The renderer distinguishes
connecting, live, unavailable, and retrying states. Errors contain a stable
public code only. Retry invalidates the old subscription, reopens the exact
current Computer identity, and cannot publish a stale bot or generation.

Selecting another Computer mode or deleting the bot clears the local viewer,
hidden browser, helper, frame timer, and private profile ownership according to
the existing lifecycle fences.

## Native New Bot and View Bot placement

Preserve the current native path:

`New` -> native recipient picker -> `Create new Bot` ->
`Meet a future teammate` -> native template or `Create your own` form.

Do not mount the legacy OpenBot setup dialog in native mode. Provider onboarding
gates entry to this path but does not replace any screen inside it.

View Bot settings continues to own Computer status, Change, permission grants,
Free Local Desktop, and the remote-Computer unavailable state. The Power
popover contains none of those controls.

## Error handling and security

- Validate renderer and provider DTOs descriptor-first and fail closed on
  accessors, proxies, extra fields, duplicate IDs, invalid URLs, and oversized
  values.
- Sanitize provider process output and never render tokens, keys, paths, or raw
  CLI errors.
- Do not read, copy, or import another application's credentials.
- Bind provider children and local-desktop work to disposal, bot deletion, and
  generation fences before external effects and after every await.
- Preserve exact Promise coalescing for duplicate connection, frame-selection,
  and disposal operations, including synchronous reentrancy.
- Make startup/provider failures truthful and retryable. Do not write an
  onboarding receipt or usable model selection before authoritative success.
- Keep the signed app's stable bundle identity. Launching the app alone must not
  invoke a provider login or Keychain authorization prompt.

## Migration

Existing OpenBot profiles are preserved. On first launch of this version:

- existing Direct Codex readiness may satisfy the connection controller, but
  the user still sees the first-connection chooser when no durable onboarding
  receipt exists and explicitly confirms the connection they want;
- existing two-provider model selections migrate to canonical shared provider
  IDs without changing the selected bot or model;
- unsupported or malformed stored provider selections become unavailable and
  require an explicit new choice; and
- existing local Computer profiles are reopened on demand and receive the safe
  start document without deleting their profile directory.

## Testing

All behavior changes begin with focused failing tests.

Provider and onboarding coverage:

- the full eight-route provider list and exact login kind/capability matrix;
- each hosted login command, cancellation, timeout, error sanitation, and
  connection readiness;
- Vertex temporary-file cleanup and hostile file/result rejection;
- loopback-only local discovery, redirect/private-address rejection, response
  limits, and optional-key secrecy;
- API-key Keychain calls only after explicit user action;
- existing bots plus a missing receipt still open the gate and block New;
- failed or cancelled connections do not commit onboarding;
- General Settings can add another provider after onboarding;
- same-named provider models keep distinct identities; and
- disconnected providers never appear as usable picker rows or receive
  inference.

Desktop coverage:

- open loads and captures the exact built-in start document before reporting
  live;
- the pre-fix `about:blank` state reproduces a failed first capture;
- arbitrary non-HTTPS and lookalike internal documents remain rejected;
- first capture failure returns a sanitized unavailable status rather than
  disappearing in a catch block;
- retry, bot switch, navigation, deletion, renderer destruction, and disposal
  invalidate stale frames and timers; and
- two bots keep distinct partitions, workspaces, frames, and permissions.

Power layout coverage:

- computed simple height equals the slider content plus compact insets and the
  36-pixel footer, with no 121-pixel minimum or 55-pixel spacer;
- Advanced uses its independently measured height;
- repeated rapid simple/Advanced toggles end at the last requested state;
- popover anchoring remains inside the viewport at normal and narrow sizes;
- focus, keyboard input, Fast toggles, Ultra entry, reduced motion, light/dark
  appearance, and longer provider/model labels remain usable.

Native-flow coverage:

- the exact pinned Grok renderer still opens the native teammate picker and
  profile form;
- no legacy New Bot setup mounts in native mode;
- Computer remains in View Bot and absent from Power; and
- connection gating cannot create a bot or mutate the native picker.

## Installed acceptance

Source tests and package checks are necessary but not sufficient. Build and
install one fresh candidate from the exact reviewed commit, replace the
canonical `/Users/harlin/Applications/OpenBot.app`, unregister and trash stale
OpenBot copies, then inspect that exact process.

The installed pass must prove:

1. launch produces no app-initiated password prompt;
2. a legacy profile without a receipt sees the full first-connection chooser;
3. at least one Direct Codex route, one non-Anthropic CLIProxy route, and one
   local or API-key route complete real catalog and inference checks when the
   required user authorization is available;
4. General Settings lists all eight provider routes;
5. connected models appear in the composer picker with canonical identity;
6. New reaches the native teammate picker and native profile form;
7. View Bot shows a live initial Free Local Desktop frame, public HTTPS
   navigation, and a working retry state;
8. the simple Power popover has no large empty region and Advanced expands from
   that compact geometry;
9. Computer controls remain absent from the Power popover; and
10. stale installed copies and stale processes are absent.

Capture a full screenshot and focused crop for the compact Power state, the
Advanced state, AI Connections, first-connection onboarding, native New Bot,
and live Desktop. Use a short recording for the measured height transition and
Ultra motion; report sampled versus exhaustive frame coverage accurately.

## Completion boundary

This work is complete only when the same exact commit passes focused tests,
the broad macOS suite, package/source checks, a fresh signed installation, and
the installed interaction matrix above. A connected-provider UI without a
working provider request, a ready Computer record without a live frame, or a
source-only New Bot test does not satisfy the product contract.
