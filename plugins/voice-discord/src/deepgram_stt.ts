// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { STTOptions, STTProvider, Utterance } from "@skeinkeeper/orchestrator";
import { assertOk, buildUtterance, drainBytes } from "./provider_util.js";

/**
 * Deepgram speech-to-text provider (CLAUDE.md tech stack: Deepgram STT
 * default, plugin-swappable per ADR-0004).
 *
 * This implements the prerecorded REST path: it drains the audio stream for a
 * single utterance, posts the bytes to Deepgram's listen endpoint, and yields
 * one finalized `Utterance`. The DiscordVoiceIO already segments per speaker
 * (one subscription per speaking burst), so "one stream → one utterance" is
 * the right granularity here. For lower latency, prefer the streaming
 * websocket provider (`DeepgramStreamingSTT`, design doc 0018); this
 * prerecorded path remains as a fallback and for batch/offline use.
 *
 * Network-bound; fetch is injectable for unit tests.
 */
export interface DeepgramSTTOptions {
  apiKey: string;
  /** Deepgram model, e.g., "nova-3". */
  model?: string;
  /** Audio encoding hint, e.g., "linear16"; with sampleRate for raw PCM. */
  encoding?: string;
  sampleRate?: number;
  /** Channel count for raw PCM (Discord decodes to 2). */
  channels?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface DeepgramAlternative {
  transcript?: string;
  confidence?: number;
}
interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
}
interface DeepgramResponse {
  results?: { channels?: DeepgramChannel[] };
}

export class DeepgramSTT implements STTProvider {
  readonly name = "deepgram";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;

  constructor(private readonly options: DeepgramSTTOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.deepgram.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.model = options.model ?? "nova-3";
  }

  async *transcribe(
    audio: AsyncIterable<Uint8Array>,
    opts: STTOptions,
  ): AsyncIterable<Utterance> {
    const bytes = await drainBytes(audio);
    if (bytes.length === 0) return;

    const url = new URL(`${this.baseUrl}/v1/listen`);
    url.searchParams.set("model", this.model);
    url.searchParams.set("smart_format", "true");
    if (this.options.encoding) url.searchParams.set("encoding", this.options.encoding);
    if (this.options.sampleRate) url.searchParams.set("sample_rate", String(this.options.sampleRate));
    if (this.options.channels) url.searchParams.set("channels", String(this.options.channels));
    if (opts.language) url.searchParams.set("language", opts.language);

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Token ${this.options.apiKey}`, "content-type": "application/octet-stream" },
      body: bytes,
    });
    assertOk(res, "Deepgram listen request");
    const body = (await res.json()) as DeepgramResponse;
    const alt = body.results?.channels?.[0]?.alternatives?.[0];
    const text = alt?.transcript?.trim() ?? "";
    if (text.length === 0) return;

    yield buildUtterance(opts, text, alt?.confidence);
  }
}
