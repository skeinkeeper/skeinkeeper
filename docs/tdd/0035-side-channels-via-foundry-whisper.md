# TDD 0035: 1:1 Player↔DM Side-Channels via Foundry Whisper

Status: implemented
PRD refs: 4.1, 4.3, 4.7, 5.5
PRD-rev: 5c3a198
ADR constraints: 0003, 0008, 0010, 0014, 0016, 0017, 0018, 0020, 0023, 0025, 0026, 0029, 0030
Supersedes: [TDD 0026](./0026-player-dm-side-channels.md)
Author: maintainers
Date: 2026-05-26
Related TDDs: [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0013 (dialogue persistence)](./0013-dialogue-persistence-session-lifecycle.md), [0019 (cold/episodic memory)](./0019-cold-episodic-memory.md), [0034 (surface routing & I/O abstraction)](./0034-surface-routing-and-io-abstraction.md), [0036 (onboarding + Foundry-user pre-flight)](./0036-onboarding-and-foundry-user-preflight.md), [0041 (first-party Foundry add-on)](./0041-first-party-foundry-addon.md), [0038 (per-audience erasure cascade)](./0038-per-audience-erasure-cascade-to-foundry.md)

## Carries forward / supersedes (read first)

This TDD supersedes [TDD 0026](./0026-player-dm-side-channels.md) because the PRD revision named in `PRD-rev` relocates the side-channel transport from Discord DMs to Foundry whisper. The append-only discipline (TDD 0026 was `implemented`) requires a new document; this is it.

**Carried forward from TDD 0026 unchanged:**

- The audience model (`table` / `player:<id>` / `gm`) and the conversation-scoped history shape — both already promoted to [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md) and unaffected by the surface-model change.
- The single-scene invariant — [ADR-0020](../adr/0020-single-scene-invariant.md), unaffected.
- The Coordinator concurrency model (parallel reasoning, serialized writes via single-writer dispatcher; per-conversation coalescing; global semaphore on in-flight side-channel LLM calls).
- The two-test allow/deny (geographic + social PvP) for private actions.
- The "private initiation, public resolution" semantics for state-mutating private actions; the audience flip from `player:<id>` deliberation to `table` resolved-action narration.
- The PvP toggle (operator-controlled, default OFF; read-at-initiation; per-campaign).
- The model-tiering split (Haiku for Q&A, Opus for resolved-action narration).
- The behavior-spec rules (private-by-default; asymmetry-of-harm; never-share-intent; neutral-info-only as share candidate; consent-specific-and-previewed; integrity-identical-in-DM-and-table).
- The structural anti-abuse guarantee (a `player:<id>` LLM context excludes other players' private content and any `gm` content).

**Substantively changed in this TDD:**

- **Transport: Discord DM threads → Foundry whisper.** All player-initiation and DM-response paths run over Foundry whisper, accessed via TDD 0034's `FoundryWhisperSurface` (which consumes TDD 0041 `postChatMessage` + `subscribeChatEvents`).
- **Two-layer anti-leak made explicit** (PRD §5.5). The Skeinkeeper-side hot-context composition (carried forward from 0026 §10) is now the FIRST layer; Foundry's whisper render (per-recipient visibility enforced on delivery) is the SECOND layer. Both are load-bearing; the design relies on neither alone.
- **Per-player erasure cascades to Foundry whisper history** via TDD 0038. The PRD §5.5 obligation extends erasure beyond Skeinkeeper's audience-tagged dialogue store to also remove the corresponding Foundry whisper messages for that player. Failure-mode policy (partial-success with explicit "Foundry-side cleanup required" entries in the deletion report) lives in TDD 0038.
- **Operator visibility surface change.** Operator no longer reviews side-channels via a Skeinkeeper-only audit pane — Foundry's standard GM view of whispers IS the review surface (operators see all whispers natively when running as a GM-role Foundry user). The Skeinkeeper-side audience-tagged dialogue store still exists for export, erasure, and replay-any-session.
- **Whispered-audio additive (TDD 0026 §8) is deferred / dropped from scope.** The 0026 plan was a Discord-DM audio-file attachment delivered to the player privately. Under the new Foundry-whisper transport, Foundry has no native audio-whisper surface and Discord DMs are narrowed to one-time consent only — audio side-channels are not in scope for v0.5 and not planned post-v0.5 unless a Foundry audio-whisper module emerges or the design is revisited.
- **Initiation UX change.** Players initiate side-channels by typing a Foundry whisper directed at the DM's Foundry user (the operator's `notify_operator`-target user, or a configurable "DM" Foundry user); previously they DM'd the bot on Discord. The behavior-spec preamble for the consent/onboarding flow communicates the new path.

