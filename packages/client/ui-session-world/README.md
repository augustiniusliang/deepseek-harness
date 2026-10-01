---
description: "The session execution-world chip for readers composing or debugging the web conversation header."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-world

English | [中文](README.zh.md)

## Summary

A read-only chip in the session header naming the execution world the session runs in: `Local`, `WSL · <distro>`, or `SSH · <profile>`, read from the session's `world` projection. There is no world switch — a session's world follows from its workspace path, so the hover tooltip carries the full reference and states the routing is automatic. The new-session hero takes no seat: the workspace chip already implies the world a fresh session starts in.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in the web client composition (the web-app bundle mounts it beside the other conversation-header surfaces) whenever sessions may run outside the local world.

### When to choose it

Choose it for any deployment that composes non-local execution worlds (WSL distributions, SSH profiles). With only the local world composed, the chip still renders `Local`, which is honest but adds no information; skip it there if header width matters.

### Minimal configuration

The package takes no config; mount it and let it read the projection:

```yaml
- id: ui-session-world
  name: '@deepseek-ai/dsh-client-ui-session-world'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one `conversation.session.header.actions` slot entry (`id: 'session-world'`, order −9, trailing the agent-preset label's −10 in the header's static-context band) and one `session.world` locale namespace (zh/en). The component subscribes the session list's `projectionValues.world` through the framework `useSessions` hook and renders nothing when the projection is absent. The ref-to-label mapping is a pure exported function (`worldLabel`): `local` translates, `wsl:<distro>[:user]` drops the user and names the distribution, `ssh:<profileId>` names the profile, and unknown shapes pass through verbatim so future world kinds degrade to their reference text. The host half is an empty apply so the plugin appears in the Loader.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty host apply (Loader presence only) |
| [`src/client/index.ts`](src/client/index.ts) | Browser apply: locale namespace + header slot registration |
| [`src/client/SessionWorldLabel.tsx`](src/client/SessionWorldLabel.tsx) | The chip component: projection read, tooltip, container-query yield |
| [`src/client/locales.ts`](src/client/locales.ts) | zh/en dictionaries and the pure `worldLabel` mapping |
| — | No runtime invariant companion is published: the package owns no event stream; the world registry's `session/world` invariant guards the grammar it displays. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Execution worlds subsystem](../../../docs/subsystems/world.md) — the `WorldRef` grammar the chip parses and the projection it reads.
- [Agent-preset label](../ui-agent-preset/README.md) — the sibling header chip this package's structure mirrors.

-----

<a id="model-experience"></a>
## Model Experience

None, as the chip displays an already-projected fact to humans and registers no prompt, tool, or model-visible context of its own.

#### KV Cache effect

None; the chip never enters a provider request, and a session's request prefix is byte-identical with or without this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the chip this package provides. They are current package constraints, not a task backlog.

- **Display only, by design** — there is no world switch; the chip offers no action, and world selection stays a consequence of the workspace path. A world picker would be a separate feature with its own host support.
- **Unresolved profiles show their id** — the chip maps `ssh:<profileId>` to the raw profile id; a friendly display name would need the remote-ssh settings catalog on the client, which is deferred to the SSH settings surfaces.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
