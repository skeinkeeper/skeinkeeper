// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { loadIntakeConfig, persistSurfacedFindings, saveIntakeConfig } from "./persist.js";
import type { IntakeFinding } from "./types.js";

function setup(): TenantDb {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  const t = new TenantDb(db, "default");
  t.campaigns.create({
    id: "c1",
    name: "C",
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return t;
}

describe("SessionConfig.intake persistence", () => {
  it("round-trips chosen module / scene / resolved findings", () => {
    const t = setup();
    saveIntakeConfig(t, "c1", {
      resolvedFindings: { MULTIPLE_CAMPAIGN_MODULES: "lmop" },
      chosenCampaignModuleId: "lmop",
      chosenStartingSceneId: "s-start",
    });
    const loaded = loadIntakeConfig(t, "c1");
    expect(loaded.chosenCampaignModuleId).toBe("lmop");
    expect(loaded.chosenStartingSceneId).toBe("s-start");
    expect(loaded.resolvedFindings.MULTIPLE_CAMPAIGN_MODULES).toBe("lmop");
  });

  it("persists critical and ambiguity findings but not recommendations", () => {
    const t = setup();
    const findings: IntakeFinding[] = [
      { code: "NO_PARTY_ACTORS", kind: "critical-gap", summary: "none", dmOnly: false },
      {
        code: "RECO_PROPOSED_OWNERSHIP_MAP",
        kind: "recommendation",
        summary: "map",
        dmOnly: false,
      },
    ];
    const persisted = persistSurfacedFindings(t, "c1", "sess-1", findings);
    expect(persisted[0]?.id).toBeGreaterThan(0);
    expect(persisted[1]?.id).toBeUndefined();
    expect(t.sessionIntakeFindings.listBySession("sess-1")).toHaveLength(1);
  });
});
