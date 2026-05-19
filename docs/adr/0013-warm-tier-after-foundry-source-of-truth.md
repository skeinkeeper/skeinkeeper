# ADR-0013: Warm-Tier State after Foundry-as-Source-of-Truth

## Status
Accepted (2026-05-19). **Supersedes the warm-tier contents description in [ADR-0002](./0002-four-tier-memory-model.md).** The four-tier framing (hot / warm / cold / episodic) itself remains current; only the per-tier *contents* are revised.

## Context

ADR-0002 (2026-05-17) defined the four-tier memory model. The warm tier was specified as: *"HP, slots, inventory, conditions, location, quest flags, faction reputation, time-of-day"* — stored in SQLite and mutated only via tool calls.

[Design doc 0007 (Foundry-as-source-of-truth)](../design/0007-foundry-as-source-of-truth.md), accepted 2026-05-19, moved mechanical state from Skeinkeeper's SQLite to Foundry. Foundry now owns character sheets (HP, slots, inventory, conditions), NPCs, scenes (location), and dice mechanics. Skeinkeeper continues to own AI-DM-specific state.

The four-tier model is still the right architecture — hot / warm / cold / episodic with distinct mechanisms — but several items previously named as "warm tier" content now live in Foundry rather than in Skeinkeeper's SQLite.

## Decision

**Warm-tier contents are split across two sources.**

| Source | Warm-tier contents |
|---|---|
| Foundry (read via `FoundryClient`) | Party actors (with full per-system sheet — HP/stats/conditions/inventory under D&D 5e; stress/aspects under Fate; debilities/HP under PbtA); NPC actors on the active scene; active scene with description; tokens on scene; combat tracker state |
| Skeinkeeper SQLite (read via `TenantDb`) | Campaign metadata; sessions; audit log; consents; quest flags (AI-DM-internal plot state); deletion log |

**Per-turn warm-state assembly** (in `orchestrator/src/warm_state.ts`) does both reads and produces a single `WarmStateSnapshot` that the hot-context layer consumes. The orchestrator does not need to know which source any field came from — that's a presentation detail handled by the warm-state assembler and the per-system renderer.

**Mutation rules unchanged from ADR-0003**: every change still goes through a typed tool call. Some tools mutate the Skeinkeeper SQLite (e.g., `set_quest_flag`, `advance_time`); others route through MCP to Foundry (e.g., `apply_damage` for D&D 5e — registered by the Foundry plugin at session start once the active system is known). The dispatcher's surface is uniform — only the implementation differs.

## Consequences

**Positive**
- No duplication of mechanical state between Skeinkeeper and Foundry — eliminates a whole class of sync bugs ("we say HP 22, Foundry says 18").
- The Foundry-side system module is authoritative for per-system mechanics; we don't reinvent it.
- Erasure surface shrinks: Skeinkeeper-side erasure adapters cover only AI-DM state, not character sheets. Foundry-side erasure is the operator's responsibility on the Foundry instance and is surfaced in `docs/PRIVACY.md`.

**Negative**
- Per-turn warm-state assembly now requires I/O to Foundry (via MCP). Measured budget in design doc 0007: <100ms — acceptable in a multi-second LLM turn.
- A network glitch or stopped Foundry process means warm-state assembly fails. The orchestrator must handle this gracefully (Phase 3 concern; mocked in unit tests today via `MockFoundryClient`).

**Neutral**
- Cold tier (campaign content, SRD rules) and episodic tier are unchanged by this ADR.
- Hot-tier assembly continues to be a pure function over the assembled warm-state snapshot plus the dialogue window (ADR-0002 / `orchestrator/src/hot_context.ts`).

## Revisit when
- The latency of Foundry MCP round-trips becomes a problem in practice (consider local Skeinkeeper-side caching).
- A non-Foundry VTT driver is added (the warm-state assembler signature already accepts a `FoundryClient`; renaming to a more generic `VttClient` may be appropriate at that point).
- A "Skeinkeeper-only" mode for text-only Discord play (no VTT) becomes a goal, which would route around Foundry entirely.
