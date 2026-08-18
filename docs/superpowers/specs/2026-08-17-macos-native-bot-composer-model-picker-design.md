# macOS Native Bot and Composer Model Picker Parity Design

**Date:** 2026-08-17

**Status:** Approved in chat

## Goal

Make the shipped OpenBot native Grok 0.20 surface behave like its source products in three connected places:

1. Creating a bot uses Grok's native `Create new Bot` flow instead of OpenBot's custom setup dialog.
2. The model trigger lives inside the composer control row immediately before the voice/send controls.
3. The trigger opens a Codex-style Power picker whose Advanced view uses menu rows and nested flyouts, never OpenBot's old grid of HTML `<select>` elements.

The exact read-only reference sources are `/Applications/Grok Bot original 20260811.app` version 0.20.0 for the shell and bot-creation flow, and `/Applications/ChatGPT.app` version 26.810.52044 for the composer model-picker behavior and styling.

## Scope

This slice changes the native-protocol renderer integration, trusted native bot-creation composition, and their tests. It does not redesign the account menu, bot sidebar, conversation renderer, Computer controls, branding, installer, signing, or notarization.

The implementation must preserve the current validated Direct Codex and CLIProxy model catalog, durable per-bot selection, Fast behavior, Ultra behavior, and native model RPC boundary. Provider identity remains part of each model option's canonical identity; there is no separate provider form row in the composer.

## Reference Behavior

### Native bot creation

The Grok `+` action opens its existing `New chat` route. The user can search for a bot or choose `Create new Bot`. Choosing it creates a literal `New Bot`, opens its conversation immediately, and leaves profile, model, and Computer configuration to their existing post-creation surfaces.

OpenBot must not open `dialog.codex-new-bot-setup`, request a photo, name, description, shape, color, provider, model, Power, or Speed before the bot exists. The native Grok route remains mounted and visually unchanged.

The trusted native `createAgent` path creates the bot with `setupStage: "complete"`. The ordinary OpenBot IPC creation path retains `profile-model` for its existing non-native setup flow. The native path still validates the Grok request, applies its name, description, and appearance, makes the new bot active, and publishes the authoritative roster. It does not synthesize model or provider state: a missing per-bot model selection continues to resolve through the existing advertised default-model path.

### Composer placement

The model trigger is a compact composer control inside the same footer/control row as the voice and send actions. It sits immediately before those right-side actions and never becomes a separate row below the text box.

Mount discovery must identify the native composer action row and a stable voice/send anchor. It must insert or move the single OpenBot trigger before that anchor. DOM remounts may relocate the same trigger, but must never duplicate it. If the exact action row is unavailable, the integration remains pending instead of appending the control to an outer composer container.

### Compact picker

Opening the trigger displays a 224px Codex-style menu. Its compact view contains the existing Power slider, an `Advanced` control at the lower left, and the Fast lightning control at the lower right. The selected model and effort remain visible in the composer trigger.

The existing Power semantics remain unchanged:

- pointer drag changes the selected Power option;
- Ultra entry occurs only through the established pointer-drag-to-maximum gesture;
- keyboard or click selection must not replay the Ultra entry effect;
- reduced motion keeps state changes but removes motion;
- rapid Fast on/off input resolves in user order and converges to the authoritative persisted state.

### Advanced picker

`Advanced` changes the menu from the compact slider to a detailed view. It does not reveal a form and does not use native `<select>` controls.

The detailed view contains, in this order:

1. **Model** — current model value aligned right with a chevron.
2. **Effort** — current effort value aligned right with a chevron.
3. **Speed** — current speed value aligned right with a chevron.

Each row is a menu item. Activating it opens a titled flyout with selectable rows and a checkmark on the active option. Model uses a 280px flyout, Effort uses at least 180px, and Speed uses 233px, matching the signed Codex component. Effort's Ultra option includes the existing Ultra usage warning as secondary text. Speed's Fast option includes `1.5x speed, more usage` as secondary text.

Changing Model recomputes the available Effort and Speed options before rendering their next interaction. Canonical provider/model identity travels through the existing validated selection DTO; display labels never become lookup keys. If two providers expose the same model label, their opaque canonical identities remain distinct and the menu adds only the minimum provider context needed to disambiguate them.

The `Advanced` control remains at the lower left in both views. Its chevron rotates to show the active view and activating it again returns to the compact slider.

## Motion and Layout

The picker owns an overflow-hidden measured viewport with a vertical view track. It measures the compact view, Advanced view, and shared controls using live element geometry and `ResizeObserver`, then sets the menu height to the active view plus shared controls.

The view-height and vertical-track transitions use 300ms `cubic-bezier(.23, 1, .32, 1)`. Panel opacity uses 200ms with the same easing. The initial measurement does not animate. `prefers-reduced-motion: reduce` disables height, transform, opacity, and chevron transitions.

Advanced begins behind a one-pixel subtle divider inset six pixels from each side. The shared controls have the Codex 36px compact minimum height and 40px expanded measurement where needed. The popover entry uses the existing Codex 320ms scale-and-fade behavior from 0.98 to 1 after a 30ms delay, except under reduced motion.