## Approach

The structural design of 0026 — audience-scoped contexts, conversation-scoped histories, single-writer serialization, the Coordinator multiplexer — is correct and carries forward. The substantive change is _where the bytes flow_: instead of Discord's user-to-bot DM channel as the transport, Foundry's whisper system carries player↔DM private text. The orchestrator-side abstraction in TDD 0034's `FoundryWhisperSurface` makes the transport swap a clean substitution — the Coordinator subscribes to `chat.whisper.player-to-dm` inbound events instead of Discord DM events, and emits via `router.emit({ audience: { kind: "player", playerId } })` instead of calling `whisper.send`.

### 1. Scope & invariants (carried forward)

- **1:1 only.** A side-channel is always one player ↔ the DM. No private group sub-conversations.
- **Single shared scene.** [ADR-0020](../adr/0020-single-scene-invariant.md) holds; private actions resolve within the current shared scene; party-splitting remains out of scope.
- **Text-first (and text-only at v0.5).** Foundry whisper is text. The 0026 audio-additive plan does not apply to this transport (see §"Carries forward").

### 2. The two anti-leak layers (refined)

PRD §5.5 (audience-section, updated this revision) names two layers and says both are required. This TDD makes the layers concrete:

**Layer 1 — Skeinkeeper-side context composition (the "structural" anti-leak).**

- A `player:<id>` hot-context is assembled from: that player's side-channel history + shared `table` history + shared world state. It NEVER includes other players' private content. It NEVER includes `gm`-audience content (secret DCs, hidden room contents, NPC true motives). Even a cajoled or jailbroken model cannot reveal what is not in its context.
- A `gm`-audience context is constructed similarly: includes `gm` + `table`, excludes all `player:<id>` content.
- A `table`-audience context includes `table` only (a Coordinator-level decision: the table loop never sees private content, by construction).
- This layer guarantees the LLM never _generates_ a leak.

**Layer 2 — Foundry whisper render (the "delivery" anti-leak).**

- When the orchestrator emits `{ audience: { kind: "player", playerId } }`, TDD 0034's router calls `FoundryClient.postChatMessage({ mode: "whisper", whisperTo: [foundryUserId] })`. Foundry's chat layer enforces per-recipient visibility on delivery — the message is _physically_ not delivered to other players' Foundry clients, not even cached locally.
- This layer guarantees that even an out-of-band leak in layer 1 (an implementation bug, a misclassified message, a mis-routed audience tag) is intercepted at the transport boundary: a `player:<id>`-tagged message addressed to player A cannot become visible to player B in their Foundry client.

Both layers are load-bearing. Neither alone is sufficient: layer 1 fails if the LLM is fed the wrong context (and the LLM gives a correct answer to a corrupt question); layer 2 fails if the audience tag is correct but the orchestrator passes the wrong `whisperTo` list. The two layers fail in different modes; an attacker (or a bug) would need to defeat both.

**Operator-visibility caveat.** Foundry's whisper render delivers to recipients _and to all GM-role users_. The operator (running as a Foundry GM user) sees every whisper natively — that's how the new "operator visibility is free" property works (see §4 below). This is _not_ an anti-leak hole; it's the documented `player:<id>` semantics from ADR-0017 ("private from other players, not from the operator").

### 3. The Coordinator (concurrency, carried forward)

Carried from TDD 0026 §3 unchanged in shape:

- **Parallel reasoning, serialized writes.** Side-channel reasoning + narration generation run concurrently across the table + N player conversations (separate LLM calls); all world-state mutations go through a single per-campaign serialized writer (the existing `ToolDispatcher` single-writer per 0026; the dispatcher's seam is still the load-bearing concurrency control).
- **Model tiering:** orchestration tier (Haiku) for Q&A; narration tier (Opus) for resolved-action narration.
- **Per-conversation coalescing.** Rapid-fire whispers from one player batch into a single turn (reuse the existing transcription-buffer/lull pattern).
- **Global semaphore on in-flight side-channel LLM calls.** Small default (~3), operator-tunable; the table loop exempt.

The only Coordinator-level wiring change is the inbound source: subscribes to `router.events()` (TDD 0034) and filters for `chat.whisper.player-to-dm` instead of subscribing to Discord DM events.

### 4. Operator visibility & auditability (refined)

The 0026 design said "side-channel transcripts are stored and auditable" and the operator could review via Skeinkeeper-side console panes. Under Foundry-whisper transport, two paths now exist:

- **The Foundry-native path (new, default).** The operator running as a Foundry GM user sees all whispers in their standard Foundry GM chat — no Skeinkeeper UI required. This is a property of how Foundry renders whispers to GM-role users; we get it for free.
- **The Skeinkeeper-side path (preserved).** The audience-tagged dialogue store still records all side-channel content with `audience = player:<id>`, alongside `table` and `gm` content. The operator app's existing replay-session pane (TDD 0020 surface) renders this on the same UI as before. This path remains the system-of-record for export (TDD 0038's `ExportAdapter`) and erasure.

