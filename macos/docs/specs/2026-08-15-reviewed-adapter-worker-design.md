# Reviewed Remote Adapter Worker Design

**Status:** Approved continuation on `macos/codex-bot`

**Date:** 2026-08-15

**Platform:** macOS controller running Node.js 24.14.1 or newer

**Extends:** `2026-08-15-remote-runtime-live-acceptance-design.md`

## Problem

The live acceptance gate hashes and executes exactly one provider module and
one Computer exercise module. Its in-process `node:vm` context denied direct
`require`, but host-realm globals such as `Buffer` exposed the host `Function`
constructor. Reviewed source could recover `process`, create an unrestricted
`require`, and load an unhashed neighboring file. Removing individual globals
would not close the boundary because host operation inputs and callbacks expose
the same constructor path.

## Decision

Each reviewed adapter executes in its own Node Worker with the Node permission
model enabled and no filesystem, child-process, native-addon, WASI, or nested
worker grants. The worker receives the already-read, SHA-256-verified source as
data, so it needs no filesystem permission. Network access remains available
for the provider's reviewed remote API implementation.

The main thread communicates only through structured-clone messages. It never
passes host objects, functions, prototypes, or callback capabilities into
reviewed source. Abort is represented by an operation ID and recreated as a
worker-local `AbortController`. Provider events and operation results cross the
same clone boundary and are then subjected to the existing strict provider and
exercise validators.

## Components

### Worker bootstrap

`src/bots/reviewed-adapter-worker-source.cjs` exports only an immutable worker
source string. The worker:

- evaluates the exact reviewed source with a throwing CommonJS `require`;
- requires exactly one named factory export;
- validates the factory result's exact method topology;
- opens and validates the provider subscription before reporting ready;
- executes bounded RPC operations and creates worker-local abort signals;
- emits only structured-cloneable results and events;
- unsubscribes and exits on explicit shutdown.

Although reviewed code can recover its worker-local `process`, Node permissions
still deny local/package file reads and process creation. An import attempt,
including `Buffer.constructor(...).getBuiltinModule("node:module")`, therefore
fails before the worker reports ready or before an operation result is
accepted.

### Main-thread proxy

`remote-provider-live-gate.cjs` starts one worker per adapter, performs a
synchronous bounded readiness handshake, and returns objects with the same
public provider/exercise methods already consumed by the gate. RPC replies are
matched by monotonically increasing IDs. Unknown, duplicate, stale, malformed,
or post-shutdown messages fail closed without exposing diagnostics.

The provider proxy buffers at most the existing event-log limit before the
single validated subscriber attaches. Unsubscribe shuts down its worker after
all live-gate cleanup operations have completed. `exercise.dispose()` always
shuts down the exercise worker, including rejected disposal.

## Alternatives rejected

1. **Expand the `node:vm` membrane.** Every host value would need a bespoke
   wrapper, and one missed constructor reopens the host. This is too fragile.
2. **Spawn a general child process.** It provides stronger crash isolation but
   duplicates lifecycle and IPC machinery and conflicts with the verifier's
   explicit no-local-execution audit. A permissioned worker is sufficient for
   the reviewed-module import boundary and preserves the current process model.
3. **Lexically reject dangerous source strings.** Computed property names and
   equivalent language forms make a denylist non-enforceable.

## Failure behavior

Startup, permission, topology, serialization, protocol, timeout, or worker exit
failures are mapped to the existing sanitized
`REMOTE_PROVIDER_GATE_BLOCKED` loader result. Runtime RPC failures are mapped by
the existing provider/exercise validators to sanitized gate failure. No worker
stack, source path, credential, endpoint, or provider diagnostic is public.

## Verification

The existing exact-byte test must reject direct `require`, `createRequire`,
`process.getBuiltinModule`, and the host-constructor escape while continuing to
load a valid single-file provider and exercise. Additional tests cover abort
propagation, early provider events, malformed/duplicate RPC replies, worker
shutdown, permission denial, and no filesystem side effects. The focused live
gate suites, broad macOS test suite, syntax checks, diff checks, privacy scan,
and independent review must pass before the real provider gate is attempted.

The real gate remains separate: it must provision two isolated remote runtimes
and use the selected bot's remote Chrome to open `https://www.youtube.com/`.
No local Chrome, local VM, SSH, cloud-task substitute, or silent fallback can
satisfy that acceptance step.
