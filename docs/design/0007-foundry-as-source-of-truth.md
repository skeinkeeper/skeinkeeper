# Design Doc 0007: Foundry-as-Source-of-Truth

> Status: Accepted
> Author: maintainers
> Date: 2026-05-19
> Related ADRs: [ADR-0011 (Foundry MCP bridge — supersedes 0001)](../adr/0011-prefer-oss-foundry-mcp-bridges.md), [ADR-0002 (four-tier memory)](../adr/0002-four-tier-memory-model.md), [ADR-0003 (tool-call-only mutation)](../adr/0003-tool-call-only-state-mutation.md), [ADR-0004 (plugin interfaces)](../adr/0004-plugin-interface-pattern.md), [ADR-0008 (tenant scoping)](../adr/0008-tenant-scoping.md)
> Supersedes: parts of design doc [0005 (state schema)](./0005-state-schema.md)

## Context

The initial state-schema design (doc 0005) gave Skeinkeeper its own first-class `characters`, `npcs`, `locations`, and `faction_reputation` tables with D&D-shaped columns (HP, conditions, disposition, reputation-as-integer). A critical architectural review surfaced two things:

1. **D&D-coupled primitives don't generalize.** Fate Core has no HP (stress tracks + consequences); PbtA games often have no HP either (harm clocks). Conditions are an aspect-with-free-invokes in Fate, a list-of-debility-flags in PbtA, a Boolean status array in D&D. NPC disposition is a binary enum only in D&D-style games. Faction-relationships-as-integer is D&D / Pathfinder; Fate uses aspects, PbtA uses clocks.
2. **Foundry already solves this.** Foundry's per-system data models (`actor.system`, validated by each system's `defineSchema()`) are exactly the ruleset-pluggable layer we were about to build from scratch. The dnd5e, pf2e, fate-core, and PbtA community systems cover the long tail of mechanics. We were about to reinvent it.

This design records the resulting architectural shift: **Foundry owns mechanical state; Skeinkeeper owns AI-DM-specific state.**

## Decision

### Foundry is authoritative for mechanical state

The following entities live in Foundry, accessed via the MCP bridge:

- **Characters / Player Actors** — full sheet, HP, stats, conditions, inventory. Whatever the active Foundry system defines.
- **NPCs** — same. NPCs are Foundry actors of type `npc`.
- **Locations / Scenes** — Foundry Scenes plus linked Journal entries.
- **Tokens** — placement, disposition, visibility, fog-of-war reveal.
- **Combat tracker** — initiative order, current turn, conditions in play.
- **Dice rolls** — server-side, visible in Foundry chat, audit-logged on Foundry's side.
- **Compendium content** — SRD rules, monster stat blocks, items.

Skeinkeeper **does not duplicate** any of this in its own database. We hold references (Foundry actor IDs, scene IDs) when needed; the canonical state lives in Foundry.

### Skeinkeeper owns AI-DM-specific state

The following stays in Skeinkeeper's SQLite (`server/`):

- **`tenants`, `campaigns`** — operator and campaign metadata. A campaign references one Foundry world.
- **`sessions`** — AI DM sessions (not Foundry play sessions). Tracks behavior-spec version, start/end times, post-session summary.
- **`audit_log`** — every AI tool call, state mutation request, behavior decision. Per ADR-0003 + ADR-0010.
- **`consents`** — per-player voice-processing consent (keyed on Discord ID, not Foundry user ID).
- **`deletion_log`** — anonymous erasure trail.
- **`quest_flags`** — AI-DM-internal world state. The AI's view of plot/quest progression, kept separate from Foundry's official world state so operators can curate what's visible to players.

### The `FoundryClient` interface

Application code (orchestrator, tool handlers) interacts with Foundry exclusively through a `FoundryClient` interface:

```ts
export interface FoundryActor {
  id: string;
  name: string;
  type: "character" | "npc" | string;
  system: string;                 // "dnd5e" | "fate-core" | "dungeon-world" | etc.
  sheet: Record<string, unknown>; // Foundry's `actor.system` blob — opaque
  flags?: Record<string, unknown>;
}

export interface FoundryScene {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  tokens: ReadonlyArray<{ actorId: string; name: string; disposition?: number }>;
}

export interface FoundryClient {
  readonly system: string;
  listPartyActors(): Promise<FoundryActor[]>;
  listSceneActors(sceneId: string): Promise<FoundryActor[]>;
  getActor(actorId: string): Promise<FoundryActor | null>;
  getActiveScene(): Promise<FoundryScene | null>;
  applyActorUpdate(actorId: string, update: Record<string, unknown>): Promise<void>;
  rollDice(formula: string, opts?: { speaker?: string; whisperTo?: string[] }): Promise<{ total: number; rolls: number[]; formula: string }>;
}
```

Two implementations:
- `MockFoundryClient` — in-memory; used by orchestrator unit tests. No network or Foundry process required.
- `McpFoundryClient` (Phase 3) — wraps the MCP bridge selected per ADR-0011 (adambdooley default).

### Per-system rendering, not per-system schema

Because Foundry's `actor.system` blob is opaque to our orchestrator, we need a thin per-system layer that formats it for the LLM's system prompt:

```ts
export function renderActorState(actor: FoundryActor): string {
  switch (actor.system) {
    case "dnd5e":        return renderDnd5e(actor);
    case "fate-core":    return renderFateCore(actor);
    case "dungeon-world": return renderDungeonWorld(actor);
    default:             return renderGeneric(actor);
  }
}
```