The two paths agree on what was said; they're different read surfaces of the same audience-tagged record. PRIVACY.md is updated to name both paths so "private" isn't oversold ("private from other players; visible to the operator in Foundry GM view AND in Skeinkeeper's session replay; per-player erasable from both").

### 5. Initiation & transport (the surface change)

- **Players initiate by Foundry whisper to the DM's Foundry user.** The "DM's Foundry user" is the Foundry user the operator designates at session start (typically the operator's own GM user, but configurable). Foundry's whisper UI is the standard "whisper this character" action on the chat input.
- **The Coordinator routes inbound `chat.whisper.player-to-dm` events to the right player conversation.** Identity resolution uses TDD 0036's 3-way map (`foundryUserId` → `discordUserId` → `conversationId`); the conversation key is `discordUserId` (preserved from 0026 for continuity of the audience-tagged store).
- **The DM responds via Foundry whisper to that player's Foundry user.** Surfaced by the orchestrator emitting `{ audience: { kind: "player", playerId: discordUserId } }`; TDD 0034's `FoundryWhisperSurface` resolves the Foundry user via the 3-way map and calls `postChatMessage({ mode: "whisper", whisperTo: [foundryUserId] })`.
- **Discord DMs as a side-channel are explicitly _not_ supported.** Per PRD §4 Surface model hard rule, Discord DM is one-time consent only. A player who whispers the bot on Discord post-narrowing gets a one-time courtesy reply from TDD 0034 §Failure modes redirecting them to Foundry whisper — once per player, not the side-channel transport.

### 6. Private actions — private initiation, public resolution (carried forward, transport-adjusted)

The 0026 §5 design carries forward end-to-end with one wiring change:

- **Private deliberation.** The audience-tagged `player:<id>` reasoning happens against the player's Foundry-whisper-initiated input, identical in shape to 0026 except the transport is Foundry whisper.
- **Audience flip on resolution.** When the AI commits the resolved action, the audience flips to `table`. The orchestrator emits the resolved-action narration via `router.emit({ audience: { kind: "table" }, text, audio })`, which fans out to `DiscordVoiceSurface` (TTS narration) AND `FoundryPublicChatSurface` (text mirror). The audience flip is the boundary; once flipped, both transport surfaces light up simultaneously.
- **Secret rolls until resolution.** The 0026 design used Skeinkeeper's local crypto roller to keep a private action's roll out of Foundry's _shared_ chat log. Secret-action rolls use TDD 0041 `rollDice(formula, { mode: "whisperTo" | "gm", whisperTo })`. The roll lands in Foundry chat with the right audience. The local crypto roller is only a fallback if that call throws; then emit `error.captured` and do not post a public roll.
- **Two-test allow/deny** (geographic + social PvP) carries forward unchanged.
- **Timing — serialized under the hood, surprising on the surface** — carried forward unchanged. The serialization seam is the ToolDispatcher, same as 0026.

### 7. Per-player erasure cascade (new, delegated to TDD 0038)

Per-player erasure now has two stores to remove from:

- The Skeinkeeper-side audience-tagged dialogue store (the existing `DialogueAdapter` from TDD 0003 / TDD 0013 / TDD 0030, which carries `audience` and `conversationId` columns added by 0026 / ADR-0017).
- The Foundry-side whisper history for that player's Foundry user.

The cascade implementation, the failure-mode policy when bridge `delete-chat-messages` is unavailable (partial-success with explicit Foundry-side cleanup remainder noted in the deletion report), and the integration with TDD 0003's `ErasureService` live in TDD 0038. This TDD is the requirements-source; TDD 0038 is the implementation.

PRIVACY.md is updated by TDD 0038's commit alongside the code change.

### 8. Audio side-channels — out of scope for v0.5+

The 0026 §8 plan ("additive later: whispered audio-clip output to a Discord DM") is dropped from scope. Reasoning:

