---
description: "校验执行提交，并通过易失的参考提供方测试乐观并发。"
kind: "package-reference"
---

# @deepseek-ai/dsh-execution

[English](README.md) | 中文

## 概述

开发者可以校验执行记录并测试提交拒绝，而不修改生产 Session。参考提供方在发布批次前检查 revision、所有权与逻辑操作转换。它的回执明确标为易失存储。进程退出会丢失全部参考状态；本包不启用持久执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 JSON 边界使用导出的 schema，在隔离测试组合中使用具名参考提供方。

### 何时选择它

本包用于协议契约测试。生产 Session 持久化仍使用原有提供方。参考提交成功不赋予执行外部副作用的权限。

### 最小配置

fixture 模块可以将具名提供方导出为默认值：

```js
export { ReferenceExecutionCoordinator as default } from '@deepseek-ai/dsh-execution'
```

在 `cordis.yml` 挂载该 fixture，并在消费者声明 `inject = ['execution']`。[Loader 测试](tests/loader.spec.ts) 通过真实隔离的 headless host 运行该组合。直接加载本包的抽象默认导出会抛出错误。

| 字段 | 默认值 | 含义 |
|---|---|---|
| — | — | 参考提供方不接受配置字段。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

协调器先校验完整请求，再替换内存映射。只有已接纳的数据一致时，重复 transaction 或 command 身份才返回原回执。Session 序号检查失败不会改变 Run 和 Activity 快照。版本读取器要求显式注册相邻迁移，拒绝未来版本和缺失迁移。

| 源码 | 职责 |
|---|---|
| [service.ts](src/service.ts) | 提供方边界和回执查询 |
| [schema.ts](src/schema.ts) | JSON 接纳和暂定执行版本 |
| [reference.ts](src/reference.ts) | 原子的内存参考行为 |
| [readers.ts](src/readers.ts) | 显式迁移注册 |
| [protocol.spec.ts](tests/protocol.spec.ts) | 状态、所有权和确认契约 |

不发布运行时 invariant companion。本参考提供方不拥有生产事件流；契约测试校验映射和回执行为。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Execution 包组](../README.zh.md) — 能力地图。
- [Session 子系统](../../../docs/subsystems/session.zh.md) — 当前生产历史与持久化。
- [Durable 测试运行时](../../test-support/durable-runtime/README.zh.md) — 真实进程 fixture。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

本包是协议开发检查点，尚未冻结为下游契约。

- 参考提供方退出即丢失全部状态，不能证明重启恢复。
- 原子变更目前覆盖 Run 和 Activity。输入、等待、预算和交接 schema 尚无协调器变更接口。
- Session append 校验序号及必需事件词汇，但不存储事件内容，也不更新真实 Session。
- 逻辑操作尚不支持替换 attempt。未实现外部重试、恢复授权或共享预算策略。
- 生产 profile 不加载本提供方。参考事件仅用于 fixture，不是 SessionEventMap 扩展。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
