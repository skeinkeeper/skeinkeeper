// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FindingCode } from "./types.js";

/**
 * Compile-time exhaustive spoiler table (TDD 0031 §Spoiler-aware framing).
 * Adding a FindingCode without a row here is a type error.
 */
export const SPOILER_DM_ONLY: Record<FindingCode, boolean | "if-names-creature-or-location"> = {
  NO_FOUNDRY_SYSTEM: false,
  UNKNOWN_FOUNDRY_SYSTEM: false,
  FOUNDRY_NOT_CONNECTED: false,
  NO_PARTY_ACTORS: false,
  MISSING_RACE_CONTENT: false,
  MISSING_CLASS_CONTENT: false,
  NO_STARTING_SCENE: false,
  MULTIPLE_CAMPAIGN_MODULES: false,
  AMBIG_STARTING_SCENE: true,
  AMBIG_SOURCE_PACK_FOR_CREATURE: true,
  AMBIG_RACE_SOURCE: false,
  RECO_PROPOSED_STARTING_SCENE: true,
  RECO_PROPOSED_OWNERSHIP_MAP: false,
  RECO_PROPOSED_PRIMARY_PACK: "if-names-creature-or-location",
  RECO_FOUNDRY_OWNERSHIP_UNRESOLVED: false,
};

export const DM_ONLY_MARKER = "*DM-only — affects tonight's session:*";

export interface FindingSummaryPayload {
  label?: string;
  optionLabels?: ReadonlyArray<string>;
  namesCreatureOrLocation?: boolean;
  detail?: string;
}

export interface FramedFindingCopy {
  summary: string;
  detail?: string;
  dmOnly: boolean;
}

export function buildFindingSummary(
  code: FindingCode,
  payload: FindingSummaryPayload = {},
): FramedFindingCopy {
  const rule = SPOILER_DM_ONLY[code];
  const dmOnly =
    rule === "if-names-creature-or-location" ? payload.namesCreatureOrLocation === true : rule;
  const summary = defaultSummary(code, payload);
  const framed: FramedFindingCopy = { summary, dmOnly };
  if (payload.detail !== undefined) framed.detail = payload.detail;
  return framed;
}

function defaultSummary(code: FindingCode, payload: FindingSummaryPayload): string {
  const labels = payload.optionLabels ?? [];
  switch (code) {
    case "NO_FOUNDRY_SYSTEM":
      return "No Foundry game system is active in this world.";
    case "UNKNOWN_FOUNDRY_SYSTEM":
      return payload.label !== undefined
        ? `Unrecognized Foundry system "${payload.label}".`
        : "Unrecognized Foundry system.";
    case "FOUNDRY_NOT_CONNECTED":
      return "Foundry is not connected.";
    case "NO_PARTY_ACTORS":
      return "No party-actor candidates were found in the Foundry world.";
    case "MISSING_RACE_CONTENT":
      return payload.label !== undefined
        ? `Required race content for "${payload.label}" is not loaded.`
        : "Required race content is not loaded.";
    case "MISSING_CLASS_CONTENT":
      return payload.label !== undefined
        ? `Required class content for "${payload.label}" is not loaded.`
        : "Required class content is not loaded.";
    case "NO_STARTING_SCENE":
      return "No scene matches a starting-scene convention.";
    case "MULTIPLE_CAMPAIGN_MODULES":
      return labels.length > 0
        ? `More than one campaign module is loaded: ${labels.join(", ")}. Which one tonight?`
        : "More than one campaign module is loaded. Which one tonight?";
    case "AMBIG_STARTING_SCENE":
      return "More than one scene could be tonight's starting beat. Which should we use?";
    case "AMBIG_SOURCE_PACK_FOR_CREATURE":
      return "The same creature is present in more than one pack. Which pack should I use?";
    case "AMBIG_RACE_SOURCE":
      return payload.label !== undefined
        ? `Race "${payload.label}" is defined in more than one source. Which should I use?`
        : "A player race is defined in more than one source. Which should I use?";
    case "RECO_PROPOSED_STARTING_SCENE":
      return payload.label !== undefined
        ? `Proposed starting scene: ${payload.label}.`
        : "A starting scene has been proposed.";
    case "RECO_PROPOSED_OWNERSHIP_MAP":
      return "Proposed character-to-player pairings are ready to confirm.";
    case "RECO_PROPOSED_PRIMARY_PACK":
      return payload.label !== undefined
        ? `Proposed primary pack: ${payload.label}.`
        : "A primary source pack has been proposed.";
    case "RECO_FOUNDRY_OWNERSHIP_UNRESOLVED":
      return "A player's Foundry-user mapping needs attention.";
  }
}
