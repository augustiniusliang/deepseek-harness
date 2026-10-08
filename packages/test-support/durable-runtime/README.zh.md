---
description: "故障注入测试设施：在指定的持久性检查点对真实 headless dsh 宿主执行 SIGKILL，并回读幸存的台账与 session 日志证据，供仓库持久性测试使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-durable-runtime

[English](README.md) | 中文

## 概述

使用 `dsh-durable-runtime` 可以刻画在 headless dsh 运行的两个持久性检查点之间硬杀进程后幸存的状态。宿主内的 fixture（测试前置）插件读取控制文件，在指定检查点触发时向经过 fsync 的台账追加命中记录并对自身执行 SIGKILL；随后测试进程对两条独立幸存的证据流——fixture 台账与 session JSONL 日志——进行断言。控制器库创建按测试隔离的运行时、通过共享双模式启动器 spawn 并重启宿主，并在拆卸时收敛孤儿进程。这个支持层库面向仓库持久性测试，不用于产品集成。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

一个测试创建运行时、可选地布防故障点、用 fixture 协议提示词 spawn 宿主，并对持久证据断言：

```text
const runtime = await createDurableTestRuntime()
await armFailpoint(runtime, { name: 'model-settled', once: true })
const host = spawnDurableHost(runtime, { prompt: 'EFFECT:x' })
const result = await host.result            // killed at the checkpoint
await expectFailpointHit(runtime, 'model-settled')
await expectSideEffectCount(runtime, 'tool-effect', 0)
await runtime.dispose()                     // after teardownDurableHosts()
```

重启就是对同一运行时再次 `spawnDurableHost`；恢复崩溃的 session 使用 `sessionId`（headless `--session-id`）。提示词选择确定性协议：`ECHO:<text>` 回答 `<text>`，`EFFECT:<name>` 执行一次 `durable_effect` 调用并回答 `DONE:<name>`，`PARALLEL:A:<delayMs>:B:<delayMs>` 执行两次 `durable_effect` 调用并回答 `DONE:PARALLEL`。

### 故障点检查点

检查点名称是本设施的公开 API。`match.tool` 与 `durable_effect` 调用的 `name` 实参比较。

| 故障点 | 真实接缝 | 触发时机 |
|---|---|---|
| `input-accepted` | `session/event`（`user/message`）+ 等待 `SessionStore.flush` 屏障 | 用户消息持久落盘之后 |
| `input-claimed` | `session/event`（`agent/inbox/spliced` 且 `removedCount > 0`） | agent loop 持久认领待处理输入时 |
| `model-settled` | fixture LLM 适配器中，最后一个 chunk 之后、`stream()` 返回之前 | loop 提交已定响应之前 |
| `dispatch-intent` | `tools/pre-execute` 瀑布（监听器调用 `next()`） | fixture 工具体运行之前 |
| `external-effect` | `durable_effect` 工具体内，fsync 台账写入之后 | 工具返回之前 |
| `receipt-stored` | `session/event`（`tool/result`）+ 等待 flush 屏障 | 工具结果持久落盘之后 |
| `outbox-delivered` | `session/event`（`team/message/delivered`）+ 等待 flush 屏障 | Agent Teams 投递持久落盘之后；需经 `profileExtras` 加入 agent-team bundle，内置协议不驱动该组合 |

命中时 fixture 先删除 `once` 控制文件，再以 fsync 追加 `{kind:'failpoint-hit', detail:{name}}`，然后 `process.kill(process.pid, 'SIGKILL')`——在接缝允许处全程同步，使之后的宿主代码无法再添加证据。

### 证据流

`<runtime>/ledger/effects.jsonl` 台账只追加；每行都按 打开-写入-fsync-关闭 写入，因此测试读到的行必然在杀进程后幸存。种类：`model-request`（每次适配器调用）、`tool-effect`（外部副作用）、`failpoint-hit`。Session JSONL 日志位于 `<runtime>/home/sessions`（按生成的 profile 不压缩）；`readSessionLogFiles` 及 `toolCalls` / `toolResultCallIds` / `inboxClaimCount` / `hasUnclosedTurn` 归约器回答持久发生了什么。持久日志从不包含中断轮次的收尾事件；恢复方在读取时推导它们（`@deepseek-ai/dsh-session` 的 `interruptedTurnClosers`），而恢复后的运行会把修复行持久化。

### 平台说明

Windows 用 `TerminateProcess` 模拟 fixture 的自身 SIGKILL：在故障点被杀的宿主报告退出码 1 且无信号，而经 execa 的控制器杀进程在所有平台都报告信号 `SIGKILL`——请像 `tests/helpers.ts` 那样结合证据（`expectFailpointHit`）与进程形态断言。WSL/Linux 路径完全相同：同样的 `process.kill` 自身 SIGKILL 与同样的 execa `killSignal: 'SIGKILL'` 期限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 设计

