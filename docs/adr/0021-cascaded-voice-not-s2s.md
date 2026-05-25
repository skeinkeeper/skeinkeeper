# ADR-0021: Cascaded voice architecture, not speech-to-speech

Status: accepted
Date: 2026-05-24
Scope: voice-architecture
Relates to: ADR-0003, ADR-0006, ADR-0009, ADR-0010

> This ADR formalizes the architectural choice recorded in
> [TDD 0028 (Real-Time Voice Latency)](../tdd/0028-real-time-voice-latency.md). The
> *design* of the optimizations (streaming narration→TTS, barge-in, latency masking) stays in
> TDD 0028; this ADR records only the durable choice of cascade over speech-to-speech, which
> forward-binds all future voice work.

## Context

Real-time voice agents converge on one of two architectures: a **cascade**
(STT → LLM → TTS, with text and tool calls in the middle) or **speech-to-speech (S2S)** models
(OpenAI Realtime, Gemini Live, Moshi, Ultravox) that fold listening, reasoning, and speaking
into one audio model. S2S is faster end-to-end (~0.8–1.1 s) and is a standing temptation for a
latency-sensitive product, so the choice needs to be recorded once rather than re-litigated per
voice feature.

## Decision

**Keep the cascade (STT → Haiku decider → Opus narration → TTS); optimize it by streaming,
barge-in, and latency masking. Do not adopt speech-to-speech.**

S2S is structurally incompatible with Skeinkeeper:

- **No disciplined tool calls.** Skeinkeeper's entire mutation model is typed tool calls
  (ADR-0003); S2S folds reasoning into an opaque audio model with no tool discipline.
- **Single voice.** S2S cannot do per-NPC `[NPC:name]` voice routing (TDD 0017).
- **No text transcript.** We *require* the transcript for episodic memory (TDD 0019), the audit
  log and erasure (ADR-0010), and the side-channel audience model (TDD 0026). S2S produces none.

Latency is closed instead by streaming the cascade, not by swapping the architecture.

## Consequences

- All future voice/latency work targets the cascade: streaming narration→TTS, barge-in,
  context-seeded latency masking, faster turn-gating — never an architecture swap.
- The win comes from **streaming** (first audio ~one sentence in) within a component budget
  where LLM time-to-first-token is the long pole; the cascade keeps tool calls, server-side
  dice, a full transcript, and multi-voice routing that S2S would forfeit.
- New telemetry surface (first-audio latency, mask-fire rate, barge-in count) rides on the
  cascade per ADR-0009.
- A future move to S2S would require a superseding ADR and would mean giving up tool discipline,
  auditability, and per-NPC voices — a deliberate trade, not a drift.
