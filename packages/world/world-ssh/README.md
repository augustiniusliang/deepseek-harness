---
description: "The SSH execution world for readers composing or debugging sessions whose capability calls run on a remote host over SSH."
kind: "package-reference"
---

# @deepseek-ai/dsh-world-ssh

English | [中文](README.zh.md)

## Summary

Use this package to let sessions work on a remote host, VS Code Remote-SSH style, with nothing installed on the far end beyond an SSH server and a POSIX shell. One `WorldBackend` per configured SSH profile registers into `ctx.worlds`: a pooled persistent bash session carries commands and filesystem frames, `ssh -tt` channels carry persistent terminals, and the world's own `bash`/`grep`/`glob` tools answer the model inside SSH sessions. Profiles and workspaces are consumed read-only from the `remote-ssh` settings entry the dsh-remote-ssh plugin owns. With no usable OpenSSH client or zero configured profiles, the plugin registers nothing and the composition boots unchanged.

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

Mount this package beside the world registry (the base composition mounts it inside the `world-local` isolate realm) whenever SSH sessions are allowed.

### When to choose it

Choose it when sessions may live on a remote Linux/macOS host reachable by key- or password-based OpenSSH, typically beside the dsh-remote-ssh plugin that owns the connection profiles and their management UI. Skip it on hosts without an OpenSSH client: the plugin is inert there.

### Minimal configuration

The package takes no config of its own; it reads the `remote-ssh` settings entry (`profiles`, `workspaces`) that dsh-remote-ssh owns:

```yaml
- id: world-ssh
  name: '@deepseek-ai/dsh-world-ssh'
```

Profile values are read live from `settings.describe()` first, then from the loader entry's fiber config, then from the raw profile-patch row — the settings form only exists once the dsh-remote-ssh fiber is active, which races world registration at boot, while the loader row carries the same fields immediately.

### Registering workspaces

Path ownership comes from two sources: settings `workspaces` entries that pair a `remotePath` with a local `mirrorPath`, and ad-hoc `.remote-ssh.json` marker files discovered walking up from a path (bounded at 8 levels). A marker names its profile by `profileId`, falling back to host+user matching, falling back to a synthesized key-auth profile.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `CommandSession` per profile is a persistent `ssh ... bash` process driven by a sentinel protocol: each command is followed by an echoed end marker carrying the exit code, so output boundaries and statuses survive multiplexing over one channel. Commands queue serially; a turn that exceeds the 8 MB capture budget or its timeout drops the session, as does a transport-level exit 255, and the next command falls back to a one-shot `ssh` run while a fresh session warms up. Idle sessions are reaped after 10 minutes and the pool dies with the plugin scope.

The fs backend speaks small shell frames over that pool: `stat -c` feeds a three-field frame for `stat`/`lstat`, reads stream base64 chunks (`tail -c +N | head -c M`), writes go through `mktemp` + `mv` for atomic publication guarded by a `size:mtimeMs` version token, `editText` keeps literal (non-regex) semantics, and every mutation re-fences the remote policy — writable roots are the workspace `remotePath`s plus `/tmp`, denied verbatim as `FS_SANDBOX_DENIED`. `watch` refuses explicitly: there is no remote file-event channel.

The subprocess backend translates each spawn into a pooled `bash -lc` with a `cd` prefix, returning a handle that mimics the local collect shape; `spawnTerminal` instead opens one `ssh -tt` per terminal through the LOCAL world's runtime, so PTY lifecycle stays host-side; `resolveExecutable` probes with `command -v`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createSshWorldBackend` factory, mirror ownership, and the graceful-degrading plugin entry |
| [`src/profile.ts`](src/profile.ts) | Profile/workspaces consumption (settings → fiber → loader row), `.remote-ssh.json` discovery, mirror-to-profile matching |
| [`src/session.ts`](src/session.ts) | `CommandSession` sentinel protocol and the `SshSessionPool` (serial queue, drop-and-fallback, idle reaper) |
| [`src/fs.ts`](src/fs.ts) | `SshFileSystem`: shell-frame stat/read/write, atomic publication, remote policy fence |
| [`src/subprocess.ts`](src/subprocess.ts) | `SshSubprocessRuntime`: pooled spawn translation, `ssh -tt` terminals, executable probes |
| [`src/ssh.ts`](src/ssh.ts) | OpenSSH argv discipline (BatchMode, ClearAllForwardings, sshpass only for passwords), shell quoting, PQ-banner stripping |
| [`src/tools-bash.ts`](src/tools-bash.ts) | The world's `bash` tool: `bash -lc` on the remote host, host-aligned output |
| [`src/tools-search.ts`](src/tools-search.ts) | The world's `grep`/`glob` tools: the GNU grep/find engine shared with `world-wsl`, host-aligned schemas, rendering, and cards |
| — | No runtime invariant companion is published: the package owns no event stream; the registry's `session/world` invariant already guards the world grammar it routes by. |

The session-pool, ssh-argv, and fs-frame halves are ported from [dsh-remote-ssh 2.4.15](https://github.com/ZhangFengshun/dsh-remote-ssh) (MIT); the mirror-sync services of that plugin became a direct-execution `WorldBackend` here.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the registry this backend registers into and the facades that route to it.

- [Execution worlds subsystem](../../../docs/subsystems/world.md) — the `WorldRef` grammar and realm layout.
- [World registry package](../world/README.md) — `ctx.worlds` and the per-session world record.
- [World router package](../world-router/README.md) — the facades delegating calls to this backend.
- [WSL world package](../world-wsl/README.md) — the sibling backend whose GNU search scripts this package reuses.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the world's own `bash`/`grep`/`glob` tools, whose names, parameter schemas, caps, output rendering, and search cards mirror the host suite (`dsh-tool-bash`, `dsh-tool-fs-search`) verbatim — the model sees the same contract, executed on the remote host. In an SSH session these definitions shadow the host tools under the same names through the tool registry's world-affinity filter.

#### KV Cache effect

In an SSH session the tool catalog swaps the host shell and search tools for same-named equivalents; the rest of the catalog is untouched, and a local session's request prefix is byte-identical to a composition without this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the SSH world this package provides. They are current package constraints, not a task backlog.

- **Profile edits apply at boot** — profiles and workspaces are read once when the plugin loads; editing the `remote-ssh` settings entry takes effect on the next launch, and live-reload reconciliation is deferred.
- **Password auth needs sshpass on the host** — key auth runs BatchMode (no prompts); password profiles shell out through `sshpass`, and hosts without it degrade to key-only profiles.
- **`watch` refuses by design** — there is no remote file-event channel; callers get an explicit rejection rather than a silent no-op.
- **GNU grep has no gitignore support** — the remote `grep` excludes hidden entries and `node_modules` explicitly but searches git-ignored files; a whole-tree content search over a very large workspace can hit the cooperative timeout, the same bound the host engine has.
- **The remote fence is coarse** — writable roots are the configured workspace `remotePath`s plus `/tmp`; per-user sudo, ACLs, and per-repo policies stay with the remote host's own enforcement (`enforcement: 'partial'`).
- **One dropped session cancels its in-flight command** — timeouts, 8 MB overflow, and transport drops (exit 255) kill the pooled session; the next command falls back to a one-shot run, but the interrupted command's side effects are whatever the remote shell already did.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
