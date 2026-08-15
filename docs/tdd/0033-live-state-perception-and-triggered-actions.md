# TDD 0033: Live State Perception & Triggered Actions

Status: implemented
PRD refs: 4.8
PRD-rev: 5c3a198
ADR constraints: 0003, 0008, 0010, 0017, 0018, 0023, 0024, 0029, 0030
Author: maintainers
Date: 2026-05-26
Related TDDs: [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md), [0022 (DM-action coverage audit)](./0022-dm-action-coverage-audit.md), [0031 (intake + intake report)](./0031-session-intake-and-intake-report.md), [0032 (autonomous setup actions)](./0032-autonomous-pre-game-setup-actions.md), [0034 (surface routing + IO abstraction)](./0034-surface-routing-and-io-abstraction.md), [0035 (side-channels via Foundry whisper)](./0035-side-channels-via-foundry-whisper.md), [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md)

## Approach

§4.8 names two distinct AI capabilities for play time: **live state perception** (the AI
subscribes to Foundry state changes — scene activation, token movement, combat-tracker
events, actor-sheet updates, journal access — and to Discord voice presence) and
**triggered actions** (place hidden tokens, reveal them, share journals to a specified
audience, distribute loot to actor inventories). This TDD designs _the AI's side of both_
— but with an explicit asymmetry.

**Perception is push from the first-party add-on, not a third-party connector.**
[TDD 0041](./0041-first-party-foundry-addon.md) defines the `evt` channel and
ships `chat` and `gone`. This TDD extends that union with `scene`, `token`,
`combat`, `actor`, and `journal` (Foundry `Hooks.on` in `main.mjs`) and is
the orchestrator consumer of those events, plus Discord voice presence
(already shipped; carried by TDD 0036). Polling Foundry is forbidden
(ADR-0018). There is no the live add-on stream default and no upstream
MCP proposal.

**Triggered actions ship against the first-party add-on.** Token reveal/hide and
hidden-token placement use TDD 0041 `applyActorUpdate` and TDD 0042 `createToken`.
Loot uses existing inventory writes. Per-audience journal share still uses TDD 0035's
`FoundryWhisperSurface` as the player-visible delivery; a native Foundry "show to
players" reveal is out of this TDD (not in TDD 0042's write set).

This TDD designs the _capability surface_ and the orchestrator wiring; the per-action
policy (when to reveal a hidden token, what journals to share with whom, when to distribute
loot) lives in the behavior spec per ADR-0006.

## Components & interfaces

### Triggered actions — orchestrator tools

New tools in the orchestrator tool registry (TDD 0006 / 0003 — tool-call-only state
mutation), each with a typed schema and an `ModuleFoundryClient` call beneath:

```ts
// orchestrator/tools/triggered.ts

// Place a creature/NPC actor in the world with a hidden token on the active scene.
// Used when an encounter triggers and pre-load didn't cover the creature (lazy path
// per TDD 0032 §4) or for an unexpected reveal.
export const place_hidden_token = tool({
  name: 'place_hidden_token',
  args: {
    actorRef: { compendiumId?: string; actorId?: string; namePack?: string },
    sceneId: string,                 // active scene unless overridden
    coords?: { x: number; y: number },
    disposition?: 'hostile' | 'neutral' | 'friendly',
  },
  // returns: { tokenId: string }
});

// Reveal an existing hidden token to the table.
export const reveal_token = tool({
  name: 'reveal_token',
  args: { tokenId: string },
});

// Hide an existing visible token.
export const hide_token = tool({
  name: 'hide_token',
  args: { tokenId: string },
});

// Deliver a journal entry to a specified audience.
// audience model is TDD 0035's: type Audience = 'table' | `player:${string}` | 'gm'
// v0.5 implementation (PRD-rev `59a0fda` surface model):
//   - 'table'        → SurfaceRouter dispatch to FoundryPublicChat (TDD 0034)
//                      + table-audience voice narration (Discord voice)
//   - `player:<id>`  → FoundryWhisperSurface (TDD 0035) to the player's Foundry user
//   - 'gm'           → FoundryGmChatSurface no-op narration (TDD 0034); already GM-visible
export const share_journal_to_audience = tool({
  name: 'share_journal_to_audience',
  args: {
    journalId: string,
    audience: Audience,              // imported from TDD 0035's audience types
    excerpt?: { pageId?: string; chars?: number },
  },
});

// Distribute items from compendium (or by template id) to one or more actors.
export const distribute_loot = tool({
  name: 'distribute_loot',
  args: {
    distributions: Array<{
      actorId: string;
      items: Array<{ compendiumId?: string; itemId?: string; quantity: number }>;
    }>;
  },
});
```

