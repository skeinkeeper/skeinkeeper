// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { AudioMediaType } from "./llm.js";

/**
 * Voice IO interfaces per ADR-0004 (the `VoiceIO` plugin surface) and
 * design doc 0012. The orchestrator interacts with the table's voice
 * channel exclusively through `VoiceIO`; the STT/TTS sub-interfaces guide
 * how a concrete adapter (e.g., DiscordVoiceIO) composes a transcription
 * provider and a speech provider.
 */

/** A single transcribed thing a player said. */
export interface Utterance {
  /** Discord user ID (or other stable speaker identifier). PII. */
  speaker: string;
  /** Optional human-friendly name for prompt rendering. */
  displayName?: string;
  /** STT transcript text. */
  text: string;
  /** STT confidence 0..1, if the provider reports it. */
  confidence?: number;
  timestamp: number;
  /**
   * Optional raw audio, for routing to an audio-native LLM provider
   * (per design doc 0010). When present, the orchestrator can build an
   * LLMAudioContent block carrying both this audio and `text` as the
   * transcript fallback.
   */
  audio?: { mediaType: AudioMediaType; data: string };
}

export interface SpeakOptions {
  /** TTS voice ID — e.g., a per-NPC ElevenLabs voice. */
  voiceId?: string;
}

/**
 * What `VoiceIO.listen()` yields. Either a transcribed utterance (the
 * speaker has consented and their audio was run through STT), or a
 * `consent_needed` signal (the speaker spoke but had NOT consented, so the
 * adapter discarded their audio without transcribing it).
 *
 * The consent check lives in the adapter — *before* STT — so that
 * unconsented audio never reaches a transcription provider. Per
 * ADR-0010 + docs/PRIVACY.md: "Audio is not processed until consent is
 * granted."
 */
export type VoiceEvent =
  | { kind: "utterance"; utterance: Utterance }
  | { kind: "consent_needed"; speaker: string; displayName?: string };

/**
 * The orchestrator-facing voice surface. A concrete implementation
 * (DiscordVoiceIO) joins a voice channel, gates inbound audio on consent,
 * runs STT on consented audio, and plays TTS for outbound narration.
 */
export interface VoiceIO {
  readonly name: string;
  /** Yields voice events as players speak. Completes when the channel closes. */
  listen(): AsyncIterable<VoiceEvent>;
  /** Synthesize + play `text` into the channel. Resolves when playback ends. */
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  /**
   * Deliver a consent prompt to a player out-of-band (e.g., a Discord DM).
   * The actual grant/withdraw arrives via a separate channel (slash command
   * or button) and is recorded by the operator-side handler, not here.
   */
  requestConsent(subjectId: string, consentText: string): Promise<void>;
  /** Tear down the connection. */
  close(): Promise<void>;
}

export interface STTOptions {
  /** Speaker ID to attribute the audio to. */
  speaker: string;
  displayName?: string;
  /** Language hint, e.g., "en". */
  language?: string;
}

/** Speech-to-text provider. Composed by a VoiceIO adapter. */
export interface STTProvider {
  readonly name: string;
  /** Stream audio chunks in, get utterances out. */
  transcribe(
    audio: AsyncIterable<Uint8Array>,
    opts: STTOptions,
  ): AsyncIterable<Utterance>;
}

export interface TTSOptions {
  voiceId?: string;
}

/** Text-to-speech provider. Composed by a VoiceIO adapter. */
export interface TTSProvider {
  readonly name: string;
  /** Synthesize audio bytes for `text`. */
  synthesize(text: string, opts?: TTSOptions): Promise<Uint8Array>;
}
