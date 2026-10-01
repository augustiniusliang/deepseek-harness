# 执行世界

[English](world.md) | 中文

执行世界是会话能力调用运行所在的、自洽的文件系统 + 子进程对：Harness 宿主机本身（`local`）、一个 WSL 发行版，或一个 SSH profile。世界注册表的服务定义是 [dsh-world](../../packages/world/world/README.zh.md)（`ctx.worlds`）；世界提供者注册纯后端对象，注册表把路径或 cwd 解析到拥有它的后端。注册表内置一个后端——包装组合中已挂载 `ctx.fs`/`ctx.subprocess` 的 local 兜底——自身不认领任何路径。

来源：[`packages/world/world/src/index.ts`](../../packages/world/world/src/index.ts)

## 门面与 realm 布局

要路由的组合挂载 [dsh-world-router](../../packages/world/world-router/README.zh.md)：门面 `FileSystem`/`SubprocessRuntime` 提供者占据根部 `ctx.fs`/`ctx.subprocess` 座位，把每次调用委托给拥有它的世界。真正的本机提供者与 `ctx.worlds` 注册表同处于一个 isolate realm（隔离 `fs` + `subprocess`），因此注册表的内置 local 后端从自己所在 realm 读到真正的提供者——永远不会读到门面自身造成递归。消费方仍读 `ctx.fs`/`ctx.subprocess`，毫无感知。替换根部提供者的组合（测试 fixture 常这么做）禁用 `world-router` 行即可。

## 世界引用

`WorldRef` 是编码世界的单个字符串：`local`、`wsl:<distro>`、`wsl:<distro>:<user>` 或 `ssh:<profileId>`。该字符串即 durable 与 wire 形态——`session/world` 事件载荷、`world` 投影状态与客户端视图都原样携带它。`parseWorldRef` 校验并分解它，`isWorldRef` 是不抛异常的判定，`formatWorldRef` 把解析结果重新编码；两者精确往返。注册表拒绝以保留的 `local` 引用注册的后端。

## 后端契约

`WorldBackend` 是纯对象，不是 Cordis 服务：世界的引用与显示名、它的 `FileSystem` 与 `SubprocessRuntime` 提供者，以及两个同步路由事实——`ownsPath(absPath)` 认领任意拼写的绝对路径，`detectFromCwd(cwd)` 把会话的创建 cwd 映射到世界引用或 `null`。两者都必须是廉价的词法判断；规范化归后端自己的提供者负责。

## 路由优先级

注册顺序即路由优先级。`resolve({ path, cwd })` 先取第一个认领 `path` 的后端，再取第一个检测到 `cwd` 的后端，最后落到 local 兜底。`detectWorldForCwd(cwd)` 是同一检测、只返回引用，`list()` 枚举所有已注册世界且 local 居末。挂载[沙箱策略](sandbox.zh.md)时，注册表通过 `ctx.sandboxPolicy.registerPathClaim` 贡献自己的路径认领，使宿主机路径语法拒绝的世界工作区根能通过策略解析，同时由认领后端执行自己的围栏。

## 逐会话记录

会话的世界是通过 `setSessionWorld(session, ref)` 写入的一条 log-only `session/world` 事件；折叠替换而非累积，最后一条事件即会话的世界。`world` 投影以从会话不可变创建 cwd 检测到的世界为初始状态——在 WSL 目录树中创建的会话无需任何事件即从该世界起步——并把折叠后的引用暴露为客户端可见的 wire 值。本包的 invariant 伴随件拒绝不符合引用语法的伪造 `session/world` 载荷，对已加载历史与新追加均生效。

## 感知世界的工具

模型可见的工具集经工具注册表的亲和接缝（`@deepseek-ai/dsh-tools`）随会话世界变化：定义可声明 `worlds`（`'local'` 或作用于引用的谓词）并作为其名称的一个变体注册；匹配的变体在世界匹配的会话里遮蔽无亲和定义；世界由 `registerWorldResolver` 解析，本包从投影安装该解析器。宿主 shell 工具（`pwsh`、`bash`）声明 `'local'`；WSL 后端用 `wsl:` 谓词注册自己的 `bash`/`grep`/`glob`——WSL 会话看到发行版原生的同名工具，本机会话看到的宿主工具集不变。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworlds--worldregistry"></a>

### `ctx.worlds` — `WorldRegistry`

The execution-world registry service (`ctx.worlds`). Owns the backend list (registration order is routing priority, local last and implicit), path/cwd resolution, cwd detection, and the `world` session projection. When the sandbox-policy service is present, the registry also contributes its path ownership as a policy path claim, so a world-owned workspace root (a POSIX WSL path on a Windows host) passes policy resolution without host absolute validation — the owning backend's filesystem enforces its own fencing.

```ts cordis-catalog
/**
 * Register one execution-world backend; registration order is routing
 * priority, and disposal removes the backend.
 * @param backend - the backend to register.
 * @returns the registration's disposer.
 */
register(backend: WorldBackend): () => void

/**
 * Resolve one path or cwd to its owning backend. A path a backend claims
 * outranks cwd detection; an unclaimed input falls back to the local world.
 * @param opts - the path and/or cwd to route.
 * @returns the owning backend, or the local fallback.
 */
resolve(opts: { path?: string; cwd?: string } = {}): WorldBackend

/**
 * Detect the world a session cwd belongs to.
 * @param cwd - the session's creation cwd; undefined detects nothing.
 * @returns the first detecting backend's reference, or `'local'`.
 */
detectWorldForCwd(cwd?: string): WorldRef

/**
 * List every registered world plus the local fallback, in routing order.
 * @returns one entry per world, for UI display and remote export.
 */
list(): { ref: WorldRef; displayName: string }[]

/**
 * Look up one world by reference, local included. A user-qualified WSL
 * reference (`wsl:<distro>:<user>`) resolves to its distribution's backend:
 * the user is a per-session preference the backend reads from the workspace
 * credentials, not a separate world.
 * @param ref - the world reference.
 * @returns the backend carrying `ref`, or undefined when no registered world does.
 */
backendOf(ref: WorldRef): WorldBackend | undefined
```

Source: [`packages/world/world/src/index.ts`](../../packages/world/world/src/index.ts)
<!-- END GENERATED cordis-surface -->
