---
description: "The execution-world registry for readers choosing, routing, or debugging which world (local, WSL, SSH) a session's filesystem and subprocess calls run in."
kind: "package-reference"
---

# @deepseek-ai/dsh-world

English | [中文](README.zh.md)

## Summary

Use this package to route one session's capability calls to the execution world they belong to. Register a backend per world (a WSL distribution, an SSH profile); the registry resolves a path or cwd to its owning backend, records a session's world as one durable `session/world` event, and projects it for consumers and clients. The built-in local backend wraps the composition's mounted fs/subprocess providers and catches everything unclaimed.

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

Mount this package in a composition whose sessions may execute outside the host world; it owns the `WorldRef` grammar, the backend registry, and the per-session world record that routing consumers read.

### When to choose it

Choose it when a deployment adds a non-local execution world (WSL, SSH) and needs one routing point every capability layer agrees on. Skip it when every session executes on the host: the registry's only shipped backend is the local fallback, so with no registered backend it adds nothing.

### Minimal configuration

The package takes no config; mount it beside the providers it wraps:

```yaml
- name: '@deepseek-ai/dsh-world'
```

### Registering a backend

A world provider registers one `WorldBackend` — a plain object pairing the world's `FileSystem` and `SubprocessRuntime` with its routing facts; registration order is routing priority, and the returned disposer removes the backend. `resolve({ path, cwd })` prefers a backend claiming `path`, then one detecting `cwd`, then the local fallback; `detectWorldForCwd(cwd)` returns the reference only.

### Switching a session's world

A caller records a session's world with `setSessionWorld(session, ref)`: one log-only `session/world` event, folded by the `world` projection, replacing rather than accumulating. A session without the event runs in the world detected from its creation cwd; the folded reference is also a client-visible projection value under the same key.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A `WorldRef` is one string — `'local'`, `'wsl:<distro>'`, `'wsl:<distro>:<user>'`, or `'ssh:<profileId>'` — validated and parsed by `isWorldRef`/`parseWorldRef` and re-encoded by `formatWorldRef`. The string is the durable and wire form: the `session/world` payload, the projection state, and the client view all carry it verbatim.

The world projection's initial state is detected from the session's immutable creation cwd, so a session created inside a WSL tree starts in that world without any event. The registry also contributes its path ownership to `ctx.sandboxPolicy.registerPathClaim` when the policy service is present, so a world-owned workspace root the host cannot parse (a POSIX spelling on a Windows host) passes policy resolution; the owning backend's filesystem enforces its own fencing.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `WorldBackend` contract, `WorldRegistry` service, the built-in local backend, and the `world` projection registration |
| [`src/ref.ts`](src/ref.ts) | `WorldRef` grammar: parse, validate, format |
| [`src/session-world.ts`](src/session-world.ts) | The `session/world` event declaration and its `setSessionWorld` write path |
| [`src/types.ts`](src/types.ts) | Pure types: `WorldRef` and the projection key declarations |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion rejecting a forged `session/world` payload |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the seams a world backend implements and the policy it relaxes.

- [Session projection package](../../session/session-projection/README.md) — the projection unit contract the `world` fold implements.
- [Filesystem Service Definition](../../fs/fs/README.md) — the `FileSystem` contract each backend provides.
- [Subprocess Service Definition](../../subprocess/subprocess/README.md) — the `SubprocessRuntime` contract each backend provides.
- [Sandbox policy package](../../sandbox/sandbox-policy/README.md) — the policy resolver consuming world path claims.

-----

<a id="model-experience"></a>
## Model Experience

None, as the registry routes already-existing capabilities between worlds and registers no prompt, tool, or model-visible context of its own.

#### KV Cache effect

None; routing state never enters a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the routing surface this package provides. They are current package constraints, not a task backlog.

- **Only the local fallback ships** — WSL and SSH backends are deferred work; until one registers, every resolution falls back to local and `list()` shows one world.
- **Routing reads paths lexically** — `ownsPath` and `detectFromCwd` are synchronous string judgments supplied by each backend; no symlink or case canonicalization happens at the registry.
- **A world switch does not re-fence in-flight policy** — `session/world` takes effect for consumers reading the projection after the event; already-resolved capability calls keep their stamped policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
