// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Voice library abstraction (design doc 0017). The only place the TTS
 * provider's catalog of available voices is touched. The real implementation
 * (ElevenLabs voices API) lives in the TTS plugin per ADR-0004; the
 * orchestrator deals only in these provider-agnostic entries.
 */
export interface VoiceLibraryEntry {
  /** Opaque provider voice ID (e.g., an ElevenLabs voice ID). */
  id: string;
  /** Human-friendly name, e.g., "Rachel". */
  name: string;
  /** Description used to match a voice to a character: gender, age, accent,
   *  timbre. e.g., "deep, gravelly, older male, gruff". */
  description: string;
  /** Optional structured labels from the provider. */
  labels?: Record<string, string>;
}

export interface VoiceLibrary {
  readonly name: string;
  /** The available voices, cached by the implementation (the list changes
   *  rarely). */
  list(): Promise<ReadonlyArray<VoiceLibraryEntry>>;
}

/** In-memory library for tests and the eval harness. */
export class FakeVoiceLibrary implements VoiceLibrary {
  readonly name = "fake";
  constructor(private readonly entries: ReadonlyArray<VoiceLibraryEntry>) {}
  async list(): Promise<ReadonlyArray<VoiceLibraryEntry>> {
    return this.entries;
  }
}
