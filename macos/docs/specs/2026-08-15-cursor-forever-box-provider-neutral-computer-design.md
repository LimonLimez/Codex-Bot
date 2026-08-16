# OpenBot Provider-Neutral Remote and Free Local Computer Design

**Status:** Proposed for written review on `macos/codex-bot`

**Date:** 2026-08-15

**Platform:** macOS Apple Silicon only

**Extends:**

- `2026-08-14-macos-direct-codex-power-control-design.md`
- `2026-08-15-remote-runtime-live-acceptance-design.md`

## Decision

OpenBot offers two explicit Computer execution modes and a disabled choice:

- **Free Local Desktop** is an OpenBot-managed desktop page on the user's Mac.
  Each top-level bot receives its own browser profile and workspace. It starts
  isolated and may request bounded access to normal Mac files or applications.
- **Cursor Remote Computer** preserves Grok Bot 0.20's native Cursor-backed
  Forever Box as the remote Computer and Work execution plane. Cursor
  authentication is required only for this mode.
- **Not Now** leaves Work and Computer disabled while preserving Chat.

The normal New Bot setup remains authoritative for the bot's literal initial
name, explicit rename, profile, model/provider selection, and other existing
choices. Setup adds one required Computer-mode question and does not preselect a
mode. OpenBot never silently falls back from remote to local or local to remote.

OpenAI Codex and reviewed optional model providers remain the inference plane.
Switching inference providers never changes, recreates, or transfers the
selected bot's Computer target.

Users do not connect GitHub, create a Codex Cloud environment, configure a
generic VM provider, or host an OpenBot VM service. Cursor Remote Computer must
use Cursor's legitimate native account and entitlement flow. It must not
extract credentials from another application, copy another application's
profile, bypass an entitlement decision, emulate private backend grants, or
embed credentials in the application or installer.

Each top-level OpenBot bot owns one immutable OpenBot identity and exactly one
selected Computer target. A remote bot maps that identity to one native agent
and Forever Box. A local bot maps it to one local desktop profile and workspace.
Subagents share the parent bot's target and receive isolated task workspaces. A
subagent never provisions another target unless the user explicitly creates a
different top-level bot.

This design supersedes the generic external-provider choice in
`2026-08-15-remote-runtime-live-acceptance-design.md`. Its lifecycle, privacy,
two-bot isolation, YouTube exercise, cleanup, signing, notarization, and release
gates remain mandatory. Free Local Desktop is a separate, honestly labeled
local product mode rather than a disguised implementation of the remote gate.

## User-visible contract

OpenBot exposes independent model and Computer surfaces:

- **Models:** OpenAI Codex uses the official ChatGPT/Codex account path.
  Reviewed optional providers use their explicit optional connection paths.
- **Computer:** setup asks **Free Local Desktop**, **Cursor Remote Computer**,
  or **Not Now**. Cursor sign-in appears only after the remote choice.

The UI must say that Cursor powers Remote Computer and that Free Local Desktop
runs on this Mac. It must not imply that Cursor supplies OpenAI, Fable, Claude,
Kimi, or other model inference. It must not call the Forever Box an OpenAI VM, a
model-owned VM, a Codex Cloud environment, or an OpenBot-hosted VM. It must not
call Free Local Desktop remote, cloud-isolated, or a virtual machine.

Without Cursor authentication or entitlement, a user may explicitly select
Free Local Desktop. Chat and direct inference remain independent. Work and
Computer remain disabled only when the user selects Not Now, when the chosen
model lacks the required tool capability, or when the selected Computer mode is
unavailable. No mode may redirect work to Codex Cloud, Docker, SSH, an
unreviewed provider, or another Computer target.

When Cursor authentication and entitlement are available, creating or selecting
a top-level bot ensures that exact bot's Forever Box. Model switching preserves
the box's filesystem, Chrome profile, open windows, and current lifecycle state.

When Free Local Desktop is selected, creating or selecting a top-level bot
opens only that bot's local page, browser profile, and workspace. Access beyond
those owned resources requires an explicit per-bot permission decision.

## Audited reference and current divergence

The authoritative runtime reference is the verified Grok Bot 0.20.0 macOS
artifact with SHA-256:

`73dfc1656a0e122a9a98bdcf1f49da5ec5475e156977c8730d207bfe01281a42`

