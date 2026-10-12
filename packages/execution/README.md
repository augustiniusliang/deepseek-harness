---
description: "Execution protocol packages for validating commits and testing providers."
kind: "package-group"
---

# execution/ — Execution contracts

English | [中文](README.zh.md)

## Summary

Developers can test optimistic execution commits and inspect explicit volatile receipts. The execution package owns the schemas and reference provider. These tests do not replace production Session persistence or enable background recovery.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group currently contains one protocol development package.

| Package | Role |
|---|---|
| [execution](execution/README.md) | Validate execution commits with a volatile reference provider |

<a id="related-documentation"></a>
## Related documentation

- [Session subsystem](../../docs/subsystems/session.md) — current Session persistence behavior.
- [Package map](../README.md) — adjacent capability groups.

<a id="dev-note"></a>
## Dev Note

None.
