// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Curated DM voice personas (design doc 0017). These are the *only* voice
 * setting the operator touches: they pick a persona by its human-meaningful
 * label and description. The mapping from a persona to a concrete provider
 * voice ID (and provider settings) lives in the TTS plugin — never here, and
 * never surfaced to the operator (ADR-0004: provider details stay in the
 * driver; the operator never learns we use ElevenLabs).
 */
export interface DmPersona {
  id: string;
  label: string;
  description: string;
}

export const DM_VOICE_PERSONAS: ReadonlyArray<DmPersona> = [
  {
    id: "warm-storyteller",
    label: "Warm Storyteller",
    description: "Inviting and unhurried; leans into wonder.",
  },
  {
    id: "gravelly-veteran",
    label: "Gravelly Veteran",
    description: "Weathered and low; a voice that has seen things.",
  },
  {
    id: "theatrical-showman",
    label: "Theatrical Showman",
    description: "Big and playful; relishes a dramatic reveal.",
  },
  {
    id: "measured-sage",
    label: "Measured Sage",
    description: "Calm, precise, quietly authoritative.",
  },
];

/** Pairs with the behavior spec's default "Generous Collaborator" preset. */
export const DEFAULT_DM_PERSONA_ID = "warm-storyteller";

export function getDmPersona(id: string): DmPersona | undefined {
  return DM_VOICE_PERSONAS.find((p) => p.id === id);
}