Its preserved desktop/host boundary exposes native operations including:

- `getForeverBoxStatus({ id })`;
- `ensureForeverBox({ id })`;
- `resetForeverBox({ id })`;
- `updateForeverBox({ id })`;
- `handBackForeverBox({ id, trigger })`.

The native backend service provisions a box for a native agent identity and
returns private execution, network, gateway, and VNC credentials. Those values
belong to the preserved native coordinator and must not be copied into a new
renderer API, BotStore record, log, report, or generic provider object.

The current OpenBot candidate diverges before provisioning. It creates a
separate BotStore identity and passes it to a configurable external provider
through `capabilities`, `provision`, `inspect`, `retire`, and `subscribe`.
That identity does not establish the native agent-to-Forever-Box relationship.

The fix is identity and ownership unification, not another cloud adapter:

- the native agent ID is the authoritative remote-computer identity;
- OpenBot's bot profile and model selection are keyed to that identity;
- the preserved native coordinator owns VM lifecycle and execution;
- OpenBot consumes only sanitized lifecycle and frame information;
- the generic provider module cannot replace or bypass the native path in
  production.

## Architecture

### Cursor Remote Computer authority

The preserved Grok host and coordinator remain the only production components
allowed to call Cursor's Forever Box service. OpenBot must not reimplement the
private RPC client or invoke Cursor backend endpoints directly from new code.

A narrow OpenBot/native bridge coordinates these operations:

- list or create the native agent identity for a top-level OpenBot bot;
- bind the OpenBot profile and model-selection record to that native ID;
- read and ensure the native Forever Box through the preserved coordinator;
- translate native lifecycle state into sanitized OpenBot presentation state;
- correlate Computer frames and actions with the exact bot, box, and lifecycle
  generation;
- hand back or retire only the exact current box when the native contract and
  user action require it.

The bridge may adapt sanitized lifecycle state to existing controller concepts,
but it must not force raw native connection credentials into the generic
remote-app-server contract. The original coordinator path remains authoritative
for Work tools, Computer actions, VNC, and host events.

### Free Local Desktop authority

Free Local Desktop is an app-managed local execution target, not a full virtual
machine or a malicious-code security boundary. It consists of:

- a dedicated desktop page embedded in OpenBot;
- one persistent browser storage partition per top-level bot;
- one private OpenBot workspace per top-level bot;
- one constrained local helper that performs approved filesystem, shell, app,
  and Computer actions;
- one main-process permission broker that owns every grant and prompt.

The local helper runs under the signed-in macOS user's authority. OpenBot must
not claim that it protects the host from malicious commands with VM-strength
isolation. It may use sandbox profiles and process restrictions as defense in
depth, but the permission broker and clear user consent remain authoritative.

Each permission request contains only bounded structured fields identifying the
current bot, requested capability, sanitized resource description, action, and
reason. The prompt offers exactly:

- **Deny**;
- **Allow Once**;
- **Always Allow for This Bot**.

Always-allow grants are keyed to the requesting bot and the narrow resource and
capability. They never apply to every bot. Grants are revocable from the bot's
settings. A renamed bot keeps its immutable grant identity; deleting the bot
deletes its local profile, owned workspace, and grants after explicit
confirmation without deleting user-owned files.

OpenBot may ask macOS for Automation, Accessibility, Screen Recording, camera,
microphone, or selected file/folder access only when an approved action needs
it. The user completes any macOS system prompt or System Settings step. OpenBot
cannot self-grant TCC permissions, install privileged helpers, request root, or
turn Full Disk Access into an implicit per-bot grant.

File and folder access uses explicit user selection and scoped persisted
bookmarks where macOS supports them. App control uses documented macOS
Automation or Accessibility paths and is restricted to the app named in the
grant. The bot's ordinary browser data never reuses the user's normal Chrome or
Safari profile. Accessing a normal browser profile requires a separate explicit
grant and is not part of the free-mode default.

### Provider-neutral inference

The preserved host-inference seam remains the only inference substitution
point. It supplies the selected OpenBot provider while retaining the original
host's tool definitions and execution loop.

The exact selection tuple remains:

`{ botId, provider, model, reasoningEffort, serviceTier, generation }`

Supported provider routes remain fail closed:

- `openai-codex` -> official packaged Codex app-server and ChatGPT account;
- reviewed optional providers -> their explicit pinned transport;
- unknown, disconnected, malformed, or mismatched provider -> unavailable.

