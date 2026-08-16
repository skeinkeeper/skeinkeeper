// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { questFlags, tenants } from "../schema/index.js";
import { CampaignAdapter } from "./campaign-adapter.js";

function seedCampaign(db: Db, tenantId: string, id: string): void {
  new TenantDb(db, tenantId).campaigns.create({
    id,
    name: id,
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function setup(): { db: Db } {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  db.insert(tenants).values({ id: "other", name: "O", createdAt: Date.now() }).run();
  return { db };
}

describe("CampaignAdapter", () => {
  it("deletes one campaign on campaign scope and cascades its child rows", async () => {
    const { db } = setup();
    seedCampaign(db, "default", "c1");
    seedCampaign(db, "default", "c2");
    const t = new TenantDb(db, "default");
    t.questFlags.set({ campaignId: "c1", key: "k", value: "v", updatedAt: Date.now() });

    const n = await new CampaignAdapter(db).delete({
      kind: "campaign",
      tenantId: "default",
      campaignId: "c1",
    });
    expect(n).toEqual({ recordsDeleted: 1 });
    expect(t.campaigns.list().map((c) => c.id)).toEqual(["c2"]);
    // FK cascade removed the campaign's quest flags.
    expect(db.select().from(questFlags).all()).toHaveLength(0);
  });

  it("deletes all of a tenant's campaigns on tenant scope, leaving other tenants", async () => {
    const { db } = setup();
    seedCampaign(db, "default", "c1");
    seedCampaign(db, "default", "c2");
    seedCampaign(db, "other", "c3");
    const n = await new CampaignAdapter(db).delete({ kind: "tenant", tenantId: "default" });
    expect(n).toEqual({ recordsDeleted: 2 });
    expect(new TenantDb(db, "default").campaigns.list()).toHaveLength(0);
    expect(new TenantDb(db, "other").campaigns.list().map((c) => c.id)).toEqual(["c3"]);
  });

  it("does nothing on player scope", async () => {
    const { db } = setup();
    seedCampaign(db, "default", "c1");
    const n = await new CampaignAdapter(db).delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:1",
    });
    expect(n).toEqual({ recordsDeleted: 0 });
    expect(new TenantDb(db, "default").campaigns.list()).toHaveLength(1);
  });
});
