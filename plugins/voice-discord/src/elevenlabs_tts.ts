// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TTSOptions, TTSProvider } from "@skeinkeeper/orchestrator";
import { assertOk } from "./provider_util.js";

/**
 * ElevenLabs text-to-speech provider (CLAUDE.md tech stack: ElevenLabs TTS,
 * plugin-swappable per ADR-0004). Synthesizes a narration segment with a
 * given voice ID. Returns raw audio bytes; the DiscordVoiceIO turns them
 * into a playable audio resource.
 *
 * Network-bound; fetch is injectable for unit tests.
 */
export interface ElevenLabsTTSOptions {
  apiKey: string;
  /** Default voice ID when a call doesn't specify one. */
  defaultVoiceId?: string;
  /** ElevenLabs model, e.g., "eleven_turbo_v2_5" (low latency). */
  modelId?: string;
  /** Output format, e.g., "mp3_44100_128" or a PCM format. */
  outputFormat?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly modelId: string;

  constructor(private readonly options: ElevenLabsTTSOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.elevenlabs.io";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.modelId = options.modelId ?? "eleven_turbo_v2_5";
  }

  async synthesize(text: string, opts?: TTSOptions): Promise<Uint8Array> {
    const voiceId = opts?.voiceId ?? this.options.defaultVoiceId;
    if (voiceId === undefined) {
      throw new Error("ElevenLabsTTS.synthesize: no voiceId provided and no defaultVoiceId set");
    }
    const url = new URL(`${this.baseUrl}/v1/text-to-speech/${voiceId}`);
    if (this.options.outputFormat) url.searchParams.set("output_format", this.options.outputFormat);

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": this.options.apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: this.modelId }),
    });
    assertOk(res, "ElevenLabs TTS request");
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}
