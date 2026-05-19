// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { SpeakOptions, VoiceEvent, VoiceIO } from "./voice.js";

/**
 * Scripted in-memory VoiceIO for unit tests and the eval harness. Yields
 * a fixed list of voice events from `listen()`, and records every `speak`
 * and `requestConsent` call for assertions.
 */
export class FakeVoiceIO implements VoiceIO {
  readonly name = "fake";
  readonly spoken: Array<{ text: string; opts: SpeakOptions | undefined }> = [];
  readonly consentRequests: Array<{ subjectId: string; consentText: string }> = [];
  closed = false;

  constructor(private readonly events: ReadonlyArray<VoiceEvent>) {}

  async *listen(): AsyncIterable<VoiceEvent> {
    for (const e of this.events) {
      if (this.closed) return;
      yield e;
    }
  }

  async speak(text: string, opts?: SpeakOptions): Promise<void> {
    this.spoken.push({ text, opts });
  }

  async requestConsent(subjectId: string, consentText: string): Promise<void> {
    this.consentRequests.push({ subjectId, consentText });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
