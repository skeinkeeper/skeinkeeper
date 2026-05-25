# TDD 0015: Always-Listening Voice Loop
Status: implemented
PRD refs: 4.1
PRD-rev: 10391ba
ADR constraints: 0004, 0010
Author: maintainers
Date: 2026-05-19
Related TDDs: [0008 (LLM provider interface)](./0008-llm-provider-interface.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0016 (identity mapping)](./0016-player-character-identity-mapping.md), [0017 (voice assignment)](./0017-voice-assignment.md)

**Amendment (2026-05-19):** added §2a, the operator-tunable **Eagerness** setting. The core decision (capture/respond split, Haiku decider) is unchanged; this adds a runtime knob *on* that decider, so it's an amendment rather than a superseding doc (same treatment as design doc 0006's tool-table amendment).

## Approach

Design doc 0012 shipped a `runVoiceSession` loop that processes one discrete utterance, calls `runTurn`, speaks the response, repeats. That is a turn-based "player addresses DM, DM replies" model. It does not survive a real table, where:

- Players talk *to each other*, not just to the DM, and a good DM absorbs that side-chatter and reacts to it.
- Speech overlaps: while utterance 1 is being transcribed + reasoned + spoken, utterances 2 and 3 happen.
- The DM must sometimes **interject unprompted** — a player tells their friends "I move into the corner," which trips a trap; the DM has to jump in even though no one addressed it.
- Background noise (a dog bark) must not be mistaken for a player trying to interrupt.

This doc replaces the naive loop with an always-listening architecture. Hotwords are explicitly rejected: requiring "Hey DM…" blinds the AI to the exact context (player deliberation, incidental declarations of action) that makes a DM feel present.

The core move is to **separate capturing from responding.** The AI always *captures* (transcribes everything into a buffer) but *selectively responds*.

## Components & interfaces

### 1. Continuous per-speaker capture

The `VoiceIO` adapter transcribes every consented speaker's audio continuously into a rolling, timestamped, per-speaker **transcription buffer** — not start/stop per utterance. Discord provides a separate audio stream per user, so overlapping speech is separable rather than garbled, and a noise source in one player's room stays isolated to that player's stream.

Consent still gates capture upstream (doc 0012): an unconsented speaker's audio is discarded before STT and never enters the buffer.

The buffer is ephemeral working memory: an ordered list of `{ speaker, displayName, text, startTs, endTs, final }` fragments. STT providers (Deepgram) emit interim + final results; only finalized fragments enter the durable part of the buffer, but interim results can inform the respond-decision's timing.

### 2. The "should I respond?" decider

This is the heart of the design, and it is broader than "is the DM being addressed." The decider answers **"should the DM respond now?"** — which is true in several cases, only one of which is direct address:

- A player directly asks/addresses the DM.
- A player **declares a consequential action** ("I move into the corner," "I open the chest," "I drink the potion") — the DM must adjudicate even though the player was talking to the table, not the DM. *This is the trap case.*
- A player asks a rules question the DM should answer.
- The table has reached a **lull** and is implicitly waiting for the DM to move the scene.
- Something time-sensitive is happening (an initiative-relevant declaration mid-combat).

It is **false** for pure inter-player deliberation that doesn't need adjudication ("should we trust him?" "I dunno, seems shifty") — the AI captures it (it's context) but stays quiet.

Implementation: a **cheap orchestration-tier (Haiku 4.5) call** over the recent buffer, returning a structured `{ respond: boolean, reason: string }`. This is exactly the model-tier split from design doc 0008 — Haiku for the fast/cheap meta-decision, Opus 4.7 reserved for the expensive narration only when `respond` is true. Running a Haiku classification on every lull is cheap; running Opus on every utterance would be wasteful and produce a chatty, interrupting DM.

The decider's prompt is informed by the behavior spec (the DM's sense of when to speak) and the current warm state (e.g., "is there a trap adjacent to where the player just said they moved?" — though full trap-awareness depends on cold-tier module knowledge, Phase 4).

### 2a. Eagerness — the operator-tunable calibration (amendment 2026-05-19)

The decider's calibration is the make-or-break of the whole loop: too quiet and the DM feels absent; too eager and it interrupts the table constantly. No upfront default is right for every group or every moment, so this is an **operator-tunable runtime setting** with a sensible default.

**Setting:** `Eagerness` (operator-facing label may read as "Chattiness"). It biases the "should I respond?" decider's threshold — not a separate mechanism, just a dial on the existing one.

**Operator-facing shape:** three presets rather than a raw number, because operators shouldn't have to reason about a threshold:

