# TDD 0012: Voice IO — Interface, Consent, Session Loop (Phase 2b)
Status: implemented
PRD refs: 4.1, 5.5
PRD-rev: 10391ba
ADR constraints: 0004, 0010, 0012
Author: maintainers
Date: 2026-05-19
Related TDDs: [0002 (privacy foundation)](./0002-privacy-foundation.md), [0008 (LLM provider interface)](./0008-llm-provider-interface.md), [0010 (audio-extensible interface)](./0010-audio-extensible-llm-interface.md), [0011 (orchestrator turn loop)](./0011-orchestrator-turn-loop.md)

## Approach

Phase 2a's `runTurn` takes text input and produces text narration. Phase 2b connects that to a voice channel: players speak, the AI DM speaks back. This is the `VoiceIO` plugin surface promised by [ADR-0004](../adr/0004-plugin-interface-pattern.md).

Voice IO has two distinct halves with very different testability:

1. **Orchestrator-side core** — the `VoiceIO`/`STTProvider`/`TTSProvider` interfaces, the consent gate, and the `runVoiceSession` loop that bridges voice events to `runTurn`. Fully unit-testable with fakes.
2. **Live adapters** — `DiscordVoiceIO` (using `@discordjs/voice`, which carries native Opus + libsodium dependencies), `DeepgramSTT` / ElevenLabs-Scribe STT, ElevenLabs TTS. These can only be validated against live credentials + a live Discord voice channel + a human speaking. No amount of mocking proves they work.

This doc covers #1 (Phase 2b, this commit). #2 is tracked as Phase 2b-live and validated by the operator at the table, not in CI.

### The consent boundary is in the adapter, not the loop

This is the central privacy decision. Per [ADR-0010](../adr/0010-privacy-as-architecture.md) and `docs/PRIVACY.md`: *"Audio is not processed until consent is granted."* If the orchestrator loop did the consent check, the audio would already have been transcribed (sent to the STT provider) before the check — a violation.

So: **the `VoiceIO` adapter checks consent before running STT.** When an unconsented speaker talks, the adapter discards the audio without transcribing it and yields a `{ kind: "consent_needed", speaker }` event. When a consented speaker talks, the adapter transcribes and yields `{ kind: "utterance", ... }`. The orchestrator loop never sees unconsented audio — only the *fact* that someone unconsented spoke.

The adapter gets its consent state from a `TenantDb.consents.isGranted(speaker, "voice_processing")` check (the accessor added in this phase).

## Components & interfaces

### Interfaces (`orchestrator/src/interfaces/voice.ts`)

```ts
export interface Utterance {
  speaker: string;          // Discord user ID (PII)
  displayName?: string;
  text: string;             // STT transcript
  confidence?: number;
  timestamp: number;
  audio?: { mediaType: AudioMediaType; data: string };  // for audio-native LLMs (doc 0010)
}

export type VoiceEvent =
  | { kind: "utterance"; utterance: Utterance }
  | { kind: "consent_needed"; speaker: string; displayName?: string };

export interface VoiceIO {
  readonly name: string;
  listen(): AsyncIterable<VoiceEvent>;
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  requestConsent(subjectId: string, consentText: string): Promise<void>;
  close(): Promise<void>;
}

export interface STTProvider { /* transcribe(audioStream, opts) → AsyncIterable<Utterance> */ }
export interface TTSProvider { /* synthesize(text, opts) → Promise<Uint8Array> */ }
```

`STTProvider` and `TTSProvider` are sub-interfaces a `VoiceIO` adapter composes; the orchestrator itself only ever touches `VoiceIO`.

### `runVoiceSession` (`orchestrator/src/voice_session.ts`)

```ts
for await (const event of voiceIO.listen()) {
  if (event.kind === "consent_needed") {
    await voiceIO.requestConsent(event.speaker, consentText);  // adapter sends a DM
    continue;
  }
  const turn = await runTurn(session, { speaker, displayName, text });
  if (turn.narration) await voiceIO.speak(turn.narration, resolveVoiceId?.(turn));
}
```

