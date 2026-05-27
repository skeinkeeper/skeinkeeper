# TDD 0016: Player↔Character Identity Mapping

Status: superseded by [0036](./0036-onboarding-and-foundry-user-preflight.md)
PRD refs: 4.1, 4.6
PRD-rev: 10391ba
ADR constraints: 0008, 0010, 0011
Author: maintainers
Date: 2026-05-19
Related TDDs: [0007 (Foundry-as-source-of-truth)](./0007-foundry-as-source-of-truth.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md)

## Approach

Voice arrives keyed on a **Discord user ID** (an `Utterance.speaker`). Mechanical state lives in **Foundry**, keyed on a **Foundry actor ID**. Nothing links them today, so the AI knows "Discord user 12345 said 'I attack the goblin'" but not _which character sheet_ to attack with. The turn loop (doc 0011) and the always-listening decider (doc 0015) both need this attribution: to apply an action to the right actor, and to reason about "the player standing on the trap tile."

Foundry knows which _Foundry user_ owns which actor (`list-actor-ownership`), but Foundry users are not Discord users — there's no automatic Discord→Foundry→actor chain.

**Player-initiated mapping through the DM at session start, with operator override.** The mapping is created by the natural opening ritual of a session rather than a config screen.

### The intro ritual

At session start, after greeting the table, the AI DM asks each player to introduce themselves and say who they're playing — exactly what a human DM does at a first session. As each player answers in voice ("Hi, I'm Chris, I'm playing Aragorn the ranger"), the always-listening loop attributes the utterance to a Discord ID, and the AI:

1. Extracts the claimed character name from the utterance.
2. Resolves it to a Foundry actor (see resolution below).
3. Records the mapping via a new `record_player_character` tool.
4. **Confirms aloud** ("Got it — Chris is playing Aragorn") so the player can correct a mis-hearing in the moment.

This is warm, in-fiction, and requires zero setup screens. Returning players who are already mapped are skipped (the AI greets them by character).

### Name → Foundry actor resolution

The AI resolves the spoken character name against Foundry's actors via the bridge (`list-characters` + optionally `list-actor-ownership`), using fuzzy matching (case-insensitive, nickname-tolerant — "Aragorn" matches actor "Aragorn, Ranger of the North"). On ambiguity or no match, the AI asks a clarifying question or defers the mapping to the operator rather than guessing.

### The `record_player_character` tool

A new built-in, **operator-gated by default is wrong here** — the AI needs to call it during the ritual, so it's a normal LLM-callable tool. Input: `{ campaignId, discordUserId, foundryActorId, displayName }`. It upserts the map row and audit-logs the mapping. The AI calls it once per player as the intro proceeds.

### Operator override

The operator can correct any mapping — the AI mis-heard "Aragorn" as "Aragon," or two players have similar character names — via:

- The **web UI** (Phase 5): a simple table of Discord user ↔ character with edit controls.
- A **Discord command**: `/skeinkeeper map @player <character>`.

Operator-set rows carry `source: "operator"` and win over player-set rows.

### How it's consumed

`runTurn` and the always-listening decider look up `currentForPlayer(discordUserId)` to attribute an utterance to a character. This lets the AI:

