---
description: "面向读者的会话执行世界 chip：组装或调试 web 对话头部时阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-world

[English](README.md) | 中文

## 概述

会话头部的只读 chip，标示会话运行在哪个执行世界：`本机`、`WSL · <发行版>` 或 `SSH · <profile>`，读自会话的 `world` 投影。没有世界切换——会话的世界由其工作区路径决定，因此悬停提示携带完整引用并说明路由是自动的。新会话 hero 不占座位：工作区 chip 已经暗示了新会话将启动在哪个世界。

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

当会话可能运行在非本机世界时，把本包挂进 web 客户端组合（web-app bundle 把它与其他对话头部表面挂在一起）。

### 何时选择它

为任何组合了非本机执行世界（WSL 发行版、SSH profile）的部署选择它。只组合本机世界时 chip 仍渲染 `本机`，诚实但没有增量信息；头部宽度紧张时可以跳过。

### 最小配置

本包无配置；挂上即读投影：

```yaml
- id: ui-session-world
  name: '@deepseek-ai/dsh-client-ui-session-world'
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

浏览器半注册一个 `conversation.session.header.actions` 槽位条目（`id: 'session-world'`，order −9，在头部静态上下文带里尾随 agent-preset 标签的 −10）和一个 `session.world` 本地化命名空间（zh/en）。组件经框架 `useSessions` hook 订阅会话列表的 `projectionValues.world`，投影缺失时不渲染。引用到标签的映射是纯导出函数（`worldLabel`）：`local` 走翻译；`wsl:<distro>[:user]` 丢弃用户、只标发行版；`ssh:<profileId>` 标 profile；未知形状原样透传，未来的世界种类因此降级为引用文本。宿主半是空 apply，只为让插件出现在 Loader 里。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 空宿主 apply（仅为 Loader 存在） |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器 apply：本地化命名空间 + 头部槽位注册 |
| [`src/client/SessionWorldLabel.tsx`](src/client/SessionWorldLabel.tsx) | chip 组件：投影读取、悬停提示、容器查询让位 |
| [`src/client/locales.ts`](src/client/locales.ts) | zh/en 词典与纯 `worldLabel` 映射 |
| — | 不发布运行时不变量伴随件：本包不拥有事件流；世界注册表的 `session/world` 不变量已守卫它显示的文法。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [执行世界子系统](../../../docs/subsystems/world.zh.md)——chip 解析的 `WorldRef` 文法与它读取的投影。
- [agent-preset 标签](../ui-agent-preset/README.zh.md)——本包结构镜像的姊妹头部 chip。

-----

<a id="model-experience"></a>
## 模型体验

无：chip 只把已投影的事实显示给人看，自身不注册任何 prompt、工具或模型可见上下文。

#### KV Cache 影响

无；chip 从不进入 provider 请求，挂不挂本包，会话的请求前缀逐字节一致。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了本包提供的 chip。它们是当前的包约束，不是任务清单。

- **设计上只显示**——没有世界切换；chip 不提供任何动作，世界选择始终是工作区路径的结果。世界选择器会是一个需要宿主支持的独立特性。
- **未解析的 profile 显示其 id**——chip 把 `ssh:<profileId>` 映射为原始 profile id；友好的显示名需要客户端能读 remote-ssh 设置目录，延后到 SSH 设置表面处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
