# Signed-Out Local Routines for the Native Grok Shell

## Status

Approved product direction: local Routines use the exact Grok Bot 0.20 renderer and work while the OpenBot process is running, including when its windows are closed. Explicitly quitting OpenBot stops scheduling. App-closed background execution is a separate future helper design.

## Goal

Make the native Grok 0.20 Routines surface functional when Cursor/Grok is signed out. A Routine runs through the bot's existing OpenBot model selection, so Direct Codex and CLIProxy models continue to work. Cursor Remote VM / Forever Box remains unavailable and no local operation is presented as a remote one.

This slice must not replace, clone, or restyle the vendor renderer. It adapts the existing coordinator protocol and current OpenBot conversation runtime.

## User-visible contract

- The stock Routines list, create, edit, enable, delete, run-now, run-history, and status UI remains authoritative.
- Local cron Routines work while the OpenBot process is alive. Closing every window does not stop them; choosing Quit does.
- Schedules and run history survive an app restart.
- After restart, an enabled Routine that missed one or more occurrences may run once immediately. It never replays an unbounded backlog.
- A Routine never overlaps with another run of itself. A due occurrence while it is already running is coalesced into the existing run.
- Each run sends the Routine prompt through that bot's current per-bot model selection and the durable standalone conversation system.
- Direct Codex and CLIProxy remain usable while Cursor is signed out.
- Remote VM / Forever Box, remote event connectors, and remote-only actions remain truthfully unavailable.
- Errors are visible as terminal error runs with sanitized details; scheduler failures do not crash the app or disable unrelated bots.

## Scope

### Included

- Native automation RPCs:
  - `getAgentAutomations`
  - `listAllAutomations`
  - `createAgentAutomation`
  - `updateAgentAutomation`
  - `setAgentAutomationEnabled`
  - `deleteAgentAutomation`
  - `runAgentAutomationNow`
