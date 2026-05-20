// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { STTOptions, STTProvider, Utterance } from "@skeinkeeper/orchestrator";
import { assertOk, buildUtterance, drainBlob } from "./provider_util.js";

/**
 * ElevenLabs Scribe speech-to-text provider — the alternative STT to
 * Deepgram (plugin-swappable per ADR-0004). Useful for operators who already
 * have an ElevenLabs key and prefer one provider for both STT and TTS.
 *
 * Prerecorded path (one stream → one utterance), mirroring DeepgramSTT.
 * Network-bound; fetch is injectable for unit tests.
 */
export interface ElevenLabsScribeSTTOptions {
  apiKey: string;
  /** Scribe model, e.g., "scribe_v1". */
  modelId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ScribeResponse {
  text?: string;
  language_probability?: number;
}

export class ElevenLabsScribeSTT implements STTProvider {
  readonly name = "elevenlabs-scribe";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly modelId: string;

  constructor(private readonly options: ElevenLabsScribeSTTOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.elevenlabs.io";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.modelId = options.modelId ?? "scribe_v1";
  }

  async *transcribe(
    audio: AsyncIterable<Uint8Array>,
    opts: STTOptions,
  ): AsyncIterable<Utterance> {
    const blob = await drainBlob(audio);
    if (blob.size === 0) return;

    const form = new FormData();
    form.set("model_id", this.modelId);
    form.set("file", blob, "audio");
    if (opts.language) form.set("language_code", opts.language);

    const res = await this.fetchImpl(`${this.baseUrl}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": this.options.apiKey },
      body: form,
    });
    assertOk(res, "ElevenLabs Scribe request");
    const body = (await res.json()) as ScribeResponse;
    const text = body.text?.trim() ?? "";
    if (text.length === 0) return;

    yield buildUtterance(opts, text, body.language_probability);
  }
}