The host gives every compatible selected model the same bounded shell,
filesystem, browser, and Computer tool schema. Tool calls are routed only to the
current bot's explicitly selected target: its native Forever Box or its Free
Local Desktop permission broker. Cursor is not asked to choose or run the
reasoning model, and local mode does not replace the selected inference route.

Models that cannot produce the required structured tool calls may still support
Chat, but Work and Computer are disabled for that model. OpenBot never fabricates
tool capability from a model name.

### Bot and subagent ownership

One immutable OpenBot bot ID anchors each top-level bot. Remote mode adds an
immutable native agent ID and box identity; local mode adds an immutable local
desktop profile identity. Model selection, conversation binding, target state,
Computer frames, permission grants, and task events must prove the exact bot,
target kind, target identity, selection epoch, and relevant generation before
any effect becomes visible.

Subagents inherit the parent bot's exact Computer target. Each subagent receives
a bounded task ID and an isolated workspace directory inside that target. A
subagent cannot:

- change the parent bot's selected model tuple;
- access another bot's box, local desktop profile, grants, or workspace;
- replace, reset, hand back, retire, or change the parent's Computer target;
- publish Computer frames as another bot;
- persist its task directory outside the parent bot's native lifecycle policy.

Concurrent subagent operations rely on target-specific task/workspace isolation
and OpenBot's bot/generation fence. If the selected target cannot prove safe
concurrent isolation, OpenBot serializes Computer actions for that bot rather
than provisioning hidden targets or crossing into another bot's resources.

### Account and credential ownership

Cursor sign-in must use the preserved native authentication UI and account
protocol in OpenBot's own user-data profile. OpenBot must not read or import
tokens from Grok Bot, Cursor, ChatGPT, shell profiles, environment variables,
browser storage, or developer files.

Private Cursor values remain inside the native coordinator boundary. Renderer
and public IPC may receive only bounded sanitized fields such as:

- account state: signed out, signing in, ready, unavailable;
- entitlement state: allowed, denied, trial, unknown when the native surface
  exposes it safely;
- bot ID and lifecycle generation;
- box state: starting, ready, reconnecting, sleeping, unavailable;
- whether a current Computer frame is available.

No token, endpoint, query string, account email, tenant, pod, cluster, VNC URL,
gateway value, backend diagnostic, local path, or raw native error may cross the
new public bridge or appear in evidence.

Local permission records contain no passwords, browser cookies, file contents,
shell history, Apple-event payloads, screenshots, or accessibility data. Public
renderer state receives only the target kind, sanitized capability label,
decision scope, and whether a grant exists. Raw bookmark data and system-level
permission state remain in the privileged main-process boundary.

## State transitions and races

Creating a bot preserves the normal setup transaction:

1. create the zero-argument record with the literal name **New Bot**;
2. collect explicit rename/profile and model/provider choices;
3. ask the user to choose **Free Local Desktop**, **Cursor Remote Computer**,
   or **Not Now** without a preselected answer;
4. persist the complete record before enabling Work or Computer;
5. initialize only the selected target.

Selecting an existing bot follows one ordered transaction:

1. resolve the authoritative bot ID, selected target kind, and target identity;
2. advance the selection epoch and clear the prior Computer frame;
3. select the persisted model tuple for that same ID;
4. read current state from the exact selected target;
5. ensure the Forever Box or open the local desktop session as applicable;
6. publish ready only after the returned target identity and current epoch still
   match;
7. enable Work and Computer only after a current frame/tool channel is proven.

Changing provider, model, effort, or speed advances only the model generation.
It does not call ensure, reset, update, hand-back, or retire on the box, and it
does not recreate or transfer the local desktop.

Changing Computer mode is a separate explicit transaction. It cancels current
Computer actions, clears frames before awaiting, advances the target generation,
persists the new choice, and starts only that target. It never copies browser
state, workspaces, grants, credentials, or running processes between local and
remote modes. Failure leaves the requested mode truthfully unavailable rather
than falling back to the previous target without the user's choice.

Late status replies, frames, permission decisions, tool acknowledgements,
account events, model commits, and subagent results are ignored unless bot ID,
target kind, target identity, selection epoch, and relevant generation remain
current. A same-ID successor must never receive a predecessor credential,
grant, frame, task result, or cleanup action.

