---
description: "The execution-world package group: world references, the backend registry, and per-session world selection."
kind: "package-group"
---

# packages/world

English | [中文](README.zh.md)

## Summary

The `world/` group names and routes execution worlds — the environments a session's filesystem and subprocess calls run in (`local`, a WSL distribution, an SSH profile). One package delivers it: `world/` owns the `WorldRef` grammar, the `WorldBackend` provider contract, the `ctx.worlds` registry with its built-in local fallback, and the per-session `session/world` record with its projection.

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
