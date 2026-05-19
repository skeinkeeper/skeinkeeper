// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { buildWarmStateSnapshot, summarizeWarmStateForOperator } from "./warm_state.js";

function setup() {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(schema.tenants)
    .values({ id: "default", name: "Test", createdAt: Date.now() })
    .run();
  db.insert(schema.campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "Phandelver",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const t = new TenantDb(db, "default");
  return { db, t };
}

describe("buildWarmStateSnapshot", () => {
  it("includes the campaign, party with conditions, and alive NPCs only", () => {
    const { t } = setup();
    t.characters.create({
      id: "ch-1",
      campaignId: "c1",
      name: "Aragorn",
      playerDiscordId: "111",
      hp: 20,
      maxHp: 30,
      rulesetDataJson: JSON.stringify({ conditions: ["bleeding"] }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    t.npcs.create({
      id: "npc-1",
      campaignId: "c1",
      name: "Sildar",
      mannerism: "rubs beard",
      motivation: "find friend",
      disposition: "friendly",
      alive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    t.npcs.create({
      id: "npc-2",
      campaignId: "c1",
      name: "Glasstaff",
      disposition: "hostile",
      alive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const snap = buildWarmStateSnapshot(t, "c1");
    expect(snap.campaign.name).toBe("Phandelver");
    expect(snap.party).toHaveLength(1);
    expect(snap.party[0]?.conditions).toEqual(["bleeding"]);
    expect(snap.activeNpcs).toHaveLength(1);
    expect(snap.activeNpcs[0]?.name).toBe("Sildar");
    expect(snap.activeNpcs[0]?.mannerism).toBe("rubs beard");
  });

  it("resolves currentLocation via the party.location quest flag", () => {
    const { t } = setup();
    t.locations.create({
      id: "loc-tavern",
      campaignId: "c1",
      name: "Stonehill Inn",
      description: "smells of stew",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    t.questFlags.set({
      campaignId: "c1",
      key: "party.location",
      value: "loc-tavern",
      updatedAt: Date.now(),
    });
    const snap = buildWarmStateSnapshot(t, "c1");
    expect(snap.currentLocation?.id).toBe("loc-tavern");
    expect(snap.currentLocation?.name).toBe("Stonehill Inn");
    expect(snap.currentLocation?.description).toBe("smells of stew");
  });

  it("returns null currentLocation when no party.location flag set", () => {
    const { t } = setup();
    const snap = buildWarmStateSnapshot(t, "c1");
    expect(snap.currentLocation).toBeNull();
  });

  it("does not cross tenants", () => {
    const { db, t } = setup();
    db.insert(schema.tenants).values({ id: "other", name: "Other", createdAt: Date.now() }).run();
    db.insert(schema.campaigns)
      .values({
        id: "other-c1",
        tenantId: "other",
        name: "Other Tenant's Campaign",
        rulesetId: "dnd5e",
        behaviorSpecVersion: "v0.1",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    // The other tenant's campaign exists, but a TenantDb scoped to "default"
    // should not see it.
    expect(() => buildWarmStateSnapshot(t, "other-c1")).toThrow(/not found/);
    // And default's campaign is unaffected.
    expect(buildWarmStateSnapshot(t, "c1").campaign.name).toBe("Phandelver");
  });

  it("throws on unknown campaign", () => {
    const { t } = setup();
    expect(() => buildWarmStateSnapshot(t, "nonexistent")).toThrow(/not found/);
  });
});

describe("summarizeWarmStateForOperator", () => {
  it("renders a one-line summary", () => {
    const { t } = setup();
    t.characters.create({
      id: "ch-1",
      campaignId: "c1",
      name: "Aragorn",
      playerDiscordId: "111",
      hp: 22,
      maxHp: 30,
      rulesetDataJson: "{}",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const summary = summarizeWarmStateForOperator(buildWarmStateSnapshot(t, "c1"));
    expect(summary).toContain("Phandelver");
    expect(summary).toContain("Aragorn 22/30 HP");
    expect(summary).toContain("no set location");
  });

  it("handles empty party gracefully", () => {
    const { t } = setup();
    const summary = summarizeWarmStateForOperator(buildWarmStateSnapshot(t, "c1"));
    expect(summary).toContain("no characters created yet");
  });
});