Small, testable, and the natural integration point. The `resolveVoiceId` hook lets a future per-NPC-voice mapping route different NPCs to different TTS voice IDs (see open question).

### Consent accessor on `TenantDb`

The `consents` table existed since Phase 0.6 but had no accessor. Added:

```ts
tenantDb.consents.record({ subjectId, purpose, action, consentTextVersion, timestamp });
tenantDb.consents.currentState(subjectId, purpose): "granted" | "withdrawn" | undefined;
tenantDb.consents.isGranted(subjectId, purpose): boolean;
```

Append-only event log; current state = most recent row by `(timestamp, id)`. Granting writes a `granted` row; withdrawing writes a `withdrawn` row; the latest wins. Tenant-scoped per ADR-0008.

### Consent text + version

`VOICE_CONSENT_TEXT` and `VOICE_CONSENT_TEXT_VERSION` live in `voice_session.ts`, matching the wording in `docs/PRIVACY.md`. The version is recorded with each grant so a consent record ties to the exact wording the player saw — important if the consent text ever changes.

## Data & state

Consent state lives in the `consents` table (append-only log); accessed via the `TenantDb.consents` accessor described above. Audio is never persisted; the `Utterance.audio` field is held only for the duration of a turn. Transcripts are PII-adjacent and live in `Session.dialogue` (in-memory this phase; persisted in Phase 2c, tenant-scoped and erasable).

## Sequencing / implementation plan

## What ships in Phase 2b (this commit)

- The interfaces, `FakeVoiceIO`, the consent accessor + tests, `runVoiceSession` + tests, consent text constants.
- Fully unit-tested: the orchestrator can run a complete voice session against a `FakeVoiceIO` with scripted events, exercising consent gating, turn dispatch, narration playback, and the per-turn hooks.

## What is deferred to Phase 2b-live

- `DiscordVoiceIO`: join a voice channel via `@discordjs/voice`, demux per-speaker Opus streams, gate on consent, run STT, emit voice events; play TTS audio back. Native deps (`@discordjs/opus` or `opusscript`, `libsodium-wrappers` / `sodium-native`).
- `DeepgramSTT` and an ElevenLabs-Scribe STT alternative (per the earlier "do we need Deepgram?" decision — prototype both, pick at the table).
- `ElevenLabsTTS` with per-NPC voice IDs.
- The Discord slash-command / button handler that records consent grants/withdrawals into `tenantDb.consents`.

These are I/O plumbing whose correctness can only be confirmed against live services and a real voice channel. Shipping them untested would be lower-value than a clean, tested core with clear contracts. The operator validates them interactively (this is also the natural Phase 2c "dress rehearsal" moment).

## Failure modes & edge cases

- **Unconsented speaker talks:** adapter discards audio without transcribing, yields `consent_needed` event; orchestrator fires `requestConsent` and continues — the table is not blocked.
- **Consent granted mid-session:** the adapter's next utterance from that speaker passes the `isGranted` check and is transcribed normally.
- **TTS provider failure:** narration is lost for that turn; graceful degradation per PRD §5.8 (text-only fallback) is a Phase 2b-live concern.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.1 | Bot joins Discord voice; real-time STT per speaker with diarization; TTS streamed back | `VoiceIO` interface defines `listen()` / `speak()`; `STTProvider` / `TTSProvider` sub-interfaces; `DiscordVoiceIO` (Phase 2b-live) implements these |
| 4.1 | IC/OOC disambiguation; wake-word; configurable activation mode | `VoiceEvent` union extends naturally; `listen()` is an `AsyncIterable` the adapter filters; specific modes are adapter configuration in Phase 2b-live |
| 5.5 | Privacy — audio not processed until consent granted; audio is ephemeral | consent gate is in the adapter (before STT); `Utterance.audio` held only for turn duration; never persisted; consent accessor is versioned and append-only |
| 5.5 | Voice consent is per-player, versioned, withdrawable | `TenantDb.consents` accessor; `consentTextVersion` recorded with each grant; withdrawal is a newer `withdrawn` row |

