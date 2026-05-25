# TDD 0028: Real-Time Voice Latency (Streaming, Barge-In, Latency Masking)
Status: implemented
PRD refs: 5.3, 4.1
PRD-rev: 10391ba
ADR constraints: 0003, 0004, 0006, 0009, 0010, 0021
Author: maintainers
Date: 2026-05-21
Related TDDs: [0010 (audio-extensible LLM)](./0010-audio-extensible-llm-interface.md), [0011 (turn loop)](./0011-orchestrator-turn-loop.md), [0012 (voice IO)](./0012-voice-io.md), [0015 (always-listening loop)](./0015-always-listening-voice-loop.md), [0017 (voice assignment)](./0017-voice-assignment.md), [0018 (streaming STT)](./0018-streaming-stt.md)

## Approach

Skeinkeeper's table loop today is **turn-atomic**: on a `lull` the decider runs (a Haiku round-trip), then `runTurn` generates the **entire** Opus narration to completion, *then* `speakTurn` synthesizes and plays it. The player hears nothing until the whole turn is done. With Opus reach + per-NPC voice routing + occasional Foundry tool round-trips, that's seconds of dead air — the dominant felt-latency problem.

This is a solved class of problem: real-time voice agents (call-center AI, voice assistants) have converged on a small set of techniques. We're not the first to need "listen → think → speak fast." This doc records what the field does, why our **cascaded** architecture is the right base (not speech-to-speech), and the phased plan to close the gap — including a latency-masking design that avoids the "arrow to the knee" repetition meme.

**Industry budget** (cascaded, ~2025–2026): humans expect a **300–500 ms** turn gap; well-tuned cascades hit **750–900 ms** end-to-end; the component budget is roughly STT ~350 ms, **LLM time-to-first-token ~375 ms** (the long pole), TTS time-to-first-byte ~100 ms, orchestration/network ~200 ms. The decisive lever is **streaming**: waiting for the full LLM response adds 1–3 s, and waiting for a full sentence in TTS adds 200–500 ms.

**Optimize the cascade in phases; do not adopt speech-to-speech (S2S).** S2S (OpenAI Realtime, Gemini Live, Moshi, Ultravox) is faster end-to-end (~0.8–1.1 s) but structurally incompatible with Skeinkeeper:

> The cascade-not-speech-to-speech decision is recorded as [ADR-0021](../adr/0021-cascaded-voice-not-s2s.md); this TDD retains its design and rationale.

- **No disciplined tool calls.** Our entire mutation model is typed tool calls ([ADR-0003](../adr/0003-tool-call-only-state-mutation.md)); S2S folds reasoning into an opaque audio model.
- **Single voice.** S2S can't do per-NPC `[NPC:name]` voice routing ([design doc 0017](./0017-voice-assignment.md)).
- **No text transcript.** We *require* the transcript for episodic memory (0019), the audit log, erasure (ADR-0010), and the side-channel audience model (0026). S2S has none.

The field agrees cascaded is correct for tool-using, auditable agents. So we keep the cascade and make it stream.

The phases:

- **P1 — Stream narration → TTS.** The biggest win; the code seam already exists.
- **P2 — Barge-in + latency masking.** Naturalness multipliers.
- **P3 — Faster turn-gating + (experimental) anticipatory reasoning.**

### P1. Streaming narration → TTS

Today `runLlmIterations` already consumes the LLM's `text_delta` events — it just accumulates them into one `narration` string that `speakTurn` plays after the turn returns. P1 emits narration **incrementally** and speaks each completed unit while the next generates ("dual streaming").

- **Segment at boundaries.** Buffer streamed tokens until a **speakable unit** is complete — a sentence boundary, or an `[NPC:name]` marker boundary (a voice change is always a flush point, per [0017](./0017-voice-assignment.md)). Flush that unit to TTS immediately; keep buffering the next.
- **Speak unit *n* while generating unit *n+1*.** First audio starts ~one sentence in, not after the whole turn. This collapses sinks "no LLM→TTS streaming" and "voice routing waits for full narration" together — segment 1 plays in the DM persona while segment 2's NPC voice resolves.
- **Streaming TTS transport.** Use the provider's input-streaming/flush path (ElevenLabs websocket; see [provider notes](#provider-notes)). The `VoiceIO.speak` contract gains a streaming form (feed text chunks, flush, await playback) alongside today's one-shot `speak`.
- **Persistence unchanged.** The full narration is still assembled and persisted as one `narrator` dialogue turn (memory/audit/transcript see one coherent turn); only *delivery* is incremental.
- **Ordering + barge-in hooks.** Segments play in order; the player can interrupt mid-stream (P2). The serialized-writer (0026 §3) is unaffected — tool mutations still serialize regardless of speech streaming.

