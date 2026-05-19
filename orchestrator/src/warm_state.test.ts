// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, TenantDb, schema } from "@skeinkeeper/server";
import { buildWarmStateSnapshot, summarizeWarmStateForOperator } from "./warm_state.js";
import { MockFoundryClient } from "./foundry/mock.js";
import type { FoundryActor, FoundryScene } from "./foundry/client.js";

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

function character(id: string, name: string, hp: number, maxHp: number): FoundryActor {
  return {
    id,
    name,
    type: "character",
    system: "dnd5e",
    sheet: { attributes: { hp: { value: hp, max: maxHp } } },
  };
}

function npc(id: string, name: string): FoundryActor {
  return {
    id,
    name,
    type: "npc",
    system: "dnd5e",
    sheet: { attributes: { hp: { value: 10, max: 10 } } },
  };
}

describe("buildWarmStateSnapshot", () => {
  it("merges Foundry party + scene NPCs with campaign metadata", async () => {
    const { t } = setup();
    const aragorn = character("char-aragorn", "Aragorn", 22, 30);
    const sildar = npc("npc-sildar", "Sildar");
    const villain = npc("npc-glasstaff", "Glasstaff");
    const scene: FoundryScene = {
      id: "scene-tavern",
      name: "Stonehill Inn",
      description: "smells of stew",
      active: true,
      tokens: [
        { actorId: aragorn.id, name: aragorn.name, disposition: 1 },
        { actorId: sildar.id, name: sildar.name, disposition: 1 },
      ],
    };
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [aragorn, sildar, villain],
      scenes: [scene],
      partyActorIds: ["char-aragorn"],
      activeSceneId: "scene-tavern",
    });

    const snap = await buildWarmStateSnapshot(foundry, t, "c1");
    expect(snap.campaign.name).toBe("Phandelver");
    expect(snap.party).toHaveLength(1);
    expect(snap.party[0]?.name).toBe("Aragorn");
    expect(snap.activeNpcs).toHaveLength(1);
    expect(snap.activeNpcs[0]?.name).toBe("Sildar");
    expect(snap.currentLocation?.name).toBe("Stonehill Inn");
    expect(snap.currentLocation?.description).toBe("smells of stew");
  });

  it("returns null currentLocation when no active scene", async () => {
    const { t } = setup();
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    const snap = await buildWarmStateSnapshot(foundry, t, "c1");
    expect(snap.currentLocation).toBeNull();
    expect(snap.activeNpcs).toHaveLength(0);
  });

  it("throws on unknown campaign", async () => {
    const { t } = setup();
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    await expect(buildWarmStateSnapshot(foundry, t, "nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("summarizeWarmStateForOperator", () => {
  it("renders a one-line summary including party", async () => {
    const { t } = setup();
    const aragorn = character("char-aragorn", "Aragorn", 22, 30);
    const foundry = new MockFoundryClient({
      system: "dnd5e",
      actors: [aragorn],
      partyActorIds: ["char-aragorn"],
    });

    const summary = summarizeWarmStateForOperator(await buildWarmStateSnapshot(foundry, t, "c1"));
    expect(summary).toContain("Phandelver");
    expect(summary).toContain("Aragorn");
    expect(summary).toContain("HP 22/30");
    expect(summary).toContain("no active scene");
  });

  it("handles empty party gracefully", async () => {
    const { t } = setup();
    const foundry = new MockFoundryClient({ system: "dnd5e" });
    const summary = summarizeWarmStateForOperator(await buildWarmStateSnapshot(foundry, t, "c1"));
    expect(summary).toContain("no party loaded");
  });
});
