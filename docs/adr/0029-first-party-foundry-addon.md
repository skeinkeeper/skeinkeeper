# ADR-0029: First-party Foundry add-on; no third-party connector

Status: accepted
Date: 2026-08-15
Scope: vtt-integration
Supersedes: [0011](./0011-prefer-oss-foundry-mcp-bridges.md)

## Context

[ADR-0011](./0011-prefer-oss-foundry-mcp-bridges.md) chose a third-party Foundry MCP
bridge so Skeinkeeper would not maintain Foundry-side code. The surface model
([ADR-0025](./0025-foundry-as-table-text-and-operator-surface.md)) then made
Foundry the table-text and operator surface. The capabilities that model needs —
audience-targeted chat, chat events, server-side rolls with modes, filtered
whisper deletion, user enumeration — do not exist on the bridges, and the
bridge maintainers optimize for a different client (a chat LLM talking to a
world). PRD-rev `5c3a198` withdraws the third-party connector and requires
Skeinkeeper-provided Foundry support (FR-F2) that fails closed when missing
(FR-F6).

## Decision

**Skeinkeeper ships its own Foundry add-on.** The operator enables that add-on
in their world. The add-on is the only supported Foundry integration.

- A third-party Foundry connector is a non-goal, including the bridges named
  in ADR-0011.
- Foundry remains the only VTT ([ADR-0030](./0030-drop-vttdriver-plugin-interface.md)).
- The add-on does not phone home ([ADR-0009](./0009-telemetry-opt-in.md)).
- How the add-on talks to the operator's Skeinkeeper process is a TDD concern
  ([TDD 0041](../tdd/0041-first-party-foundry-addon.md)).

## Consequences

**Positive.** The table-text capabilities become work we can ship. The operator
installs one Foundry add-on from the Skeinkeeper project, not a second product.
Foundry version compatibility is one axis, not two.

**Negative.** We own Foundry v13/v14 add-on maintenance. Foundry majors will
break our add-on, not someone else's.

**Neutral.** `FoundryClient` remains the orchestrator's internal seam
(tests still use `MockFoundryClient`). It is not a public VTT plugin.

## Revisit when

- Foundry ships a first-party API that makes an add-on unnecessary.
- A Foundry major we cannot absorb forces a compatibility fork.
