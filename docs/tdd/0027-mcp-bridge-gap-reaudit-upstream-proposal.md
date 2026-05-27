# TDD 0027: MCP Bridge Gap Re-Audit + Upstream Proposal

Status: superseded by [0037](./0037-bridge-dependencies-surface-model-critical-batch.md)
PRD refs: 4.2
PRD-rev: 10391ba
ADR constraints: 0011, 0017, 0023
Author: maintainers
Date: 2026-05-20
Related TDDs: [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0026 (1:1 player↔DM side-channels)](./0026-player-dm-side-channels.md)
Extends: [0022 (DM-Action Coverage Audit)](./0022-dm-action-coverage-audit.md)

## Approach

0022 audited the `adambdooley/foundry-vtt-mcp` bridge against the in-play DM actions ADR-0015 requires the AI to perform, found five invariant-critical gaps, and drafted a proposal to send upstream. Two things have happened since: we shipped scene-switching against the bridge, and we accepted [design doc 0026](./0026-player-dm-side-channels.md) (1:1 player↔DM side-channels). This doc (1) **re-verifies** 0022's gaps against the current bridge surface, and (2) **adds one new requirement** that 0026 introduces, then consolidates the full upstream proposal so it can go to the maintainer in one message.

This doc _extends_ 0022; it does not supersede it. 0022's coverage table remains accurate.

### Re-verification (current bridge surface, 2026-05-20)

The bridge still exposes ~37 GM-only tools. Re-checking the five gaps from 0022 §"gaps that violate ADR-0015":

| Gap (from 0022)                                                             |  Still missing?  | Notes on the current surface                                                                                                                                                            |
| --------------------------------------------------------------------------- | :--------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Combat tracker control (start/end, add combatant, initiative, next-turn) | ✅ still missing | No `Combat`/`Combatant` tools. Confirmed absent.                                                                                                                                        |
| 2. GM / secret / blind dice roll                                            | ✅ still missing | `request-player-rolls` _asks players_ to roll; there is still no tool for the GM side to roll for an NPC or a hidden check.                                                             |
| 3. Apply damage / set HP / heal                                             | ✅ still missing | `toggle-token-condition` does conditions only; `use-item` triggers item effects; `update-token` edits token props — none is a damage/HP write. The doc-0014 mutation gap stands.        |
| 4. Fog-of-war reveal                                                        | ✅ still missing | No fog/exploration tool.                                                                                                                                                                |
| 5. Spawn a token onto the scene at a position                               |    ⚠️ partial    | `create-actor-from-compendium` creates the actor (and a token); placing it at explicit coords on the active scene still isn't a first-class arg. `move-token` can reposition afterward. |

No upstream change has closed any of these since 0022. The proposal below is still current.

### New requirement from design doc 0026: per-player content reveal

0026's private side-channels let the DM hand secret information to **one player** without the rest of the table seeing it. Most of that lives in Skeinkeeper (private text in Discord DMs, per-audience memory per ADR-0017). But one piece wants Foundry support: **revealing a journal entry, handout, or image to specific players only.** Today the bridge can `create-quest-journal` / `update-quest-journal` / `list-journals` / `search-journals`, but it can't _show_ an entry to a chosen subset of players — reveal is all-or-nothing / GM-only.

This is a natural fit for the bridge's existing model: **`request-player-rolls` already targets specific players.** We're asking for the same targeting applied to content reveal. Foundry supports it natively (per-document ownership + the core "Show to Players" socket).

0026 also **reinforces gap #2**: a player's private skill check ("can I pick his pocket?") needs a roll the _other_ players can't see — exactly the GM/secret/blind roll already on the list. So #2 now serves both NPC rolls and private-action rolls.

### Recommendation (unchanged from 0022, plus #4)

- **Stay on `adambdooley`** — still the most complete and active bridge; the gaps are shared across the field, so they're worth fixing once, upstream.
- **Propose upstream first; offer to contribute the PR.** The maintainer has been active and the additions are general-purpose (every AI-DM-over-Foundry project needs them), not Skeinkeeper-specific. Fork only if upstream declines or stalls (the ADR-0011 fork-as-Plan-B clause).
- **Keep wiring what's already supported.** Each newly-exposed tool follows the doc-0014 path: `McpFoundryClient` mapping (replacing the "throw actionable error" stub) → `FoundryClient` interface method → `MockFoundryClient` impl → unit tests → an LLM-callable tool.

## Components & interfaces

### Consolidated upstream proposal (priority order)

What we'd propose the maintainer add (or accept as a PR from us — ADR-0011 prefers upstreaming over forking):

1. **Combat tracker tools** — `start-combat`, `end-combat`, `add-to-combat` (tokens/actors), `roll-initiative` (all or one), `next-turn` / `previous-turn` (returns whose turn it is). _Foundry: `Combat` / `Combatant` documents._
2. **GM dice roll** — `roll-dice { formula, flavor?, mode?: public|gmroll|blind|self, whisperTo?: userIds }`, returning the result, so the AI rolls for NPCs **and** for a player's private/secret check. _Foundry: `Roll` + `ChatMessage` roll modes (`CONST.DICE_ROLL_MODES`)._
3. **Apply damage / healing / set HP** — `apply-damage { actorOrToken, amount }` (negative = heal), system-aware where possible (dnd5e `Actor#applyDamage`) with a generic `actor.update("system.attributes.hp.value")` fallback. _Closes the doc-0014 mutation gap._
4. **Per-player content reveal** _(new — for 0026)_ — `show-to-players { journalRef | journalPageRef | imageRef, playerUserIds }`, revealing the content to only the named players (and leaving it hidden from the rest). Mirrors the targeting `request-player-rolls` already does. _Foundry: JournalEntry/JournalEntryPage ownership + the core Show-to-Players socket / `ImagePopout` share._
5. **Fog-of-war control** — `reveal-fog` / `reset-fog` (optionally reveal-area) for the active scene.
6. **Spawn token on scene** — `create-token { actorId | compendiumRef, x, y, hidden? }` to drop a combatant onto the current scene at a position (today's `create-actor-from-compendium` makes the actor; this places the token).

Lower priority (mention, don't block): arbitrary active effects/buffs; door/wall/secret-passage state; ambient lighting/time-of-day; a generic `post-chat-message`.

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement                                                                           | Satisfied by                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.2     | AI performs every in-play DM table action; gaps are tracked and a closure plan exists | Re-verification table confirms all 5 gaps from 0022 still open; consolidated 6-item upstream proposal (priority-ordered) closes them; graceful-degradation fallbacks for #2 and #4 while upstream is pending |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this doc extends 0022 with a re-verification and an additional requirement from 0026; no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the durable decisions (prefer `adambdooley`, upstream before fork) are already captured in ADR-0011.

## Alternatives considered

Covered under Approach (Recommendation section).

## Build implications

- #2 (GM roll) and #4 (per-player reveal) are on the **critical path for 0026**: the secret-roll guardrail in 0026 §5 and the "secret info to one player" reveal in 0026 §4 both want them. Until upstream lands them, 0026 degrades gracefully — secret rolls fall back to Skeinkeeper's local roller (result delivered privately over Discord, not posted to Foundry chat), and per-player reveal is text-only in the Discord DM (no Foundry handout push).
- #1, #3, #5, #6 remain general DM-action coverage (0022), independent of 0026.

## Open questions

- Whether to bundle a small **capabilities probe** (`list-tools`-driven) so Skeinkeeper detects at session start which of these are available and shows the operator a pre-game checklist of what's missing (carried over from 0022; still open).
