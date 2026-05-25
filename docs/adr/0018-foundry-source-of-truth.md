# ADR-0018: Foundry is the authoritative source of truth for mechanical state

Status: accepted
Date: 2026-05-24
Scope: state-ownership
Relates to: ADR-0002, ADR-0004, ADR-0011, ADR-0012, ADR-0013

> This ADR formalizes a decision originally made and recorded in
> [TDD 0007 (Foundry-as-Source-of-Truth)](../tdd/0007-foundry-as-source-of-truth.md),
> accepted 2026-05-19. It is documented as an ADR now, during the docs migration, because
> several accepted ADRs (0011, 0012, 0013) already build on it without ever stating it.
> The *design* of how this is implemented (the `FoundryClient` interface, the SQLite
> schema, per-system renderers) stays in TDD 0007; this ADR records only the decision.

## Context

The initial state-schema design (TDD 0005) gave Skeinkeeper its own first-class
`characters`, `npcs`, `locations`, and `faction_reputation` tables with D&D-shaped columns
(HP, conditions, disposition, reputation-as-integer). A critical architectural review
surfaced two problems:

1. **D&D-coupled primitives don't generalize.** Fate Core has no HP (stress tracks +
   consequences); PbtA games often have no HP either (harm clocks); conditions, disposition,
   and faction relationships are modeled differently in every system. A Skeinkeeper-owned
   mechanical schema would be a D&D schema wearing a generic name.
2. **Foundry already solves this.** Foundry's per-system data models (`actor.system`,
   validated by each system's `defineSchema()`) are exactly the ruleset-pluggable layer we
   were about to build from scratch. The `dnd5e`, `pf2e`, `fate-core`, and PbtA community
   systems already cover the long tail of mechanics.

## Decision

**Foundry is authoritative for mechanical game state; Skeinkeeper never duplicates it.**

- Foundry owns: player/NPC actors (full sheets — HP, stats, conditions, inventory, whatever
  the active system defines), scenes/locations, tokens (placement, disposition, fog),
  the combat tracker, server-side dice, and compendium content. Skeinkeeper holds *references*
  (Foundry actor/scene IDs), not copies.
- Skeinkeeper owns only AI-DM-specific state in its SQLite: `tenants`, `campaigns`,
  `sessions`, `audit_log`, `consents`, `deletion_log`, and `quest_flags` (the AI's internal
  plot/quest state, deliberately separate from Foundry's official world state).
- All application code reaches Foundry exclusively through the `FoundryClient` interface over
  the MCP bridge — never a direct, system-specific path.

## Consequences

- **No custom ruleset abstraction.** This is what lets us drop the `Ruleset` plugin interface
  (ADR-0012) and split the warm memory tier across Foundry + SQLite (ADR-0013).
- **Per-system mechanics** become a thin presentation concern — per-system renderers that
  format the opaque `actor.system` blob, plus per-system mutation tools registered at session
  start — not a stored schema.
- **A per-turn read dependency on Foundry.** Skeinkeeper's mechanical view is only as available
  as the Foundry connection; on disconnect it degrades to chat-only narration with state
  preserved (it never invents mechanical state to fill the gap).
- Reversing this (giving Skeinkeeper its own authoritative mechanical store again) would be a
  superseding ADR, not an in-place change.