Each tool's handler:

1. Validates inputs against its schema (no audience mis-targeting; no token-action against
   a token outside the active scene without explicit `sceneId`).
2. Calls one or more `ModuleFoundryClient` methods (or, for the journal-share player path,
   the `FoundryWhisperSurface` of TDD 0035 via TDD 0034's SurfaceRouter).
3. Returns the structured result to the orchestrator turn loop; failures bubble as tool-
   call errors and route through `notify_operator` (which dispatches to the Foundry GM
   chat surface per TDD 0036 / TDD 0034) on a configurable severity threshold.

### Detailed wiring per action

**`place_hidden_token`.** Resolve `actorRef` to a Foundry actor id (direct id, or
compendium/name via TDD 0021 search + TDD 0032 preload). Then one call:

`createToken({ actorId, x, y, hidden: true, sceneId })` (TDD 0042).

If the actor is not in the world, pass `compendiumRef` instead of `actorId`.
No two-step place-then-move. No third-party connector tools.

**`reveal_token` / `hide_token`.** `applyActorUpdate` / token update with
`hidden: false`/`true` (TDD 0041).
Trivial. Returns success on bridge ack.

**`share_journal_to_audience`.** Branch on audience tag (under the PRD-rev `59a0fda`
surface model):

- `'table'` → the Coordinator (TDD 0035 §3) emits a `table`-audience narration. The
  SurfaceRouter (TDD 0034) dispatches to two surfaces: `DiscordVoice` (table-audience
  TTS narration, capped excerpt) and `FoundryPublicChat` (the visible table text — the
  journal title + the excerpt, default cap 1500 chars, posted via `post-chat-message`
  with the public roll-mode). The bridge has no first-class "show to all" affordance
  verified at the time of design (see Open questions); v0.5 therefore relies on the
  chat-message path rather than a bridge-side `ownership = OBSERVER` mutation. When
  live bridge verification or upstream support lands a true Foundry-side reveal, this
  branch additively gains it.
- `player:<id>` → the Coordinator routes through TDD 0035's `FoundryWhisperSurface`
  (`post-chat-message` with `whisper: [foundryUserId]`, resolved via the 3-way identity
  map from TDD 0036). Prefix the message with a framing marker
  (`*A note slips into your hand:*`) + the journal title; excerpt cap default 1500
  chars; suffix `(full entry: <name> — ask your DM to share)`. Other players' Foundry
  views are untouched. **Anti-leak Layer 1** (TDD 0035 §"Two-layer anti-leak") ensures
  Skeinkeeper composes a single-recipient message; **Layer 2** is Foundry's whisper
  render itself.
- `'gm'` → no-op (the journal is GM-visible by default in Foundry); log + return
  success.

The fallback respects the audience model from TDD 0035 + ADR-0017: per-audience visibility
is preserved (player gets the content; table never sees it). The two-layer anti-leak
posture is the same one TDD 0035 uses for other player-targeted content.

**`distribute_loot`.** For each `{ actorId, items }` pair, call `add-actor-items` per item.
Validate that every `actorId` is one of the party actors (looked up via intake's
`partyActorCandidates`); reject distributions to non-party actors as a tool-call validation
error. Atomicity is per-distribution — a failure on one item does not roll back prior items
in the batch (the bridge has no transaction primitive); the handler returns per-item
status so the turn loop can decide whether to retry.

### Live-state perception — the design contract

```ts
// orchestrator/perception/event-stream.ts

export interface FoundryEventStream {
  subscribe(handler: (event: FoundryEvent) => void): Unsubscribe;
}

export type FoundryEvent =
  | { type: "scene-activated"; sceneId: string; activatedBy?: "ai" | "operator" }
  | { type: "token-moved"; tokenId: string; from: Coords; to: Coords; movedBy?: ActorRef }
  | { type: "combat-started"; combatId: string; sceneId: string }
  | { type: "combat-ended"; combatId: string }
  | { type: "combat-turn"; combatId: string; combatantId: string }
  | { type: "actor-updated"; actorId: string; patch: Partial<ActorState> }
  | { type: "journal-accessed"; journalId: string; byUserId?: string };
```

The orchestrator wires `FoundryEventStream` exactly once at session start (parallel to
TDD 0041 `ModuleFoundryClient`). The v0.5 default is the live add-on stream. A
`MockFoundryEventStream` is provided for tests.

`ModuleFoundryClient` (TDD 0041) delivers these as `evt` frames on the same
socket as `chat`/`gone`. This TDD adds `evt` kinds `scene`, `token`, `combat`,
`actor`, and `journal` (Foundry hooks in `modules/skeinkeeper/scripts/main.mjs`).
Payloads carry entity id + changed-fields patch. GM-session only (the add-on
does not run for players).

### Per-audience journal share

v0.5 delivery is TDD 0035 `FoundryWhisperSurface` (journal content as a
whisper plus the entry name). A native Foundry "show to players" reveal is
out of TDD 0042 and not required for this TDD. `share_journal_to_audience`
for `audience: 'player:<id>'` uses the whisper path. The "you found a note"
framing is the whisper; there is no third-party connector reveal.
reveal makes the entry visible in the player's Foundry UI).

## Data & state

No new persistent state in Skeinkeeper for these capabilities. State lives in Foundry per
ADR-0018. The Foundry-whisper fallback for player-targeted journal share writes through
TDD 0035's existing dialogue-persistence path; no new tables, no new audience-tagging
schema (the existing `audience` column already handles `player:<id>`).

`coldIndexReady` is read here only as an _informational_ signal — none of these tools
require the index to function; lazy actor creation in `place_hidden_token` falls back to a
direct compendium-search per call when the index isn't ready. The flag is carried on TDD
0032's `SessionRunState` and reaches tool handlers via the existing tool-dispatch context
(`ToolDispatcher` per TDD 0006) — handlers read `ctx.runState.coldIndexReady`. No new
state introduced by this TDD.

## Sequencing / implementation plan

1. `reveal_token` / `hide_token` — one-line `update-token` wrappers.
2. `distribute_loot` — `add-actor-items` per item with party-actor validation.
3. `place_hidden_token` — resolve actor, ensure in world, place + hide (with the two-step
   place-then-position fallback for the known bridge gap).
4. `share_journal_to_audience` — Foundry-whisper fallback (TDD 0035) for player audience;
   SurfaceRouter dispatch to `FoundryPublicChat` + `DiscordVoice` (TDD 0034) for table
   audience; no-op for GM audience.
5. `FoundryEventStream` interface + live add-on adapter + `MockFoundryEventStream`.
6. Orchestrator wiring of the live stream; tool registry adds the four tools.

## Failure modes & edge cases

- **`update-token` fails** (token already gone, scene changed mid-call). Tool returns
  failure; turn loop decides whether the AI re-narrates. No automatic retry.
- **`create-actor-from-compendium` returns success but no token spawned.** The handler's
  fallback path (`get-token-details` check → `move-token` if needed) handles the
  ambiguous-spawn case; if the second-pass read still shows no token, the handler raises a
  `bridge-coverage-gap` tool error to be escalated via `notify_operator`.
- **Audience-targeted journal share for an audience that includes a non-consented
  player.** TDD 0035's consent gate already covers this (Discord DM-consent precondition
  for the Foundry-whisper surface to fire); the surface rejects; this tool surfaces the
  rejection back to the AI.
