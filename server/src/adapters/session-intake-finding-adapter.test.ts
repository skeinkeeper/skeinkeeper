// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { tenants } from "../schema/index.js";
import { SessionIntakeFindingAdapter } from "./session-intake-finding-adapter.js";

function seedCampaign(db: Db, tenantId: string, id: string): TenantDb {
  const t = new TenantDb(db, tenantId);
  t.campaigns.create({
    id,
    name: id,
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return t;
}

describe("SessionIntakeFindingAdapter", () => {
  const openHandles: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const h of openHandles) h.close();
    openHandles.length = 0;
  });

  it("deletes findings for a campaign and a tenant", async () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    openHandles.push(db);
    db.insert(tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
    db.insert(tenants).values({ id: "other", name: "O", createdAt: Date.now() }).run();
    const def = seedCampaign(db, "default", "c1");
    seedCampaign(db, "default", "c2");
    const other = seedCampaign(db, "other", "c3");
    def.sessionIntakeFindings.insert({
      campaignId: "c1",
      sessionId: "s1",
      findingCode: "NO_PARTY_ACTORS",
      kind: "critical-gap",
      summary: "x",
      dmOnly: false,
      createdAt: Date.now(),
    });
    def.sessionIntakeFindings.insert({
      campaignId: "c2",
      sessionId: "s2",
      findingCode: "NO_PARTY_ACTORS",
      kind: "critical-gap",
      summary: "y",
      dmOnly: false,
      createdAt: Date.now(),
    });
    other.sessionIntakeFindings.insert({
      campaignId: "c3",
      sessionId: "s3",
      findingCode: "NO_PARTY_ACTORS",
      kind: "critical-gap",
      summary: "z",
      dmOnly: false,
      createdAt: Date.now(),
    });

    const adapter = new SessionIntakeFindingAdapter(db);
    expect(await adapter.delete({ kind: "campaign", tenantId: "default", campaignId: "c1" })).toBe(
      1,
    );
    expect(def.sessionIntakeFindings.listByCampaign("c1")).toHaveLength(0);
    expect(def.sessionIntakeFindings.listByCampaign("c2")).toHaveLength(1);

    expect(await adapter.delete({ kind: "tenant", tenantId: "default" })).toBe(1);
    expect(def.sessionIntakeFindings.listByCampaign("c2")).toHaveLength(0);
    expect(other.sessionIntakeFindings.listByCampaign("c3")).toHaveLength(1);
    expect(await adapter.delete({ kind: "player", tenantId: "default", subjectId: "x" })).toBe(0);
  });
});
