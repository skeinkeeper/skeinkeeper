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

function seedCampaign(t: TenantDb, id = "c1") {
  const now = Date.now();
  t.campaigns.create({
    id,
    name: "Test Campaign",
    rulesetId: "dnd5e",
    behaviorSpecVersion: "v0.1",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

describe("TenantDb — campaigns", () => {
  it("creates and lists campaigns scoped by tenant", () => {
    const { t } = setup();
    seedCampaign(t, "phandelver");
    const all = t.campaigns.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.tenantId).toBe("default");
    expect(t.campaigns.get("phandelver")?.name).toBe("Test Campaign");
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
    seedCampaign(t);
    t.questFlags.set({ campaignId: "c1", key: "phandelver.cragmaw.cleared", value: "false", updatedAt: now });
    t.questFlags.set({ campaignId: "c1", key: "phandelver.cragmaw.cleared", value: "true", updatedAt: now + 1 });
    const all = t.questFlags.listByCampaign("c1");
    expect(all).toHaveLength(1);
    expect(all[0]?.value).toBe("true");
  });
});

describe("TenantDb — clocks", () => {
  function freshClockSetup() {
    const env = setup();
    seedCampaign(env.t);
    return env;
  }

  it("creates and lists clocks scoped to a campaign", () => {
    const { t } = freshClockSetup();
    t.clocks.create({
      id: "clk-1",
      campaignId: "c1",
      name: "Faction: Redbrands",
      description: "Their hold over Phandalin",
      category: "faction",
      segmentsTotal: 6,
      segmentsFilled: 0,
      visibleToPlayers: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const all = t.clocks.listByCampaign("c1");
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("Faction: Redbrands");
    expect(all[0]?.segmentsTotal).toBe(6);
  });

  it("ticks clocks forward and clamps at the total", () => {
    const { t } = freshClockSetup();
    t.clocks.create({
      id: "clk-1",
      campaignId: "c1",
      name: "Harm",
      segmentsTotal: 4,
      segmentsFilled: 0,
      visibleToPlayers: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r1 = t.clocks.tick("clk-1", 2);
    expect(r1.segmentsFilled).toBe(2);
    const r2 = t.clocks.tick("clk-1", 5);
    expect(r2.segmentsFilled).toBe(4); // clamped
  });

  it("ticks clocks backward and clamps at zero", () => {
    const { t } = freshClockSetup();
    t.clocks.create({
      id: "clk-1",
      campaignId: "c1",
      name: "Countdown",
      segmentsTotal: 8,
      segmentsFilled: 3,
      visibleToPlayers: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const r = t.clocks.tick("clk-1", -10);
    expect(r.segmentsFilled).toBe(0); // clamped
  });

  it("sets clocks to an explicit value and clamps", () => {
    const { t } = freshClockSetup();
    t.clocks.create({
      id: "clk-1",
      campaignId: "c1",
      name: "Mystery",
      segmentsTotal: 6,
      segmentsFilled: 0,
      visibleToPlayers: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(t.clocks.set("clk-1", 100).segmentsFilled).toBe(6);
    expect(t.clocks.set("clk-1", -5).segmentsFilled).toBe(0);
    expect(t.clocks.set("clk-1", 3).segmentsFilled).toBe(3);
  });

  it("deletes clocks", () => {
    const { t } = freshClockSetup();
    t.clocks.create({
      id: "clk-1",
      campaignId: "c1",
      name: "X",
      segmentsTotal: 4,
      segmentsFilled: 0,
      visibleToPlayers: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    t.clocks.delete("clk-1");
    expect(t.clocks.listByCampaign("c1")).toHaveLength(0);
  });

  it("throws on tick/set against an unknown clock", () => {
    const { t } = freshClockSetup();
    expect(() => t.clocks.tick("missing", 1)).toThrow();
    expect(() => t.clocks.set("missing", 1)).toThrow();
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
