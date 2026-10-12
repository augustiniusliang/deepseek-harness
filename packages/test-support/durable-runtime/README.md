---
description: "Fault-injection test facility that SIGKILLs a real headless dsh host at named durability checkpoints and reads back the surviving ledger and session-log evidence, for repository durability tests."
kind: "package-library"
---

# @deepseek-ai/dsh-durable-runtime

English | [中文](README.zh.md)

## Summary

Use `dsh-durable-runtime` to characterize what survives a hard kill between two durability points of a headless dsh run. A fixture plugin inside the host reads a control file, appends a hit record to an fsynced ledger, and SIGKILLs itself when a named checkpoint fires; the test process then asserts on the two independent evidence streams that survived — the fixture ledger and the session JSONL logs. The controller library creates isolated per-test runtimes, spawns and restarts hosts through the shared dual-mode launcher, and converges orphan processes at teardown. This support-tier library is for repository durability tests, not product integrations.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

One test creates a runtime, optionally arms a failpoint, spawns a host with a fixture-protocol prompt, and asserts on durable evidence:

```text
const runtime = await createDurableTestRuntime()
await armFailpoint(runtime, { name: 'model-settled', once: true })
const host = spawnDurableHost(runtime, { prompt: 'EFFECT:x' })
const result = await host.result            // killed at the checkpoint
await expectFailpointHit(runtime, 'model-settled')
await expectSideEffectCount(runtime, 'tool-effect', 0)
await runtime.dispose()                     // after teardownDurableHosts()
```

Restart is a second `spawnDurableHost` against the same runtime; resuming the crashed session uses `sessionId` (headless `--session-id`). Prompts select the deterministic protocol: `ECHO:<text>` answers `<text>`, `EFFECT:<name>` runs one `durable_effect` call and answers `DONE:<name>`, `PARALLEL:A:<delayMs>:B:<delayMs>` runs two `durable_effect` calls and answers `DONE:PARALLEL`.

The legacy `PARALLEL` protocol uses exclusive calls. `BARRIER` declares concurrency-safe calls and holds A until B has returned and its promise reactions have run, without timing delays. `createDurableTestRuntime({ schedule: true })` mounts real Schedule, Session controller, workspace, upload and Connection services without a Web server. `SCHEDULE` creates a reminder and waits for its task receipt; a fresh foreground `SCHEDULE:resume` run waits while Schedule restores the original Session. Do not also pass that target's `sessionId`: two restorers would compete for its write handle.

### Failpoint checkpoints

The checkpoint names are the facility's public API. `match.tool` compares against the `durable_effect` call's `name` argument.

| Failpoint | Real seam | Fires |
|---|---|---|
| `input-accepted` | `session/event` (`user/message`) + awaited `SessionStore.flush` barrier | After the user message is durably flushed |
| `input-claimed` | `session/event` (`agent/inbox/spliced` with `removedCount > 0`) | When the loop claims input, before any durability acknowledgement |
| `model-settled` | fixture LLM adapter, after the final chunk, before `stream()` returns | Before the loop commits the settled response |
| `dispatch-intent` | `tools/pre-execute` waterfall (listener calls `next()`) | Before the fixture tool body runs |
| `external-effect` | inside the `durable_effect` body, after its fsynced ledger write | Before the tool returns |
| `tool-settled` | Next event-loop turn after barrier B returns | While A remains blocked, before ordered result publication |
| `schedule-flushed` | Wrapped real `SessionStore.flush` | After delivery is durable, before the caller writes the task receipt |
| `receipt-stored` | `session/event` (`tool/result`) + awaited flush barrier | After the tool result is durably flushed |
| `outbox-delivered` | `session/event` (`team/message/delivered`) + awaited flush barrier | After an Agent Teams delivery is durably flushed; needs the agent-team bundle via `profileExtras`, which the built-in protocol does not drive |

On a hit the fixture deletes a `once` control file, appends `{kind:'failpoint-hit', detail:{name}}` with an fsync, then `process.kill(process.pid, 'SIGKILL')` — synchronously where the seam allows, so no later host code can add evidence.

### Evidence streams

The ledger at `<runtime>/ledger/effects.jsonl` is append-only; every row is written with open-write-fsync-close, so a row the test reads survived the kill. Kinds: `model-request` (every adapter invocation), `tool-effect` (the external side effect), `failpoint-hit`. Session JSONL logs live under `<runtime>/home/sessions` (uncompressed, per the generated profile); `readSessionLogFiles` plus the `toolCalls` / `toolResultCallIds` / `inboxClaimCount` / `hasUnclosedTurn` reducers answer what durably happened. Durable logs never contain interrupted-turn closers; a resuming reader derives them (`interruptedTurnClosers` in `@deepseek-ai/dsh-session`), and a resumed run persists the repair rows.

