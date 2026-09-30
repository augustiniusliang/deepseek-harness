---
description: "dsh Web 客户端右侧 Sidebar 的文件树 tab 类型：会话的根目录（工作区根目录与额外可写根目录）通过网络逐层列出，按资源地址把文件打开到 Sidebar。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-files

[English](README.md) | 中文

## 概述

浏览 Session 的各个根目录，并在 Sidebar 预览中打开文件。各个根目录与已展开目录通过直接子项监听自动刷新，手动重新读取仍可用。该 tab 从引导页进入，不认领资源地址。

## 目录

- [注册了什么](#what-it-registers)
- [树](#the-tree)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册了什么

命令 `workspace.files` 在焦点分栏内打开或聚焦文件页；从聊天区触发时使用当前会话的活动停靠分栏。文件页替换开始页，同一分栏内重复打开仍保留一个文件页。桌面默认键为 Mod+P。开始页入口显示有效快捷键；Windows 和 macOS Web 使用[快捷键服务的平台默认值](../shortcuts/README.zh.md)；Linux Web 默认不绑定此命令。

- **类型**：`ctx.sidebarRightTabs.register(...)`，kind 为 `files`，id 为 `@deepseek-ai/dsh-client-ui-sidebar-files`，档位 `builtin`，没有 patterns，另有一个打开该类型的引导页入口（order 10，标题与描述取自 `sidebarFiles` 命名空间，图标为黄色文件夹）。
- **正文**：以该 id 为键的 `sidebar.right.pane.tab` slot：strip 下的一行标题行，然后是树。共享的 [`PathLabel`](../ui-primitives/README.zh.md#component-catalog) 显示根路径，目录使用弱化颜色，最后一段使用主色。路径过长时保留尾部字符并在左侧渐隐；悬停显示完整路径。重新读取控件位于右端。
- **标签页标题**：以该 id 为键的 `sidebar.right.pane.tab.title` slot：类型标签前的一枚 16px 共享 `FileTypeIcon` 文件夹图标。树本身的行不画这枚图标。

`src/client/` 下的源文件：`definition.tsx`（类型是什么）、`store.ts`（它保存什么）、`face.ts`（Remote 读取与监听）、`directory-node.ts`（打开的目录及其生命周期）、`FilesBody.tsx`（它画什么，含排序与失败行两个辅助函数）、`FilesTitle.tsx`（标签页标题）、`locales.ts`（它说什么）、`index.ts`（接线）。

<a id="the-tree"></a>
## 树

根是会话的工作目录，读自 `useSessions().byId[sessionId].cwd`，随后是它的额外可写根目录，来自 `sandboxExtraRoots` 投影（`useProjection`）；Host 随这些根目录的记录推送该投影，因此 tab 打开期间新增或移除的根目录会重新植入树，无需重新打开。只有一个根目录的会话把该根目录的子项直接画在标题行下，与旧版完全一样；多于一个根目录时，每个根目录各占一行顶层行，行名取文件夹名，完整路径在悬停时显示，主要根目录在前。相对路径仍相对主要根目录解析。`/` 和 Windows 盘根等文件系统根路径均可作为树的根。每一层以绝对路径为键；子路径是父路径以 `/` 拼上条目名。一层在首次展开时经 `@deepseek-ai/dsh-api-workspace-files` 命名空间的 `remote.workspaceFiles.list(sessionId, absolutePath)` 列出，该端点接受会话任一根目录内的目录；适配器保留列表的条目与截断标志，丢弃其相对所属根目录的路径。行序为目录优先，其后按自然序、不分大小写的名称排列；dotfiles 与其他条目一样显示。

| 条目类型 | 行 |
|---|---|
| `directory` | 切换展开与折叠；再次打开时重新列举，并恢复仍存在的已展开后代。折叠期间保留已显示条目的缓存。 |
| `file` | 经 `useTabInfo().tab.actions.openResource` 打开 `dsh-resource://file/session/<sessionId>/<encoded path>`，地址由 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor` 从条目的绝对路径与主要根目录生成，落在该 tab 自己的 pane 里。主要根目录下的文件保持与旧版相同的相对根目录地址；额外根目录下的文件在同一会话作用域地址中携带其绝对路径，由 Host 按会话解析。 |
| `other` | 灰显且不可点击，从而完整呈现目录内容。 |

被端点条目上限截断的层以一条标记收尾；空层如实说明；失败的层按错误码各显示一行（`workspace-file/not-found`、`outside-workspace`、`not-directory`），其他情况显示传输层自己的消息。重新读取就地刷新每个根目录与展开中的层，读取期间保留显示条目，不重置整棵树；折叠的层在下次打开时重新拉取。没有工作目录的会话只显示一行说明，而不是树。

状态保存在类型自己的存储里，按 tab id 分桶：`roots`、`levels`（每个绝对路径的 loading / ready / failed）、`expanded`、`autoRefresh` 与 `scrollTop`——滚动期间偏移由正文自己记录，卸载时一次性写入。存储比 body 活得久，切到其他侧栏 tab 再切回来时树带着已加载的层重新挂载，滚动位置也随之恢复。owner 的 `signal` 终结一个桶：中止时忘掉该 tab，其后才结算的列表与卸载时的偏移提交都什么也不写。

每个打开的 `DirectoryNode` 在 Tab 生命周期内持有自己的目标监听，每个根目录一个；折叠关闭该节点及其不可见后代，会话移除某个根目录时也以同样方式关闭其节点，其缓存层随之离开存储。祖先恢复期间的展开状态变化会更新存储和待恢复节点，后代恢复时遵循最新展开偏好。自动刷新默认开启；独立开关暂时隐藏，状态、文案、样式与切换逻辑保留。目录读取期间或收尾时收到的变化仍会留待下一次刷新。

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器里绘制工作区文件树，不注册任何面向模型的内容。

#### KV Cache 影响

无；目录列表经 Remote 传输，不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>
- **只有列目录。**没有搜索、产物过滤、拖拽、重命名、右键菜单或当前文件高亮。
- **根目录来自 Session。**树显示会话的工作目录及其日志授予的额外根目录；只有 Host 为该会话折叠并推送 `sandboxExtraRoots` 时，额外根目录才会到达这里，因此没有该投影的 Host，或 cold 会话，只显示工作目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

页面刷新快捷键通过常规目录读取器刷新聚焦的文件树。重新读取控件在悬停和键盘聚焦时显示有效绑定。

</details>

**运行时不变量：** 不发布 companion。tab 持有的 face 内部管理目录读取与监听，并通过 Slot store 写入显示状态；tab 取消时释放二者。本包未暴露可用于运行时比对的独立观测源。