fixture（`fixtures/durable-fixture.mjs`，纯 ESM，按绝对文件 URL 加载，沿用 Agent Teams team-llm 模式）在 `deepseek-official` 路由上注册 `DurableFixtureAdapter`、`durable_effect` 工具与各检查点监听器；生成的 profile 禁用 `llm-deepseek` 与 `session-title-llm`（标题请求会多消耗一次确定性模型请求），并把 JSONL 持久化固定到运行时目录。控制器从不触碰宿主内状态：控制面是控制文件，证据面是台账与日志。宿主启动经由 `resolveExampleLaunch`（`@deepseek-ai/dsh-loader-smoke`），因此 `DSH_EXAMPLE_MODE=lib` 会按 CI 的方式启动构建产物 CLI。`DURABLE_RUNTIME_BASE` 可改变 mkdtemp 父目录。`spawnDurableHost` 在模块级注册表中跟踪每个存活宿主；`teardownDurableHosts` 对幸存者对SIGKILL，`expectNoOrphanHosts` 用 `process.kill(pid, 0)` 探测记录的 pid。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/runtime.ts`](src/runtime.ts) | `createDurableTestRuntime`：隔离目录布局与生成的 headless profile |
| [`src/host.ts`](src/host.ts) | `spawnDurableHost`、如实上报的 kill 句柄、孤儿注册表、`--json` session-id 读取 |
| [`src/ledger.ts`](src/ledger.ts) | 台账读取与必须使测试失败的计数/命中断言 |
| [`src/failpoint.ts`](src/failpoint.ts) | 原子（临时文件+重命名）控制文件布防/解除 |
| [`src/session-log.ts`](src/session-log.ts) | Session JSONL 读取与事件归约器 |
| [`fixtures/durable-fixture.mjs`](fixtures/durable-fixture.mjs) | 宿主内故障点插件：适配器、工具、检查点、台账 |
| — | 不发布运行时 invariant 伴随件；这个测试支持包不拥有生产事件流或可变数据——它的检查就是消费它的各个 spec 本身。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [loader-smoke](../loader-smoke/README.zh.md)——本包构建其上的双模式启动器与子进程 harness。
- [Session 包](../../core/session/README.zh.md)——flush 屏障检查点背后的 `session/event` / `session/flush` 语义。
- [Schedule 包](../../schedule/schedule/README.zh.md)——记录 schedule 投递为何无法 headless 挂载。
- [测试策略](../../../docs/testing.zh.md)——子进程启动模式与资源所有权规则。
- [测试支持组地图](../README.zh.md)——同级 harness。

-----

<a id="model-experience"></a>
## 模型体验

### Fixture 工具 `durable_effect`

#### 模型看到什么

被 spawn 宿主的请求中多出一个工具：名称 `durable_effect`，描述 “Record one named external side effect in the durable fixture ledger, optionally after a delay.”，参数 `name`（必填字符串）与 `delayMs`（可选数字）。消费它的是确定性适配器，而非真实模型。

#### Token 影响

固定条件成本：仅在本设施 spawn 的宿主请求中增加一个小型工具条目，只存在于这些测试组合中。

#### KV 缓存影响

独立行为：fixture 适配器按协议键回答每个请求，不复用任何 provider 缓存；该工具条目只在被 spawn 的测试宿主内改变请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **schedule 投递无法在 headless 复现**——`ScheduleService.inject` 依赖 Host Web 的 `sessionController`（packages/schedule/schedule/src/index.ts:101），headless bundle 不组合该服务；在出现无浏览器的 Web 组合之前，`tests/repro-schedule-dup.spec.ts` 保持跳过。
- **`outbox-delivered` 没有驱动协议**——该检查点监听 agent-team 的 `team/message/delivered` session 事件，但内置适配器协议无法驱动 Team 组合；要触发它需经 `profileExtras` 提供能驱动 team 的 fixture 适配器。
- **flush 屏障检查点与继续前行的 loop 竞争**——`input-accepted`、`receipt-stored` 与 `outbox-delivered` 在等待 flush 后才杀进程，期间 agent loop 继续前进；后续事件可能先提交，因此场景必须断言检查点自身的证据，而不是精确的日志尾部。
- **孤儿检测存在 pid 复用窗口**——`expectNoOrphanHosts` 探测记录的 pid；已被回收的 pid 在探测前分配给无关进程时会被读作泄漏。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
