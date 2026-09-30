---
description: "执行世界包组：世界引用、后端注册表与会话级世界选择。"
kind: "package-group"
---

# packages/world

[English](README.md) | 中文

## 概述

`world/` 组负责命名并路由执行世界——会话的文件系统与子进程调用所在的环境（`local`、某个 WSL 发行版、某个 SSH profile）。由两个包交付：`world/` 拥有 `WorldRef` 语法、`WorldBackend` 提供者契约、带内置 local 兜底的 `ctx.worlds` 注册表，以及会话级 `session/world` 记录与其投影；`world-router/` 挂载门面 `ctx.fs`/`ctx.subprocess`，把每次调用委托给拥有它的世界。

## 目录

- [包清单](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包清单

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`world/`](world/README.zh.md) | 执行世界注册表：`WorldRef` 语法、后端路由、内置 local 后端与会话级世界投影 | `ctx.worlds` |
| [`world-router/`](world-router/README.zh.md) | 门面 `ctx.fs` / `ctx.subprocess` 提供者，把每次调用委托给拥有其路径或 cwd 的世界 | （实现 `ctx.fs` + `ctx.subprocess`） |

-----

<a id="related-documentation"></a>
## 相关文档

- [执行世界 subsystem](../../docs/subsystems/world.zh.md)——`WorldRef` 语法、后端契约、路由优先级与逐会话记录。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
