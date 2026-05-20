// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { VoiceLibrary, VoiceLibraryEntry } from "@skeinkeeper/orchestrator";
import { assertOk } from "./provider_util.js";

/**
 * ElevenLabs implementation of the orchestrator's `VoiceLibrary` (design doc
 * 0017). The only place the ElevenLabs voices API is touched; the rest of
 * the system deals in provider-agnostic `VoiceLibraryEntry` values and the
 * persisted assignments. Uses the operator's own API key (read scope).
 *
 * Network-bound; the fetch implementation is injectable so the mapping logic
 * is unit-tested without a live key. The catalog rarely changes, so the
 * result is cached after the first successful fetch.
 */
export interface ElevenLabsVoiceLibraryOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  description?: string | null;
  labels?: Record<string, string> | null;
}

interface ElevenLabsVoicesResponse {
  voices: ElevenLabsVoice[];
}

function describe(voice: ElevenLabsVoice): string {
  if (voice.description && voice.description.trim().length > 0) return voice.description.trim();
  const labels = voice.labels ?? {};
  const parts = Object.values(labels).filter((v) => typeof v === "string" && v.length > 0);
  return parts.join(", ");
}

export class ElevenLabsVoiceLibrary implements VoiceLibrary {
  readonly name = "elevenlabs";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cache: ReadonlyArray<VoiceLibraryEntry> | null = null;

  constructor(private readonly options: ElevenLabsVoiceLibraryOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.elevenlabs.io";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(): Promise<ReadonlyArray<VoiceLibraryEntry>> {
    if (this.cache !== null) return this.cache;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/voices`, {
      headers: { "xi-api-key": this.options.apiKey, accept: "application/json" },
    });
    assertOk(res, "ElevenLabs voices request");
    const body = (await res.json()) as ElevenLabsVoicesResponse;
    const entries: VoiceLibraryEntry[] = (body.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: describe(v),
      ...(v.labels ? { labels: v.labels } : {}),
    }));
    this.cache = entries;
    return entries;
  }
}