These renderers are pure functions, small per-system files, no schema validation. They produce one-line summaries like:
- D&D: `"Aragorn — HP 22/30, AC 18 [frightened]"`
- Fate: `"Aragorn — physical 1/2, mild: 'Shaken by what I saw'"`
- DW: `"Aragorn — HP 18/22, armor 1, debilities: weak"`
- Generic fallback: lists recognizable top-level fields (`hp`, `stress`, `harm`, `health`) if present.

Generic fallback is fine for systems we haven't added a renderer for — the LLM gets less-pretty-but-functional state.

### Tool-call dispatch in this architecture

Two categories of state-mutation tools:

**Skeinkeeper-owned** (write directly to our SQLite via `TenantDb`):
- `set_quest_flag`, `move_party`, `advance_time`, `whisper`, `fudge_roll`

**Foundry-routed** (translate to MCP calls; system-aware; registered at session start once the active Foundry system is known):
- D&D 5e: `apply_damage`, `heal`, `set_condition`, `clear_condition`, `update_inventory`, `update_npc_disposition`
- Fate Core: `apply_stress`, `take_consequence`, `invoke_aspect`, etc.
- Dungeon World: `apply_harm`, `tick_harm_clock`, `mark_debility`, etc.

The Foundry-routed tool *definitions* live in `plugins/vtt-foundry/` (where the chosen MCP bridge adapter also lives — landing in Phase 3). They register into the existing `ToolRegistry` at session start. Their handlers translate the typed input into MCP calls and into Foundry actor updates.

The `roll` tool stays in core but its implementation in Phase 3 delegates to `foundry.rollDice()`, so rolls land in Foundry's chat log and are visible to players.

### What about ruleset abstraction?

We had planned a `Ruleset` plugin interface (per the earlier ruleset-agnostic refactor plan). **We drop it.** Foundry's system module is the ruleset abstraction. We add:

- Per-system renderers (small pure functions) for the LLM prompt
- Per-system tool sets (in the Foundry plugin, registered conditionally)
- A `system` identifier on the campaign (read from Foundry at session start)

That's it. No `characterSheet: ZodSchema`, no `dice: DiceMechanic` plugin interface, no behavior overlays per ruleset. Foundry's system module owns those.

### Why not Roll20 / Owlbear?

Foundry is a deliberate bet — see ADR-0001 (the underlying "use a Foundry MCP bridge" decision) and ADR-0011 (the bridge selection). Roll20 is more popular but its character-sheet model is closed and not ruleset-pluggable the way Foundry's is. If a future v2+ port to Roll20 is wanted, that adapter would have to re-introduce something like the dropped `Ruleset` interface inside the Roll20-specific plugin — because the data won't come from Roll20 in a usable per-system shape. The core orchestrator stays unaffected.

## Alternatives considered

- **Keep our own characters/npcs/locations tables and sync to Foundry.** Rejected: sync bugs ("we say HP 22, Foundry says 18") are a class of failures we can avoid entirely by deferring to Foundry. Adds latency we measured at <100ms via MCP, acceptable.
- **Build our own `Ruleset` plugin interface from scratch.** Rejected: re-implementing what Foundry already provides. ~50+ ruleset systems live and maintained by Foundry's community would have to be redone.
- **Use the alexivenkov MCP bridge** (Patreon-gated). Rejected per ADR-0011: conflicts with project's OSS-first stance.
- **Build our own MCP bridge from scratch.** Rejected: 2–4 weeks of work duplicating what adambdooley and laurigates already provide. The fork-as-Plan-B clause in ADR-0011 covers the case where we can't get upstream changes accepted.

## Telemetry implications

No new events. The existing `tool.called` event covers tool dispatches whether they route to SQLite (quest flags, advance_time, whisper, fudge) or to Foundry (D&D-specific tools). Foundry-call latency may show up in the bucket; that's intentional — operators can observe MCP performance via opted-in analytics.

## Privacy implications

- Foundry's data stays on the operator's Foundry instance. Skeinkeeper never copies actor sheets into its own store. This is a privacy *improvement* — less duplication, smaller surface.
- The `audit_log` may record actor IDs and partial sheet snapshots inside `payloadJson` (e.g., "applied 5 damage to actor `abc-123`, HP went 22→17"). Per design doc 0002 this is PII-adjacent and is covered by the existing encryption-at-rest plan.
- Foundry user identity is *not* the same as Discord user identity. The consents table remains keyed on Discord ID (where voice consent matters); Foundry-side user identity isn't surfaced to Skeinkeeper's privacy layer.

## Eval implications

The eval harness (design doc 0004) becomes more capable: fixtures can specify a starting Foundry state (via `MockFoundryClient` setup), exercise the orchestrator, and assert on tool calls + resulting Foundry-side mutations. The mock lets us run behavior evals without a live Foundry instance. Real-Foundry integration tests are deferred to Phase 3.

## Open questions

- **Will the chosen MCP bridge cover everything we need for reads?** Specifically: querying the full actor sheet (all system fields, not just HP), listing tokens on a scene with their actor links, reading active conditions/effects. We verify this empirically when we wire the real `McpFoundryClient` in Phase 3. If gaps exist, we contribute upstream or fork.
- **Latency budget.** Per-turn warm-state assembly now makes several MCP round-trips. We measure in Phase 3 and document the budget. Expectation: <100ms total, acceptable in a multi-second LLM turn.
- **Foundry version skew.** When Foundry releases v14/v15, the MCP bridge must keep up. If it lags, our tests catch the divergence; if it's persistent, that's a fork trigger.
- **Operator without Foundry.** Currently impossible. The PRD already requires Foundry; this design hardens that requirement. If a future "no-VTT-just-Discord-text" mode is wanted, we'd need a `NoopFoundryClient` or a separate orchestrator path. Out of scope for alpha.
