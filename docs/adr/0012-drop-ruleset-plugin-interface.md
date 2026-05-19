# ADR-0012: Drop the `Ruleset` Plugin Interface

## Status
Accepted (2026-05-19). **Supersedes [ADR-0004](./0004-plugin-interface-pattern.md) for the Ruleset portion only.** The `LLMProvider`, `VTTDriver`, and `VoiceIO` interfaces from ADR-0004 remain current.

## Context

ADR-0004 (2026-05-17) defined four plugin interfaces — `LLMProvider`, `Ruleset`, `VTTDriver`, `VoiceIO` — as the modular boundaries of the orchestrator. The `Ruleset` interface was specified as "skills, ability scores, dice mechanics, character schema, condition types, encounter scaling, tool set," with `DnD5eRuleset` as the alpha implementation and `Pathfinder2eRuleset` / `CallOfCthulhuRuleset` as v2+ targets.

The `Ruleset` interface had not yet been implemented in code when we revisited it.

[Design doc 0007 (Foundry-as-source-of-truth)](../design/0007-foundry-as-source-of-truth.md), accepted 2026-05-19, identified that Foundry's per-system data models — `actor.system`, validated by each Foundry system's `defineSchema()` module — already provide exactly the abstraction the `Ruleset` interface was meant to provide. The `dnd5e`, `pf2e`, `fate-core`, and PbtA community systems already implement what we were planning to design from scratch. Building a parallel `Ruleset` abstraction in our codebase would be reinventing what an integrated dependency already provides — the anti-pattern captured in [CLAUDE.md hard rule #9](../../CLAUDE.md).

## Decision

**The `Ruleset` plugin interface is dropped.** Per-system mechanics are not Skeinkeeper's concern; Foundry's system module is the abstraction.

The Skeinkeeper-side surfaces that remain:

- **Per-system renderers** (`orchestrator/src/foundry/render.ts`) — small pure functions that format a Foundry actor's opaque `system` blob into a system-specific one-line summary for the LLM prompt. Per-system files: `renderDnd5e`, `renderFateCore`, `renderDungeonWorld`, with a generic fallback. These are not a plugin interface; they're a thin presentation layer.
- **Per-system mutation tools** — registered at session start by the Foundry plugin once the active Foundry system is known. They live in `plugins/vtt-foundry/` (Phase 3). For D&D 5e: `apply_damage`, `heal`, `set_condition`. For Fate: `apply_stress`, `take_consequence`. For PbtA: `apply_harm`, `tick_harm_clock`. These tools wrap MCP calls to Foundry.

The three remaining plugin interfaces from ADR-0004 — `LLMProvider`, `VTTDriver`, `VoiceIO` — stay valid. The "want to add Pathfinder 2e? Implement the `Ruleset` interface" answer from ADR-0004 changes to: "want to add Pathfinder 2e? Make sure the Foundry `pf2e` system module exposes what you need via MCP, add a `renderPf2e` function in `orchestrator/src/foundry/render.ts`, and register per-system tools in `plugins/vtt-foundry/`."

## Consequences

**Positive**
- No parallel ruleset abstraction to design, document, version, or test against ~50+ Foundry community systems.
- Adding support for a new ruleset becomes proportional to *renderer + tool set* — not building a full ruleset module.
- Confirms the design principle that we should not reinvent abstractions an integrated dependency already provides.

**Negative**
- Skeinkeeper depends on Foundry-side system modules for per-system mechanics. If a Foundry system module doesn't expose what we need (rare), we have to contribute upstream or fork the Foundry-side module — not a Skeinkeeper-side fix.
- The "modular contribution surface" message in ADR-0004 is narrower than originally framed. CONTRIBUTING.md is updated accordingly.

**Neutral**
- The LLMProvider, VTTDriver, and VoiceIO interfaces are still where contributions land for those concerns.
- Future scenarios where a non-Foundry VTT becomes a target (e.g., a Roll20 driver in v2+) might require re-introducing something like the `Ruleset` interface *inside the Roll20-specific plugin*, since Roll20's character-sheet model isn't per-system data models the way Foundry's is. The core orchestrator stays Foundry-shaped.

## Revisit when
- A non-Foundry VTT driver is contributed, at which point we evaluate whether per-system rendering needs to be re-abstracted for that driver.
- A Foundry-side system module proves insufficient and Skeinkeeper needs to ship its own mechanics for a specific system.
