---
description: "The execution-world package group: world references, the backend registry, and per-session world selection."
kind: "package-group"
---

# packages/world

English | [中文](README.zh.md)

## Summary

The `world/` group names and routes execution worlds — the environments a session's filesystem and subprocess calls run in (`local`, a WSL distribution, an SSH profile). Four packages deliver it: `world/` owns the `WorldRef` grammar, the `WorldBackend` provider contract, the `ctx.worlds` registry with its built-in local fallback, and the per-session `session/world` record with its projection; `world-router/` mounts the facade `ctx.fs`/`ctx.subprocess` that delegate each call to the owning world; `world-wsl/` registers one WSL backend per installed distribution; `world-ssh/` registers one SSH backend per configured remote profile.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`world/`](world/README.md) | Execution-world registry: `WorldRef` grammar, backend routing, the built-in local backend, and the per-session world projection | `ctx.worlds` |
| [`world-router/`](world-router/README.md) | Facade `ctx.fs` / `ctx.subprocess` providers delegating each call to the world that owns its path or cwd | (implements `ctx.fs` + `ctx.subprocess`) |
| [`world-wsl/`](world-wsl/README.md) | The WSL world backend: one per installed distribution — 9P-backed fs, wsl.exe subprocess, relay terminals | (registers into `ctx.worlds`) |
| [`world-ssh/`](world-ssh/README.md) | The SSH world backend: one per configured profile — pooled-shell fs frames, remote bash/grep/glob, ssh -tt terminals | (registers into `ctx.worlds`) |

-----

<a id="related-documentation"></a>
## Related documentation

- [Execution worlds subsystem](../../docs/subsystems/world.md) — the `WorldRef` grammar, backend contract, routing precedence, and per-session record.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
