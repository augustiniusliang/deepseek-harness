---
description: "执行世界注册表：供选择、路由或调试会话的文件系统与子进程调用运行在哪个世界（本机、WSL、SSH）的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-world

[English](README.md) | 中文

## 概述

用本包把一个会话的能力调用路由到它们所属的执行世界。每个世界注册一个后端（一个 WSL 发行版、一个 SSH profile）；注册表把路径或 cwd 解析到拥有它的后端，把会话的世界记录为一条 durable 的 `session/world` 事件，并为消费方与客户端投影该值。内置 local 后端包装组合中已挂载的 fs/subprocess 提供者，兜住一切未被认领的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在会话可能于宿主机世界之外执行的组合中挂载本包；它拥有 `WorldRef` 语法、后端注册表，以及路由消费方读取的会话级世界记录。

### 何时选择

当部署加入非本机执行世界（WSL、SSH）并需要一个所有能力层一致认可的路由点时选择它。当所有会话都在宿主机上执行时跳过：注册表唯一随包交付的后端是 local 兜底，没有已注册后端时它不带来任何增量。

### 最小配置

本包无配置；与它包装的提供者并排挂载即可：

```yaml
- name: '@deepseek-ai/dsh-world'
```

### 注册后端

世界提供者注册一个 `WorldBackend`——把该世界的 `FileSystem` 与 `SubprocessRuntime` 与其路由事实配对的纯对象；注册顺序即路由优先级，返回的 disposer 移除该后端。`resolve({ path, cwd })` 先认 claim `path` 的后端，再认检测到 `cwd` 的后端，最后落到 local 兜底；`detectWorldForCwd(cwd)` 只返回引用。

### 切换会话的世界

调用方用 `setSessionWorld(session, ref)` 记录会话的世界：一条 log-only 的 `session/world` 事件，由 `world` 投影折叠，替换而非累积。没有该事件的会话运行在从其创建 cwd 检测到的世界；折叠后的引用同时是同键下的客户端可见投影值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`WorldRef` 是单个字符串——`'local'`、`'wsl:<distro>'`、`'wsl:<distro>:<user>'` 或 `'ssh:<profileId>'`——由 `isWorldRef`/`parseWorldRef` 校验与解析，由 `formatWorldRef` 重新编码。该字符串即 durable 与 wire 形态：`session/world` 载荷、投影状态与客户端视图都原样携带它。

世界投影的初始状态从会话不可变的创建 cwd 检测，因此在 WSL 目录树中创建的会话无需任何事件即从该世界起步。注册表还在 policy 服务存在时把自己的路径认领贡献给 `ctx.sandboxPolicy.registerPathClaim`，使宿主机无法解析的世界工作区根（Windows 宿主机上的 POSIX 拼写）能通过 policy 解析；认领后端的文件系统自行执行围栏。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `WorldBackend` 契约、`WorldRegistry` 服务、内置 local 后端与 `world` 投影注册 |
| [`src/ref.ts`](src/ref.ts) | `WorldRef` 语法：解析、校验、编码 |
| [`src/session-world.ts`](src/session-world.ts) | `session/world` 事件声明与其 `setSessionWorld` 写路径 |
| [`src/types.ts`](src/types.ts) | 纯类型：`WorldRef` 与投影键声明 |
| [`src/invariant.ts`](src/invariant.ts) | 拒绝伪造 `session/world` 载荷的 invariant 伴随件 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

阅读这些页面以了解世界后端实现的接缝与它放宽的策略。

- [会话投影包](../../session/session-projection/README.zh.md)——`world` 折叠实现的投影单元契约。
- [文件系统服务定义](../../fs/fs/README.zh.md)——每个后端提供的 `FileSystem` 契约。
- [子进程服务定义](../../subprocess/subprocess/README.zh.md)——每个后端提供的 `SubprocessRuntime` 契约。
- [沙箱策略包](../../sandbox/sandbox-policy/README.zh.md)——消费世界路径认领的策略解析器。

-----

<a id="model-experience"></a>
## 模型体验

无：注册表只在世界之间路由既有能力，自身不注册任何 prompt、工具或模型可见上下文。

#### KV Cache 影响

无；路由状态从不进入 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包提供的路由面。它们是当前的包约束，不是任务清单。

- **只随包交付 local 兜底**——WSL 与 SSH 后端属延后工作；在任一后端注册之前，所有解析都落到 local，`list()` 只显示一个世界。
- **路由按词法读路径**——`ownsPath` 与 `detectFromCwd` 是各后端提供的同步字符串判断；注册表不做符号链接或大小写规范化。
- **世界切换不重新围栏在途策略**——`session/world` 对事件之后读取投影的消费方生效；已解析的能力调用保留其盖章策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