- Apply "I attack" to the right actor's sheet.
- Reason spatially ("Aragorn's player said they move into the corner" → check the trap near Aragorn's token).
- Voice continuity and narration ("Aragorn, you feel the floor shift…").

Utterances from consented spectators with no character map are still captured as context but attributed to a person, not a character.

## Components & interfaces

A `TenantDb.playerCharacterMap` accessor (record / get / listByCampaign / currentForPlayer). PII (`discordUserId`) → a `PlayerCharacterMapAdapter` for erasure (player + tenant scope) and export, registered in the CLI alongside the others (per the doc-0013 fix).

## Data & state

### Storage

A new tenant-scoped table:

```ts
player_character_map: {
  id, tenantId,
  campaignId,
  discordUserId,      // PII
  foundryActorId,
  displayName,        // the player's spoken/display name, for prompt rendering
  source,             // "player" | "operator"
  confirmedAt,
}
// unique-ish on (tenantId, campaignId, discordUserId); a player may remap
// (e.g., swaps characters) — most recent wins, like consents.
```

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement                                                                                  | Satisfied by                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 4.1     | Real-time speech-to-text per speaker with diarization (AI knows which player said what)      | `Utterance.speaker` (Discord user ID) looked up in `player_character_map` → attributed to named character for turn context |
| 4.6     | Players added to campaign by Discord ID; player-facing surfaces are Discord and Foundry only | `discordUserId` is the key; players interact via voice intro ritual — no web UI required                                   |
| 4.6     | Operator adds players to campaign by Discord ID via web UI                                   | operator override path via web UI table + `/skeinkeeper map` Discord command; `source: "operator"` rows win                |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — the design satisfies PRD §4.1 (diarized attribution) and §4.6 (Discord-ID-based player identity) without contradiction; the intro-ritual approach directly fulfils the "players never touch the web UI" persona constraint.

## Decisions to promote (ADR candidates)

None — no cross-cutting durable decisions here beyond what ADR-0008 (tenant scoping) and ADR-0010 (privacy/erasure) already cover. The "episodic memory is not individually erasable" scoping decision lives in doc 0019; not applicable here.

## Alternatives considered

- **Operator pre-configures every mapping in a setup screen.** Works, but it's tedious and un-fun, and it front-loads config before the table can start. The intro ritual is zero-setup and in-fiction. Operator config remains as the _override_, not the primary path.
- **Map via Foundry user ownership + a Discord↔Foundry-user link.** Requires players to also be logged into Foundry as distinct users and a separate Discord↔Foundry-user table — more moving parts, and many tables have one shared Foundry GM screen. Rejected as the primary mechanism.
- **Auto-guess from voice alone (speaker recognition → character).** Unreliable and creepy (voiceprints — explicitly out of scope per PRIVACY.md). Rejected.

## Telemetry implications

Optionally `identity.mapping_recorded { source }` (player vs operator) to learn how often operator correction is needed. No PII. Defer until the flow is live.

## Privacy implications

The map contains a **Discord user ID associated with a character** — PII-adjacent, tenant-scoped. Covered by a `PlayerCharacterMapAdapter` (player + tenant erasure, plus export so the player sees their own mapping). `docs/PRIVACY.md`'s "what Skeinkeeper stores" list gains "player↔character associations," and the deletion cascade gains this table (hard rule #15, with the implementation). No new consent purpose — the mapping is operational data inherent to running the game, like dialogue.

## Eval implications

The extraction step is unit-testable without voice: given an utterance like "I'm Chris playing Aragorn" + a list of Foundry actors, assert the AI proposes `{ discordUserId, foundryActorId }` correctly, asks for clarification on ambiguity, and defers on no-match. Behavior fixtures in the eval harness drive a `FakeLLMProvider` scripting the `record_player_character` tool call. The fuzzy name→actor resolver is a pure function with its own unit tests.

## Open questions

- **One player, multiple characters.** A player running two PCs. The map is currently one-actor-per-(player, campaign); supporting multiple needs either multiple rows or a per-utterance "which of your characters?" disambiguation. Defer; flag in the schema (don't hard-enforce uniqueness).
- **Mid-session joins / character swaps.** A player who arrives late or swaps characters mid-session re-runs the mini-ritual ("who are you playing now?"); most-recent-row-wins handles it.
- **Shared/handoff characters.** A character controlled by different players across sessions. The most-recent mapping wins; fine for alpha.
- **Confidence threshold for auto-confirm vs. ask.** How fuzzy a name match is "confident enough" to record without asking? Tuned with play; lean toward confirming aloud (cheap, friendly) over silent assumption.
