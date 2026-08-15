# Codex Bot macOS Remote Runtime Live Acceptance Design

**Status:** Proposed for review on `macos/codex-bot`

**Date:** 2026-08-15

**Platform:** macOS Apple Silicon controller; provider runtime must be remote

**Extends:**
`2026-08-14-macos-direct-codex-power-control-design.md`

## Decision

Codex Bot will not claim that bot VMs work until a real configured provider
passes a destructive, two-bot live acceptance gate. The gate proves that every
temporary bot owns an isolated remote runtime, that Work and Computer traffic
remain scoped to the current bot and generation, and that teardown retires all
created resources.

The required user-visible exercise is deliberately small: the selected bot
must use its own remote Computer to open Google Chrome and navigate to
`https://www.youtube.com/`. A bot-scoped Computer frame must prove that Chrome
is showing YouTube. The Mac's local Chrome, a local VM, SSH, a Codex cloud task,
or any silent local fallback cannot satisfy this gate. The exercise does not
sign in to YouTube, play media, search, submit forms, or use an existing browser
profile.

This verifier does not choose, purchase, or provision a cloud provider by
itself. Until an actual provider module and its credentials are configured,
the live gate reports `BLOCKED`, and packaging, signing, notarization, release,
and push remain separate later decisions.

## Existing provider boundary

The production controller already consumes a generic provider contract:

- `capabilities()`;
- `provision({ botId, idempotencyKey })`;
- `inspect({ runtimeId })`;
- `retire({ runtimeId })`;
- `subscribe(callback)`.

A successful provision result supplies a provider name, runtime ID, exact
owner bot ID, remote `wss:` endpoint, private auth token, and runtime state.
These values remain main-process private. Renderer events and saved evidence
must never contain the endpoint, token, provider diagnostics, account identity,
developer paths, or provider credentials.

The generic contract proves lifecycle and app-server ownership. A separately
reviewed provider exercise adapter is required to request a remote Computer
action and correlate its acknowledgement with the same runtime. That adapter
must execute through the provisioned remote runtime; it cannot call macOS
Chrome, AppleScript, local browser automation, a local hypervisor, or SSH.

## Live gate architecture

### Gate runner

`macos/scripts/verify-remote-provider.cjs` will be an explicit live command,
not part of ordinary unit tests or application startup. It will:

1. load an absolute provider module only when its private regular-file bytes
   match the configured SHA-256 and execute those exact bytes without local or
   package-file imports;
2. load its separately hashed reviewed Computer exercise adapter under the
   same single-file rule;
3. create two fresh temporary canonical bot UUIDs;
4. subscribe before provisioning so early lifecycle events are not lost;
5. run the exact lifecycle, protocol, isolation, exercise, and cleanup checks;
6. write a sanitized machine-readable and human-readable result;
7. retire every created runtime in `finally`, including timeout, cancellation,
   protocol failure, and assertion failure paths.

The command accepts credentials only through the provider's reviewed Keychain
or environment-variable mechanism. Credentials are never accepted in command
arguments, written into the repository, embedded in reports, or requested in
chat.

### Provider exercise adapter

The exercise adapter receives an opaque current-runtime handle rather than raw
provider secrets. Its narrow operation is equivalent to:

`openRemoteUrl({ actionId, botId, runtimeId, generation, url })`

It must return a bounded acknowledgement tied to the same opaque action, bot,
runtime, and generation. Success still requires the controller's normal scoped
Computer event path with that action ID and a new SHA-256 frame digest; the
acknowledgement alone is not proof that the browser opened.
The adapter is provider-specific because the generic lifecycle contract does
not define mouse, keyboard, browser, or Computer RPCs.

### Evidence collector

The collector records only sanitized fields:

- gate status and timestamps;
- provider display name;
- temporary bot IDs;
- non-secret, shortened runtime fingerprints;
- capability booleans and observed lifecycle states;
- remote initialize/account/catalog success booleans and model count;
- whether the remote action was acknowledged;
- observed browser name and `youtube.com` host/title evidence;
- exact bot/runtime/generation frame correlation;
- cross-bot isolation result;
- retirement and final-inspection result.

An optional screenshot may be retained only when it shows the signed-out
YouTube landing page, contains no account identity, cookies, notifications,
history, bookmarks, developer paths, or other personal content, and passes the
release privacy scan. Raw frames, WebSocket URLs, tokens, account details, and
provider responses are otherwise discarded.

## Required acceptance sequence

### Preflight

1. Confirm the provider and exercise modules are absolute, regular, private,
   reviewed single-file bundles whose bytes match separately configured
   SHA-256 values and whose exports are exact.
2. Confirm the provider advertises provision, inspect, retire, events, remote
   app-server, and Computer/browser capabilities.
