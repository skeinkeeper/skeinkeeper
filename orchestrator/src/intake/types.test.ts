// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import {
  FINDING_CODES,
  isFindingCode,
  type FindingCode,
  type IntakeFinding,
  type MinimumIntakeResult,
  type ExtendedIntakeResult,
} from "./types.js";

describe("intake types", () => {
  it("exports the closed v0.5 FindingCode set", () => {
    const expected: FindingCode[] = [
      "NO_FOUNDRY_SYSTEM",
      "UNKNOWN_FOUNDRY_SYSTEM",
      "FOUNDRY_NOT_CONNECTED",
      "NO_PARTY_ACTORS",
      "MISSING_RACE_CONTENT",
      "MISSING_CLASS_CONTENT",
      "NO_STARTING_SCENE",
      "MULTIPLE_CAMPAIGN_MODULES",
      "AMBIG_STARTING_SCENE",
      "AMBIG_SOURCE_PACK_FOR_CREATURE",
      "AMBIG_RACE_SOURCE",
      "RECO_PROPOSED_STARTING_SCENE",
      "RECO_PROPOSED_OWNERSHIP_MAP",
      "RECO_PROPOSED_PRIMARY_PACK",
      "RECO_FOUNDRY_OWNERSHIP_UNRESOLVED",
      "IDENTITY_NO_FOUNDRY_USER",
      "IDENTITY_FOUNDRY_USER_NOT_OWNING_ACTOR",
      "IDENTITY_NO_DM_FOUNDRY_USER",
      "IDENTITY_DM_IS_OPERATOR_PLAYER",
      "IDENTITY_OPERATOR_NOT_GM_ROLE",
      "IDENTITY_EXTRA_FOUNDRY_USERS",
      "IDENTITY_BRIDGE_LISTUSERS_UNAVAILABLE",
    ];
    expect([...FINDING_CODES]).toEqual(expected);
    expect(new Set(FINDING_CODES).size).toBe(22);
  });

  it("isFindingCode accepts only members of the closed union", () => {
    expect(isFindingCode("NO_PARTY_ACTORS")).toBe(true);
    expect(isFindingCode("not-a-code")).toBe(false);
  });

  it("shapes MinimumIntakeResult / ExtendedIntakeResult / IntakeFinding", () => {
    const finding: IntakeFinding = {
      code: "NO_PARTY_ACTORS",
      kind: "critical-gap",
      summary: "No party actors",
      dmOnly: false,
    };
    const minimum: MinimumIntakeResult = {
      system: { id: "dnd5e", name: "D&D 5e" },
      partyActorCandidates: [],
      criticalFindings: [finding],
    };
    const extended: ExtendedIntakeResult = {
      loadedModules: [],
      compendiumPacks: [],
      existingScenes: [],
      currentOwnershipMap: {},
      warmStateSummary: {
        priorSessionCount: 0,
        questFlagCount: 0,
        consentedPlayerCount: 0,
        mappedPlayerCount: 0,
      },
      findings: [],
    };
    expect(minimum.criticalFindings[0]?.code).toBe("NO_PARTY_ACTORS");
    expect(extended.warmStateSummary.priorSessionCount).toBe(0);
  });
});
