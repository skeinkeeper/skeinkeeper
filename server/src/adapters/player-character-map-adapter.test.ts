// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb, type Db } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { campaigns, playerCharacterMap, tenants } from "../schema/index.js";
import { PlayerCharacterMapAdapter } from "./player-character-map-adapter.js";

function setup(): { db: Db } {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  db.insert(campaigns)
    .values({
      id: "c1",
      tenantId: "default",
      name: "C",
      rulesetId: "dnd5e",
      behaviorSpecVersion: "v0.1",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  return { db };
}

function seedMappings(db: Db): void {
  const t = new TenantDb(db, "default");
  const now = Date.now();
  t.playerCharacterMap.record({
    campaignId: "c1",
    discordUserId: "discord:alice",
    foundryActorId: "actor-alice",
    source: "player",
    confirmedAt: now,
  });
  t.playerCharacterMap.record({
    campaignId: "c1",
    discordUserId: "discord:bob",
    foundryActorId: "actor-bob",
    source: "player",
    confirmedAt: now + 1,
  });
}

describe("PlayerCharacterMapAdapter — delete", () => {
  it("player scope deletes only that subject's mappings", async () => {
    const { db } = setup();
    seedMappings(db);
    const adapter = new PlayerCharacterMapAdapter(db);
    const deleted = await adapter.delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(deleted).toBe(1);
    const remaining = db.select().from(playerCharacterMap).all();
    expect(remaining.map((r) => r.discordUserId)).toEqual(["discord:bob"]);
  });

  it("tenant scope deletes all mappings for the tenant", async () => {
    const { db } = setup();
    seedMappings(db);
    const adapter = new PlayerCharacterMapAdapter(db);
    const deleted = await adapter.delete({ kind: "tenant", tenantId: "default" });
    expect(deleted).toBe(2);
    expect(db.select().from(playerCharacterMap).all()).toHaveLength(0);
  });

  it("campaign scope deletes the campaign's mappings (explicit, not just cascade)", async () => {
    const { db } = setup();
    seedMappings(db); // both mappings are in campaign c1
    const adapter = new PlayerCharacterMapAdapter(db);
    const deleted = await adapter.delete({
      kind: "campaign",
      tenantId: "default",
      campaignId: "c1",
    });
    expect(deleted).toBe(2);
    expect(db.select().from(playerCharacterMap).all()).toHaveLength(0);
  });

  it("deleting the campaign cascades to mappings via FK", async () => {
    const { db } = setup();
    seedMappings(db);
    db.delete(campaigns)
      .where(and(eq(campaigns.tenantId, "default"), eq(campaigns.id, "c1")))
      .run();
    expect(db.select().from(playerCharacterMap).all()).toHaveLength(0);
  });
});

describe("PlayerCharacterMapAdapter — export", () => {
  it("player scope returns only that subject's mappings", async () => {
    const { db } = setup();
    seedMappings(db);
    const adapter = new PlayerCharacterMapAdapter(db);
    const payload = await adapter.export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(payload.data).toHaveLength(1);
    expect((payload.summary ?? []).join(" ")).toContain("1 player↔character mapping");
  });

  it("campaign scope returns the campaign's mappings (so campaign:export isn't empty)", async () => {
    const { db } = setup();
    seedMappings(db);
    const payload = await new PlayerCharacterMapAdapter(db).export({
      kind: "campaign",
      tenantId: "default",
      campaignId: "c1",
    });
    expect(payload.data).toHaveLength(2);
  });
});
