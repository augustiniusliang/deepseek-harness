---
description: "世界路由门面：供组合或排查文件系统与子进程调用由哪个执行世界服务的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-world-router

[English](README.md) | 中文

## 概述

用本包让组合的 `ctx.fs` 与 `ctx.subprocess` 感知执行世界，且不改任何消费方。门面提供者通过 `ctx.worlds` 注册表路由每次调用——被认领的绝对路径去它的世界，相对路径跟随调用的 cwd，其余留在本机——终端还通过 `DSH_SESSION_ID` 额外尊重会话的世界投影。沙箱策略参数原样透传给各后端。

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

当组合注册了非本机世界、并希望所有能力消费方（工具、shell 执行器、终端）不改代码即被路由时，挂载本包。

### 何时选择

为任何多于一个执行世界的组合选择它。只有本机世界时跳过：没有已注册后端时，门面把一切委托给 local，只多一层间接。

### 最小配置

本包无配置；它要求 `ctx.worlds` 注册表。组合把真正的本机提供者与注册表放在同一个 isolate realm 中，注册表的 local 后端读到的才是它们而不是门面：

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

### 替换根部提供者

自行挂载根部 `ctx.fs`/`ctx.subprocess` 的组合（测试 fixture、纯远端部署）先禁用门面行：`- id: world-router` 加 `disabled: true`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`RouterFileSystem` 按注册表的认领-cwd-local 规则路由带路径操作（`resolve`、`lstat`、`processPathFromHostPath`），外加一条细化：未被认领但在宿主机语法下绝对的路径保持本机，不跟随非本机 cwd。带 target 的操作路由到产出该 target 的后端——`resolve()` 时记入 `WeakMap`；门面从未解析过的 target 落到 local。`writeText`/`editText` 原样透传逐调用 `SandboxExecutionPolicy`，`sandboxMode` 报告本机后端的默认值——工具据此宣传升权的能力事实。

`RouterSubprocessRuntime` 每次 spawn 先按会话路由：携带 `DSH_SESSION_ID` 的 spec 按该会话的 `world` 投影钉住后端（覆盖 cwd 拼写无法显示其世界的情况），会话或投影不可读时才退回 cwd 路由。可执行文件查找与终端环境探查是宿主机本地事实，始终由本机世界服务。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RouterFileSystem`、`RouterSubprocessRuntime` 与 `world-router` 插件入口 |
| — | 未发布运行时 invariant 伴随件：门面除 target 来源 WeakMap 外不拥有事件流或可变状态，路由由路由矩阵单测覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

阅读这些页面以了解门面路由所经的注册表与所实现的接缝。

- [执行世界 subsystem](../../../docs/subsystems/world.zh.md)——`WorldRef` 语法、后端契约与 realm 布局。
- [世界注册表包](../world/README.zh.md)——`ctx.worlds`、逐会话记录与投影。
- [文件系统服务定义](../../fs/fs/README.zh.md)——门面实现的 `FileSystem` 契约。
- [子进程服务定义](../../subprocess/subprocess/README.zh.md)——门面实现的 `SubprocessRuntime` 契约。

-----

<a id="model-experience"></a>
## 模型体验

间接地：每次调用落到哪个世界后端，其提供者仍经既有工具消费方渲染，与未路由的组合完全一致。

#### KV Cache 影响

无；路由从不进入 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包提供的门面面。它们是当前的包约束，不是任务清单。

- **target 身份在内存中**——target→后端映射是本进程上的 `WeakMap`；在 `resolve()` 之外重建的 target（反序列化的键、外来句柄）路由到 local。
- **可执行文件查找与终端环境保持本机**——`resolveExecutable`/`terminalEnvironment` 始终回答宿主机世界，直到远端世界需要它们。
- **无跨世界 target**——`contains(parent, child)` 的 target 来自不同世界时只按 parent 的世界回答。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