- **`distribute_loot` to an actor that isn't a party member** (or is a hostile NPC). Tool
  validation rejects; the AI must re-narrate without the distribution. The validation
  prevents the AI from accidentally arming an enemy from a behavior misfire.
- **`distribute_loot` partial failure across items.** Per-item status returned; turn loop
  surfaces a "partial distribution" notification; no rollback.
- **Player-targeted journal share larger than Foundry's chat-message limit.** Excerpt is
  applied; full content link references the Foundry entry by name. The 1500-char default
  is comfortably within Foundry's chat-message payload practical limit and leaves room
  for the prefix marker + suffix. (Discord DM is no longer the carrier — see the surface
  flip in TDD 0035.)
- **Foundry event arrives before the orchestrator has finished session-start init**
  (when upstream lands). The contract specifies events are queued behind the
  session-start barrier; the live add-on stream makes this moot at v0.5.
- **The bridge starts pushing events that the consumer didn't expect** (new event types
  added upstream). The `FoundryEvent` union is closed; unknown event types are logged-and-
  ignored, not crash.
- **Active scene changes mid-`place_hidden_token`.** Handler reads the active scene id at
  invocation; if it differs from the requested `sceneId` (or the implicit active), it
  raises a `scene-changed-mid-action` error rather than placing on the wrong scene.

## Requirement traceability

