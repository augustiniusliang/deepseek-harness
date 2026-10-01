---
description: "面向读者的 SSH 执行世界：组装或调试那些能力调用经 SSH 在远端主机上执行的会话时阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-world-ssh

[English](README.md) | 中文

## 摘要

用本包让会话在远端主机上工作，VS Code Remote-SSH 风格，远端除 SSH 服务器与 POSIX shell 外无需安装任何东西。每个配置的 SSH profile 注册一个 `WorldBackend` 进 `ctx.worlds`：池化的常驻 bash 会话承载命令与文件系统帧，`ssh -tt` 通道承载持久终端，世界自带的 `bash`/`grep`/`glob` 工具在 SSH 会话里回答模型。profile 与工作区从 dsh-remote-ssh 插件拥有的 `remote-ssh` settings 条目只读消费。没有可用的 OpenSSH 客户端或零个已配置 profile 时，插件什么都不注册，组合照常启动。

## 目录

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [进一步探索](#进一步探索)
- [模型体验](#模型体验)
- [已知限制与暂缓工作](#已知限制与暂缓工作)
- [开发注记](#开发注记)

-----

<a id="使用本包"></a>
## 使用本包

当允许 SSH 会话时，把本包挂在世界注册表旁（base 组合把它挂在 `world-local` isolate 领域内）。

### 何时选择它

当会话可能落在可通过密钥或密码 OpenSSH 到达的远端 Linux/macOS 主机上时选择它，通常与拥有连接 profile 及其管理 UI 的 dsh-remote-ssh 插件并列。没有 OpenSSH 客户端的主机上跳过它：插件在那里是惰性的。

### 最小配置

本包自身无配置；它只读 dsh-remote-ssh 拥有的 `remote-ssh` settings 条目（`profiles`、`workspaces`）：

```yaml
- id: world-ssh
  name: '@deepseek-ai/dsh-world-ssh'
```

profile 值的读取顺序是先 `settings.describe()` 的实时值，再 loader 条目的 fiber config，再 profile patch 原始行——settings 表单要等 dsh-remote-ssh fiber 激活后才存在，这与启动时的世界注册存在竞态，而 loader 行立即携带同样的字段。

### 注册工作区

路径归属有两个来源：把 `remotePath` 与本地 `mirrorPath` 配对的 settings `workspaces` 条目，以及从路径向上发现的临时 `.remote-ssh.json` 标记文件（有界 8 层）。标记按 `profileId` 指认 profile，退到 host+user 匹配，再退到合成一个密钥认证的 profile。

-----

<a id="理解实现"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

每个 profile 一条 `CommandSession`，是一个由哨兵协议驱动的常驻 `ssh ... bash` 进程：每条命令后跟一个携带退出码的回显结束标记，输出边界与状态因此在单通道复用下依然可靠。命令串行排队；超过 8 MB 捕获上限或超时的那一轮会丢弃会话，传输层 exit 255 亦然，下一条命令回退到一次性 `ssh` 运行，同时新会话热身。空闲会话 10 分钟后回收，池随插件作用域销毁。

fs 后端在该池上讲小型 shell 帧：`stat -c` 喂三字段帧给 `stat`/`lstat`；读取流式传输 base64 分块（`tail -c +N | head -c M`）；写入走 `mktemp` + `mv` 实现原子发布，由 `size:mtimeMs` 版本令牌守卫；`editText` 保持字面（非正则）语义；每次变更都重围远端策略——可写根是各工作区的 `remotePath` 加 `/tmp`，拒绝时逐字报 `FS_SANDBOX_DENIED`。`watch` 明确拒绝：没有远端文件事件通道。

subprocess 后端把每次 spawn 翻译成带 `cd` 前缀的池化 `bash -lc`，返回的句柄模仿本地 collect 形状；`spawnTerminal` 改为经本地世界的运行时为每个终端开一条 `ssh -tt`，PTY 生命周期留在宿主侧；`resolveExecutable` 用 `command -v` 探测。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `createSshWorldBackend` 工厂、镜像归属与优雅降级的插件入口 |
| [`src/profile.ts`](src/profile.ts) | profile/workspaces 消费（settings → fiber → loader 行）、`.remote-ssh.json` 发现、镜像到 profile 匹配 |
| [`src/session.ts`](src/session.ts) | `CommandSession` 哨兵协议与 `SshSessionPool`（串行队列、丢弃回退、空闲回收） |
| [`src/fs.ts`](src/fs.ts) | `SshFileSystem`：shell 帧 stat/读/写、原子发布、远端策略围栏 |
| [`src/subprocess.ts`](src/subprocess.ts) | `SshSubprocessRuntime`：池化 spawn 翻译、`ssh -tt` 终端、可执行探测 |
| [`src/ssh.ts`](src/ssh.ts) | OpenSSH argv 纪律（BatchMode、ClearAllForwardings、仅密码用 sshpass）、shell 引用、PQ 横幅剥离 |
| [`src/tools-bash.ts`](src/tools-bash.ts) | 世界的 `bash` 工具：远端主机上 `bash -lc`，输出对齐宿主 |
| [`src/tools-search.ts`](src/tools-search.ts) | 世界的 `grep`/`glob` 工具：与 `world-wsl` 共享的 GNU grep/find 引擎，宿主机型 schema、渲染与卡片 |
| — | 不发布运行时不变量伴随件：本包不拥有事件流；注册表的 `session/world` 不变量已守卫它据以路由的世界文法。 |

会话池、ssh argv 与 fs 帧部分移植自 [dsh-remote-ssh 2.4.15](https://github.com/ZhangFengshun/dsh-remote-ssh)（MIT）；该插件的镜像同步服务在这里变成了直接执行的 `WorldBackend`。

</details>

-----

<a id="进一步探索"></a>
## 进一步探索

阅读这些页面了解本后端注册进的注册表与路由到它的门面。

- [执行世界子系统](../../../docs/subsystems/world.zh.md)——`WorldRef` 文法与领域布局。
- [世界注册表包](../world/README.zh.md)——`ctx.worlds` 与每会话世界记录。
- [世界路由包](../world-router/README.zh.md)——把调用委托给本后端的门面。
- [WSL 世界包](../world-wsl/README.zh.md)——本包复用其 GNU 搜索脚本的姊妹后端。

-----

<a id="模型体验"></a>
## 模型体验

间接地，通过世界自带的 `bash`/`grep`/`glob` 工具——其名称、参数 schema、上限、输出渲染与搜索卡片逐字镜像宿主套件（`dsh-tool-bash`、`dsh-tool-fs-search`）——模型看到同一份契约，只是执行在远端主机上。在 SSH 会话里，这些定义通过工具注册表的世界亲和过滤以同名遮蔽宿主工具。

#### KV 缓存效应

在 SSH 会话里，工具目录把宿主 shell 与搜索工具换成同名等价物；目录的其余部分不动，本地会话的请求前缀与没有本包的组合逐字节一致。

## 已知限制与暂缓工作

<a id="已知限制与暂缓工作"></a>

这些限制定义了本包提供的 SSH 世界。它们是当前的包约束，不是任务清单。

- **profile 修改在启动时生效**——profile 与工作区在插件加载时读一次；编辑 `remote-ssh` settings 条目要下次启动才生效，实时重载对账暂缓。
- **密码认证需要宿主有 sshpass**——密钥认证走 BatchMode（无交互）；密码 profile 经 `sshpass` 执行，没有它的宿主降级为仅密钥 profile。
- **`watch` 设计上拒绝**——没有远端文件事件通道；调用方得到明确的拒绝而非静默空转。
- **GNU grep 不支持 gitignore**——远端 `grep` 显式排除隐藏项与 `node_modules`，但会搜索被 git 忽略的文件；对超大工作区的全树内容搜索可能撞上协作超时，与宿主引擎同一界限。
- **远端围栏是粗粒度的**——可写根是配置的工作区 `remotePath` 加 `/tmp`；每用户 sudo、ACL 与每仓库策略由远端主机自己的强制承担（`enforcement: 'partial'`）。
- **一次会话丢弃会取消其在途命令**——超时、8 MB 溢出与传输丢弃（exit 255）会杀掉池化会话；下一条命令回退到一次性运行，但被中断命令的副作用就是远端 shell 已做的一切。

<a id="开发注记"></a>
### 开发注记

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
