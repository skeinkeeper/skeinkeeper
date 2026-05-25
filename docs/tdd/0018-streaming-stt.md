# TDD 0018: Streaming Speech-to-Text
Status: implemented
PRD refs: 4.1, 5.3
PRD-rev: 10391ba
ADR constraints: 0004, 0010
Author: maintainers
Date: 2026-05-19
Related TDDs: [0010 (audio-extensible LLM interface)](./0010-audio-extensible-llm-interface.md), [0012 (voice IO)](./0012-voice-io.md), [0015 (always-listening voice loop)](./0015-always-listening-voice-loop.md)

## Approach

Live validation of the voice loop surfaced a real problem: the time between a
player finishing speaking and the DM responding is too long for a practical
table. The current STT path (the `DeepgramSTT` adapter) is **prerecorded**:

1. `DiscordVoiceIO` subscribes to a speaker with `EndBehaviorType.AfterSilence`
   (≈0.8s), so the opus stream doesn't even *close* until 0.8s after they stop.
2. The whole clip is then drained into one buffer.
3. One Deepgram REST round-trip transcribes it (~0.5–1.5s).

So the transcript doesn't exist until ≈1.5–2.5s **after** the player stops —
all of it serial, none of it overlapping the speech. That delay sits in front
of the (larger) narration cost and compounds it.