| PRD ref                                     | Requirement                                                                                                                          | Satisfied by                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.8 (place tokens with `hidden` visibility) | "The AI can place tokens with `hidden` visibility"                                                                                   | `place_hidden_token` → TDD 0042 `createToken({ hidden: true })`                                                                                                      |
| 4.8 (reveal tokens)                         | "reveal them when narratively appropriate"                                                                                           | `reveal_token` tool; `update-token hidden:false`                                                                                                                     |
| 4.8 (share journals to audience)            | "share journal entries with a specified audience (`table` / `player:<id>`, per §4.7)"                                                | `share_journal_to_audience` tool with per-audience branching; Foundry-whisper fallback (TDD 0035) for player audience until the upstream lands                       |
| 4.8 (distribute loot)                       | "distribute loot to actor inventories"                                                                                               | `distribute_loot` tool; `add-actor-items` per item                                                                                                                   |
| 4.8 (live state perception)                 | "subscribes to Foundry state changes — scene activation, token movement, combat-tracker events, actor-sheet updates, journal access" | TDD 0041 `evt` channel extended by this TDD with `scene`/`token`/`combat`/`actor`/`journal`; no third-party connector                                                |
| 4.8 (Discord voice presence)                | "and to Discord voice presence"                                                                                                      | Voice presence shipped in the legacy onboarding TDD (`VoiceIO.presence`); the responsibility now lives in TDD 0036 (which supersedes TDD 0023); not re-designed here |
| 4.8 (behavior policy separation)            | "behavior spec's job (per §4.3)" — trigger _policy_ lives in the behavior spec                                                       | Tools are platform capabilities; per-action policy is out of scope per ADR-0006                                                                                      |

## Dependencies considered

None. All four tools route through `FoundryClient` + `ModuleFoundryClient` (TDD 0041),
TDD 0034's SurfaceRouter, and TDD 0035's `FoundryWhisperSurface`. No new third-party
libraries. `FoundryEventStream` is a one-method `subscribe` over TDD 0041 `evt`;
no extra event-bus library.

## PRD conflicts surfaced (and resolution)

1. **Live state perception needed a push channel.** **Resolution:** TDD 0041 `evt`
   plus this TDD's scene/token/combat/actor/journal kinds. Not a third-party connector.
2. **Per-audience journal share has no native Foundry "show to players" in TDD 0042.**
   **Resolution:** v0.5 Foundry-whisper delivery via TDD 0035.
3. **Token placement at explicit coords is constrained.** TDD 0022 item 5 named this
   gap. **Resolution:** v0.5 uses the two-step create-then-`move-token` fallback in
   `place_hidden_token`; performance is acceptable for the action's frequency. Upstream
   proposal for a first-class place-at-coords parameter is out of this TDD
   (carried forward from TDD 0027, Band B).
4. **Behavior policy vs. capability separation.** §4.8 lists triggered actions and live
   perception together. Per ADR-0006, _trigger policy_ (when to reveal, when to share,
   when to distribute) lives in the behavior spec — not this TDD. Explicitly named to
   prevent reviewer confusion.

## Decisions to promote (ADR candidates)

None. ADR-0029 already covers first-party Foundry support. Perception events
are an `evt` extension, not a new integration decision.

## Telemetry implications

New events in `/telemetry/src/events.ts` (and `/docs/telemetry-events.md`):

| Event                              | Payload                                                                                                                                      | Description                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `action.place_hidden_token`        | `{ campaignId, sceneId, actorRefKind: 'compendium' \| 'actor' \| 'name-pack', success: boolean }`                                            | Hidden-token placement attempted                         |
| `action.reveal_token`              | `{ campaignId, success: boolean }`                                                                                                           | Token revealed                                           |
| `action.hide_token`                | `{ campaignId, success: boolean }`                                                                                                           | Token hidden                                             |
| `action.share_journal_to_audience` | `{ campaignId, audienceKind: 'table' \| 'player' \| 'gm', path: 'foundry-public-chat' \| 'foundry-whisper' \| 'gm-noop', success: boolean }` | Journal share attempted, with the path used              |
| `action.distribute_loot`           | `{ campaignId, recipientCount, itemCount, partialFailure: boolean }`                                                                         | Loot distribution attempted                              |
| `perception.event-stream.wired`    | `{ campaignId, kind: 'null' \| 'mock' \| 'real' }`                                                                                           | Event stream wired at session start (v0.5 always `null`) |

All PII-free per ADR-0010. No token IDs, no actor names, no journal text in payloads;
counts + kinds + boolean outcomes only.

## Privacy implications

