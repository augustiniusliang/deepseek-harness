---
description: "The world-routing facades for readers composing or debugging which execution world serves a filesystem or subprocess call."
kind: "package-reference"
---

# @deepseek-ai/dsh-world-router

English | [中文](README.zh.md)

## Summary

Use this package to make a composition's `ctx.fs` and `ctx.subprocess` world-aware without touching any consumer. The facade providers route each call through the `ctx.worlds` registry — a claimed absolute path goes to its world, a relative path follows the call's cwd, everything else stays local — and terminals additionally honor the session's world projection via `DSH_SESSION_ID`. The sandbox policy argument passes through to each backend verbatim.

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

Mount this package when a composition registers non-local worlds and wants every capability consumer (tools, shell executors, terminals) routed without code changes.

### When to choose it

Choose it for any composition with more than one execution world. Skip it when only the local world exists: with no registered backend the facades delegate everything to local, adding one indirection and nothing else.

### Minimal configuration

The package takes no config; it requires the `ctx.worlds` registry. The composition keeps the real local providers and the registry in one isolate realm so the registry's local backend reads them rather than the facades:

```yaml
- id: world-local
  name: cordis:group
  group: true
  isolate:
    fs: true
    subprocess: true
  config:
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: fs-sandbox
      name: '@deepseek-ai/dsh-fs-sandbox'
    - id: world
      name: '@deepseek-ai/dsh-world'

- id: world-router
  name: '@deepseek-ai/dsh-world-router'
```

### Substituting a root provider

A composition that mounts its own root `ctx.fs`/`ctx.subprocess` (a test fixture, a wholly remote deployment) disables the facade row first: `- id: world-router` with `disabled: true`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`RouterFileSystem` routes path-bearing operations (`resolve`, `lstat`, `processPathFromHostPath`) by the registry's claim-then-cwd-then-local rule, with one refinement: an unclaimed path that is absolute in the host grammar stays local rather than following a non-local cwd. Target-bearing operations route to the backend that produced the target, recorded in a `WeakMap` at `resolve()` time; a target the facade never resolved falls back to local. `writeText`/`editText` pass the per-call `SandboxExecutionPolicy` through untouched, and `sandboxMode` reports the local backend's default — the capability fact tools advertise escalation from.

`RouterSubprocessRuntime` routes every spawn by the session first: a spec carrying `DSH_SESSION_ID` pins the backend by that session's `world` projection (covering worlds whose cwd spelling does not reveal them), and the cwd route serves only when the session or projection is unreadable. Executable lookup and terminal-environment inspection are host-local facts and always serve from the local world.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `RouterFileSystem`, `RouterSubprocessRuntime`, and the `world-router` plugin entry |
| — | No runtime invariant companion is published: the facades own no event stream or mutable state beyond the target-origin WeakMap, and routing is exercised by the routing-matrix unit tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the registry these facades route through and the seams they implement.

- [Execution worlds subsystem](../../../docs/subsystems/world.md) — the `WorldRef` grammar, backend contract, and realm layout.
- [World registry package](../world/README.md) — `ctx.worlds`, the per-session record, and the projection.
- [Filesystem Service Definition](../../fs/fs/README.md) — the `FileSystem` contract the facade implements.
- [Subprocess Service Definition](../../subprocess/subprocess/README.md) — the `SubprocessRuntime` contract the facade implements.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the world backends each call lands on, whose providers render through the existing tool consumers exactly as an unrouted composition would.

#### KV Cache effect

None; routing never enters a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the facade surface this package provides. They are current package constraints, not a task backlog.

- **Target identity is in-memory** — the target→backend map is a `WeakMap` on this process; a target reconstructed outside `resolve()` (deserialized keys, foreign handles) routes local.
- **Executable lookup and terminal environment stay local** — `resolveExecutable`/`terminalEnvironment` answer for the host world until a remote world needs them.
- **No cross-world targets** — `contains(parent, child)` with targets from different worlds answers by the parent's world only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
