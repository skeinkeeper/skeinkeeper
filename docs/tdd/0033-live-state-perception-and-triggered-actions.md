# TDD 0033: Live State Perception & Triggered Actions

Status: draft
PRD refs: 4.8
PRD-rev: 59a0fda
ADR constraints: 0003, 0008, 0010, 0011, 0017, 0018, 0023, 0024
Author: maintainers
Date: 2026-05-26
Related TDDs: [0014 (McpFoundryClient)](./0014-mcp-foundry-client.md), [0022 (DM-action coverage audit)](./0022-dm-action-coverage-audit.md), [0031 (intake + intake report)](./0031-session-intake-and-intake-report.md), [0032 (autonomous setup actions)](./0032-autonomous-pre-game-setup-actions.md), [0034 (surface routing + IO abstraction)](./0034-surface-routing-and-io-abstraction.md), [0035 (side-channels via Foundry whisper)](./0035-side-channels-via-foundry-whisper.md), [0037 (bridge dependencies — surface-model critical batch)](./0037-bridge-dependencies-surface-model-critical-batch.md)

## Approach

§4.8 names two distinct AI capabilities for play time: **live state perception** (the AI
subscribes to Foundry state changes — scene activation, token movement, combat-tracker
events, actor-sheet updates, journal access — and to Discord voice presence) and
**triggered actions** (place hidden tokens, reveal them, share journals to a specified
audience, distribute loot to actor inventories). This TDD designs _the AI's side of both_
— but with an explicit asymmetry.

**Perception is blocked on upstream.** TDD 0014 established that the current Foundry MCP
bridge is request/response only; there is no event-push channel. Per ADR-0011 ("prefer
fully-OSS Foundry MCP bridges") the right response to a platform gap is an upstream
proposal, not an orchestrator polyfill. A polling overlay would solidify a workaround into
the orchestrator's perception model and the layer would be wrong: ADR-0018 places mechanical
state in Foundry, and perception of that state belongs to the bridge, not the consumer. This
TDD therefore designs the _consumer-side contract_ the orchestrator will implement when
upstream events land (so wiring is drop-in), drafts the **upstream proposal** for the bridge
feature, and ships a `null` event-stream wiring as the v0.5 default. The Discord-voice
presence half of §4.8's perception is already shipped (originally TDD 0023, now carried
forward by TDD 0036 which supersedes 0023) and is not re-designed here.

**Triggered actions ship now, against the present bridge surface, with one gap accepted.**
Token reveal/hide, hidden-token placement, and loot distribution all map cleanly to existing
bridge tools (`update-token`, `create-actor-from-compendium`, `move-token`,
`add-actor-items`). Per-audience journal share is a known bridge gap (now tracked by
[TDD 0037](./0037-bridge-dependencies-surface-model-critical-batch.md)); v0.5 ships a
**Foundry-whisper fallback** that delivers the journal content as a private chat message
to the targeted player's Foundry user via TDD 0035's `FoundryWhisperSurface` and links to
the Foundry entry by name — behaviorally equivalent from the player's perspective; not
equivalent from the operator-spectator's perspective (the bridge never reveals the entry
to the audience). The fallback is explicitly time-limited: it goes away when the upstream
proposal lands.

This TDD designs the _capability surface_ and the orchestrator wiring; the per-action
policy (when to reveal a hidden token, what journals to share with whom, when to distribute
loot) lives in the behavior spec per ADR-0006.

## Components & interfaces

### Triggered actions — orchestrator tools