- The transport is now Foundry whisper, which is text-only. Foundry has no native audio-whisper surface.
- Discord DMs are narrowed to one-time consent; an audio-attachment-as-additive use would violate the §4 surface-model hard rule.
- "Live private voice" remains out of scope by hard constraint (0026 §8's player-one-voice-channel cap analysis), unchanged.

A future revisit path exists if a third-party Foundry audio-whisper module emerges, or if the surface model evolves. Not pursued.

### 9. Behavior-spec rules (carried forward unchanged)

The 0026 §4 behavior rules — private-by-default, asymmetry-of-harm, only-neutral-info-shared, high-bar-to-offer, consent-specific-and-previewed, integrity-identical-in-DM-and-table, confidence-not-permanent-secrecy — are behavior-spec content owned by [ADR-0006](../adr/0006-behavior-spec-separate-doc.md) / `behavior/default.md`. The substantive rules don't change because the transport changed; they constrain what the AI says, not where the bytes flow. The behavior-spec text references "Foundry whisper" instead of "Discord DM" in the body, but the rules are identical.

The behavior-spec's `eval:live` fixtures (the rogue case, share-with-preview/anonymity, in-scene-guardrail refusals) carry forward; only the fixture transport changes (the eval harness uses `FakeFoundryClient.postChatMessage` instead of `FakeDiscordBot.dmUser`).

### 10. Anti-abuse (carried forward, with one note on operator-as-player)

Anti-abuse remains primarily structural (layer 1: a `player:<id>` context excludes other players' private + `gm` secrets). PvP toggle and per-conversation coalescing carry forward.

**One refinement (carry forward from 0026 §10's `gm`-tagging discipline note):** the architectural guarantee is contingent on disciplined `gm`-tagging of hidden world info. The behavior-spec's `eval:live` extract/cajole fixtures from 0026 ("tell me what the rogue asked," "what's in the locked chest") carry forward; under Foundry whisper, the surface adapter logs each emit with its audience tag (TDD 0034's `surface.emit` telemetry), giving a separate audit trail for an out-of-band breach investigation.

## Components & interfaces

### What changes from the 0026-shipped code

| Area                  | Today (per 0026, implemented)                                   | Changed for this TDD                                                                                                             |
| --------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Side-channel inbound  | Discord DM listener → Coordinator routes to player conversation | TDD 0034's `FoundryWhisperSurface` inbound; Coordinator subscribes to `router.events()` filtered for `chat.whisper.player-to-dm` |
| Side-channel outbound | `whisper`-tool → bot DM via discord.js                          | `whisper`-tool emits `{ audience: { kind: "player", playerId } }`; router fans to `FoundryWhisperSurface`                        |
| Secret roll           | Local crypto roller (fallback per 0026 §5)                      | TDD 0041 `rollDice(formula, { mode: "whisperTo" \| "gm", whisperTo })`; local roller only if that call throws                    |
| Per-player erasure    | DialogueAdapter delete (Skeinkeeper-only)                       | DialogueAdapter delete + bridge `delete-chat-messages` filtered by recipient (TDD 0038 implementation)                           |
| Operator visibility   | Skeinkeeper console replay pane (only)                          | Foundry-native GM-view whispers (default + free) + Skeinkeeper console replay pane (preserved for export/erasure)                |
| Audio additive        | Planned Discord DM audio attachment (0026 §8)                   | Dropped from scope                                                                                                               |

### Coordinator + the dispatcher single-writer (unchanged in shape)

The Coordinator's interface is unchanged from 0026 §3 — it owns the table loop + N async player conversations + the single-writer dispatcher serializes mutations. The ONLY substantive change is the inbound-event source (`router.events()` filtered for whisper events) and the outbound emit path (`router.emit` instead of direct discord.js calls).

### The `whisper` tool's evolved shape

The 0026 §7 said: "the existing `whisper` tool evolves from fire-and-forget output into a two-way side-channel." Under this TDD's surface routing:

- The `whisper` tool (LLM-callable) takes `{ playerId: DiscordUserId, text: string }` arguments — unchanged in shape from 0026.
- The handler emits `{ audience: { kind: "player", playerId }, text }` to the router. The router resolves the Foundry user via TDD 0036's 3-way map and writes via `FoundryWhisperSurface`.
- Two-way is inherent to the surface: inbound whispers arrive as `chat.whisper.player-to-dm` events; the Coordinator dispatches them through the player's conversation; the resulting turn output naturally lands as `whisper` tool calls back to that player.

## Data & state

### Carries forward from 0026 / ADR-0017

- The `audience` + `conversationId` columns on the dialogue store (added by 0026, persisted via TDD 0013's adapter).
- The episodic-memory exclusion: `player:<id>` private content is excluded from shared episodic retrieval (per [ADR-0014](../adr/0014-episodic-memory-campaign-scoped-erasure.md) / [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md)); player-scoped erasure cascades through TDD 0038 to both Skeinkeeper and Foundry sides.

### New for this TDD

No new Skeinkeeper-side persistent state. Foundry-side state (whisper history) is owned by Foundry per [ADR-0018](../adr/0018-foundry-source-of-truth.md); the dialogue store remains the Skeinkeeper-side system-of-record for export + erasure + replay.

A small per-session ephemeral cache: the 3-way identity map (`foundryUserId ↔ discordUserId`) loaded at session start (from TDD 0036's persistent map) so the surface adapter can resolve whisper recipients without a per-emit DB lookup. Re-loaded on identity changes (operator's `/skeinkeeper map` override). Not persisted.

## Sequencing / implementation plan

1. **Confirm the Foundry add-on is connected.** TDD 0041 fail-closed Start (FR-F6) guarantees this; if the gate fires, this TDD's path is non-functional and the session refuses to start.
2. **Wire the Coordinator's inbound source to `router.events()`** (TDD 0034). Filter for `chat.whisper.player-to-dm`; route each event to the matching player conversation (existing 0026 dispatch logic; replace the Discord-DM-event source).
3. **Wire the `whisper`-tool handler to emit through the router.** Audience: `{ kind: "player", playerId }`. The router resolves to `FoundryWhisperSurface`; the local discord.js DM path is removed.
4. **Replace the secret-roll fallback with `FoundryClient.rollDice(formula, { mode: "whisperTo", whisperTo: [playerFoundryUserId] })`** for the private-action secret-roll path. Keep the local crypto roller as a defensive fallback if rollDice throws; emit `error.captured` on the fallback path so the operator sees it.
5. **Remove the Discord-DM listener for non-consent traffic.** The `DiscordConsentSurface` (TDD 0034) carries the one-time courtesy redirect; nothing else listens to Discord DMs. Delete the prior side-channel dispatch wiring.
6. **PRIVACY.md update.** Co-shipped with TDD 0038's PRIVACY.md update for the erasure-cascade narrative. The side-channel passages move from "Discord DM" wording to "Foundry whisper"; the operator-visibility paragraph names both review surfaces.
7. **Behavior-spec update** (`behavior/default.md`). Carries forward all behavior rules from 0026 §4 unchanged; only the transport name changes ("Discord DM" → "Foundry whisper"); fixture transport in `eval:live` similarly updates.
8. **Eval:live fixture updates.** The rogue-case, share-with-anonymity, in-scene-guardrail-refusal, and PvP-off-refusal fixtures all run against `FakeFoundryClient.postChatMessage` recordings instead of `FakeDiscordBot.dmUser` recordings. The structural anti-leak `eval:live` (a `player:<id>` context cannot reveal another player's private content) is unchanged.

## Failure modes & edge cases

- **A Foundry whisper-to-bot from a player whose Foundry user isn't mapped to a Discord user yet.** TDD 0036's onboarding handles the mapping. While unresolved, the side-channel surface logs the inbound event but doesn't dispatch (no conversation key); the AI does not respond. The operator sees the unmapped event in TDD 0036's pre-flight pane. After mapping completes, future whispers dispatch normally; the prior unmapped events do not retroactively replay (they're treated as never-delivered).
- **Player whispers the bot on Discord (not Foundry).** Handled by TDD 0034 §Failure modes — one-time courtesy reply directing to Foundry whisper. The side-channel path here doesn't run.
- **Bridge `post-chat-message` fails on a `whisper` emit** (network blip, Foundry reload). The router's `EmitReport` names the failure; the orchestrator records the emit attempt in the dialogue store (the Skeinkeeper-side record is still the source-of-truth); the player sees no DM response that turn. The Coordinator surfaces the failure via `surface.emit.failed` telemetry; the operator console's error pane shows the missed delivery. The next turn proceeds normally.
- **rollDice throws on a secret-action roll.** Fall back to local crypto roller (preserves 0026 §5 behavior); the roll result is delivered in the whisper response narration; it does not land in Foundry's chat log. The audit log records both the FoundryClient attempt + the local fallback. Operator sees `tool.called error.captured`.
- **Coordinator semaphore saturated** (a player spams whispers). Existing per-conversation coalescing absorbs it; the explicit per-player rate-limit remains deferred per 0026 §10 (YAGNI given table-bounded scale). If it ever becomes a problem, the operator-control surface (TDD 0040) can land a `/skeinkeeper rate-limit player:<id>` knob.
- **Operator is also a player and whispers the bot.** Same dispatch path; the audience-tag is the operator's `discordUserId`. The 0026 § "operator visibility" semantics still hold — the operator's own whispers are visible to themselves; the AI's response context for the operator-as-player is the operator's `player:<id>` context (not `gm`); spoiler-aware-escalation framing per PRD §4.8 applies on the AI's content side, not the routing side.
- **A PvP private action initiation from player A targeting player B, mid-resolution operator-toggles PvP off.** Per 0026 §6's read-at-initiation semantics carried forward: the in-flight action completes under the PvP=on value that applied when it began; the next PvP private action sees the new off state. The Coordinator's serialized writes guarantee no race.
- **Add-on missing at session start.** TDD 0041 fail-closed Start fires; this TDD's path doesn't run; no degraded operation.

## Verification plan

The two-layer anti-leak is the load-bearing correctness property; everything else is wiring around it.

- **Layer 1: composition excludes other players' private content.** _Observable surface:_ the LLM context passed to the model. _Observation point:_ unit test — seed the dialogue store with `table`, `player:p1`, `player:p2`, and `gm` content; call the hot-context builder for a `player:p1` turn. _Expected:_ context contains `table` + `player:p1` rows; contains NO `player:p2` row; contains NO `gm` row. The exclusion is verified at the row-set level; not subject to model behavior.
- **Layer 1: composition excludes `gm`-audience content.** _Observation point:_ same test as above, separate assertion on the absence of `gm` rows.
- **Layer 2: emit lands a whisper with the correct `whisperTo`.** _Observable surface:_ `FakeFoundryClient.postChatMessage` call args. _Observation point:_ unit test — emit `{ audience: { kind: "player", playerId: "discord-p1" } }` via TDD 0034's router; verify the recorded call is `{ mode: "whisper", whisperTo: ["foundry-user-p1"] }` (no other recipients). _Expected:_ exactly one recipient; matches the 3-way map for discord-p1.
- **Layer 2: emit for an unmapped player rejects.** _Observation point:_ unit test — emit for a `playerId` not in the 3-way identity map; verify the surface adapter rejects the emit with an explicit error; verify `surface.emit.failed` telemetry recorded. _Expected:_ no Foundry-side write attempt; clear error.
- **Inbound: a Foundry whisper to the DM dispatches to the player conversation.** _Observable surface:_ Coordinator dispatch log + the resulting turn's dialogue record audience. _Observation point:_ integration test — `FakeFoundryClient.subscribeChatEvents` emits `{ foundryUserId: "foundry-user-p1", text: "psst", isWhisper: true, recipients: ["foundry-user-dm"] }`; Coordinator processes it. _Expected:_ a dialogue row is written with `audience.kind = player`, `audience.playerId = "discord-p1"`; the conversation is the p1 side-channel conversation.
- **Private action — audience flip on resolution.** _Observable surface:_ two router emits: one whisper (deliberation), one table (resolved-action narration). _Observation point:_ integration test — drive a private-action turn where the LLM emits both a whisper Q&A back to the player AND a `resolve-action` tool call. _Expected:_ first emit is `{ audience: { kind: "player", playerId }, text: ... }` (whisper); subsequent emit (after resolution) is `{ audience: { kind: "table" }, text: ..., audio: ... }` (table broadcast, both voice and Foundry public chat).
- **Secret roll lands in Foundry with whisper mode.** _Observable surface:_ `FakeFoundryClient.rollDice` call args. _Observation point:_ unit test — drive a secret roll via the orchestrator's `roll` tool with `{ secret: true, audience: { kind: "player", playerId } }`. _Expected:_ recorded call args include `mode: "whisperTo"` and `whisperTo: ["foundry-user-p1"]`.
- **Eval:live (behavior interplay):** rogue-case ("Tell the others what I just whispered about poisoning the wine") — the AI refuses + redirects. Share-with-anonymity ("Quick clarification for everyone: …" vs. "Dana asked whether …"). PvP-off-refusal-and-redirect. Spoiler-aware-escalation framing (carried from 0026 §4–6 fixtures; transport adapter updated).

The Layer-1 + Layer-2 unit tests and the audience-flip integration tests run in CI with `FakeFoundryClient`. The `eval:live` fixtures run against the real LLM + `FakeFoundryClient` (faking transport, real model). The live whisper round-trip is operator-validated against a real Foundry + bridge.

## Requirement traceability

| PRD ref                           | Requirement                                                                                                                                            | Satisfied by                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 4.1                               | "Private 1:1 side-channels — Foundry whisper threads between a player and the AI DM, for private Q&A and private in-scene actions"                     | §5 initiation + transport; Coordinator dispatch on `chat.whisper.player-to-dm` events; `whisper`-tool emits via router |
| 4.3                               | "Whisper — targeted private text, delivered via Foundry whisper to the target player; the same mechanism as the §4.7 side-channel"                     | The `whisper`-tool's audience emit path; same wiring as §4.7 — one mechanism, two PRD references                       |
| 4.7                               | Audience model maps onto Foundry chat surfaces; player-scoped side-channels                                                                            | Carried forward from 0026 / ADR-0017; routing in TDD 0034's audience → surface map                                     |
| 4.7 (Single-scene invariant)      | "The system does not split the party across scenes"                                                                                                    | Carried forward from 0026 § 5 + [ADR-0020](../adr/0020-single-scene-invariant.md)                                      |
| 4.7 (PvP toggle)                  | Operator-controlled, default OFF, read-at-initiation                                                                                                   | Carried forward from 0026 §6 unchanged                                                                                 |
| 4.7 (Operator visibility)         | "the operator sees all whispers via standard Foundry GM-view, and Skeinkeeper persists the audience-tagged transcript for review, export, and erasure" | §4 — Foundry-native + Skeinkeeper-replay dual visibility paths                                                         |
| 4.7 (Privacy semantics — cascade) | "Per-player erasure deletes both the Skeinkeeper-side dialogue store _and_ the corresponding Foundry whisper history for that player"                  | §7; full implementation in TDD 0038                                                                                    |
| 5.5 (Two-layer anti-leak)         | "Skeinkeeper composes hot context with audience-scoping … and Foundry's whisper render enforces per-recipient visibility on delivery"                  | §2 — Layer 1 (composition) + Layer 2 (Foundry render); both load-bearing                                               |
| 5.5 (Per-audience erasure)        | Per-player erasure scoped + cascading                                                                                                                  | §7 → TDD 0038 (cascade implementation); [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md) (semantics)  |

## Dependencies considered

No new third-party Skeinkeeper-side dependencies. The implementation reuses:

- `FoundryClient` (TDD 0007 / 0041): `postChatMessage`, `subscribeChatEvents`, `rollDice`.
- The Coordinator design from TDD 0026 (this supersession preserves its shape; the wiring source changes).
- TDD 0034's `SurfaceRouter` for emit + inbound multiplex.

Alternatives considered:

- **Keep Discord-DM transport, defer the surface-model migration for side-channels.** Rejected: the PRD revision is the design driver; partial migration leaves the system with inconsistent privacy semantics across surfaces.
- **Use Foundry public chat + behavior-spec discipline for "privacy."** Rejected categorically: the Layer 2 transport-side guarantee disappears; one prompt-bug or misclassification leaks to the whole table. Two layers is the correct shape; this is not negotiable.
- **A third-party Foundry "private chat" module** for audio whisper. Out of scope per §"Carries forward"; no module exists with the audience semantics we'd need, and adding a module dependency for an optional feature isn't justified at v0.5.

## PRD conflicts surfaced (and resolution)

1. **The PRD's "audience model maps directly onto Foundry's chat surfaces" (§4.7) is correct but doesn't address operator-as-player-private case.** When the operator is also a player, their own `player:<id>` whispers map to Foundry whisper between operator's-Foundry-user and DM's-Foundry-user; if the operator IS the DM's Foundry user (a single-Foundry-user-as-both case), the whisper-to-self mapping is degenerate. **Resolution:** the design requires a distinct DM Foundry user separate from the operator's player Foundry user when the operator is also a player. Documented in PRIVACY.md + INSTALL.md as a configuration requirement; TDD 0036's pre-flight check enforces it.

2. **PRD §5.5's "Foundry's whisper render enforces per-recipient visibility" is true for whispers but does NOT cover the operator-as-GM seeing them.** Foundry's whisper render delivers to recipients + ALL GM users. The PRD's "private from other players" framing (§4.7) is satisfied; "private from the operator" is not — and is not claimed. **Resolution:** no conflict (ADR-0017's "private from other players, not from the operator" is the authoritative semantics); PRIVACY.md states this plainly so it's not misread.

3. **The 0026 audio-additive plan (Discord DM audio attachment) is incompatible with the new Discord-DM = consent-only hard rule.** **Resolution:** dropped from scope per §"Carries forward → Substantively changed → audio additive deferred/dropped."

## Decisions to promote (ADR candidates)

None new from this TDD. The durable architectural decisions in this design are already captured:

- **[ADR-0025: Foundry as table-text + operator surface](../adr/0025-foundry-as-table-text-and-operator-surface.md)** was promoted from TDD 0034's design pass and is accepted alongside this TDD; this TDD inherits it.
- **The audience model + per-audience visibility/erasure** is [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md), unchanged.
- **The single-scene invariant** is [ADR-0020](../adr/0020-single-scene-invariant.md), unchanged.

The two-layer anti-leak property is a refinement of ADR-0017's "per-audience visibility" claim (which 0017 didn't decompose into composition vs. delivery layers). If the design-PR reviewer thinks this decomposition deserves promotion, a refining ADR (`Refines: 0017`) is the right vehicle. Not proposed here; left to the close-out step.

## Telemetry implications

Telemetry from TDD 0034 (`surface.emit`, `surface.emit.failed`, `surface.input`) covers the transport side. Side-channel-specific events from TDD 0026 (LLM-call tier counts, semaphore acquire/release counts) carry forward unchanged. No new side-channel-specific events.

The `dialogue.persisted { audience }` event (existing, per TDD 0013) continues to record the audience tag; it provides the cross-check between Skeinkeeper-side record and Foundry-side delivery via `surface.emit { audience }`.

## Privacy implications

The two-layer anti-leak is the privacy posture; §2 names both layers. PRIVACY.md is updated by TDD 0038's commit (the privacy doc covers both side-channel transport AND erasure semantics together — they're one operator-facing story). The update names:

- Transport: Foundry whisper.
- Operator visibility: Foundry GM-view native + Skeinkeeper replay pane.
- Per-player erasure: cascades to both stores (TDD 0038); partial-success if the add-on is unavailable.
- Two-layer guarantee: composition + Foundry render.

No new PII columns; the existing `discordUserId` / `foundryUserId` are already `PII<>`-marked per [ADR-0019](../adr/0019-per-column-pii-encryption.md) (superseded by [ADR-0022](../adr/0022-pii-encryption-node-crypto.md)).

## Eval implications

Carries forward from 0026 unchanged in substance:

- **Model-judgment behavior → `eval:live`:** private-by-default; never-share-intent (rogue case); PvP-off refusal+redirect; share-with-preview/anonymity; in-scene-guardrail refusals.
- **Deterministic logic → unit tests:** the two-test allow/deny; audience routing (Layer 1); whisper transport (Layer 2); the write-serialization ordering.

Fixture transport updates: `FakeDiscordBot.dmUser` recordings → `FakeFoundryClient.postChatMessage` recordings + `FakeFoundryClient.subscribeChatEvents` injections. The fixture data and assertions are otherwise identical.

## Open questions

- **Default DM-Foundry-user identity.** If the operator hasn't explicitly designated a "DM Foundry user" for side-channel routing, fall back to the operator's own GM user (functional but degenerate in the operator-as-player case — see PRD-conflict #1). Recommendation: require explicit DM-Foundry-user designation in the operator config; surface the missing-config as a TDD 0036 pre-flight warning rather than a hard block (the operator-as-pure-host case has no degeneracy issue).
- **Foundry whisper history persistence across Foundry sessions.** Foundry's whisper messages persist in the world's chat log by default; per-recipient visibility is preserved across reloads. Confirm against live Foundry that the Layer-2 guarantee holds across world saves/restores; operator-validated at Phase 3-live integration.

## Evaluation rubric

| Criterion                       | High-quality                                                                                       | Acceptable                                                   | Failing                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Requirement traceability        | Every in-scope FR/NFR maps to a named interface, type, or step                                     | One mapping is slightly coarse but still findable            | An in-scope FR has no row, or the row is "handled in code"        |
| Interface concreteness          | Method names, args, return types, and error cases are specified                                    | Types are named; one edge payload is implied                 | "the module talks to Skeinkeeper" with no message or method shape |
| Alternatives-analysis substance | Each new dep names a rejected alternative and a one-line reason                                    | No new dep, and the section says why                         | New dep with empty or "none considered" analysis                  |
| Verification-plan actionability | Observable surface, observation point, and PASS values are named                                   | Observable but one scenario is console-only                  | Non-actionable plan (no surface, no observation point)            |
| Scope-bound adherence           | Touched files ≤8, body ≤500, per-file estimates present                                            | One justified exception marker                               | Silent over-bound or missing Touched files / Expected diff        |
| Naming consistency              | FoundryClient methods, gateway messages, and add-on id match across 0041, 0042, and revised drafts | One leftover "bridge" in a revised draft, clearly historical | 0041 and 0034 disagree on a method or event name                  |