Barrier evidence adds `tool-started` and `tool-settled`; Schedule evidence adds `schedule-delivered` after inbox durability and `schedule-committed` after the task receipt, distinguishing overlap, body return and acknowledgement.

### Platform notes

Windows emulates the fixture's self-SIGKILL with `TerminateProcess`: a failpoint-killed host reports exit code 1 and no signal there, while a controller kill through execa reports signal `SIGKILL` on every platform — assert through the evidence (`expectFailpointHit`) plus the process shape, as `tests/helpers.ts` does. The WSL/Linux path is identical: the same `process.kill` self-SIGKILL and the same execa `killSignal: 'SIGKILL'` deadline.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

The fixture (`fixtures/durable-fixture.mjs`, plain ESM loaded by absolute file URL, the Agent Teams team-llm pattern) registers `DurableFixtureAdapter` on the `deepseek-official` route, the `durable_effect` tool, and the checkpoint listeners; the generated profile disables `llm-deepseek` and `session-title-llm` (a title request would spend a second deterministic model request) and pins JSONL persistence to the runtime. The controller never touches in-host state: control is the control file, evidence is the ledger and the logs. Host launch goes through `resolveExampleLaunch` (`@deepseek-ai/dsh-loader-smoke`), so `DSH_EXAMPLE_MODE=lib` boots the built CLI exactly as CI does. `DURABLE_RUNTIME_BASE` relocates the mkdtemp parent. `spawnDurableHost` tracks every live host in a module registry; `teardownDurableHosts` SIGKILLs survivors and `expectNoOrphanHosts` probes recorded pids with `process.kill(pid, 0)`.

### Source map

| File | Role |
|---|---|
| [`src/runtime.ts`](src/runtime.ts) | `createDurableTestRuntime`: isolated layout and the generated headless profile |
| [`src/host.ts`](src/host.ts) | `spawnDurableHost`, kill/truthful-kill handles, orphan registry, `--json` session-id reader |
| [`src/ledger.ts`](src/ledger.ts) | Ledger reader and the count/hit assertions that must fail a test |
| [`src/failpoint.ts`](src/failpoint.ts) | Atomic (tmp+rename) control-file arm/disarm |
| [`src/session-log.ts`](src/session-log.ts) | Session JSONL reader and event reducers |
| [`fixtures/durable-fixture.mjs`](fixtures/durable-fixture.mjs) | In-host failpoint plugin: adapter, tool, checkpoints, ledger |
| — | No runtime invariant companion is published; this test-support package owns no production event stream or mutable data — its checks are the consuming specs themselves. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [loader-smoke](../loader-smoke/README.md) — the dual-mode launcher and subprocess harness this package builds on.
- [Session package](../../core/session/README.md) — `session/event` / `session/flush` semantics behind the flush-barrier checkpoints.
- [Schedule package](../../schedule/schedule/README.md) — persistence and Session controller requirements for reminder delivery.
- [Testing policy](../../../docs/testing.md) — subprocess launch modes and resource-ownership rules.
- [Test-support group map](../README.md) — sibling harnesses.

-----

<a id="model-experience"></a>
## Model Experience

### Fixture tool `durable_effect`

#### What the model sees

One extra tool in spawned-host requests: name `durable_effect`, description "Record one named external side effect in the durable fixture ledger, optionally after a delay.", parameters `name` (required string) and `delayMs` (optional number). The deterministic adapter, not a real model, consumes it.

#### Token effect

Fixed conditional cost: one small tool entry in requests of hosts spawned by this facility, present only in those test compositions.

#### KV Cache effect

Independent behavior: the fixture adapter answers every request from the protocol key and reuses no provider cache; the tool entry changes the request prefix only inside spawned test hosts.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Schedule composition is opt-in** — the standard headless bundle omits its dependencies. The fixture's `schedule: true` option supplies them and restores its flush wrapper on disposal. This tests real services, not browser controls.
- **`outbox-delivered` has no driving protocol** — the checkpoint listens for the agent-team `team/message/delivered` session event, but the built-in adapter protocol cannot drive a Team composition; exercising it needs a team-capable fixture adapter via `profileExtras`.
- **Flush-barrier checkpoints race the loop** — armed `input-accepted`, `receipt-stored`, and `outbox-delivered` explicitly flush and kill while the loop proceeds; subsequent events may commit first. Unarmed checkpoints never add flushes. An armed checkpoint proves its requested barrier, not the uninstrumented loop's durability.
- **Pid-reuse window in orphan detection** — `expectNoOrphanHosts` probes recorded pids; a reaped pid reassigned to an unrelated process before the probe reads as a leak.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
