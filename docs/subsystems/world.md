# Execution Worlds

English | [中文](world.zh.md)

An execution world is one coherent filesystem + subprocess pair a session's capability calls run in: the Harness host itself (`local`), a WSL distribution, or an SSH profile. The world registry's Service Definition is [dsh-world](../../packages/world/world/README.md) (`ctx.worlds`); world providers register plain backend objects, and the registry resolves a path or cwd to the backend that owns it. The registry ships one built-in backend — the local fallback wrapping the composition's mounted `ctx.fs`/`ctx.subprocess` — and claims nothing by itself.

Source: [`packages/world/world/src/index.ts`](../../packages/world/world/src/index.ts)

## The facade and the realm layout

A composition that routes mounts [dsh-world-router](../../packages/world/world-router/README.md): facade `FileSystem`/`SubprocessRuntime` providers take the root `ctx.fs`/`ctx.subprocess` seats and delegate every call to the world that owns it. The real local providers and the `ctx.worlds` registry live together in one isolate realm (`fs` + `subprocess` isolated), so the registry's built-in local backend reads the REAL providers from its own realm — never the facades, which would recurse. Consumers keep reading `ctx.fs`/`ctx.subprocess` and stay oblivious. A composition substituting its own root provider (test fixtures do this) disables the `world-router` row.

## The world reference

A `WorldRef` is one string encoding the world: `local`, `wsl:<distro>`, `wsl:<distro>:<user>`, or `ssh:<profileId>`. The string is the durable and wire form — the `session/world` event payload, the `world` projection state, and the client view all carry it verbatim. `parseWorldRef` validates and decomposes it, `isWorldRef` is the non-throwing test, and `formatWorldRef` re-encodes a parsed reference; the pair round-trips exactly. The registry rejects a backend registered under the reserved `local` reference.

## The backend contract

A `WorldBackend` is a plain object, not a Cordis service: the world's reference and display name, its `FileSystem` and `SubprocessRuntime` providers, and two synchronous routing facts — `ownsPath(absPath)` claims an absolute path in any spelling, and `detectFromCwd(cwd)` maps a session's creation cwd to the world's reference or `null`. Both must be cheap lexical judgments; canonicalization belongs to the backend's own providers.

## Routing precedence

Registration order is routing priority. `resolve({ path, cwd })` prefers the first backend claiming `path`, then the first detecting `cwd`, then the local fallback. `detectWorldForCwd(cwd)` is the same detection returning the reference only, and `list()` enumerates every registered world with local last. When [sandbox policy](sandbox.md) is mounted, the registry contributes its path ownership through `ctx.sandboxPolicy.registerPathClaim`, so a world-owned workspace root the host's path grammar rejects passes policy resolution while the claiming backend enforces its own fencing.

## The per-session record

A session's world is a log-only `session/world` event written through `setSessionWorld(session, ref)`; the fold replaces rather than accumulates, so the last event is the session's world. The `world` projection initializes from the world detected from the session's immutable creation cwd — a session created inside a WSL tree starts there without any event — and exposes the folded reference as a client-visible wire value. The package's invariant companion rejects a forged `session/world` payload that fails the reference grammar, both on loaded history and on live appends.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworlds--worldregistry"></a>

### `ctx.worlds` — `WorldRegistry`

The execution-world registry service (`ctx.worlds`). Owns the backend list (registration order is routing priority, local last and implicit), path/cwd resolution, cwd detection, and the `world` session projection. When the sandbox-policy service is present, the registry also contributes its path ownership as a policy path claim, so a world-owned workspace root (a POSIX WSL path on a Windows host) passes policy resolution without host absolute validation — the owning backend's filesystem enforces its own fencing.

```ts cordis-catalog
/**
 * Register one execution-world backend; registration order is routing
 * priority, and disposal removes the backend.
 * @param backend - the backend to register.
 * @returns the registration's disposer.
 */
register(backend: WorldBackend): () => void

/**
 * Resolve one path or cwd to its owning backend. A path a backend claims
 * outranks cwd detection; an unclaimed input falls back to the local world.
 * @param opts - the path and/or cwd to route.
 * @returns the owning backend, or the local fallback.
 */
resolve(opts: { path?: string; cwd?: string } = {}): WorldBackend

/**
 * Detect the world a session cwd belongs to.
 * @param cwd - the session's creation cwd; undefined detects nothing.
 * @returns the first detecting backend's reference, or `'local'`.
 */
detectWorldForCwd(cwd?: string): WorldRef

/**
 * List every registered world plus the local fallback, in routing order.
 * @returns one entry per world, for UI display and remote export.
 */
list(): { ref: WorldRef; displayName: string }[]

/**
 * Look up one world by reference, local included. A user-qualified WSL
 * reference (`wsl:<distro>:<user>`) resolves to its distribution's backend:
 * the user is a per-session preference the backend reads from the workspace
 * credentials, not a separate world.
 * @param ref - the world reference.
 * @returns the backend carrying `ref`, or undefined when no registered world does.
 */
backendOf(ref: WorldRef): WorldBackend | undefined
```

Source: [`packages/world/world/src/index.ts`](../../packages/world/world/src/index.ts)
<!-- END GENERATED cordis-surface -->
