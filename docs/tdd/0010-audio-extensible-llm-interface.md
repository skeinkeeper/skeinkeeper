# TDD 0010: Audio-Extensible LLMProvider Interface
Status: implemented
PRD refs: 4.1, 5.2
PRD-rev: 10391ba
ADR constraints: 0004, 0009, 0010, 0012
Author: maintainers
Date: 2026-05-19
Related TDDs: [0008 (LLM provider interface)](./0008-llm-provider-interface.md)

## Approach

Phase 1.5b shipped the [`LLMProvider`](../../orchestrator/src/interfaces/llm.ts) interface with `LLMContent` as a discriminated union of text / tool_use / tool_result / compaction. That shape works for Claude — which is text-in, text-out — but the Phase 2 plan calls for Discord voice IO, which means STT-fronted *audio* on the input path. Two observations about this:

1. **Claude does not currently accept audio input.** Verified against `platform.claude.com/docs/en/api/messages` (2026-05-19): the supported content blocks are text, image, document, search_result, thinking + redacted_thinking, tool_use + tool_result variants, container_upload — no audio. So STT remains necessary on the input edge for any Claude-backed deployment.
2. **Other LLM providers do accept audio.** GPT-4o-realtime and Gemini Live take audio natively. An operator who prioritized end-to-end audio latency over Claude's narrative quality might prefer to swap providers — and the orchestrator should not force them to keep a now-unnecessary STT step in the pipeline when they do.

Today the `LLMMessage.content` union doesn't model audio at all. Forcing audio through `text` works for the STT-fronted Claude case but loses the *option* of passing audio bytes through when an audio-native provider is configured. Phase 1.7 fixes that without changing the Claude path.

## Components & interfaces

Extend `LLMContent` with a new `LLMAudioContent` variant:

```ts
// orchestrator/src/interfaces/llm.ts

export interface LLMAudioContent {
  type: "audio";
  /** Audio payload. Either inline base64 or a URL the provider can fetch. */
  source:
    | { kind: "base64"; mediaType: AudioMediaType; data: string }
    | { kind: "url"; url: string };
  /**
   * Pre-computed transcript from the STT layer. Optional but strongly
   * recommended: providers that don't accept audio natively (Anthropic
   * today) use it as a text fallback so the orchestrator code path
   * stays uniform across providers.
   */
  transcript?: string;
  /**
   * Optional speaker metadata captured by STT. Audio-native providers
   * may ignore it; text-fallback providers concatenate it into the
   * fallback string so the LLM at least knows who said what.
   */
  speakerName?: string;
}

export type AudioMediaType =
  | "audio/wav"
  | "audio/mp3"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/webm"
  | "audio/flac";

export type LLMContent =
  | LLMTextContent
  | LLMToolUseContent
  | LLMToolResultContent
  | LLMCompactionContent
  | LLMAudioContent;        // ← new
```

### Provider behavior

Each provider declares (informally, via its handling code) how it treats `LLMAudioContent`:

- **AnthropicProvider** (today): if `audio.transcript` is present, treat the block as a text block whose content is the transcript (prefixed with `speakerName` if present). If `transcript` is absent, emit an `LLMEvent` of `{kind: "error", error: {kind: "invalid_request", message: "Anthropic doesn't accept audio without a transcript; either provide audio.transcript or configure an audio-native LLM provider."}}` — explicit rejection, not a silent drop.
- **Future OpenAI / Gemini providers** (Phase 3+): pass `audio.source` through to the provider's audio-input API. Use `transcript` as a confidence cross-check or audit-log source; do not depend on it for the actual LLM call.

The orchestrator never branches on provider identity. It just builds the message with the richest content it has (audio + transcript + speaker), and each provider downsamples to what it can use.

### Graceful degradation, not silent loss

Two design forks worth being explicit about:

- **Reject silently or fail loudly when audio has no transcript and the provider can't handle audio?** Fail loudly. A silent drop would hide a misconfigured pipeline; an explicit error tells the operator to either fix STT-upstream or swap to an audio-native provider.
- **Should AnthropicProvider attach the audio data to the prompt as an "audio attachment" via image-or-document-like base64?** No. Claude's input types don't include audio; trying to smuggle audio bytes through `image` would fail server-side or get garbage results. Use the transcript field as designed.

## Data & state

Covered under Approach.

## Sequencing / implementation plan

Covered under Approach.

## Failure modes & edge cases

- **Audio block without transcript, Anthropic provider:** emits `invalid_request` error with actionable message — explicit rejection, not silent drop.
- **Audio block with transcript, Anthropic provider:** folds into prompt as text (prefixed with speaker name if present). No data loss.
- **Audio block, future audio-native provider:** passes `audio.source` through; uses `transcript` as audit-log source. Provider downsamples to what it supports.

