# TDD 0023: Session-Start Onboarding, Voice Presence, and the Operator-in-Discord Channel
Status: implemented
PRD refs: 4.6, 4.1
PRD-rev: 10391ba
ADR constraints: 0010, 0023
Author: maintainers
Date: 2026-05-20
Related TDDs: [0015 (always-listening loop)](./0015-always-listening-voice-loop.md), [0016 (identity mapping)](./0016-player-character-identity-mapping.md), [0020 (operator app)](./0020-operator-app.md)

## Approach

Two gaps surfaced in live play:

1. **The session-start ritual needs voice presence.** Skeinkeeper should stay silent in an empty channel, welcome people *as they join* (on a conversational break), and — if the room is already full at Start — greet the group and go around for introductions. Today the AI only knows who has *spoken*, not who is *present* or when someone *joins*.
2. **The operator must not babysit the console.** The operator should care about only **Foundry + Discord** during play. Operational signals (e.g., "I can't find a character for this player") and any operator↔AI exchange should happen over **Discord DMs**, the single chat surface we already use for player consent — not a web console the operator has to watch.

This also answers "how much should the AI verify/troubleshoot?" (ADR-0015): the operator readies the **world** pre-game; the AI onboards people **live** and escalates genuine setup problems to the operator over Discord.

### 1. Voice presence awareness

`VoiceIO` gains a `presence` event: `{ kind: "presence"; members: [{ id, displayName? }] }`. `DiscordVoiceIO` emits it once on join and on every `voiceStateUpdate` for the target channel (join/leave). The always-listening loop tracks the current member set from these events. `FakeVoiceIO` can emit them, so the logic is testable without Discord.

### 2. Onboarding turns (the ritual)

The loop computes, per lull, **who is awaiting onboarding** = consented members present − already-mapped (`player_character_map`) − already-greeted-this-session. A small pure helper (`selectOnboardingTargets`) does this and is unit-tested.

- **Empty channel** → nobody present → no onboarding, and (with the empty-buffer-lull fix) no chatter. Silent.
- **Someone present & awaiting, on a lull** → the loop runs an **onboarding turn** (bypassing the "should I respond?" decider — onboarding is a deliberate ritual, not a judgment call) with a synthetic input naming who to welcome. The AI greets, introduces itself, asks each to say who they are + which character, and (as they answer in later turns) calls `record_player_character` and confirms back. Greeted members are marked so they aren't re-greeted.
- **Full room at Start** → same mechanism: several awaiting members → the AI greets the group and goes around.

Eagerness does **not** suppress onboarding (you always greet newcomers); it only governs in-play chatter.

### 3. Character verification — AI conversational, never creation

When a player names a character, the AI matches it against Foundry's party (`listPartyActors` + the `resolveCharacterName` fuzzy helper). One clear match → record + confirm. No/ambiguous match → re-ask once, offering what it sees ("I have Gimli and Legolas unclaimed — are you one of those?"). Still unresolved → it does **not** block the table: it proceeds and **notifies the operator over Discord** (see §4). It never creates/edits a character — that's pre-game operator work.

The map is Discord-user → Foundry **actor**, not → Foundry **login**: players need a character *actor in the world*, not a Foundry account. How players view the board (own Foundry, screen-share, theatre-of-mind) is a separate table choice.

### 4. The operator-in-Discord channel

> **Update (2026-05-20):** the operator-*designation* mechanism below
> (env-var-only snowflake) is superseded by [design doc 0024](./0024-operator-self-designation.md),
> which adds a Discord slash command (`/skeinkeeper operator claim`), a live
> console picker, and a console @username field, with the env var kept as a
> fallback default. The rest of this section (how the operator is *reached* —
> Discord DM via `notify_operator`) stands.

- The operator is designated by **`DISCORD_OPERATOR_USER_ID`** (pre-game config).
- Skeinkeeper reaches the operator via **Discord DM** — the single chat surface. A `notify_operator` built-in tool (LLM-callable) sends a DM via `ctx.notifyOperator`, wired by the operator app to DM that user. The AI uses it for setup problems ("couldn't match player Chris to a character; unclaimed: Gimli, Legolas"); it's general-purpose for any operator-facing escalation.
- The operator corrects things via the existing override path (slash command / future buttons), also in Discord.
- **The web console is demoted:** pre-game configuration + *optional* live observability. **Nothing the operator must watch during play happens only in the console** — it goes to Discord. (If `DISCORD_OPERATOR_USER_ID` is unset, escalations fall back to the console log, degraded.)

### 5. Operator pre-flight (required before Start)

Foundry running + bridge connected; the campaign's **character actors exist + are named**; players invited to Discord. **Not** required: everyone already in voice / introduced / logged into Foundry. People trickle in; the AI onboards them live (rejecting the everyone-ready-before-Start extreme).

## Components & interfaces

Covered under Approach.

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.6 | Operator receives setup escalations over Discord, not the web console | `notify_operator` built-in tool sends DMs to the designated operator; console demoted to config + observability |
| 4.1 | Session-start ritual greets players as they join and maps them to characters | Voice presence events (`presence` on `VoiceIO`); `selectOnboardingTargets` helper; onboarding turns triggered per lull; character verification via `listPartyActors` + fuzzy match |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design resolves two live-play gaps within existing ADR constraints (ADR-0010, ADR-0015); no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None promoted. The "operator escalations go to Discord DM; the console is demoted to config + observability" surface decision is largely subsumed by ADR-0016 (operator control parity across surfaces); it is not promoted to a separate ADR. (Note: §4 of this doc was superseded by TDD 0024.)

## Alternatives considered

- **Operator watches the live console** — rejected per the explicit goal (Foundry + Discord only).
- **Two chat surfaces (console + Discord)** — rejected; one surface (Discord) is simpler and consistent with the consent flow. The console stays for *config*, not chat.
- **Greet immediately on join** (not on a lull) — rejected; interrupts. Greet on the next break, like a real DM.
- **Require all players present before Start** — rejected (contradicts late-joiners; un-table-like).
- **Speech-only (no presence)** — the AI could greet whoever speaks, but couldn't welcome silent joiners or "go around the room." Presence is the small new capability that makes the ritual real.

## Privacy implications

Presence = who is in the voice channel (Discord IDs + display names), used transiently to drive onboarding; not a new persistent store. Consent still gates transcription before any audio is processed (doc 0012). Operator DMs contain player display names + character names (campaign-operational, not sensitive beyond what's already stored). No change to ADR-0010 posture.

## Eval implications

Pure + unit-tested: `selectOnboardingTargets` (present − mapped − greeted), the presence-tracking reducer, and the not-found → notify-operator decision. The Discord presence wiring + the DM delivery are operator live-validated. The ritual's wording is behavior-spec + live.

## Open questions

- **Re-greet on rejoin** — if someone leaves and returns, do we re-welcome? v1: no (greeted set persists per session).
- **Operator free-form replies** — buttons/slash commands avoid the privileged MessageContent intent; free-form operator DM parsing is deferred.
- **Multiple operators / co-DM** — single `DISCORD_OPERATOR_USER_ID` for now.