- **Reserved** — respond only to direct address and imminent danger (a player walking onto a trap). Gets out of the way; good for heavy role-play scenes between players.
- **Balanced (default)** — the behavior §2 describes: direct address, consequential action declarations, rules questions, and lulls. Quiet during pure deliberation.
- **Eager** — all of Balanced, plus proactive color, hints when the party seems stuck, and more frequent scene-moving. Good for new groups who want a present, guiding DM.

(Internally this can be a 0–100 scalar if finer control proves useful; the presets map to anchor values. Start with presets.)

**Runtime-tunable:** the operator changes it mid-session — combat often wants a more present DM, freeform RP a sparser one — via a Discord command (`/skeinkeeper eagerness reserved|balanced|eager`) or the web UI. It takes effect on the next decision; no restart.

**Mechanically:** the chosen level is passed into the Haiku decider's prompt as an explicit instruction shaping how readily it returns `respond: true`. It lives on the session/campaign config (a field the decider reads each cycle), defaulting to Balanced. Because it's just a prompt bias, changing it is instant and cheap.

**Why operator-controlled rather than AI-self-tuned:** the right eagerness is a *table preference*, not something the AI can infer reliably — and getting it wrong is the most-felt failure mode of a voice DM. Putting the dial in the operator's hand (with a good default) lets the table correct it in seconds rather than enduring a mis-calibrated DM for a whole session. The AI may *suggest* an adjustment ("the table's been quiet — want me to dial back?"), but the operator owns the setting.

### 3. Endpointing — when to run the decider

Two triggers fire the decider:

- **Lull detection**: the table goes quiet for a tunable threshold (~1–2s of no speech across all streams), via VAD + provider endpointing. A lull is the most common "your move, DM" cue.
- **Consequential-declaration interrupt**: even without a lull, certain phrasings (action declarations) can fire the decider early so the DM can jump in before the player keeps talking past a trap. (Heuristic + the decider itself; tuned with play.)

When the decider returns `respond: true`, the accumulated buffer since the last response is handed to **`runTurn`** as the turn input (multiple speakers' fragments collapsed into the turn's context). `runTurn` (doc 0011) is unchanged — it's the right "respond" primitive; this loop is the wrapper that decides *when* to call it and *over what*.

### 5. Barge-in (interrupting the DM's narration) — noise-resistant

When the DM's TTS is playing and a player speaks, we may want to stop and listen. But we must not stop for a dog bark. The gate is layered:

1. **VAD says it's speech** (not silence/noise). Modern VAD separates speech from most ambient noise, imperfectly.
2. **Sustained**: the speech persists for ≥1–2s (a tunable threshold). A bark or cough is transient; a player actually interrupting sustains.
3. **(Optional, strongest) transcribes to words**: run STT on the first ~1–2s; if it yields real tokens, it's a genuine interruption; if it yields nothing, it was noise. Adds latency, so it's a tunable "strict barge-in" mode.

Only when the gate passes does TTS playback stop and the loop return to listening. Note: this is entirely an STT/VAD-side concern — **TTS is output-only and cannot detect input**; barge-in lives in the capture path, not the speech path.

## Data & state

### 4. Nothing is lost during processing

Because capture is continuous and independent of the respond cycle, anything said while `runTurn` + TTS is working keeps transcribing into the buffer. When the DM finishes, the decider re-evaluates the newly-accumulated buffer. Overlap is queued, not dropped.

### 6. Persistence

The buffer is ephemeral. On each response cycle, the accumulated player fragments (attributed by speaker) **and** the DM's narration are persisted to the `dialogue` table (doc 0013), so the durable transcript faithfully reflects what the AI heard and said — including the side-chatter that informed a response. Pure side-chatter in a window that produced no response is still part of the transcript and is persisted on the next flush; we don't silently drop captured context from the record.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

Covered under Approach.

## Forthcoming sibling design docs (decisions captured here so they aren't lost)

The user settled two adjacent designs on 2026-05-19; each gets its own doc, but the decisions are recorded here:

