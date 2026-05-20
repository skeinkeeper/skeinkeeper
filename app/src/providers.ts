// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { join } from "node:path";
import { AnthropicProvider } from "@skeinkeeper/llm-anthropic";
import {
  DeepgramStreamingSTT,
  ElevenLabsTTS,
  ElevenLabsVoiceLibrary,
} from "@skeinkeeper/voice-discord";
import { LocalEmbeddingProvider } from "@skeinkeeper/embed-local";
import { LanceMemoryStore } from "@skeinkeeper/memory-lance";
import type { AppConfig } from "./config.js";

/**
 * Builds the concrete provider instances from config (design doc 0020 §2).
 * This is the one place the operator's real services are wired; the rest of
 * the app deals in interfaces.
 */
export interface AppProviders {
  llm: AnthropicProvider;
  stt: DeepgramStreamingSTT;
  tts: ElevenLabsTTS;
  voiceLibrary: ElevenLabsVoiceLibrary;
  embed: LocalEmbeddingProvider;
}

export function buildProviders(config: AppConfig): AppProviders {
  return {
    llm: new AnthropicProvider({ apiKey: config.anthropicApiKey }),
    stt: new DeepgramStreamingSTT({
      apiKey: config.deepgramApiKey,
      encoding: "linear16",
      sampleRate: 48_000,
      channels: 2,
    }),
    tts: new ElevenLabsTTS({ apiKey: config.elevenLabsApiKey, defaultVoiceId: config.dmVoiceId }),
    voiceLibrary: new ElevenLabsVoiceLibrary({ apiKey: config.elevenLabsApiKey }),
    embed: new LocalEmbeddingProvider(),
  };
}

/** Per-tenant LanceDB memory store (one directory per tenant, ADR-0008). */
export function memoryStoreFor(
  config: AppConfig,
  dimensions: number,
  tenantId: string,
): LanceMemoryStore {
  return new LanceMemoryStore({
    dir: join(config.dataDir, "memory", tenantId),
    dimensions,
  });
}