## Interaction and Accessibility

The trigger exposes `aria-haspopup="menu"` and `aria-expanded`. The Advanced control exposes `aria-expanded`, `Show advanced options`, and `Show compact options` states. Model, Effort, and Speed rows announce both label and selected value.

Only the active compact or Advanced panel participates in focus or accessibility traversal; the inactive panel is inert and `aria-hidden`. Flyouts support arrow-key navigation, Enter/Space selection, Escape to return to the parent menu, and a visible focus treatment. Closing the parent menu restores focus to the composer trigger.

Outside click, composer remount, bot switch, bot deletion, and controller disposal close any open parent or nested menu without committing an unselected value. An in-flight accepted change may finish, but its result is applied only if it still belongs to the current bot and current selection generation.

## Data Flow

1. The native shell exposes the current bot and available model variants through the existing five model RPCs.
2. The renderer normalizes the authoritative snapshot into immutable model, effort, and speed option rows keyed by canonical identity.
3. Opening the picker renders compact and Advanced panels from that same snapshot.
4. Selecting an option sends one exact validated native selection DTO.
5. Pending UI is disabled only for the affected selection mutation. A later user intent is queued in order rather than derived from a stale snapshot.
6. The next authoritative snapshot updates the trigger, slider, Advanced rows, and checkmarks together.

There is one durable active-selection owner. Renderer labels, provider hints, and animation state are projections and do not create a second model-selection store.

## Error Handling

Malformed catalog or selection data fails closed at the existing native boundary. The renderer never invents a provider, model, effort, or speed fallback that was not advertised. A rejected mutation restores the last authoritative selection and keeps the menu usable. A deleted or switched bot cannot receive a late selection result.

If no selectable model exists, the trigger remains present but disabled with the existing unavailable/error treatment. Missing composer anchors keep mounting pending; they do not create a second row or attach controls to `body`.

## Code Organization

The existing renderer integration remains the owner of mounting and lifecycle. Pure catalog, option, and canonical-identity projection remains in `macos/src/renderer/model-controls.js`. Power selection and gesture state remains in `macos/src/renderer/reasoning-control.js`. DOM construction, menu focus, view measurement, native creation-dialog suppression, and composer mounting remain in `macos/src/renderer/bot-runtime-ui.js`; this avoids adding another packaged renderer script while keeping the already tested state boundaries intact. The boundaries are:

- composer-anchor discovery and single-instance mounting;
- immutable picker option projection;
- compact/Advanced view state and measurement;
- nested menu focus and selection;
- native bot-creation interception removal.

`macos/src/bots/bot-store.cjs` accepts an exact trusted creation-stage field, defaulting to `profile-model`. `macos/src/desktop/openbot-native-coordinator.cjs` is the only native caller that requests `complete`. `macos/src/bots/runtime-controller.cjs` passes the validated creation input through without changing existing callers.

CSS remains in `macos/src/renderer/codex-ui.css`, scoped under the OpenBot model picker. No signed Codex or Grok asset is copied into the repository; the implementation reproduces the reviewed behavior using the project's own DOM and CSS.

## Testing

Behavioral tests must prove:

- native mode has no custom `Set up New Bot` dialog and the existing Grok create route reaches the coordinator once;
- the single model trigger mounts before voice/send inside the composer action row and survives a native DOM remount without duplication;
- native mode includes Advanced while containing no model, effort, or speed `<select>` controls;
- compact and Advanced panels expose the exact active/inert/ARIA states;
- Advanced renders Model, Effort, and Speed rows in order and opens titled flyouts with correct active checkmarks and secondary text;
- provider/model collisions remain distinct through selection and round-trip to the right controller identity;
- changing Model recomputes valid Effort and Speed choices;
- rapid Fast toggles and rapid Advanced mutations preserve intent order;
- bot switch, deletion, outside click, Escape, disposal, and held mutation completion cannot publish stale state;
- measured view transitions use the reviewed durations/easing and are disabled for reduced motion;
- pointer-only Ultra entry, steady particles, burst, and warning behavior remain green.

Static/package tests must reject reintroduction of the old raw-select Advanced grid, a separate provider row, outer-composer append mounting, or the custom new-bot setup dialog in native mode. The focused renderer, native coordinator, desktop runtime, package-closure, source-check, and full macOS suites run before completion.

## Acceptance Boundary

Passing source tests is not sufficient. Final acceptance requires a fresh installer built from the exact committed source, installation against the verified read-only Grok 0.20 source app, and live inspection of the generated OpenBot app. The live check must prove native New Bot creation, inside-composer trigger placement, compact/Advanced animation, all three flyouts, provider/model selection, Fast rapid-toggle convergence, Ultra pointer entry, and reduced-motion behavior. Source, built installer, installed app, and running process are reported as separate evidence.

## Non-Goals

- Recreating or replacing Grok's renderer tree.
- Restoring the old OpenBot Advanced `<select>` grid.
- Adding a separate provider selector to the composer.
- Redesigning the account menu or sidebar.
- Expanding remote VM, Cursor, MCP, publishing, or signed-out capabilities.
- Changing installer signing, notarization, or distribution policy in this slice.