New tools in the orchestrator tool registry (TDD 0006 / 0003 — tool-call-only state
mutation), each with a typed schema and an `McpFoundryClient` call beneath:

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
2. Calls one or more `McpFoundryClient` methods (or, for the journal-share player path,
   the `FoundryWhisperSurface` of TDD 0035 via TDD 0034's SurfaceRouter).
3. Returns the structured result to the orchestrator turn loop; failures bubble as tool-
   call errors and route through `notify_operator` (which dispatches to the Foundry GM
   chat surface per TDD 0036 / TDD 0034) on a configurable severity threshold.

### Detailed wiring per action

**`place_hidden_token`.** Resolve `actorRef` to a Foundry actor:

- If `actorId` present → use it directly.
- If `compendiumId` present → ensure the actor exists in the world; if not, call
  `create-actor-from-compendium` (idempotent existence check via `list-characters` first;
  matches TDD 0032's preload pattern).
- If only `namePack` present → resolve via `search-compendium` to a compendium id, then
  the above.

Then place the token on the active scene. The bridge's `create-actor-from-compendium` may
implicitly spawn a token (per TDD 0022's "create-actor-from-compendium creates the actor;
placing a token at coords on the active scene is unclear"); the handler treats explicit
placement defensively:

- If a token for the actor already exists on the scene (read `get-token-details` /
  `list-tokens`-equivalent), use it.
- Otherwise, the create implicitly spawned one — read its position and adjust via
  `move-token` to the requested coords (if provided).
- Set `hidden: true` via `update-token`. Set `disposition` if provided.

The known token-placement-at-coords gap (TDD 0022 item 5) means this path is two
round-trips at v0.5; that's acceptable performance for a low-frequency action. When
upstream lands a first-class place-at-coords tool, the handler collapses to one call.

**`reveal_token` / `hide_token`.** Single `update-token` call with `hidden: false`/`true`.
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

The orchestrator wires `FoundryEventStream` exactly once at session start (parallel to the
existing Foundry client wiring in TDD 0014). v0.5 default: a `NullFoundryEventStream` that
subscribes successfully and never emits — the orchestrator runs correctly without
perception; behaviors that depend on it (e.g., "react when a player moves a token") are
no-ops until upstream lands. A `MockFoundryEventStream` is provided for tests that exercise
event-handling logic.

`McpFoundryClient` will gain an event-stream implementation when the upstream bridge
supports it — the typed contract above is the consumer-side spec the upstream proposal
should target.

### Upstream proposal — bridge events feature

Drafted here for the next batch upstream (joining the Band B items in TDD 0037):

> **Feature: server-pushed events from the Foundry MCP bridge to the MCP client.**
> The bridge already maintains a websocket to the Foundry-side module to drive its own
> request/response tools. Surface a subset of Foundry-side events to the MCP client over
> the MCP server's notification channel:
>
> - `scene-activated` (Foundry's `updateScene` with `active: true`)
> - `token-moved` (Foundry's `updateToken` on `x`/`y`)
> - `combat-started` / `combat-ended` / `combat-turn` (Foundry's `Combat` lifecycle)
> - `actor-updated` (Foundry's `updateActor` filtered to mechanical fields)
> - `journal-accessed` (Foundry's journal-page render hook, opt-in only since it can be
>   noisy)
>
> Event payloads should carry the entity id + the changed-fields patch, so consumers can
> avoid a round-trip read after each event.
>
> Privacy: events are GM-only by default (the bridge is already GM-scoped). No
> per-player filtering required at the bridge level.

This proposal is added to TDD 0037's upstream batch (Band B) on the next iteration.

### Per-audience journal-share upstream piggyback

The audience-targeted journal share is already in TDD 0037's upstream batch ("per-player
content reveal" — currently in Band B). This TDD's Foundry-whisper fallback (via TDD
0035's `FoundryWhisperSurface`) is explicitly the v0.5 implementation; when the upstream
lands, `share_journal_to_audience` adds a first-class bridge-side branch for
`audience: 'player:<id>'` and the player still gets the bridge-side reveal _plus_ the
whisper narration (the whisper layer is the "you found a note" framing; the bridge-side
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
5. `FoundryEventStream` interface + `NullFoundryEventStream` + `MockFoundryEventStream`.
6. Orchestrator wiring of the null stream; orchestrator tool registry adds the four
   tools.
7. Upstream proposal text added to TDD 0037's Band B batch.

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
  session-start barrier; `NullFoundryEventStream` makes this moot at v0.5.
- **The bridge starts pushing events that the consumer didn't expect** (new event types
  added upstream). The `FoundryEvent` union is closed; unknown event types are logged-and-
  ignored, not crash.
- **Active scene changes mid-`place_hidden_token`.** Handler reads the active scene id at
  invocation; if it differs from the requested `sceneId` (or the implicit active), it
  raises a `scene-changed-mid-action` error rather than placing on the wrong scene.

## Requirement traceability

| PRD ref                                     | Requirement                                                                                                                          | Satisfied by                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.8 (place tokens with `hidden` visibility) | "The AI can place tokens with `hidden` visibility"                                                                                   | `place_hidden_token` tool; `update-token hidden:true`                                                                                                                                                     |
| 4.8 (reveal tokens)                         | "reveal them when narratively appropriate"                                                                                           | `reveal_token` tool; `update-token hidden:false`                                                                                                                                                          |
| 4.8 (share journals to audience)            | "share journal entries with a specified audience (`table` / `player:<id>`, per §4.7)"                                                | `share_journal_to_audience` tool with per-audience branching; Foundry-whisper fallback (TDD 0035) for player audience until the upstream lands                                                            |
| 4.8 (distribute loot)                       | "distribute loot to actor inventories"                                                                                               | `distribute_loot` tool; `add-actor-items` per item                                                                                                                                                        |
| 4.8 (live state perception)                 | "subscribes to Foundry state changes — scene activation, token movement, combat-tracker events, actor-sheet updates, journal access" | `FoundryEventStream` consumer-side contract; `NullFoundryEventStream` v0.5 wiring; upstream proposal section; **real implementation blocked on upstream** (per the approved design decision for this TDD) |
| 4.8 (Discord voice presence)                | "and to Discord voice presence"                                                                                                      | Voice presence shipped in the legacy onboarding TDD (`VoiceIO.presence`); the responsibility now lives in TDD 0036 (which supersedes TDD 0023); not re-designed here                                      |
| 4.8 (behavior policy separation)            | "behavior spec's job (per §4.3)" — trigger _policy_ lives in the behavior spec                                                       | Tools are platform capabilities; per-action policy is out of scope per ADR-0006                                                                                                                           |

## Dependencies considered

None. All four tools route through existing `FoundryClient` + `McpFoundryClient` (TDD 0014),
TDD 0034's SurfaceRouter, and TDD 0035's `FoundryWhisperSurface`. No new third-party
libraries.

A separate event-bus library was evaluated for `FoundryEventStream` (e.g., `mitt`,
`eventemitter3`) and rejected — the consumer-side contract is a one-method `subscribe`;
adding a dependency for one method is over-engineered. `NullFoundryEventStream` is a
single file; the real implementation, when upstream lands, can use a simple internal
fanout off the MCP SDK's notification handler.

## PRD conflicts surfaced (and resolution)

1. **Live state perception is unfeasible against the current bridge wire.** §4.8's
   perception spec assumes server push; TDD 0014 shows the bridge is request/response
   only. **Resolution (approved):** block real perception on an upstream proposal;
   design the consumer-side contract; ship a `NullFoundryEventStream` v0.5 wiring.
   Behaviors that depend on perception are no-ops until upstream lands. This is named in
   the PRD's traceability above as a known gap, not a silent omission.
2. **Per-audience journal share is unfeasible against the current bridge surface.**
   TDD 0037 (which supersedes TDD 0027) carries this gap as a Band B upstream item.
   **Resolution:** v0.5 Foundry-whisper fallback via TDD 0035's `FoundryWhisperSurface`;
   upstream piggyback in TDD 0037's batch; tool surface is forward-compatible (the
   bridge-side "show to players" branch lights up additively when upstream lands).
3. **Token placement at explicit coords is constrained.** TDD 0022 item 5 named this
   gap. **Resolution:** v0.5 uses the two-step create-then-`move-token` fallback in
   `place_hidden_token`; performance is acceptable for the action's frequency. Upstream
   proposal for a first-class place-at-coords parameter is in TDD 0037's batch
   (carried forward from TDD 0027, Band B).
4. **Behavior policy vs. capability separation.** §4.8 lists triggered actions and live
   perception together. Per ADR-0006, _trigger policy_ (when to reveal, when to share,
   when to distribute) lives in the behavior spec — not this TDD. Explicitly named to
   prevent reviewer confusion.

## Decisions to promote (ADR candidates)

- **Platform gaps are upstream proposals, not orchestrator workarounds — optional
  recommend.** The discipline of refusing to polyfill in the orchestrator what should be
  fixed in the bridge (the explicit design decision behind blocking perception on
  upstream events) is a posture that affects every future bridge-coverage gap. It's a
  refinement of ADR-0011 ("prefer fully-OSS Foundry MCP bridges") rather than a wholly
  new principle; worth evaluating at step 6 whether to record it as a refining ADR or
  leave it as a captured-in-TDD design note.
- The other §4.8 ADR candidates (operator-as-host supersession; silence-is-success)
  originate in TDD 0031; no new candidates from this TDD beyond the optional one above.

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
9. **`NullFoundryEventStream` no-op.** `subscribe` returns a no-op unsubscribe; no events
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
  bridge. This is a smaller version of the per-player gap (now tracked in TDD 0037 Band
  B, carried forward from TDD 0027) and folds into the same upstream proposal.
- **Combat-tracker control** (start/end/initiative/next-turn) is a known bridge gap
  (TDD 0022 #1; carried forward into TDD 0037's Band B). It's not in §4.8's enumerated
  triggered actions but is needed to drive combat. Out of scope for this TDD; tracked in
  TDD 0022 + TDD 0037's upstream batch. When the upstream lands, a follow-up TDD adds the
  combat control tools.
