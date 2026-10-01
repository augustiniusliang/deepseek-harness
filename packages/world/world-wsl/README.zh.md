---
description: "WSL 执行世界：供组合或排查能力调用运行在 WSL 发行版内部的会话的读者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-world-wsl

[English](README.md) | 中文

## 概述

用本包让会话在 WSL 发行版内部工作，VS Code Remote-WSL 风格，无需在发行版内安装任何工具链。每个已安装发行版注册一个 `WorldBackend` 到 `ctx.worlds`：fs 侧经 9P 共享服务发行版目录树并重新围栏宿主文件策略，一次性进程以 `wsl.exe --exec` 经本机世界运行，持久终端经 relay 挂在本机 PTY 之后。未安装 WSL 时插件不注册任何东西，组合照常启动。

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

在允许 WSL 会话时，把本包挂在世界注册表旁边（基座组合把它挂在 `world-local` isolate realm 内）。

### 何时选择

在装有 WSL 的 Windows 宿主机上、会话可能落在发行版工作区（`\\wsl.localhost\<distro>\…` 或凭据登记的盘符工作区）时选择它。其余情况跳过：非 Windows 与零发行版时插件完全惰性。

### 最小配置

本包无配置；挂载即自动发现发行版：

```yaml
- id: world-wsl
  name: '@deepseek-ai/dsh-world-wsl'
```

### 登记工作区

任何指向该发行版的 WSL UNC 自动被认领。Windows 盘符工作区（在 WSL 内以 `/mnt/<drive>` 到达）只有在凭据库（harness home 下的 `wsl-workspaces.json`）登记后才属于某个世界：`registerWindowsWorkspace(path, distro, username?)`；每个工作区的 Linux 用户用 `setWorkspaceUsername(unc, user)` 设置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

fs 后端扩展 `LocalFileSystem`，因此身份、原子发布与版本守卫保持本机机制——作用于 Node 可直接打开的 UNC 路径——而面向模型的路径保持 Linux 形态（`processPath`、`displayPath`、`fileUrl`）。9P 共享无法描述的 Linux 符号链接回退为每个链接一次 `wsl.exe readlink -f`（并发 4）。写操作在解析后的真实路径上重新围栏共享策略（逐字节一致的 `FS_SANDBOX_DENIED`），并把发行版的 `/tmp` 并入可写根。

subprocess 后端翻译每次 spawn：cwd（UNC → Linux，盘符 → `/mnt/<drive>`）、env（合并并计算 `WSLENV`）、argv 包装为 `wsl.exe -d <distro> [-u <user>] --cd <dir> --exec …`。`argv[0]` 为宿主盘符绝对路径的 spawn（今天是随包的 ripgrep）改为在本机世界经 9P 共享运行，路径参数翻成 UNC。终端在本机 PTY 之后 spawn relay 脚本（`lib/types/relay.js`，纯 Node）；relay 从自身 cwd 与 `DSH_WSL_DISTRO`/`DSH_WSL_USER` 读取会话坐标，把 stdio 交给 `wsl.exe bash -i`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `createWslWorldBackend` 工厂、relay 路径解析与优雅降级的插件入口 |
| [`src/fs.ts`](src/fs.ts) | `WslFileSystem`：UNC/Linux/盘符翻译、符号链接回退、策略再围栏 |
| [`src/subprocess.ts`](src/subprocess.ts) | `WslSubprocessRuntime`：spawn/terminal 翻译、可执行文件探针、宿主二进制 9P 回退 |
| [`src/tools-bash.ts`](src/tools-bash.ts) | 本世界的 `bash` 工具：会话发行版内 `bash -lc`，输出对齐宿主工具 |
| [`src/tools-search.ts`](src/tools-search.ts) | 本世界的 `grep`/`glob` 工具：发行版内 GNU grep/find 引擎，schema/渲染/卡片对齐宿主套件 |
| [`src/relay.ts`](src/relay.ts) | 独立的持久 shell relay（作为 PTY 进程运行） |
| [`src/paths.ts`](src/paths.ts) | UNC/drvfs 路径语法（纯函数） |
| [`src/wsl.ts`](src/wsl.ts) | 发行版发现（`wsl.exe -l -q`、Lxss 注册表默认项） |
| [`src/credentials.ts`](src/credentials.ts) | `wsl-workspaces.json` 凭据库 |
| [`src/links.ts`](src/links.ts) | 经发行版的 `readlink -f` 符号链接解析 |
| — | 未发布运行时 invariant 伴随件：本包不拥有事件流；注册表的 `session/world` invariant 已守护它路由所依的世界语法。 |

fs、路径、凭据与 relay 各部分移植自 [dsh-wsl-workspace 0.7.3](https://github.com/6Mikao9/dsh-wsl-workspace)（MIT）；原插件的服务类提供者在此变为纯对象 `WorldBackend` 工厂。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

阅读这些页面以了解本后端注册进的注册表与路由到它的门面。

- [执行世界 subsystem](../../../docs/subsystems/world.zh.md)——`WorldRef` 语法与 realm 布局。
- [世界注册表包](../world/README.zh.md)——`ctx.worlds` 与逐会话世界记录。
- [世界路由包](../world-router/README.zh.md)——把调用委托给本后端的门面。

-----

<a id="model-experience"></a>
## 模型体验

间接地：通过本世界自有的 `bash`/`grep`/`glob` 工具——名称、参数 schema、上限、输出渲染与搜索卡片逐字节对齐宿主套件（`dsh-tool-bash`、`dsh-tool-fs-search`）——模型看到同一份契约，只是执行发生在发行版内。在 WSL 会话中，这些定义经工具注册表的世界亲和过滤以同名遮蔽宿主工具。

#### KV Cache 影响

WSL 会话的工具目录会把宿主 shell 与搜索工具换成同名等价物；目录其余部分不变，本机会话的请求前缀与未装本包的组合逐字节一致。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本包提供的 WSL 世界。它们是当前的包约束，不是任务清单。

- **本世界的 `bash` 仅前台**——后台任务与沙箱升权字段留给宿主工具；WSL 会话的命令在本世界自己的 fs 围栏下运行（`enforcement: 'partial'`），没有升权方言。`bash_background` 桥接属延后工作。
- **GNU grep 不支持 gitignore**——发行版内 `grep` 显式排除隐藏项与 `node_modules`，但仍搜索被 git 忽略的文件；超大工作区的全树内容搜索仍可能触及协作超时，与宿主引擎同界。
- **杀 wsl.exe 不是 POSIX 信号**——终止一次性句柄只结束启动器；内部进程的命运由发行版决定（沿袭上游插件语义）。
- **后端在发现完成后注册**——注册完成前已初始化世界投影的会话，在下一次读取时按 cwd 重新检测；`wsl.exe -l -q` 的延迟落在插件加载路径上。
- **凭据库写入没有 UI**——`registerWindowsWorkspace`/`setWorkspaceUsername` 是编程接缝；web 工作区对话框留给 vendored 插件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