- Cron triggers using five-field cron syntax, the standard aliases `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, and `@annually`, plus `@every N[s|m|h|d]`.
- Optional `CRON_TZ=` or `TZ=` prefixes backed by an IANA time-zone name accepted by `Intl.DateTimeFormat`.
- Durable local storage, restart recovery, deletion cleanup, protocol events, package closure, and tests.

### Deferred

- Running after an explicit application Quit through a LaunchAgent or background helper.
- Slack, GitHub, Microsoft Teams, Linear, Sentry, PagerDuty, or group-listener triggers.
- General workflow import/export, local-skill porting, plugin publishing, and Cursor-account features.
- MCP/plugin execution inside Direct Codex. The current direct lane continues to disable unreviewed MCP and recursive tool surfaces.
- Any mapping between Free Local Desktop and Forever Box.

Unsupported mutations fail with Grok's exact capability-unavailable classification rather than reporting false success.

## Architecture

### 1. Local cron schedule module

`src/desktop/local-cron-schedule.cjs` is a pure parser and next-occurrence calculator. It has no timers or persistence.

It:

- validates and normalizes supported expressions;
- computes the first due time strictly after an input timestamp;
- applies time-zone conversion deterministically, including daylight-saving transitions;
- rejects impossible or unsupported expressions with a sanitized automation error;
- enforces bounded search so hostile schedules cannot consume unbounded CPU;
- exposes no vendor, account, or filesystem state.

Five-field expressions support `*`, comma lists, numeric ranges, and `/step` forms within the normal minute, hour, day-of-month, month, and day-of-week ranges. Day-of-month and day-of-week use standard cron OR semantics when both are restricted.

### 2. Durable automation store

`src/desktop/local-automation-store.cjs` owns a private schema-v1 JSON file under the existing OpenBot private state root.

The store uses the repository's existing signed native filesystem helper as the durability boundary. Node opens the already-existing private state directory with `O_DIRECTORY | O_NOFOLLOW`, validates the opened descriptor and the current pathname identity, and passes that exact directory descriptor to the helper as child fd 3. Every state-file lookup, read, sibling temporary-file creation, file sync, atomic replacement, and directory sync is then relative to fd 3 with `openat`/`fstatat`/`renameatx_np`; no post-validation absolute pathname is used by the helper. The helper retains its existing exclusive profile-publication invocation unchanged and adds bounded, versioned `--state-read-v1` and `--state-write-v1` subcommands. Symlinked, substituted, foreign-owned, or non-private roots/files fail closed before content is returned or a replacement path can be touched.

Each private record contains:

- public automation fields;
- its normalized schedule;
- at most 20 newest-first run records;
- a private durable conversation ID, when established;
- scheduler bookkeeping needed for the next due time and bounded catch-up;
- a revision used for compare-and-set updates.

Limits:

- at most 50 Routines per bot;
- at most 100 records in a returned aggregate slice;
- at most 20 runs per Routine;
- names trimmed and bounded to 80 Unicode characters;
- prompts, trigger strings, IDs, arrays, and total file size are explicitly bounded;
- unknown, accessor, proxy, cyclic, and prototype-polluted input is rejected before traversal.

The store exposes list/create/update/set-enabled/delete, append-or-update-run, bind-conversation, and `deleteBots` operations. All mutations are serialized and atomic. Public projections never expose private paths or bookkeeping.

### 3. Local automation controller

`src/desktop/local-automation-controller.cjs` owns scheduling and execution. It depends only on the store, the existing standalone conversation controller, and injected clock/timer functions.

It maintains one earliest-due timer for all enabled local Routines. Long delays are re-armed within the platform timer limit. Every timer callback re-reads durable state before claiming a run.

Run sequence:

1. Claim the Routine revision and persist a `running` run record before external work.
2. Reuse its exact durable conversation when it still belongs to the same bot; otherwise create one and atomically bind it.
3. Call `StandaloneConversationController.send` with the bot, conversation, and Routine prompt.
4. Persist the accepted invocation identity.
5. Listen for the exact invocation's `completed`, `failed`, or `cancelled` event and persist one terminal `ok` or `error` result.
6. For `runAgentAutomationNow`, await that terminal persistence and final publication before returning `undefined`, matching Grok 0.20. Scheduled timer dispatch remains asynchronous to the scheduler loop.
7. Broadcast updated automation and workflow projections through the native coordinator.

Only one claimed run per automation may exist. Duplicate timers, repeated manual clicks, and schedule/manual races coalesce. Other bots and other Routines remain independent.

If sending fails before acceptance, the claimed run becomes a sanitized terminal error. If the app restarts with a `running` record, startup first marks it as interrupted, then independently evaluates whether one missed scheduled occurrence should be caught up.

### 4. Native coordinator adapter

`OpenBotNativeCoordinator` delegates the seven native automation methods to the local controller and retains the exact Grok 0.20 request and reply shapes.

Public automation records include:

```js
{
  id, name, prompt, trigger, schedule, triggerDescription,
  isEnabled, provenance, createdAt, lastRunAt,
  nextRunAt, runs, filePath
}
```

`filePath` is a non-sensitive logical local marker rather than a private filesystem path. Lists are sorted by next run and then creation time; runs are newest first.

Every committed change emits:

```js
{ kind: "event", family: "agents-automation", payload: { agentId, automations } }
```

The coordinator also emits the native `agents-workflow` projection for schedule-backed workflow rows so the existing Routines surfaces remain coherent. Stale async reads and events are fenced by per-bot automation revisions and native bot-deletion epochs.

### 5. Runtime and deletion composition

Runtime construction creates the store/controller after the durable conversation controller is available. Automation startup waits for bot-deletion replay readiness before scheduling or accepting native automation mutations.

Shutdown ordering is:

1. close native automation ingress;
2. dispose the automation controller, cancel timers, and await owned run bookkeeping;
3. dispose conversation, model, computer, provider, and bot-runtime owners through the existing phased shutdown.

Bot deletion invokes automation `deleteBots` after the canonical BotStore tombstone is durable and before standalone conversations are purged. This permanently fences target schedulers, waits exact target run bookkeeping, removes their private automation records, and keeps unrelated bot timers live. Startup tombstone replay repeats the same idempotent cleanup.

## Failure and recovery rules

- No durable automation mutation is reported successful before its atomic store commit.
- Once a commit is authoritative, a later publication/read failure does not turn it into a false failed mutation; the current state is re-read and republished when possible.
- Store durability-uncertain results are resolved by bounded read-back of the exact revision.
- A failed run never disables its Routine automatically.
- Invalid schedules are rejected during create/update and are never installed into the timer heap.
- One bad or unavailable bot does not block timers for other bots.
- Deleting a bot dominates late timers, conversation events, store reads, and native publications.
- Disposing the app dominates late timer and conversation events and publishes nothing afterward.
- Cursor auth changes do not rewrite or migrate local Routines. They remain scoped to the OpenBot bot ID and its local model selection.

## Testing strategy

Development is strict RED-to-GREEN TDD.

### Cron tests

- every supported alias and `@every` unit;
- lists, ranges, steps, day-of-month/day-of-week semantics;
- invalid values, impossible expressions, oversized/proxy/accessor inputs;
- time zones, spring-forward, fall-back, month/year boundaries;
- bounded next-occurrence search.

### Store tests

- atomic CRUD, ordering, caps, run-history truncation, restart read-back;
- fsync/rename/directory-sync failures and authoritative read-back;
- private-root/symlink/permission checks;
- bot deletion, retry, idempotency, and hostile DTOs.

### Controller tests

- one earliest timer and long-delay rearming;
- manual and scheduled Direct Codex/CLIProxy send paths;
- exact invocation terminal matching;
- no overlap, duplicate-fire coalescing, one missed-run catch-up;
- interrupted-run recovery;
- send/create/read failures;
- delete, dispose, and late-event races;
- unrelated bot isolation.

### Native/runtime/package tests

- exact Grok request/reply DTOs and event families;
- signed-out Cursor plus ready Direct Codex and CLIProxy paths;
- native create/edit/enable/delete/run-now behavior with no custom renderer;
- remote VM remains null/unavailable and no remote provider call occurs;
- startup deletion gate and phased shutdown;
- package manifest, mutation closure, installer source closure, syntax, and diff checks.

Before the implementation commit is pushed, run the focused suites, the full macOS suite, `npm run check`, package closure tests, and an independent frozen-diff review. A staged/live native Routines walkthrough remains a separate acceptance lane after source and package verification.

## Acceptance criteria

The slice is complete when:

1. a signed-out Cursor user can create a cron Routine in the stock Grok UI;
2. the Routine persists, appears after restart, and can be edited/enabled/deleted;
3. Run Now starts one Direct Codex or CLIProxy conversation turn using that bot's current selection;
4. scheduled execution works while OpenBot is alive, including with all windows closed;
5. run history reaches a truthful terminal result and is visible through native data refresh/events;
6. no duplicate, late, deleted-bot, or post-dispose run can publish;
7. Forever Box and remote event connectors remain unavailable without fallback;
8. focused, full, package, and independent review gates are green.