### P2. Barge-in + latency masking

**Barge-in.** Keep capture live during playback (the always-listening loop already captures continuously) and **cancel TTS + the in-flight LLM the instant a player speaks** — the standard cancel-propagation pattern (Pipecat "cancel frame"). Needs: a cancel path in the voice plugin's `speak` (stop playback now) and an `AbortSignal` threaded into `runLlmIterations` (the `LLMProvider.complete` interface already accepts `opts.signal`; the fake honors it). WebRTC/Discord echo cancellation keeps the bot from barging in on its own audio. **Tuning bias for a *table* (not a call center): prefer slightly-late over aggressive — cutting a player off mid-sentence is the worse failure.**

**Latency masking — without the repetition meme.** When we genuinely need sound *before* the first real token (a Foundry tool round-trip, a cold start, a long Opus reach), we cover the gap. The trap to avoid is the "I took an arrow to the knee" effect: the same handful of canned lines, repeated, becomes a joke. The design separates the two things people conflate — **generating** variety (slow, off the critical path) from **selecting** a line (instant) — and layers three defenses:

1. **Mask rarely.** Repetition *frequency* is half the meme. Once P1 lands and first-audio is usually sub-second, most turns need no filler at all. Masking fires **only above a measured latency threshold**, never blanket. Rarity + variety together kill the meme; either alone doesn't.

2. **Prefer a front-loaded *contentful* opener over a discrete filler.** The best mask for a DM is the **start of the real narration that's true regardless of how the beat resolves** — sensory/scene detail ("The torchlight gutters as you step in—"). With P1 streaming, the model's own first sentence *is* the cover, with no separate filler system. This becomes behavior-spec guidance ([ADR-0006](../adr/0006-behavior-spec-separate-doc.md)): *open with resolution-independent sensory detail, then resolve.* Discrete fillers are the fallback only when even the first token can't start in time.

