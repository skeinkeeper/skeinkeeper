// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { TenantDb } from "./tenant_db.js";
import { tenants } from "./schema/index.js";

function setup(tenantId = "default") {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: tenantId, name: "Test", createdAt: Date.now() }).run();
  return { db, t: new TenantDb(db, tenantId) };
}

describe("TenantDb — campaigns + characters", () => {
  it("creates and lists campaigns scoped by tenant", () => {
    const { t } = setup();
    const now = Date.now();
    t.campaigns.create({
      id: "phandelver",
      name: "Lost Mine of Phandelver",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const all = t.campaigns.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.tenantId).toBe("default");
    expect(t.campaigns.get("phandelver")?.name).toBe("Lost Mine of Phandelver");
  });

  it("does not see another tenant's data", () => {
    const { db } = setup("alpha");
    db.insert(tenants).values({ id: "beta", name: "Beta", createdAt: Date.now() }).run();
    const alpha = new TenantDb(db, "alpha");
    const beta = new TenantDb(db, "beta");
    alpha.campaigns.create({
      id: "shared-id",
      name: "Alpha's Campaign",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(alpha.campaigns.list()).toHaveLength(1);
    expect(beta.campaigns.list()).toHaveLength(0);
    expect(beta.campaigns.get("shared-id")).toBeUndefined();
  });
});

describe("TenantDb — quest flags upsert", () => {
  it("inserts and then updates a flag by key", () => {
    const { t } = setup();
    const now = Date.now();
    t.campaigns.create({
      id: "c1",
      name: "C",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    t.questFlags.set({ campaignId: "c1", key: "phandelver.cragmaw.cleared", value: "false", updatedAt: now });
    t.questFlags.set({ campaignId: "c1", key: "phandelver.cragmaw.cleared", value: "true", updatedAt: now + 1 });
    const all = t.questFlags.listByCampaign("c1");
    expect(all).toHaveLength(1);
    expect(all[0]?.value).toBe("true");
  });
});

describe("TenantDb — audit log append-only", () => {
  it("appends entries scoped to tenant and session", () => {
    const { t } = setup();
    const now = Date.now();
    t.auditLog.append({
      sessionId: "sess-1",
      actor: "tool:roll",
      eventType: "tool_called",
      payloadJson: JSON.stringify({ formula: "1d20+3", result: 17 }),
      timestamp: now,
    });
    t.auditLog.append({
      sessionId: "sess-1",
      actor: "tool:apply_damage",
      eventType: "tool_called",
      payloadJson: JSON.stringify({ target: "goblin-1", amount: 4 }),
      timestamp: now + 1,
    });
    const entries = t.auditLog.listForSession("sess-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.actor).toBe("tool:roll");
  });
});
