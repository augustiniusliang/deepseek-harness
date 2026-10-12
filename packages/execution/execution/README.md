---
description: "Validate execution commits and test optimistic concurrency with a volatile reference provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-execution

English | [中文](README.zh.md)

## Summary

Developers can validate execution records and test rejected commits without changing production Sessions. The reference provider checks revisions, ownership and logical operation transitions before publishing a batch. Its receipts explicitly report volatile storage. Process exit loses all reference state; this package does not enable durable execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the exported schemas at JSON boundaries and the named reference provider in isolated test compositions.

### When to choose it

Choose this package for protocol contract tests. Keep production Session persistence on its existing provider. A successful reference commit supplies no authority to dispatch an external effect.

### Minimal configuration

A fixture module can re-export the named provider as its default:

```js
export { ReferenceExecutionCoordinator as default } from '@deepseek-ai/dsh-execution'
```

Mount that fixture in `cordis.yml` and declare `inject = ['execution']` in its consumer. The [Loader test](tests/loader.spec.ts) runs this composition through a real isolated headless host. Loading the package's abstract default export directly throws an error.

| Field | Default | Meaning |
|---|---|---|
| — | — | The reference provider accepts no configuration fields. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The coordinator validates a complete request before replacing its in-memory maps. Duplicate transaction and command identities return the original receipt only when their admitted data agree. Rejected Session sequence checks leave Run and Activity snapshots unchanged. Version readers require an explicitly registered adjacent migration; they reject future versions and missing migrations.

| Source | Responsibility |
|---|---|
| [service.ts](src/service.ts) | Provider boundary and receipt lookup |
| [schema.ts](src/schema.ts) | JSON admission and provisional execution version |
| [reference.ts](src/reference.ts) | Atomic in-memory reference behavior |
| [readers.ts](src/readers.ts) | Explicit migration registration |
| [protocol.spec.ts](tests/protocol.spec.ts) | State, ownership and acknowledgement contracts |

No runtime invariant companion is published. This reference provider owns no production event stream; contract tests verify its map and receipt behavior.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Execution packages](../README.md) — capability map.
- [Session subsystem](../../../docs/subsystems/session.md) — current production history and persistence.
- [Durable test runtime](../../test-support/durable-runtime/README.md) — real process fixtures.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This package is a protocol development checkpoint, not a frozen downstream contract.

- The reference provider loses all state on exit and cannot prove restart recovery.
- Atomic mutations currently cover Runs and Activities. Input, wait, budget and handoff schemas do not yet have coordinator mutations.
- Session appends validate sequence and required-event vocabulary but do not store event content or update a real Session.
- Attempts cannot yet be replaced on a logical operation. No external retry, recovery grant or shared budget policy is implemented.
- No production profile loads this provider. The reference event is fixture-only and is not a SessionEventMap extension.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
