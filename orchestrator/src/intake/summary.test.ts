// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { FINDING_CODES, type FindingCode } from "./types.js";
import { buildFindingSummary, SPOILER_DM_ONLY } from "./summary.js";

const EXPECTED_DM_ONLY: Record<FindingCode, boolean | "conditional"> = {
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
  RECO_PROPOSED_PRIMARY_PACK: "conditional",
  RECO_FOUNDRY_OWNERSHIP_UNRESOLVED: false,
  IDENTITY_NO_FOUNDRY_USER: false,
  IDENTITY_FOUNDRY_USER_NOT_OWNING_ACTOR: false,
  IDENTITY_NO_DM_FOUNDRY_USER: false,
  IDENTITY_DM_IS_OPERATOR_PLAYER: false,
  IDENTITY_OPERATOR_NOT_GM_ROLE: false,
  IDENTITY_EXTRA_FOUNDRY_USERS: false,
  IDENTITY_BRIDGE_LISTUSERS_UNAVAILABLE: false,
};

describe("buildFindingSummary spoiler table", () => {
  it("is exhaustive over FindingCode", () => {
    for (const code of FINDING_CODES) {
      expect(code in EXPECTED_DM_ONLY).toBe(true);
      const framed = buildFindingSummary(code, { label: "x" });
      expect(framed.summary.length).toBeGreaterThan(0);
      expect(typeof framed.dmOnly).toBe("boolean");
    }
  });

  it("uses the conservative dmOnly default per code", () => {
    for (const code of FINDING_CODES) {
      const expected = EXPECTED_DM_ONLY[code];
      if (expected === "conditional") continue;
      expect(buildFindingSummary(code, {}).dmOnly).toBe(expected);
    }
  });

  it("RECO_PROPOSED_PRIMARY_PACK is dmOnly only when the pack names a creature or location", () => {
    expect(
      buildFindingSummary("RECO_PROPOSED_PRIMARY_PACK", { namesCreatureOrLocation: true }).dmOnly,
    ).toBe(true);
    expect(
      buildFindingSummary("RECO_PROPOSED_PRIMARY_PACK", { namesCreatureOrLocation: false }).dmOnly,
    ).toBe(false);
  });

  it("surfaces the choice, not the context, for module ambiguity", () => {
    const framed = buildFindingSummary("MULTIPLE_CAMPAIGN_MODULES", {
      optionLabels: ["Lost Mine of Phandelver", "Ravenloft"],
    });
    expect(framed.summary).toContain("Lost Mine of Phandelver");
    expect(framed.summary).toContain("Ravenloft");
    expect(framed.dmOnly).toBe(false);
  });

  it("exposes the compiled spoiler table for exhaustiveness checks", () => {
    expect(Object.keys(SPOILER_DM_ONLY).sort()).toEqual([...FINDING_CODES].sort());
  });
});
