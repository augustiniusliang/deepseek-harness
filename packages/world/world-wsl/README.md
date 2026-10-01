---
description: "The WSL execution world for readers composing or debugging sessions whose capability calls run inside a WSL distribution."
kind: "package-reference"
---

# @deepseek-ai/dsh-world-wsl

English | [中文](README.zh.md)

## Summary

Use this package to let sessions work inside a WSL distribution, VS Code Remote-WSL style, with no toolchain install inside it. One `WorldBackend` per installed distribution registers into `ctx.worlds`: the fs side serves the distro tree over the 9P share with the host file policy re-fenced, one-shot processes run as `wsl.exe --exec` through the local world, and persistent terminals ride a relay behind the local PTY. With no WSL installed, the plugin registers nothing and the composition boots unchanged.

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

Mount this package beside the world registry (the base composition mounts it inside the `world-local` isolate realm) whenever WSL sessions are allowed.

### When to choose it

Choose it on Windows hosts with WSL installed where sessions may live in a distribution workspace (`\\wsl.localhost\<distro>\…` or a credential-registered drive workspace). Skip it everywhere else: the plugin is inert off Windows and with zero distributions.

### Minimal configuration

The package takes no config; mount it and let it discover distributions:

```yaml
- id: world-wsl
  name: '@deepseek-ai/dsh-world-wsl'
```

### Registering workspaces

Path ownership is automatic for any WSL UNC naming the distribution. A Windows-drive workspace (reached inside WSL as `/mnt/<drive>`) belongs to a world only when registered in the credential store (`wsl-workspaces.json` under the harness home): `registerWindowsWorkspace(path, distro, username?)`, with `setWorkspaceUsername(unc, user)` for the per-workspace Linux user.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The fs backend extends `LocalFileSystem` so identity, atomic publication, and version guards stay the local mechanics — over the UNC path Node can open — while model-facing paths stay Linux (`processPath`, `displayPath`, `fileUrl`). Linux symlinks the 9P share cannot describe fall back to one `wsl.exe readlink -f` per link (concurrency 4). Mutations re-fence the shared policy at the resolved real path (`FS_SANDBOX_DENIED` verbatim), with the distro's `/tmp` added to the writable roots.

The subprocess backend translates each spawn: cwd (UNC → Linux, drive → `/mnt/<drive>`), env (merged with a computed `WSLENV`), argv wrapped as `wsl.exe -d <distro> [-u <user>] --cd <dir> --exec …`. A spawn whose `argv[0]` is a host drive-absolute binary (the bundled ripgrep today) instead runs in the local world over the 9P share with paths translated to UNC. Terminals spawn the relay script (`lib/types/relay.js`, plain Node) behind the local PTY; the relay reads the session coordinates from its cwd and `DSH_WSL_DISTRO`/`DSH_WSL_USER` and hands its stdio to `wsl.exe bash -i`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createWslWorldBackend` factory, relay-path resolution, and the graceful-degrading plugin entry |
| [`src/fs.ts`](src/fs.ts) | `WslFileSystem`: UNC/Linux/drive translation, symlink fallback, policy re-fence |
| [`src/subprocess.ts`](src/subprocess.ts) | `WslSubprocessRuntime`: spawn/terminal translation, executable probes, host-binary 9P fallback |
| [`src/relay.ts`](src/relay.ts) | Standalone persistent-shell relay (run as the PTY process) |
| [`src/paths.ts`](src/paths.ts) | UNC/drvfs path grammar (pure) |
| [`src/wsl.ts`](src/wsl.ts) | Distribution discovery (`wsl.exe -l -q`, Lxss registry default) |
| [`src/credentials.ts`](src/credentials.ts) | The `wsl-workspaces.json` credential store |
| [`src/links.ts`](src/links.ts) | `readlink -f` symlink resolution through the distribution |
| — | No runtime invariant companion is published: the package owns no event stream; the registry's `session/world` invariant already guards the world grammar it routes by. |

The fs, path, credential, and relay halves are ported from [dsh-wsl-workspace 0.7.3](https://github.com/6Mikao9/dsh-wsl-workspace) (MIT); the service-class providers of that plugin became a plain-object `WorldBackend` factory here.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the registry this backend registers into and the facades that route to it.

- [Execution worlds subsystem](../../../docs/subsystems/world.md) — the `WorldRef` grammar and realm layout.
- [World registry package](../world/README.md) — `ctx.worlds` and the per-session world record.
- [World router package](../world-router/README.md) — the facades delegating calls to this backend.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool consumers whose calls the world router delegates here; the backend changes WHERE calls execute, never what the model is told.

#### KV Cache effect

None; no prompt, schema, or session event is added.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the WSL world this package provides. They are current package constraints, not a task backlog.

- **Search tools ride the 9P fallback** — grep/glob run the bundled Windows ripgrep against the UNC share (functionally correct, slower than an in-distro engine); the in-distro replacement waits on a per-world search seam in tool-fs-search.
- **Killing wsl.exe is not POSIX signalling** — terminating a one-shot handle ends the launcher; the distribution decides the inner process's fate (inherited from the upstream plugin's semantics).
- **Backends register after discovery completes** — a session whose world projection initialized before registration settles at its cwd's detected world on the next read; `wsl.exe -l -q` latency lives on the plugin load path.
- **Credential-store writes have no UI here** — `registerWindowsWorkspace`/`setWorkspaceUsername` are the programmatic seam; the web workspace dialog stays with the vendored plugin.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