## Failure behavior

- Free Local Desktop selected: show **Runs on this Mac** and the current bounded
  permission state; never describe it as remote or VM-isolated.
- Local permission denied: fail only the requested action and keep the bot's
  owned local page and workspace available.
- Local macOS permission missing: explain the exact required macOS category and
  provide a user-driven System Settings path; do not loop or self-grant.
- Local helper crash or hang: terminate the exact helper, clear current frames,
  fail the action, and require an explicit bounded retry without changing mode.
- Cursor signed out: show **Connect Cursor for Remote Computer**; Chat remains
  independent and remote Work/Computer stay disabled.
- Entitlement denied: show a truthful sanitized unavailable state; do not retry
  continuously or suggest GitHub/Codex environments.
- Box starting or reconnecting: keep prior frames cleared and controls disabled
  until current readiness is proven.
- Box/host failure: retain the selected inference tuple, fail current Work and
  Computer operations, and allow bounded native retry.
- Model-provider failure: fail only that inference request; do not reset or
  retire the box.
- Cursor account changes during ensure: discard the stale result and re-read
  authoritative native status before any publication.
- Bot switch during an action or permission prompt: cancel or suppress the
  predecessor action/decision and clear the frame before rendering the
  successor.
- App shutdown: dispose public listeners and model transports before allowing
  native hand-back behavior; never retire a successor or another bot's box.
- Unsupported or changed private native protocol: fail closed and block release;
  do not add an unreviewed direct Cursor RPC fallback.

## Privacy, distribution, and legal boundary

The installer and DMG contain no Cursor credentials, OpenAI credentials,
browser profiles, local workspaces, permission grants, security-scoped
bookmarks, box state, tokens, logs, evidence frames, developer paths, or private
account data. Runtime credentials and grants are created only after first
launch in the legitimate account and protected application stores.

OpenBot documentation and privacy copy must disclose that Remote Computer uses
Cursor infrastructure and that model prompts use the selected inference
provider. Computer screenshots, page content, tool arguments, and results may
flow between those two planes as required to execute the user's task.

Documentation must also disclose that Free Local Desktop executes on the user's
Mac under that user's account and may access approved files or applications.
Every prompt identifies whether an action is local or remote. Local grants are
visible and revocable per bot.

Grok Bot's Forever Box interface is a private proprietary service rather than a
documented public third-party SDK. Technical success does not establish a right
to distribute the integration. Public release, notarized DMG placement, and
repository push remain blocked until the project confirms that its use and
redistribution of the preserved native client/service path are permitted.
A local-only release may proceed with Cursor Remote Computer omitted or disabled
if all other release gates pass; it must not pretend the remote feature shipped.

## Test strategy

### Deterministic RED/GREEN coverage

Tests must prove:

- normal New Bot setup retains its existing naming/profile/model flow and asks
  one unselected Computer-mode question;
- immutable bot ID owns exactly one selected target, with native agent ID for
  remote mode and local profile ID for local mode;
- creating, adopting, renaming, and deleting bot profiles do not create a
  second independent runtime identity;
- Cursor signed-out and denied states leave Chat available and never select
  local mode without the user's explicit choice;
- local mode works without Cursor/Grok sign-in and is always labeled local;
- model switching never calls box lifecycle methods or recreates local state;
- mode switching is explicit, clears frames first, and transfers no state;
- OpenAI Codex and optional tool-capable provider fixtures receive the same
  tool schema and exact current local/remote bot binding;
- unsupported models do not receive fabricated Computer capability;
- subagents share the parent target but receive isolated task/workspace IDs;
- local browser partitions, workspaces, permission records, and helper processes
  cannot cross bot boundaries;
- permission prompts expose Deny, Allow Once, and Always Allow for This Bot;
- once grants expire after the action, persistent grants apply only to the exact
  bot/resource/capability, and revocation prevents later use;
- stale, duplicate, accessor/proxy-hostile, oversized, malformed, or wrong-bot
  permission requests and decisions fail before any local effect;
- macOS TCC denial, missing bookmarks, helper crash, helper timeout, bot switch,
  mode switch, deletion, and shutdown release exact resources without granting
  more authority;
- cross-bot, cross-generation, late, duplicate, replayed, and malformed frames
  or acknowledgements are rejected;
