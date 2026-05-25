# TDD 0022: DM-Action Coverage Audit (Foundry + MCP bridges)
Status: implemented
PRD refs: 4.2, 4.3
PRD-rev: 10391ba
ADR constraints: 0011, 0015
Author: maintainers
Date: 2026-05-20
Related TDDs: [0007 (Foundry-as-source-of-truth)](./0007-foundry-as-source-of-truth.md), [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md)

## Approach

ADR-0015 says the AI must perform **every** in-play DM table action; any that falls to the operator is a bug. This audit makes that concrete: for each in-play DM **action** (the VTT-handled kind, not AI judgment), it records (1) whether **Foundry** supports it natively and (2) whether our current **bridge** (`adambdooley/foundry-vtt-mcp`, 37 tools) exposes it. It then compares competing bridges and proposes the additions needed to close the gaps.

## Components & interfaces

### Scope — what counts as a "DM table action"

**In scope** (VTT *actions* a DM performs at the table): show/switch maps, move/show/place tokens, apply conditions/damage, roll dice, run combat, reveal fog, surface monster/spell/rule content, track quests.

**Out of scope** (DM *judgment* — the AI's brain, never a VTT action, per ADR-0015 §corollary 4): deciding what an NPC does, narrating, setting DCs, interpreting rules, pacing, plot. A VTT shouldn't do these and neither should the bridge.

### Coverage table

✅ supported · ⚠️ partial · ❌ missing

| DM in-play action | Foundry native? | Current bridge (adambdooley) |
|---|:--:|---|
| Show current map + token positions | ✅ | ✅ `get-current-scene` |
| **Switch/activate the map as the party moves** | ✅ | ✅ `switch-scene`, `list-scenes` |
| **Reveal fog of war as they explore** | ✅ | ❌ |
| Move a token | ✅ | ✅ `move-token` |
| Show/hide a token; set disposition | ✅ | ✅ `update-token` |
| **Spawn a monster token onto the scene at a position** | ✅ | ⚠️ `create-actor-from-compendium` (creates the actor; placing a token at coords on the active scene is unclear) |
| Delete a token | ✅ | ✅ `delete-tokens` |
| Apply/remove a condition (prone, poisoned…) | ✅ | ✅ `toggle-token-condition`, `get-available-conditions` |
| Apply an arbitrary active effect/buff/debuff | ✅ | ⚠️ conditions only |
| Ask a player to roll | ✅ | ✅ `request-player-rolls` |
| **Roll dice for an NPC / a secret GM roll** | ✅ | ❌ (only player-facing rolls) |
| **Apply damage / change HP** | ✅ | ❌ |
| **Apply healing** | ✅ | ❌ |
| Use an item/ability; consume a resource | ✅ | ✅ `use-item` |
| Give a character an item (loot) | ✅ | ✅ `add-actor-items` |
| **Start / end a combat encounter** | ✅ | ❌ |
| **Add combatants to the tracker** | ✅ | ❌ |
| **Roll initiative** | ✅ | ❌ |
| **Advance turn / round** | ✅ | ❌ |
| Look up a monster/spell/rule mid-game | ✅ | ✅ `search-compendium`, `get-compendium-item`, `get-compendium-entry-full`, `list-creatures-by-criteria` |
| Read / create / update quest journals | ✅ | ✅ `list/search/create/update-quest-journal`, `link-quest-to-npc` |
| Assign actor ownership (mostly pre-game) | ✅ | ✅ `assign/list/remove-actor-ownership` |
| Post a chat message / whisper in Foundry | ✅ | ⚠️ none generic (Skeinkeeper narrates via Discord voice, so low priority) |
| Adjust lighting / time-of-day (ambient) | ✅ | ❌ (cosmetic; low priority) |
| Toggle a door / reveal a secret passage | ✅ | ❌ (low priority) |

**Bridge bonus (beyond table actions):** AI battlemap generation (`generate-map` via ComfyUI), campaign dashboards. Nice-to-have, not invariant-critical.

### The gaps that violate ADR-0015 (Foundry ✅, bridge ❌/⚠️)

Invariant-critical (the AI genuinely can't run a normal session without these, so the operator would have to step in):

1. **Combat tracker control** — start/end combat, add combatants, roll initiative, advance turn. *(none of the bridges have this — see below)*
2. **GM/secret dice rolls** — roll for monsters and hidden checks, not just request rolls from players.
3. **Apply damage / set HP / heal** — the core "you take 7 damage" loop (the doc-0014 mutation gap).
4. **Fog-of-war reveal** — so exploration actually uncovers the map.
5. **Spawn a token onto the active scene at a position** — drop the monsters where the fight is.

Lower priority: arbitrary active effects, lighting, doors, Foundry chat posts.

### Competing bridges

| Capability | adambdooley (current) | laurigates | TheStranjer |
|---|:--:|:--:|:--:|
| Maturity / activity | most complete; active (v0.6.x) | read-leaning; active | early; active |
| License | MIT | MIT | MIT |
| Scene switch/activate | ✅ | ❌ | ❌ |
| Token move/show/delete/conditions | ✅ | ❌ | ❌ |
| Compendium / quests / journals | ✅ (rich) | ⚠️ search/read | ⚠️ generic read |
| GM/server-side dice roll | ❌ | ✅ `roll_dice` | ❌ |
| Apply damage / set HP | ❌ | ❌ | ⚠️ via generic `modify_document` |
| Combat tracker control | ❌ | ❌ (planned) | ❌ (read combats only) |
| Fog of war | ❌ | ❌ | ❌ |
| Writes model | semantic tools | mostly read-only | generic CRUD (`create/modify/delete_document`) |

**Read:** `adambdooley` is by far the most complete for *table actions* (scenes, tokens, conditions, compendium, quests) and the most active. `laurigates` adds GM dice but is otherwise read-only. `TheStranjer` offers generic document writes (so it *can* set HP via `modify_document`) but has no scene/token/combat/dice semantics. **No bridge has combat-tracker control or fog of war.**

### Recommendation

- **Stay on `adambdooley`** — it's the best base by a wide margin, and the gaps are shared by the field (so they're worth fixing once, upstream).
- **Don't fork yet.** Propose the additions below to the maintainer first (the owner has been receptive/active). Fork only if upstream declines or stalls (the ADR-0011 fork-as-Plan-B clause).
- **In the meantime,** wire everything the bridge *already* supports (scene switching is first — see the build alongside this doc). The McpFoundryClient already throws actionable errors for the unsupported mutations (doc 0014); those error paths become the to-do list.

### Proposed additions to send the maintainer (priority order)

1. **Combat tracker tools** — `start-combat`, `end-combat`, `add-to-combat` (tokens/actors), `roll-initiative` (all or one), `next-turn` / `previous-turn` (returns whose turn it is). *Foundry API: the `Combat`/`Combatant` documents.*
2. **GM dice roll** — `roll-dice { formula, flavor?, mode?: public|gm|blind, whisperTo?: userIds }`, returning the result, so the AI rolls for NPCs and secret checks. *Foundry API: `Roll` + `ChatMessage` roll modes.*
3. **Apply damage / healing / set HP** — `apply-damage { actorOrToken, amount }` (negative = heal) and/or a guarded `update-actor { hp }`. System-aware where possible (dnd5e `Actor#applyDamage`), with a generic `actor.update(system.attributes.hp.value)` fallback. *Closes the doc-0014 mutation gap.*
4. **Fog-of-war control** — `reveal-fog` / `reset-fog` (and optionally reveal-area) for the active scene.
5. **Spawn token on scene** — `create-token { actorId | compendiumRef, x, y, hidden? }` to drop a combatant onto the current scene at a position.

Lower priority (mention, don't block): apply arbitrary active effects; door/wall state; ambient lighting/time; a generic `post-chat-message`.

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.2 | AI performs every in-play DM table action without operator intervention | Coverage audit maps 24 DM actions against Foundry native support and the current bridge; identifies 5 invariant-critical gaps that would force operator intervention |
| 4.3 | Gaps are tracked and a plan exists to close them | Competing-bridge comparison + prioritized upstream proposal for all 5 gaps; stay-on-adambdooley recommendation with fork-as-Plan-B per ADR-0011 |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this is an audit doc that identifies gaps against an existing ADR requirement (ADR-0015); it does not surface a conflict between PRD requirements.

## Decisions to promote (ADR candidates)

None — the durable decisions (prefer `adambdooley`, propose upstream before forking) are already captured in ADR-0011.

## Alternatives considered

Covered under Approach (Competing bridges section and Recommendation).

## Eval / build implications

Each newly-exposed tool gets a thin `McpFoundryClient` mapping (replacing the current "throw actionable error" stub) + a `FoundryClient` interface method + `MockFoundryClient` impl + unit tests, then an LLM-callable tool. Scene switching is the first such build (it's already supported upstream).

## Open questions

- Whether to also contribute a small **capabilities/`list-tools`-driven feature probe** so Skeinkeeper can detect at session start which DM actions are available and tell the operator what's missing (turns silent gaps into a visible pre-game checklist).