3. Reject `file:`, `http:`, local socket, loopback, link-local, private-network,
   or non-`wss:` runtime endpoints.
4. Confirm no local fallback callback or local VM/browser launcher is present.
5. Subscribe to lifecycle and Computer events before creating resources.

### Two-bot lifecycle and protocol proof

1. Provision Bot A and Bot B using independent idempotency keys of the form
   `codex-bot:<botId>`.
2. Require distinct runtime IDs and distinct remote endpoints.
3. Inspect both runtimes and require exact owner bot IDs and ready state.
4. Connect each through the production remote app-server client.
5. Complete `initialize` / `initialized`, `account/read`, and paginated
   `model/list` for each runtime.
6. Require the client-visible provider/runtime/generation tuple to match the
   authoritative controller tuple without exposing endpoint or token fields.

### Chrome to YouTube Computer proof

1. Select Bot A and capture its current runtime ID and generation once.
2. Submit the small remote task: "Open Google Chrome and navigate to
   https://www.youtube.com/."
3. Require the provider exercise acknowledgement to match Bot A, its runtime,
   and that exact generation.
4. Require a current bot-scoped Computer frame from Bot A showing Google Chrome
   with `youtube.com` as the active host and a YouTube page/title marker.
5. Reject a missing, stale, unscoped, malformed, cross-runtime, cross-generation,
   cross-bot, cached, or replayed frame.
6. Require Bot B to receive none of Bot A's frame, endpoint, session, or task
   events. Bot B must remain independently ready and usable.
7. Record that local macOS Chrome state was neither used as evidence nor
   intentionally changed by the verifier.
8. Do not log in, accept account prompts, play a video, search, click content,
   import a profile, or persist browser history beyond the disposable runtime.

The gate may repeat the harmless navigation on Bot B with a different public
landing page when a provider needs symmetric proof, but it may not weaken the
required Bot A YouTube assertion.

### Cleanup proof

1. Stop remote clients and unsubscribe from provider events.
2. Retire both exact runtime IDs, even if an earlier assertion failed.
3. Inspect until each runtime is terminal, absent, or authoritatively detached.
4. Require no remaining endpoint, session, owner, generation, timer, listener,
   child process, provider event, or temporary bot record in Codex Bot.
5. Remove only verifier-owned temporary files and redact reports before they
   leave the private temporary directory.

## Fail-closed and adversarial requirements

The implementation must have deterministic RED/GREEN coverage for:

- missing provider, credentials, or exercise adapter -> `BLOCKED`;
- malformed, proxy-backed, accessor-backed, oversized, or extra provider data;
- two bots receiving the same runtime, endpoint, owner, token, or event stream;
- owner mismatch and runtime replacement during any awaited operation;
- early, late, duplicated, reordered, stale, or post-retirement events;
- malformed, stale, cached, or cross-bot Computer frames;
- a provider claiming success without a correlated current frame;
- any attempt to invoke local Chrome, a local VM, SSH, or local browser tools;
- endpoint, token, account, path, or provider-diagnostic leakage in reports;
- timeout, cancellation, disposal, partial provisioning, and failed retirement;
- cleanup after every failure boundary without retiring a successor runtime.

The live gate returns exactly one of:

- `PASS`: every lifecycle, protocol, YouTube, isolation, privacy, and cleanup
  assertion succeeded;
- `BLOCKED`: no reviewed real provider/credentials are configured;
- `FAIL`: a configured provider violated the contract or an assertion failed.

`BLOCKED` and `FAIL` cannot be converted into success by local simulation,
fixture results, a unit-test provider, screenshots from the Mac, or a manually
opened browser.

## Test and release boundaries

Unit and adversarial tests use in-memory providers and sockets. They prove the
runner's validator, receipt correlation, timeout behavior, report redaction,
two-bot isolation, and cleanup logic, but they are never called live VM proof.

A real-provider run is a separate acceptance lane. Its sanitized report must be
reviewed before any claim that bot VMs work. Only a `PASS` may unblock later
release verification. Apple Developer ID signing, notarization, final clean DMG
construction, installation testing, release placement, and pushing the isolated
macOS branch each remain explicit subsequent gates and require the relevant
credentials and approvals. No Windows files or the collaborator's Windows
branch are touched by this design.

## Implementation scope after approval

The expected macOS-only implementation boundary is:

- `macos/scripts/verify-remote-provider.cjs`;
- `macos/test/remote-provider-live-gate.test.cjs`;
- a provider exercise adapter supplied by the selected reviewed provider;
- ignored temporary evidence under a verifier-owned directory.

Production controller changes are allowed only if the live tests expose a
generic contract gap. They require their own RED, focused regression suite, and
independent review. No provider package, account, VM purchase, credential
creation, DMG, install, notarization, release upload, or push is authorized by
approving this design alone.