- bot switches clear the frame before any awaited operation;
- account/logout, box replacement, model switch, dispose, and shutdown races
  cannot publish stale state or retire a successor;
- public snapshots, errors, events, reports, and DMG contents contain no native
  credential, local bookmark, workspace, browser profile, or personal data.

### Free Local Desktop acceptance

The free-mode live gate uses no Cursor or Grok sign-in. It must:

1. create a temporary top-level bot through the normal setup and explicitly
   choose Free Local Desktop;
2. prove the page says **Runs on this Mac** and uses a verifier-owned browser
   profile and workspace;
3. ask the bot to open its local Chrome surface and navigate to
   `https://www.youtube.com/`, then prove a new current frame;
4. deny a selected normal-file or app action and prove zero side effects;
5. allow a harmless action once and prove the grant cannot be reused;
6. persist a harmless always-allow grant for that bot, prove a second bot cannot
   use it, revoke it, and prove later use is denied;
7. spawn a subagent and prove it shares the parent desktop while using an
   isolated task workspace;
8. switch bots and modes during in-flight actions/prompts and prove stale frames,
   decisions, and effects are suppressed;
9. remove only verifier-owned profiles, workspaces, grants, and test files.

This gate must not open, read, or modify the user's personal browser profile,
Desktop, Documents, application data, or existing files. A separate manually
approved lane covers real normal-app and user-selected-folder access.

### Cursor Remote Computer acceptance

The live gate uses an explicitly signed-in, entitled Cursor account through the
normal OpenBot UI. It must not read credentials from test arguments or the
repository.

The required run must:

1. create two temporary top-level bots and prove distinct native agent and box
   identities;
2. select direct OpenAI Codex for Bot A and ensure its Forever Box;
3. ask Bot A to open Google Chrome and navigate to `https://www.youtube.com/`;
4. prove a new current Bot A Computer frame showing Chrome on YouTube;
5. prove Bot B receives none of Bot A's frames, actions, workspace data, or
   lifecycle events;
6. switch Bot A to another connected tool-capable provider without changing
   its box, then perform a harmless second remote action;
7. spawn a subagent and prove it uses an isolated workspace in Bot A's existing
   box without creating another box;
8. switch between Bot A and Bot B while actions are in flight and prove frame,
   event, and generation isolation;
9. clean up temporary conversations, tasks, profiles, and exact verifier-owned
   resources without retiring a successor or touching personal browser state.

If no optional provider is connected, step 6 remains `BLOCKED` rather than
being simulated. The mandatory direct-Codex, two-bot, Chrome/YouTube, isolation,
privacy, and cleanup assertions still must pass before any remote-VM claim.
Passing Free Local Desktop acceptance does not satisfy or unblock this remote
gate.

## Implementation and release boundaries

Approval of this design authorizes a macOS-only implementation plan and, after
all implementation and release gates pass, integration into the repository's
main branch and publication of the versioned DMG requested by the user. It does
not authorize credential extraction, entitlement bypass, direct private-RPC
reimplementation, account purchase, destructive use of a personal box,
force-push, overwriting collaborators' work, or distributing a proprietary
Cursor integration without the required permission.

Implementation must begin with identity and native-bridge RED tests. It must
preserve the collaborator's Windows files and branches. Every production change
requires focused regressions, the broader macOS suite, exact-source visual
evidence where UI changes, an independent review, and the live acceptance gate
before completion may be claimed.

Integration and release follow this order:

1. implement and commit only on `macos/codex-bot`;
2. fetch and inspect the current remote main and collaborator changes;
3. prove the macOS branch changes only intended macOS-owned or explicitly shared
   files and resolve conflicts without replacing Windows work;
4. run focused, broader macOS, package, privacy, signing, and installed-app
   verification from the exact merge candidate;
5. merge without force and push only after the exact merge commit remains green;
6. build the release from that commit, audit an exact internal allowlist and all
   files for personal/private data, sign with the configured Developer ID,
   notarize, staple, and verify Gatekeeper on a clean install path;
7. upload the exact audited DMG to the repository's correct versioned release
   area with its version, commit, size, and SHA-256.

If repository authentication, signing identity, notarization credentials,
Cursor-distribution permission, tests, privacy audit, or collaborator-safe merge
cannot be proven, the corresponding push or DMG publication remains blocked and
must be reported rather than bypassed.