- **Per-audience journal share** inherits TDD 0035's audience invariant + ADR-0017's
  per-audience visibility/erasure model. The Foundry-whisper fallback writes the journal
  excerpt to the player's whisper record (already audience-tagged `player:<id>`), so
  per-player erasure via TDD 0038's `FoundryWhisperDeletionAdapter` also erases the
  shared excerpt — the same property the bridge-side reveal would _not_ automatically
  give us, making the fallback strictly better for erasure semantics at v0.5.
- **Loot distribution + token actions** touch only Foundry-side state (per ADR-0018);
  no new Skeinkeeper-side PII.
- **Live-state perception** doesn't exist yet; when it lands, `journal-accessed` events
  carry a `byUserId` that maps to a Discord user. That binding is operator-owned
  identity (the same one used in `player_character_map`); the existing privacy posture
  covers it.

## Eval implications

Scenario fixtures required before this ships:

1. **Reveal/hide round trip.** `reveal_token` on a hidden token → bridge ack; subsequent
   `hide_token` reverses. State queried via `get-token-details` matches.
2. **Hidden-token placement, two-step fallback.** `place_hidden_token` with a compendium
   ref; the test bridge spawns the actor's token at a default position; the handler
   calls `move-token` to the requested coords; `update-token hidden:true` succeeds.
3. **Hidden-token placement, no-spawn case.** Bridge creates the actor but no token; the
   handler's coverage-gap error surfaces with a `bridge-coverage-gap` code and routes to
   `notify_operator`.
4. **Journal share, table audience.** Tool dispatches a table-audience narration
   through the Coordinator's existing dialogue-write path; player-side DM channels are
   _not_ touched; the journal's Foundry-side ownership is unchanged at v0.5.
5. **Journal share, player audience.** Tool dispatches a per-player Foundry whisper
   through TDD 0035's `FoundryWhisperSurface` (`post-chat-message` with
   `whisper: [foundryUserId]`) with the audience-prefixed text; other players' Foundry
   views are untouched (covered by TDD 0035's audience-isolation tests).
6. **Loot distribution, valid party-actor recipients.** Items added to each actor's
   inventory; per-item status returned.
7. **Loot distribution, non-party recipient.** Validation rejects; no bridge call made;
   `partialFailure: true` reported with the offending entry.
8. **Loot distribution, partial item failure.** One item's `add-actor-items` fails; the
   others succeed; report flags `partialFailure: true`; no rollback.
9. **the live add-on stream no-op.** `subscribe` returns a no-op unsubscribe; no events
   emitted; behaviors depending on events log a "perception not yet available" notice
   on first attempt (not per call).
10. **`MockFoundryEventStream` happy path.** Test-only stream emits a scripted sequence
    of events; the orchestrator's event handlers (when behaviors that consume them
    exist) receive them in order. Establishes the contract is exercise-able even with
    the real implementation deferred.

## Open questions

- **Table-audience journal-reveal bridge surface.** The bridge has journal _mutation_
  tools but the exact "show to all players" affordance needs live verification. The v0.5
  implementation falls back to the `notify_table` Discord narration if the bridge
  affordance proves missing; flagged for implementer verification against the live
  bridge. This is a smaller version of the per-player gap (not in TDD 0042; tracked as later
  B, carried forward from TDD 0027) and folds into the same upstream proposal.
- **Combat-tracker control** (start/end/initiative/next-turn) is a known bridge gap
  (TDD 0022 #1; combat writes are TDD 0042). It's not in §4.8's enumerated
  triggered actions but is needed to drive combat. Out of scope for this TDD; tracked in
  TDD 0022. A follow-up TDD may add the
  combat control tools.

## Evaluation rubric

| Criterion                       | High-quality                                                                                       | Acceptable                                                   | Failing                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Requirement traceability        | Every in-scope FR/NFR maps to a named interface, type, or step                                     | One mapping is slightly coarse but still findable            | An in-scope FR has no row, or the row is "handled in code"        |
| Interface concreteness          | Method names, args, return types, and error cases are specified                                    | Types are named; one edge payload is implied                 | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason                                    | No new dep, and the section says why                         | New dep with empty or "none considered" analysis                  |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named                                   | Observable but one scenario is console-only                  | Non-actionable plan (no surface, no observation point)            |
| Scope-bound adherence           | Touched files ≤8, body ≤500, per-file estimates present                                            | One justified exception marker                               | Silent over-bound or missing Touched files / Expected diff        |
| Naming consistency              | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name                  |