- **Player↔character identity mapping** (task #38): player-initiated at session start — the DM asks each player to introduce themselves and name their character; the AI records the Discord-user → Foundry-actor mapping; the operator can override/correct. This loop's respond-decider and `runTurn` attribution depend on that mapping.
- **DM + NPC voice assignment** (task #39): the operator picks the DM voice from a **curated short list in the Skeinkeeper UI, fully abstracted from ElevenLabs** (the operator never learns the provider). NPC voices are **AI-assigned** — the AI reads the available voices + descriptions and maps each NPC to a voice, with operator override. This loop's TTS step (`speak` + the `resolveVoiceId` hook) consumes those mappings.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.1 | Always-on with VAD activation mode — every utterance treated as directed to the AI unless flagged OOC | continuous per-speaker capture buffer; decider classifies whether to respond rather than requiring hotword |
| 4.1 | Real-time speech-to-text per speaker with diarization | per-speaker Discord audio streams feed separate STT transcription; attributed `{ speaker, displayName }` fragments |
| 4.1 | Configurable activation mode — eagerness/chattiness knob | `Eagerness` preset (Reserved / Balanced / Eager) passed to Haiku decider; operator-changeable mid-session |
| 4.1 | IC vs OOC disambiguation | decider prompt includes OOC convention detection; pure deliberation → `respond: false` |
| 4.1 | TTS streamed to Discord voice channel | barge-in gate + TTS playback stop on sustained speech; capture is independent of TTS output path |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — the design directly implements the configurable-activation-mode and always-on-with-VAD requirements from PRD §4.1; no requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — no cross-cutting durable decisions here that aren't already captured in ADR-0004 (plugin interface) and ADR-0010 (privacy/consent gates).

## Alternatives considered

- **Hotword activation.** Rejected — blinds the DM to table context (deliberation, incidental action declarations) that's essential to feeling present. The user explicitly ruled this out.
- **Respond to every finalized utterance** (the current `runVoiceSession`). Rejected — produces an interrupting, chatty DM and runs the expensive Opus model constantly. The capture/respond split fixes both.
- **A single model call that both decides and narrates.** Rejected — couples the cheap "should I speak" judgment to the expensive narration; you'd pay Opus rates to decide *not* to speak. The two-tier split (Haiku decides, Opus narrates) is the cost-correct shape.
- **Push-to-talk per player** (a Discord button to address the DM). Rejected as the default for the same reason as hotwords, though it could be an *optional* "strict mode" for noisy environments.
- **Stop TTS on any inbound audio** (naive barge-in). Rejected — the dog-bark problem. Hence the layered VAD + sustained + optional-transcription gate.

## Telemetry implications

Candidate new events (deferred until the loop is live and we know what's useful):
- `voice.respond_decision { decided: boolean, reason_bucket, buffer_fragment_count }` — to learn how often the AI chooses to speak vs. stay quiet, and tune the decider.
- `voice.barge_in { accepted: boolean }` — to measure false-positive barge-ins (noise) vs. real interruptions.

No PII (counts + buckets only). Per ADR-0009.

## Privacy implications

Always-listening sends **more** audio to the STT provider than a hotword model — effectively all consented table talk, continuously. This is the cost of the DM having real context. Mitigations, consistent with ADR-0010 + `docs/PRIVACY.md`:

- **Consent still gates capture** before STT (doc 0012); unconsented audio never enters the buffer.
- **The buffer is ephemeral**; audio bytes are discarded after transcription (PRIVACY.md's "audio is transcribed and immediately discarded" still holds — we transcribe more, but retain no more audio).
- **Transcripts are persisted** to the tenant-scoped, erasable `dialogue` table (doc 0013). Always-listening means more transcript text is stored; it's all covered by the existing player/tenant erasure path.
- `docs/PRIVACY.md` should gain a sentence clarifying that the AI transcribes ongoing table conversation (not only direct addresses) so context is captured — an honest disclosure the consent flow should reflect. (Doc edit lands with the implementation, per hard rule #15.)

## Eval implications

The respond-decider is **unit-testable without audio**: it's a function over a transcript buffer → `{ respond, reason }`. Eval fixtures can present buffers and assert the decision:
- "player asks DM a question" → respond.
- "players deliberate among themselves" → don't respond.
- "player declares moving onto a trap tile" → respond (proactive interjection).
- "lull after a scene beat" → respond (move the scene).

These become behavior fixtures in the eval harness (doc 0004 / Phase 1.6 loader), driven by a `FakeLLMProvider` scripting the Haiku decision. The endpointing/VAD/barge-in timing is *not* unit-testable and is tuned with real play.

## Open questions

- **Lull threshold tuning.** 1–2s is a starting guess; real tables vary. Needs play-testing; likely operator-configurable.
- **Latency budget.** Lull → Haiku decide → Opus narrate → TTS is a multi-second chain. How long is tolerable before the table feels the DM is slow? Streaming narration to TTS (the deferred `runTurnStreaming` from doc 0011) materially helps and may become required here.
- **VAD quality in practice.** How often does VAD misclassify noise as speech at a real table? Determines whether the "strict barge-in" (transcribe-to-confirm) mode is the default.
- **Proactive-interjection false positives.** An over-eager DM that jumps in on every action declaration is as bad as a silent one. The decider's calibration is the make-or-break, and it's tuned with play, not upfront.
- **Simultaneous cross-talk collapse.** When three players talk at once before a response, how is their overlapping speech ordered/merged into the turn input? Per-speaker streams + timestamps give us the raw material; the merge heuristic needs design.
