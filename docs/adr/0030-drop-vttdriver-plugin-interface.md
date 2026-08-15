# ADR-0030: Drop the VTTDriver plugin interface

Status: accepted
Date: 2026-08-15
Scope: plugin-architecture
Supersedes: the `VTTDriver` portion of [0004](./0004-plugin-interface-pattern.md)

## Context

[ADR-0004](./0004-plugin-interface-pattern.md) defined four plugin interfaces,
including `VTTDriver`, so a second VTT (Owlbear, Roll20) could be a contained
PR. [ADR-0012](./0012-drop-ruleset-plugin-interface.md) already dropped
`Ruleset` because Foundry's system modules *are* the ruleset. [ADR-0018](./0018-foundry-source-of-truth.md)
then made Foundry authoritative for mechanical state, and [ADR-0025](./0025-foundry-as-table-text-and-operator-surface.md)
made Foundry the table-text surface. PRD-rev `5c3a198` (FR-F1) states Foundry
is the only VTT at every roadmap phase. A second VTT would reintroduce a
ruleset schema and an audience/whisper model those products do not have.

## Decision

**There is no VTT plugin contribution surface.** Foundry is the table.

- `LLMProvider` and `VoiceIO` from ADR-0004 remain.
- `FoundryClient` stays as an internal test seam, not as a public "write an
  Owlbear driver" interface.
- Issue templates and CONTRIBUTING do not invite VTT plugins.

## Consequences

**Positive.** The same class of fiction that produced a third-party Foundry
connector is gone. Design effort goes into one table.

**Negative.** A hypothetical future second VTT is a new product, not a plugin.

## Revisit when

- A VTT appears that already owns per-system actor data and an audience-aware
  chat model equivalent to Foundry's. That would be a new ADR, not a plugin.