## Requirement traceability

| PRD ref | Requirement | Satisfied by |
|---------|-------------|--------------|
| 4.1 | Pluggable STT/TTS providers; orchestrator should not force unnecessary STT when an audio-native provider is configured | `LLMAudioContent` variant in `LLMContent` union; audio-native providers can receive raw audio bytes; STT-fronted providers fall back to `transcript` field |
| 4.1 | Voice-first interaction over Discord with distinct NPC voices | interface extension creates the seam for audio-input path; `speakerName` carries diarization attribution through to the LLM |
| 5.2 | Plugin architecture — `LLMProvider` is one of three plugin interfaces; modular boundary is real | `LLMAudioContent` is defined in `orchestrator/src/interfaces/llm.ts` (the provider interface); orchestrator never branches on provider identity |

## Dependencies considered

None — no new third-party dependency introduced by this design.

## PRD conflicts surfaced (and resolution)

None — the design directly extends the existing `LLMProvider` interface (ADR-0004) without breaking the Claude path. No PRD requirement proved infeasible or contradictory.

## Decisions to promote (ADR candidates)

None — the plugin interface pattern is already captured in ADR-0004. The audio-fallback approach (transcript field, explicit rejection) is an implementation detail of the AnthropicProvider, not a cross-cutting architectural decision.

## Alternatives considered

- **Wait until an audio-native provider is implemented to add the type.** Tempting but means a breaking change to `LLMContent` later, which ripples through every adapter and test. Adding the type now, with Anthropic-side rejection, is cheap and forward-compatible.
- **Make audio a wholly separate `LLMAudioRequest` type, parallel to `LLMRequest`.** Rejected — audio is *one input modality among others* in a multimodal turn. Tabletop sessions will have text (operator overrides), image (map snapshots one day), and audio (player voice) in the same turn. A separate request type makes that combination awkward.
- **Use `LLMTextContent` with a `mediaUrl` field carrying the audio.** Rejected — overloads `text` semantically, makes audio-native providers do string parsing to find the audio reference.
- **Have STT produce a richer "multimodal transcript" object that includes prosody/sentiment as structured metadata, and ship that as a custom content type.** Interesting and worth exploring in Phase 2.5 — but orthogonal to "interface allows audio at all," which is what this doc decides.

## Telemetry implications

No new events for this phase — the audio path isn't wired yet. When Phase 3 ships an audio-native provider, the existing `llm.completed` event gains useful additional information automatically (e.g., the bucketed input-tokens field will reflect audio-tokens, which are billed differently). At that point we may add `llm.audio_used` for visibility into adoption.

## Privacy implications

When an audio-native provider is eventually configured, raw audio bytes flow from the orchestrator to that provider. That's a new data path beyond the existing STT provider's path. Per [ADR-0010](../adr/0010-privacy-as-architecture.md), this is operator-disclosed — the operator chose the provider — and falls under the existing "the LLM provider receives your prompt content" framing in `docs/PRIVACY.md`. Phase 3's audio-native provider implementation must update `PRIVACY.md` to name audio as one of the prompt-content types sent to the LLM (currently it implies text only).

For Phase 1.7 (this commit): no behavioral change. AnthropicProvider continues to receive text. The interface gains the option; PRIVACY.md is not yet updated because no audio actually flows.

## Eval implications

Eval fixtures can now carry audio content for future audio-native provider tests, but FakeLLMProvider continues to be the default and exercises only text paths. A test in `translate_request.test.ts` confirms AnthropicProvider:

- Accepts an audio block *with* `transcript` and folds it into the prompt as text.
- Rejects an audio block *without* `transcript` with an `invalid_request` error and a helpful message.

## Open questions

- **Audio out** (TTS generation by the LLM). Not addressed here. Per the discussion that prompted this doc, Skeinkeeper's TTS needs per-NPC voice fidelity that current LLMs don't offer; ElevenLabs (or equivalent) likely stays in the pipeline regardless of LLM audio-output support. Revisit when an LLM ships consistent per-character voice cloning.
- **Streaming audio input.** OpenAI 4o-realtime accepts streaming audio; whether our interface should support it (vs. only fixed-length clips per turn) is a design decision deferred to Phase 3.
- **Per-NPC TTS voice IDs in LLM output.** Orthogonal to this doc, but worth flagging: the AI DM's text response should carry per-NPC voice markers (e.g., `[NPC:sildar speaker:concerned]`) so the TTS layer routes to the right voice. That's a behavior-spec convention to land alongside Phase 2 voice IO; not an LLM-interface concern.