Deepgram (and most STT providers) offer **streaming** transcription over a
WebSocket: audio is sent continuously *during* speech and interim + final
transcripts come back in real time, so the final transcript is ready almost
the instant the speaker stops. Design doc 0015 §1 already anticipated this
("STT providers emit interim + final results; only finalized fragments enter
the durable buffer, but interim results can inform the respond-decision's
timing").

Crucially, the `STTProvider` interface (doc 0012) is **already streaming-shaped**:

```ts
transcribe(audio: AsyncIterable<Uint8Array>, opts): AsyncIterable<Utterance>
```

The prerecorded `DeepgramSTT` just happens to implement it by draining then
POSTing. A streaming implementation fits the same interface — no interface
change.

Add a **streaming Deepgram STT provider** and make it the default for the live
voice loop; keep the prerecorded one as a fallback.

### 4. Default wiring

The live session runner / Phase 5 operator app uses `DeepgramStreamingSTT` by
default. `DeepgramSTT` (prerecorded) stays for: the `ElevenLabsScribeSTT`
alternative (no streaming API in scope), batch/offline transcription, and as a
fallback if the socket can't open.

### 5. Out of scope (noted, deferred)

- **Interim results feeding the decider / barge-in** (doc 0015 §5). The
  streaming client parses interims; wiring them into earlier endpointing or
  noise-resistant barge-in is a later refinement.
- **Streaming narration → TTS.** The *other* (larger) half of the latency
  picture — generating narration sentence-by-sentence and speaking sentence 1
  while sentence 2 generates — is a separate effort (the deferred
  `runTurnStreaming` from doc 0011). This doc is STT only.
- **Narration model choice / thinking** (Opus vs. Sonnet) — an orthogonal
  config lever, not part of this doc.

## Components & interfaces

### 1. `DeepgramStreamingSTT` (new STTProvider)

- Opens a Deepgram **live** WebSocket per `transcribe()` call (i.e., per
  speaker burst the adapter feeds it), with query params for the raw PCM
  Discord produces: `encoding=linear16`, `sample_rate=48000`, `channels=2`,
  `model`, `interim_results=true`, `endpointing` / `utterance_end_ms`.
- Forwards each inbound PCM chunk from the `AsyncIterable<Uint8Array>` to the
  socket as it arrives (no draining).
- Parses Deepgram result frames: emits an `Utterance` for each **final**
  segment (`is_final` / `speech_final`). Interim frames are parsed but not
  yielded in v1 (reserved for endpointing/barge-in, §5 below).
- Closes the socket when the input iterable ends (speaker stopped) and flushes
  any trailing final.

**Transport choice — thin `ws` client, injectable.** Use a small wrapper over
the `ws` package (already present transitively via `@discordjs/voice`; we'll
declare it directly) with an **injectable socket factory**, mirroring the
`fetchImpl` injection the REST adapters use. This keeps the frame-parsing
logic unit-testable with a fake socket feeding canned Deepgram JSON, and keeps
the dependency footprint minimal.

*Alternative considered:* the official `@deepgram/sdk` live client — more
robust (built-in keepalive/reconnect) but heavier and harder to unit-test
(mocking the SDK vs. feeding a fake socket). Per hard rule #10 we prefer the
lighter, testable option; we revisit if reconnect/keepalive correctness proves
fiddly to maintain by hand.

### 2. `DiscordVoiceIO` capture path

Today the adapter does subscribe → pipe opus→decoder→`stt.transcribe` →
collect. That already hands the STT an `AsyncIterable<Uint8Array>` of decoded
PCM; with a streaming provider, the **same plumbing** now streams to Deepgram
live and yields finals as they arrive — the 0.8s `AfterSilence` close + drain +
REST serialization disappears. We keep `AfterSilence` only as a stream-end
signal (so the socket closes when the speaker truly stops), but can shorten it,
since Deepgram's own endpointing now drives segment boundaries.

### 3. Endpointing & the lull timer

Segment boundaries (when one utterance ends) come from Deepgram's
`utterance_end` / `speech_final`, not the adapter's silence timer. The
always-listening **lull timer** (doc 0015 §3) that triggers the decider stays,
but because the transcript is ready sooner we can lower the lull threshold
(operator-tunable) for a snappier "your move, DM" cue. Exact value: tuned with
play; not hard-coded here.

## Data & state

Covered under Approach. The streaming client introduces no new persistent state; transcripts continue to flow into the existing ephemeral buffer and from there to the `dialogue` table (doc 0013).

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

- **Socket can't open**: fall back to `DeepgramSTT` (prerecorded path). No loss of functionality, only latency regression.
- **Mid-utterance disconnect**: hand-rolled `ws` must handle Deepgram keepalive pings and reconnects; if this proves fiddly, reconsider `@deepgram/sdk` (see Open questions).
- **Backpressure**: if the socket stalls, decoded PCM must not buffer unbounded; define a drop/close policy.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.1 | Real-time speech-to-text per speaker | `DeepgramStreamingSTT` sends audio live during speech; final transcript ready near-instantly on utterance end, removing the 1.5–2.5s prerecorded delay |
| 5.3 | Voice round-trip ≤ 3s p95 from player end-of-utterance to AI start-of-speech | streaming STT eliminates the REST round-trip serial cost, materially reducing the STT component of the latency chain |
| 5.3 | Streamed TTS required | not in scope of this doc (deferred `runTurnStreaming`); streaming STT is the STT half of the latency improvement |

## Dependencies considered

- **Chosen:** thin `ws` client wrapper (already transitive via `@discordjs/voice`; declared directly) with injectable socket factory for testability.
- **`@deepgram/sdk` live client:** more robust (built-in keepalive/reconnect) but heavier and harder to unit-test (mocking the SDK vs. feeding a fake socket). Per hard rule #10 we prefer the lighter, testable option; revisit if reconnect/keepalive correctness proves fiddly to maintain by hand.
- **A different streaming STT provider** (AssemblyAI, streaming Whisper): Deepgram is the project default (CLAUDE.md); the provider is plugin-swappable per ADR-0004, so this is an operator choice, not an architecture change.

## PRD conflicts surfaced (and resolution)

None — streaming STT directly reduces the voice round-trip latency required by PRD §5.3; no requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — no cross-cutting durable decisions beyond ADR-0004 (plugin interface / provider swappability) which already governs the STTProvider pattern.

## Alternatives considered

- **Keep prerecorded, just tune thresholds.** Shortening `AfterSilence` and
  the lull helps a little but can't remove the REST round-trip; it caps how low
  STT latency can go. Rejected as the primary fix; threshold tuning is
  complementary.
- **`@deepgram/sdk` live client.** See §1 — robust but heavier/less testable.
- **A different streaming STT provider** (AssemblyAI, streaming Whisper).
  Deepgram is the project default (CLAUDE.md); the provider is plugin-swappable
  per ADR-0004, so this is an operator choice, not an architecture change.

## Telemetry implications

Candidate `voice.stt_final { latency_bucket }` (time from socket open / last
audio to final), deferred until the loop is tuned. Counts/buckets only, no
content, per ADR-0009.

## Privacy implications

No change in posture from doc 0015. Audio is already streamed continuously to
the STT provider in the always-listening model; streaming STT is the same
audio, transcribed live. **Consent still gates capture before any audio reaches
the socket** (doc 0012). Audio bytes remain ephemeral (sent, not stored);
transcripts persist to the erasable `dialogue` table. `docs/PRIVACY.md` already
states audio is streamed to the STT provider and discarded — still accurate; a
wording pass will confirm it covers live streaming.

## Eval implications

The streaming client's **frame parsing** (Deepgram JSON interim/final →
`Utterance`, segment boundaries, trailing flush) is a pure-ish function over a
message stream and is unit-tested by feeding a **fake socket** canned Deepgram
frames — the same testability the REST adapters get from `fetchImpl`
injection. The end-to-end live behavior (latency, real endpointing) stays
operator-validated, like the rest of `DiscordVoiceIO`.

## Open questions

- **Connections per speaker.** One live socket per active speaker burst — cost
  and connection-count at a full table; whether to pool/persist sockets per
  speaker across bursts instead of per-burst.
- **Reconnect / keepalive.** Hand-rolled `ws` must handle Deepgram keepalive
  pings and mid-utterance disconnects; if this gets fiddly, reconsider
  `@deepgram/sdk`.
- **Backpressure.** If the socket stalls, decoded PCM must not buffer
  unbounded; define a drop/close policy.
- **Lull retuning.** With faster STT, what's the new default lull threshold
  before it starts cutting players off?
- **Interim-driven endpointing.** Whether to act on interims for sub-lull
  responsiveness (ties into barge-in, doc 0015 §5).
