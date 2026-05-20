// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { DM_VOICE_PERSONAS, DEFAULT_DM_PERSONA_ID, type DmPersona } from "@skeinkeeper/orchestrator";

/**
 * Operator-facing DM personas (design doc 0017) mapped to concrete ElevenLabs
 * premade voice IDs. The operator picks a persona by label in the UI and never
 * sees a voice ID or the word "ElevenLabs"; this app-level map is the single
 * place that binding lives.
 */
const PERSONA_VOICE_IDS: Record<string, string> = {
  "warm-storyteller": "JBFqnCBsd6RMkjVDRZzb", // George
  "gravelly-veteran": "N2lVS1w4EtoT3dr4eOWO", // Callum
  "theatrical-showman": "IKne3meq5aSn9XLyUdCD", // Charlie
  "measured-sage": "SAz9YHcvj6GT2YYXdXww", // River
};

export function dmPersonas(): ReadonlyArray<DmPersona> {
  return DM_VOICE_PERSONAS;
}

export function resolveDmPersonaVoice(personaId: string): string | undefined {
  return PERSONA_VOICE_IDS[personaId];
}

export function defaultDmPersonaVoice(): string {
  return PERSONA_VOICE_IDS[DEFAULT_DM_PERSONA_ID]!;
}