## Dependencies considered

None — no new third-party dependency introduced by this design. (Phase 2b-live will introduce `@discordjs/voice`, `deepgram-sdk`, and `elevenlabs` — those are deferred and will be evaluated with alternatives at that point.)

## PRD conflicts surfaced (and resolution)

None — this design directly implements the VoiceIO plugin interface (ADR-0004) and the privacy-as-architecture principle (ADR-0010). No PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the consent-gate-in-adapter pattern is an implementation detail flowing from ADR-0010 (privacy as architecture), not a new cross-cutting decision.

## Alternatives considered

- **Consent check in the orchestrator loop.** Rejected — violates the "no STT before consent" privacy rule, since the loop only sees already-transcribed text.
- **Block (await) for consent inline before continuing.** Rejected — a player who hasn't consented shouldn't freeze the whole table's session. The `consent_needed` event is fire-and-continue; that player can grant out-of-band and their *next* utterance is processed.
- **Bake STT/TTS directly into `VoiceIO` with no sub-interfaces.** Rejected — operators want to swap Deepgram for Scribe, or ElevenLabs for another TTS, independently of the Discord transport. The sub-interfaces keep those swappable.
- **Stream narration to TTS sentence-by-sentence as the LLM produces it** (lower latency). Real win for table feel, but requires a streaming `runTurn` variant (flagged as deferred in doc 0011). Phase 2b-live revisits once the non-streaming path works.

## Telemetry implications

No new events in this commit. When Phase 2b-live ships, the existing `session.started` / `session.ended` events gain a real firing site, and a `voice.consent_requested` event may be worth adding to track how often unconsented audio is encountered (no PII — just a count). Defer until there's a live path.

## Privacy implications

This is a privacy-critical phase. The key guarantees, encoded in the design:

- **No STT without consent.** Enforced in the adapter (Phase 2b-live), with the `consent_needed` event as the orchestrator-visible signal. The orchestrator core in this commit never receives unconsented audio because the `FakeVoiceIO` (and the real adapter) only emit utterances for consented speakers.
- **Audio is ephemeral.** The `Utterance.audio` field is optional and, when present, is held only for the duration of a turn (to optionally pass to an audio-native LLM). It is never persisted. `docs/PRIVACY.md` already states audio is transcribed and discarded.
- **Consent is per-player, versioned, withdrawable.** The accessor records the consent-text version with each grant; withdrawal is just a newer row. `docs/PRIVACY.md` documents the `/skeinkeeper consent withdraw voice` path.
- **Transcripts are PII-adjacent** (they contain what players said, attributed to Discord IDs). They live in `Session.dialogue` (in-memory this phase; persisted in Phase 2c, tenant-scoped and erasable).

No `docs/PRIVACY.md` change is required — it already describes the voice consent flow accurately; this phase implements what that doc promised.

## Eval implications

`runVoiceSession` is unit-tested directly with `FakeVoiceIO`. No eval-harness fixtures needed — voice is mechanical plumbing around `runTurn`, and `runTurn`'s behavior is covered by the session tests + (future) behavior fixtures. A live-voice "does the AI DM sound right" evaluation is a human judgment at the table, not an automated fixture.

## Open questions

- **Per-NPC TTS voice routing.** The `resolveVoiceId(turn)` hook is a placeholder. The real mechanism: the AI DM's narration carries inline voice markers (e.g., `[NPC:sildar]`) per a behavior-spec convention, and a parser splits the narration into voiced segments routed to different ElevenLabs voice IDs. That's a Phase 2b-live + behavior-spec change; the hook reserves the seam.
- **Barge-in / interruption.** A player talking over the AI DM's narration should (probably) interrupt TTS playback. Needs the streaming path and Discord voice-activity detection. Deferred.
- **Speaker diarization when multiple players talk at once.** Discord gives per-user audio streams, so the adapter attributes utterances by stream — but cross-talk timing is a real UX problem to handle in Phase 2b-live.
