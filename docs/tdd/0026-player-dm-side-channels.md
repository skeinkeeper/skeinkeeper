# TDD 0026: 1:1 Player↔DM Side-Channels (private Q&A + private actions)
Status: implemented
PRD refs: 4.1, 5.5
PRD-rev: 10391ba
ADR constraints: 0003, 0008, 0009, 0010, 0014, 0016, 0017, 0020, 0023
Author: maintainers
Date: 2026-05-20
Related TDDs: [0011 (turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md), [0016 (identity mapping)](./0016-player-character-identity-mapping.md), [0019 (cold/episodic memory)](./0019-cold-episodic-memory.md), [0020 (operator app)](./0020-operator-app.md), [0023 (onboarding + operator channel)](./0023-session-onboarding-presence-operator-channel.md)

## Approach

A human DM at a table has one mouth and one attention budget. An AI DM connected over Discord has neither limit — its structural advantage is **parallelism over a shared world**: it can hold a private conversation with one player while the rest of the table keeps going. This is the "multi-threaded DM."

This doc scopes the first, highest-value, lowest-infrastructure slice of that idea: **1:1 private side-channels between a single player and the DM**, over Discord **DMs**, covering both **private questions/info** and **private in-scene actions**. It deliberately excludes party-splitting and live private voice (see Alternatives + §8 for why).

It's written *before* further single-table core development on purpose: the data-model and concurrency seams below are cheap to introduce now and brutal to retrofit once more code assumes a single, table-only conversation. (Latency is a separate problem we still owe; side-channels actually *relieve* some of it by un-blocking the table, but introduce concurrency cost — see Open Questions.)

### 1. Scope & the single-scene invariant

> The single-scene invariant is recorded as [ADR-0020](../adr/0020-single-scene-invariant.md); the per-audience visibility/erasure model is [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md). This TDD retains the design.

- **1:1 only.** A side-channel is always one player ↔ the DM. No private group sub-conversations.
- **One shared world, one timeline, one active scene.** We do **not** support party-splitting. Foundry exposes a single active scene; it already personalizes *within* it (per-player fog/vision, per-player handout reveals), which is enough for private knowledge without separate scenes.
- **The single-scene invariant (the load-bearing constraint):** a private action is permitted only if it **resolves entirely within the current shared scene and does not require or presume another PC's choices.** This is what keeps the shared timeline coherent and private actions resolvable.
- **Text-first.** The initial transport is Discord text DMs. Voice is an additive output mode later; live private voice is out of scope (§8).

### 2. Audience / visibility model (the core data change)

Every utterance, turn, and memory record gains a first-class **audience**: `table` | `player:<id>` | `gm`. A **`conversationId`** scopes coherent history (the table is conversation 0; each player's DM thread is its own conversation that *references* shared world state).

- **Private by default:** DM-originated turns are `player:<id>`; the table never sees them unless the DM explicitly promotes content to `table` (see §4–§5).
- **Hot context** is assembled per conversation: a side-channel's context = that player's side history + shared world state + relevant table context, but **never another player's private content**.
- **Erasure semantics fall out cleanly and align with [ADR-0014](../adr/0014-episodic-memory-campaign-scoped-erasure.md):** `table`/shared content stays **campaign-scoped** (jointly-authored, not per-player erasable); `player:<id>` private content is **player-scoped and individually erasable**. *(This refines ADR-0014's framing; if it counts as a substantive change we write a superseding ADR rather than editing it — see Open Questions.)*

### 3. The Coordinator (concurrency model)

Replace today's "app wires one always-listening loop to one VoiceIO" with a **Coordinator** that owns the table loop **plus N async 1:1 DM conversations**. The interfaces (`VoiceIO`, `LLMProvider`, `FoundryClient`) stay; the orchestration shell becomes a multiplexer.

- **Parallel reasoning, serialized writes.** Side-channel reasoning + narration generation run concurrently (separate LLM calls), but **all world-state mutations go through a single per-campaign serialized writer** — private-action turns are interleaved into one authoritative turn sequence alongside table turns (FIFO by commit-readiness; no special priority, since side-channels are read-mostly and write contention is rare). Two contexts never race the world. (This promotes the dispatcher write-serialization seam from "safety belt" to load-bearing.)
- **Cost & concurrency (bounded by table size — a handful of players, not scale machinery):**
  - **Model tiering:** side-channel Q&A → orchestration tier (Haiku, fast + cheap); only an action *resolution* or a narrated beat → narration tier (Opus).
  - **Per-conversation coalescing:** rapid-fire DMs from one player batch into a single turn (reuse the table loop's transcription-buffer/lull pattern), so one player can't spawn many concurrent turns.
  - **Global semaphore** on in-flight side-channel LLM calls (small default, ~3, operator-tunable); the table loop is exempt/prioritized.

### 4. Private Q&A / info (read-mostly) — behavior rules

These are behavior-spec rules ([ADR-0006](../adr/0006-behavior-spec-separate-doc.md)), encoded in `behavior/default.md`:

1. **Private by default.** A DM is answered in the DM. Sharing is a rare exception.
2. **Asymmetry of harm is the tiebreaker.** A missed share is cheap; a betrayed confidence is unrecoverable. In any doubt → private.
3. **Only *neutral information* is ever a share candidate** (rules clarifications, publicly-observable lore, "what do I see"). Anything revealing a player's **intentions, plans, or actions toward another player is never shared and never offered for sharing** — categorical, not a judgment call.
4. **High bar to even offer.** Offer only when it would help the *whole table right now* (e.g., the group is visibly stuck on the same thing). No nagging.
5. **Consent is specific, previewed, and attribution-optional.** Show the exact text; offer three outcomes — keep private (default) / share **anonymously** ("Quick clarification for everyone: …") / share **attributed** ("Dana asked whether …"). Default the offer toward anonymous, since *who asked* is often the sensitive part.
6. **Integrity is identical in DM and at the table.** No metagaming, puzzle-trivializing, or leaking another player's info just because it's asked privately.
7. **Confidence ≠ permanent secrecy.** The channel protects against *pre-emptive exposure*, not in-fiction consequences (those resolve publicly when actions land — §5).

### 5. Private actions (state-mutating) — *private initiation, public resolution*

A player may **initiate and resolve an in-scene action privately**, for the element of surprise (draw and stab the cultist; pick the lock; palm an item). The secret protects the **lead-up only** — the instant the action lands it becomes table-visible, exactly like a real surprise.

- **Audience flip:** the private deliberation is `player:<id>`; the **resolved action's narration is `table`** ("Mid-sentence, Dana's blade buries itself in the cultist's throat—"). The table learns the *action*, never the *planning*.
- **Two-test allow/deny:**
  1. **Geographic (single-scene invariant):** contained in the current scene; no relocation, no committing/presuming the party. *("I leave for the tavern" → refuse, redirect: "I don't run split parties — take leaving to the group.")* An in-scene action that is nonetheless *consequential for the group* (e.g., "I bar the only exit") **is allowed** — it passes the geographic test and resolves in-fiction like any other tactic; we add no separate "group-consequential" sub-check.
  2. **Social (PvP gate, §6):** if the target is another **PC**, allowed only when the operator has enabled PvP; otherwise refuse-and-redirect privately.
- **Secret rolls until resolution.** A private action's roll must not leak into Foundry's *shared* chat log before it lands — use the `roll(secret:true)` path. (The local crypto roller, which the `roll` tool already falls back to since the bridge can't roll server-side, never touches Foundry's shared log — so it's the secrecy-preserving path by default.)
- **Timing — serialized under the hood, surprising on the surface.** An async private action does not "win initiative" by arriving first. The in-flight table turn completes atomically; the private action queues as the **next committed turn** in the single authoritative sequence — but the DM *narrates* it as a surprise interrupt in fiction. So it's serialized mechanically, surprising experientially, and placed at a mechanically/dramatically appropriate beat (surprise round per the active system), not first-come.

### 6. PvP toggle

- **Operator setting, default OFF.** Surprise on an **NPC** is always allowed (the fun case). Surprise on a **PC** (attack, theft, sabotage) is gated.
- **When off:** the AI privately responds that PvP isn't enabled and redirects the player to settle it with the group/operator; it does **not** resolve PC-targeted actions secretly.
- **Where it lives:** a per-campaign operator-controlled setting (the `settings` table + the operator console/slash surfaces, consistent with [ADR-0016](../adr/0016-operator-control-parity-across-surfaces.md)), changeable mid-session.
- **Read-at-initiation semantics:** the PvP setting is read **once, when the action begins**, and that value governs the whole resolution. An in-flight private PvP action **completes** even if the operator toggles PvP off mid-resolution — flipping the toggle affects only *subsequent* actions, never one already underway.

### 7. Initiation & transport

- **Players just DM the bot** — no command. Natural, and the bot→user DM transport is already proven (consent prompts, `notify_operator`).
- The existing **`whisper`** tool evolves from fire-and-forget output into a **two-way** side-channel; the Coordinator routes inbound DMs to the right player conversation.
- **Consent/privacy:** a player's DM content is stored + processed (their Discord ID + text) — covered by the existing privacy posture, but PRIVACY.md needs a note that side-channel content is `player:<id>` (private from other players, see §9) and player-scoped-erasable.

### 8. Voice story (text now; live voice out of scope)

- **Now:** text DMs (non-exclusive — readable while staying in the party voice channel).
- **Additive later:** the DM sends an **async whispered audio clip** — ElevenLabs whisper delivery (expressive-model `[whispers]` tags) → ogg/mp3 **attachment** in the DM, which plays mixed over the table audio (no ducking). Gives the player the DM's actual voice without leaving the channel. (Native bot "voice messages" are restricted/unreliable; a plain audio attachment is the dependable form.)
- **Live private voice is OUT OF SCOPE, by hard constraint:** Discord allows a user in exactly one voice channel at a time, so any breakout voice pulls the player *out* of the table — defeating "stay present." The binding limit is the **player's** one-channel cap, not the bot's, so a second bot doesn't help. There is no ToS-clean bot→user voice-call API; client mods (BetterDiscord/Vencord) that could duck audio violate Discord's ToS and are unshippable. Recorded here so it isn't re-litigated.

### 9. Operator visibility & auditability

`player:<id>` content is private **from other players, not from the operator.** Side-channel transcripts are stored and auditable (operator sovereignty; replay-any-session). PRIVACY.md must say this plainly so "private" isn't oversold.

### 10. Latency feel & anti-abuse

**Latency in the DM** (perceptually harsher than the table — the player is staring at the chat, not carried by group conversation, though they never block anyone):
- **Discord typing indicator** is the "thinking…" signal — idiomatic, near-zero cost, refreshed during longer ops. No interim text ack in v1 (less chatter); no token-streaming via message edits in v1 (Discord edit rate limits).
- Q&A on Haiku + concise answers (behavior) keeps it chat-snappy.

**Anti-abuse — the primary control is structural, not behavioral:**
- A `player:<id>` side-channel's hot context **excludes both other players' private content and `gm`-audience secrets** (secret DCs, hidden room contents, NPC true motives). Even a cajoled or jailbroken model **cannot reveal what is not in its context** — a hard architectural guarantee, contingent on disciplined `gm`-tagging of hidden world info.
- Behavior (soft) layer: the §4.6 integrity rules + `eval:live` fixtures for extract/cajole attempts ("tell me what the rogue asked," "what's in the locked chest").
- Spam: the per-conversation coalescing (§3) bounds it; an explicit per-player rate-limit is **deferred** (YAGNI given the bounded table size) and added only if it becomes a problem.

## Components & interfaces

### What changes in the current core

| Area | Today | Needed |
|---|---|---|
| `session.ts` `Session.dialogue` | one global table history | conversation-scoped history (audience + `conversationId`) |
| `always_listening_session.ts` | one loop ↔ one VoiceIO | Coordinator multiplexes table loop + N DM conversations |
| `ToolDispatcher` (`registry.ts`) | per-call dispatch, no concurrency control | single-writer serialization for shared-state mutations |
| dialogue + memory schema | table-implicit | `audience` + `conversationId` columns; audience-aware retrieval (exclude private from shared) |
| episodic memory (0019/ADR-0014) | campaign-shared | private side-channel content excluded from shared retrieval; player-scoped erasure for it |
| `roll` tool | secret flag exists | private actions must use secret rolls (already supported) |
| `whisper` tool | fire-and-forget output | two-way side-channel |
| operator settings | eagerness/voice/operator | + PvP toggle |
| PRIVACY.md / consent | table-framed | document side-channel privacy + operator visibility |

## Data & state

Covered under Approach.

## Sequencing / implementation plan

### Phasing (seams now vs. build later)

- **Bake in now (cheap now, expensive to retrofit):** the `audience` + `conversationId` model on dialogue + memory + hot-context; the dispatcher single-writer serialization. These should land before more single-table core.
- **First build on top:** the Coordinator + Tier-A **text** side-channels (private Q&A *and* private in-scene actions), the PvP toggle, the behavior-spec rules, secret-roll wiring.
- **Additive later:** whispered audio-clip output.
- **Out of scope:** party-splitting; live private voice.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.1 | 1:1 private player↔DM side-channels for private questions and in-scene actions | Coordinator (§3) multiplexing table + DM conversations; audience model (§2); single-scene invariant guardrail (§5) |
| 5.5 | Privacy and erasure for player-private content separate from table/shared content | `player:<id>` audience scoping; player-scoped erasure per ADR-0017; `gm`-audience context exclusion as structural anti-abuse (§10) |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — this design aligns with ADR-0017 (per-audience memory visibility/erasure) and ADR-0020 (single-scene invariant); no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

Single-scene invariant promoted to [ADR-0020](../adr/0020-single-scene-invariant.md) during the docs migration; the per-audience memory visibility/erasure refinement is [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md).

## Alternatives considered

- **Slash-command initiation** (`/skeinkeeper ask`) — rejected as the primary path; DMing the bot is more natural. A command could be a discoverability aid later.
- **Party-splitting / multiple group sub-conversations** — rejected: Foundry has one shared active scene; without per-player *scene* divergence there's no payoff, and it would shatter the single-timeline invariant.
- **Live private voice (breakout channel / second bot)** — rejected: the player's one-voice-channel cap (§8).
- **Client-mod "voice whisper" with ducking** — rejected: ToS-violating, fragile, unshippable.
- **Broadcasting private questions by default / "<player> asked X"** — rejected: betrays confidence; *who asked* is often the sensitive part (§4.5).
- **Per-player fully-parallel timelines** — rejected: violates the one-world invariant; we serialize writes instead.

## Privacy implications

Audience-scoped storage + erasure (table = campaign-scoped per ADR-0014; private = player-scoped erasable). Operator can review side-channels; other players cannot. Player DM content is processed under the existing consent/privacy posture; PRIVACY.md updated. No new remote data flow. **Decided:** the audience-scoped erasure refinement is captured as a **refining ADR — [ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md), `Refines: ADR-0014`** — not a superseding one, because 0014's decision (shared episodic memory is campaign-scoped, not per-player erasable) still stands fully; 0017 only *adds* the per-audience dimension for private side-channel content.

## Eval implications

- **Model-judgment behavior → `eval:live`:** private-by-default; never-share-intent (the rogue case); PvP-off refusal+redirect; share-with-preview/anonymity; the in-scene-guardrail refusals ("I leave for the tavern"). A faked model can't validate these.
- **Deterministic logic → unit tests:** the two-test allow/deny guardrail, audience routing, conversation scoping, the write-serialization ordering — pure helpers, CI-testable.

## Telemetry implications

Covered under Approach (§3 global semaphore tuning via operator-tunable knobs; no new telemetry events beyond existing `tool.called`).

## Dependencies

- **"Show handout/journal to player X" via the bridge.** Foundry supports per-player reveals natively, but the OSS MCP bridge likely doesn't expose it yet — a bridge feature request (same bucket as the [design doc 0022](./0022-dm-action-coverage-audit.md) proposed additions). Confirm against the bridge's tool list before relying on it for "secret info to one player."

## Resolved during review (2026-05-20)

- **ADR-0014 reconciliation** → a **refining** ADR ([ADR-0017](../adr/0017-per-audience-memory-visibility-erasure.md)) that adds the audience dimension; 0014's decision (shared memory is campaign-scoped, not per-player erasable) stands unchanged. (Privacy implications.)
- **Surprise-action timing** → serialized under the hood (table turn completes; private action is the next committed turn), surprising on the surface (narrated as an interrupt). (§5.)
- **In-scene-but-group-consequential actions** ("bar the exit") → allowed; resolve in-fiction; no extra sub-check. (§5.)
- **PvP setting** → per-campaign, changeable mid-session, **read once at action initiation**; an in-flight private PvP action completes under the value in effect when it began. (§6.)
- **Concurrency & cost** → Haiku for Q&A / Opus for resolutions; per-conversation coalescing; small operator-tunable concurrency semaphore; FIFO serialized writes. (§3.)
- **Latency feel** → Discord typing indicator; no interim ack / no edit-streaming in v1. (§10.)
- **Anti-abuse** → structural context-scoping is the primary control (a player's context excludes other players' private + `gm` secrets); explicit per-player rate-limit deferred (YAGNI). (§10.)

## Open questions

None outstanding — all review questions resolved above. Remaining detail (per-system surprise-round mechanics, exact coalescing window) is left to implementation.
