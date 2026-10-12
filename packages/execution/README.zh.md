---
description: "用于校验提交并测试提供方的执行协议包组。"
kind: "package-group"
---

# execution/ — 执行契约

[English](README.md) | 中文

## 概述

开发者可以测试乐观执行提交，并检查明确标为易失的回执。execution 包拥有 schema 与参考提供方。这些测试不替代生产 Session 持久化，也不启用后台恢复。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

本组目前包含一个协议开发包。

| 包 | 职责 |
|---|---|
| [execution](execution/README.zh.md) | 通过易失参考提供方校验执行提交 |

<a id="related-documentation"></a>
## 相关文档

- [Session 子系统](../../docs/subsystems/session.zh.md) — 当前 Session 持久化行为。
- [包地图](../README.zh.md) — 相邻能力组。

<a id="dev-note"></a>
## 开发备注

无。
