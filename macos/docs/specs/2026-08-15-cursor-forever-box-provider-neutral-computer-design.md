# OpenBot Cursor Forever Box Provider-Neutral Computer Design

**Status:** Proposed for written review on `macos/codex-bot`

**Date:** 2026-08-15

**Platform:** macOS Apple Silicon only

**Extends:**

- `2026-08-14-macos-direct-codex-power-control-design.md`
- `2026-08-15-remote-runtime-live-acceptance-design.md`

## Decision

OpenBot will preserve Grok Bot 0.20's native Cursor-backed Forever Box as the
remote Computer and Work execution plane. Cursor authentication is required
only for that remote-computer plane. OpenAI Codex and reviewed optional model
providers remain the inference plane. Switching inference providers never
changes, recreates, or transfers the selected bot's remote computer.

Users do not connect GitHub, create a Codex Cloud environment, configure a
generic VM provider, or host an OpenBot VM service. OpenBot must use Cursor's
legitimate native account and entitlement flow. It must not extract credentials
from another application, copy another application's profile, bypass an
entitlement decision, emulate private backend grants, or embed credentials in
the application or installer.

Each top-level OpenBot bot owns one native agent identity and one corresponding
Forever Box identity. Subagents spawned by that bot share the parent bot's box
and use native task/workspace isolation inside it. A subagent does not provision
another box unless the user explicitly creates another top-level bot.

This design supersedes the generic external-provider choice in
`2026-08-15-remote-runtime-live-acceptance-design.md`. Its lifecycle, privacy,
two-bot isolation, YouTube exercise, cleanup, signing, notarization, and release
gates remain mandatory.

## User-visible contract

OpenBot exposes two independent account surfaces:

- **Models:** OpenAI Codex uses the official ChatGPT/Codex account path.
  Reviewed optional providers use their explicit optional connection paths.
- **Remote Computer:** Cursor sign-in enables the native Forever Box path.

The UI must say that Cursor powers Remote Computer. It must not imply that
Cursor supplies OpenAI, Fable, Claude, Kimi, or other model inference. It must
not call the box an OpenAI VM, a model-owned VM, a Codex Cloud environment, or
an OpenBot-hosted VM.

Without Cursor authentication or entitlement:

- Chat and direct inference may remain available;
- Work and Computer remain unavailable;
- Retry may re-check account and box state;
- no operation runs on the Mac, Codex Cloud, Docker, a local VM, SSH, or an
  unreviewed provider.

When Cursor authentication and entitlement are available, creating or selecting
a top-level bot ensures that exact bot's Forever Box. Model switching preserves
the box's filesystem, Chrome profile, open windows, and current lifecycle state.

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

### Native computer authority

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
filesystem, browser, and Computer tool surface. Tool calls are routed to the
current bot's native Forever Box. Cursor is not asked to choose or run the
reasoning model.

Models that cannot produce the required structured tool calls may still support
Chat, but Work and Computer are disabled for that model. OpenBot never fabricates
tool capability from a model name.

### Bot and subagent ownership

One immutable native agent ID anchors each top-level bot. Model selection,
conversation binding, box status, Computer frames, and task events must all
prove that exact ID plus the current generation before any effect becomes
visible.

Subagents inherit the parent bot's exact runtime lease. Each subagent receives a
bounded task ID and an isolated native workspace directory. A subagent cannot:

- change the parent bot's selected model tuple;
- access another bot's box or workspace;
- replace, reset, hand back, or retire the parent box;
- publish Computer frames as another bot;
- persist its task directory outside the parent bot's native lifecycle policy.

Concurrent subagent operations rely on the native host's task/workspace
isolation and OpenBot's bot/generation fence. If the native host cannot prove
safe concurrent isolation, OpenBot serializes Computer actions for that bot
rather than provisioning hidden boxes or using the Mac.

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

## State transitions and races

Selecting a bot follows one ordered transaction:

1. resolve the authoritative native agent ID;
2. advance the selection epoch and clear the prior Computer frame;
3. select the persisted model tuple for that same ID;
4. read current native box status;
5. ensure the box when account and entitlement allow it;
6. publish ready only after the returned native identity and current epoch
   still match;
7. enable Work and Computer only after a current frame/tool channel is proven.

Changing provider, model, effort, or speed advances only the model generation.
It does not call ensure, reset, update, hand-back, or retire on the box.

Late status replies, frames, tool acknowledgements, account events, model
commits, and subagent results are ignored unless bot ID, native agent ID, box
identity, selection epoch, and relevant generation remain current. A same-ID
successor must never receive a predecessor credential, frame, task result, or
cleanup action.

## Failure behavior

- Cursor signed out: show **Connect Cursor for Remote Computer**; Chat remains
  independent and Work/Computer stay disabled.
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
- Bot switch during an action: cancel or suppress the predecessor action and
  clear the frame before rendering the successor.
- App shutdown: dispose public listeners and model transports before allowing
  native hand-back behavior; never retire a successor or another bot's box.
- Unsupported or changed private native protocol: fail closed and block release;
  do not add an unreviewed direct Cursor RPC fallback.

## Privacy, distribution, and legal boundary

The installer and DMG contain no Cursor credentials, OpenAI credentials,
browser profiles, box state, tokens, logs, evidence frames, developer paths, or
private account data. Runtime credentials stay in the legitimate account and
native coordinator stores used by the installed application.

OpenBot documentation and privacy copy must disclose that Remote Computer uses
Cursor infrastructure and that model prompts use the selected inference
provider. Computer screenshots, page content, tool arguments, and results may
flow between those two planes as required to execute the user's task.

Grok Bot's Forever Box interface is a private proprietary service rather than a
documented public third-party SDK. Technical success does not establish a right
to distribute the integration. Public release, notarized DMG placement, and
repository push remain blocked until the project confirms that its use and
redistribution of the preserved native client/service path are permitted.

## Test strategy

### Deterministic RED/GREEN coverage

Tests must prove:

- native agent ID is the single bot/box identity;
- creating, adopting, renaming, and deleting bot profiles do not create a
  second independent runtime identity;
- Cursor signed-out and denied states leave Chat available but disable
  Work/Computer without local fallback;
- model switching never calls box lifecycle methods;
- OpenAI Codex and optional tool-capable provider fixtures receive the same
  remote tool surface and current bot binding;
- unsupported models do not receive fabricated Computer capability;
- subagents share the parent box but receive isolated task/workspace IDs;
- cross-bot, cross-generation, late, duplicate, replayed, and malformed frames
  or acknowledgements are rejected;
- bot switches clear the frame before any awaited operation;
- account/logout, box replacement, model switch, dispose, and shutdown races
  cannot publish stale state or retire a successor;
- public snapshots, errors, events, reports, and DMG contents contain no native
  credential or personal data.

### Live acceptance

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
privacy, and cleanup assertions still must pass before any VM claim.

## Implementation and release boundaries

Approval of this design authorizes a macOS-only implementation plan. It does
not authorize credential extraction, entitlement bypass, direct private-RPC
reimplementation, package installation, account purchase, destructive use of a
personal box, notarization submission, DMG publication, GitHub authorization,
release upload, or push.

Implementation must begin with identity and native-bridge RED tests. It must
preserve the collaborator's Windows files and branches. Every production change
requires focused regressions, the broader macOS suite, exact-source visual
evidence where UI changes, an independent review, and the live acceptance gate
before completion may be claimed.