3. **For the fallback: a pre-warmed, context-seeded, pre-synthesized pool with anti-repeat selection.**
   - **Decouple generate from select.** A low-priority **Haiku** background job keeps a pool (~100–200 lines) topped up — running during lulls and *while the real turn generates*, never on the critical path. Marginal cost is a few cheap tokens amortized across idle time.
   - **Seed from recent context.** The background job writes lines *using the last few turns + current scene + active NPC + DM persona*, so the pool **drifts to match the current scene over the session** (tense in a dungeon, warm at the tavern). Variety is unbounded over time (new lines always being made); context is current (seeded from current state) — all off-path.
   - **Pre-synthesize the audio.** Cache each pooled line as **rendered TTS audio** (keyed by `(text, voiceId)`), so masking is *play a file* — zero on-path TTS. (See [privacy](#privacy-implications): fillers are content-neutral DM gestures/atmosphere, never quotes of player speech, so cached clips carry no player PII.)
   - **Select instantly by tag-match.** Each line is tagged (combat / social / exploration / tension / comedic; NPC; topic keywords). At fire time the orchestrator already knows the context (warm state + recent dialogue) and filters to matching tags — trivial cost, no model call.
   - **Shuffle-bag selection, not random.** Draw without replacement; never repeat a line until the bag is exhausted, **plus** a global recency window and a per-stem usage **histogram** that down-weights overused verbs/gestures ("strokes his beard"). A per-session frequency cap bounds how often *any* filler plays.
   - **Fail safe to neutral.** A *wrong* filler ("the innkeeper chuckles" mid-combat) is worse than a generic one. Keep tags coarse, prefer persona-flavored-but-scene-neutral lines, and require a confident tag match for scene-specific ones — fail to neutral, never to wrong.

Net: generation is amortized background Haiku; selection plays a pre-rendered clip; context comes from tag-match + context-seeded refill; repetition is killed by shuffle-bag + recency + histogram + rarity. Nothing touches the critical path.

### P3. Faster turn-gating + anticipatory reasoning (experimental)

- **Endpointing.** Our decider is already *semantic* (the smart kind), but it's a full Haiku round-trip on every `lull`. Options to cut it: use Deepgram's native endpointing / utterance-end events to fire earlier; run a lighter turn-detector; or run the decider on partials. Pair any aggressive endpointing with **graceful abort** (cancel downstream if we mis-fire) so we can be fast without cutting players off.
- **Anticipatory reasoning ("think while listening").** Prior art (LTS-VoiceAgent: Listen-Think-Speak) overlaps reasoning with listening — a semantic trigger starts a speculative response from the *partial* transcript before the player finishes. Maps onto our `TranscriptionBuffer` + decider: a cheap Haiku "pre-plan" could prime Opus while the player is still talking. Advanced (risk: wasted tokens); gated behind P1/P2 proving out.

## Components & interfaces

### What changes in the current core

| Area | Today | Needed |
|---|---|---|
| `LLMProvider.complete` | streams `text_delta` (already) | unchanged — we already get the token stream |
| `runLlmIterations` / `runTurn` | accumulates `narration`, returns it whole | emit speakable **segments** incrementally (callback / async iterator) while still returning the full narration for persistence |
| `always_listening_session.ts` `speakTurn` | speaks after the turn returns | consume the segment stream; speak segment *n* while *n+1* generates |
| `VoiceIO.speak` ([0012](./0012-voice-io.md)) | one-shot text → audio | + a streaming form (feed chunks / flush) and a **cancel** for barge-in |
| voice plugin (`voice-discord`) | synth full text, play | streaming synth (ElevenLabs ws); cancel playback on barge-in |
| always-listening capture | continuous (already) | on speech-during-playback, emit a **cancel** that stops TTS + aborts the LLM |
| behavior spec ([0006](../adr/0006-behavior-spec-separate-doc.md)) | — | "front-loaded resolution-independent opener" guidance; filler tone/persona guidance |
| new: masking subsystem | — | pooled filler generator (background Haiku), pre-synth cache, tag-match + shuffle-bag selector, latency-threshold trigger |
| turn-gating ([0015](./0015-always-listening-voice-loop.md)) | Haiku decider on lull | (P3) cheaper/earlier endpointing; optional anticipatory pre-plan |
| telemetry ([ADR-0009](../adr/0009-telemetry-opt-in.md)) | turn metrics | + first-audio latency, mask-fire rate, barge-in count (bucketed, no content) |

## Data & state

Covered under Approach.

## Sequencing / implementation plan

### Phasing

- **P1 (now):** streaming narration→TTS + keep TTS/STT sockets warm. Target: first audio well under the full-turn time (sub-second on a typical beat).
- **P2:** barge-in; the masking subsystem (front-loaded opener behavior first, then the pooled fallback).
- **P3:** cheaper endpointing; experimental anticipatory pre-planning.
- **Out of scope:** speech-to-speech; replacing the cascade.

## Failure modes & edge cases

Covered under Approach.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 5.3 | Real-time voice latency within human-acceptable bounds (300–900 ms) | P1 streaming narration→TTS (first audio ~one sentence in); P2 barge-in + latency masking; cascade architecture preserved per ADR-0021 |
| 4.1 | Naturalness of DM voice interaction at the table | front-loaded opener guidance (behavior spec); barge-in cancel; latency masking with anti-repetition (shuffle-bag + histogram + rarity) |

## Dependencies considered

- **ElevenLabs (current TTS)** — kept as default; supports websocket input streaming + flush sufficient for P1. Flash/Turbo models cut time-to-first-byte. Already wired and operator-keyed. OSS client SDK, operator-keyed API.
- **Cartesia Sonic** — evaluated: dramatically faster TTFB (~90 ms Turbo ~40 ms); behind the existing TTS plugin interface per ADR-0004. Caveat: hosted/paid single vendor; self-hostable OSS TTS (Piper, Kokoro) trade quality for control. Not a P1 dependency — P1 works on ElevenLabs streaming.
- **Deepgram (current STT)** — kept; exposes endpointing / utterance-end events usable for P3 turn-gating.
- **Speech-to-speech end-to-end (OpenAI Realtime, Gemini Live, Moshi, Ultravox)** — rejected: kills typed tool calls, per-NPC voice routing, and the text transcript our memory/audit/erasure/side-channels depend on. Recorded as ADR-0021.

## PRD conflicts surfaced (and resolution)

None — this design directly implements ADR-0021 (cascaded voice, not S2S); no PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

Promoted to [ADR-0021](../adr/0021-cascaded-voice-not-s2s.md) (cascaded voice architecture, not speech-to-speech) during the docs migration.

## Alternatives considered

- **Speech-to-speech end-to-end** — rejected: kills typed tools, per-NPC voices, and the transcript our memory/audit/erasure/side-channels depend on (see Decision). Industry consensus also favors cascaded for tool-using agents.
- **A fixed list of N filler phrases** — rejected: the arrow-to-the-knee meme; finite + frequently-repeated.
- **Generate a unique filler on demand (LLM call at mask time)** — rejected: that *is* latency; defeats the purpose. We pre-generate off-path and select instantly instead.
- **Pure combinatorial templates** ({gesture}+{beat}) — rejected as the primary (mechanical, still memes); acceptable only as a cold-start fallback before the pool fills.
- **Mask every turn** — rejected: over-masking is itself the meme; gate on a real latency threshold.

## Provider notes (evaluate alternatives — [CLAUDE.md hard rule #10](../../CLAUDE.md))

- **ElevenLabs (current TTS)** supports websocket **input streaming + flush** — sufficient for P1. Flash/Turbo models cut time-to-first-byte. Keep it as the default; it's already wired and operator-keyed.
- **Cartesia Sonic** is dramatically faster on TTFB (~90 ms, Turbo ~40 ms). Worth a future evaluation **behind the existing TTS plugin interface** ([ADR-0004](../adr/0004-plugin-interface-pattern.md)). Caveat per our OSS-first lean: it's a hosted/paid single vendor; self-hostable OSS TTS (Piper, Kokoro) trade quality for control. Not a P1 dependency — P1 works on ElevenLabs streaming.
- **Deepgram (current STT)** exposes endpointing / utterance-end events usable for P3 turn-gating.
- **Opus TTFT** is the binding constraint; benchmark it explicitly. Consider tiering: short reactions/acks on Haiku, substantial narration on Opus.

## Privacy implications

- **No new player data.** Streaming changes *delivery*, not what's stored; the persisted transcript is unchanged.
- **Filler pool contains no player PII.** Fillers are content-neutral DM gestures/atmosphere seeded by *scene tone*, never quotes of player speech; cached audio clips are the DM's own generated voice lines. The background generator must be prompted to stay scene-neutral and never echo a player's words verbatim — so a cached/persisted clip can't leak player content.
- Audio remains ephemeral per [ADR-0010](../adr/0010-privacy-as-architecture.md) except the deliberately-cached filler clips (DM content, not player data).

## Eval implications

- **Deterministic → unit tests:** the segment chunker (sentence/`[NPC:]` boundary flushing); the shuffle-bag/recency/histogram selector (no repeat until exhausted; down-weights stems); the latency-threshold trigger; the streaming `speakTurn` ordering. Pure helpers, CI-testable.
- **Model-judgment → `eval:live`:** the front-loaded-opener behavior (does the model open with resolution-independent detail?); filler relevance/tone. The live Discord run validates felt latency + barge-in.

## Telemetry implications

New bucketed, content-free events ([ADR-0009](../adr/0009-telemetry-opt-in.md)): first-audio latency bucket per responding turn, masking fire-rate, barge-in count. No prompt/response content, opt-in only.

## Dependencies

- A streaming-capable TTS transport in the `voice-discord` plugin (ElevenLabs websocket). P1's only hard dependency.
- The masking subsystem depends on a cheap background model tier (Haiku, already available) and the TTS cache.

## Open questions

- **Segment granularity vs. prosody:** too-fine chunking (clause-level) can hurt TTS prosody/naturalness; sentence-level is the safe default — tune during P1 live validation.
- **Filler cache scope:** per-session in-memory vs. per-campaign on-disk (survives restarts). Lean in-memory first; revisit if cold-start masking quality warrants persistence.
- **Anticipatory reasoning cost ceiling (P3):** how much speculative Opus/Haiku spend is acceptable for the latency gain — decide with real numbers after P1/P2.
