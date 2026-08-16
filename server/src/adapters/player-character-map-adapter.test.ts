// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb, type Db } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { campaigns, playerCharacterMap, tenants } from "../schema/index.js";
import { PlayerCharacterMapAdapter } from "./player-character-map-adapter.js";
import { createPiiCrypto } from "../column_crypto.js";

const PII_SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const enabledCrypto = () =>
  createPiiCrypto({ keySource: { getPassphrase: () => "pw" }, salt: PII_SALT });

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

describe("PlayerCharacterMapAdapter — encrypted rows (TDD 0030)", () => {
  it("erases an AEAD-encrypted mapping by its hash companion", async () => {
    const { db } = setup();
    const c = enabledCrypto();
    db.insert(playerCharacterMap)
      .values({
        tenantId: "default",
        campaignId: "c1",
        discordUserId: c.enc("discord:alice"),
        discordUserIdHash: c.hash("discord:alice"),
        foundryActorId: "actor-alice",
        source: "player",
        confirmedAt: Date.now(),
      })
      .run();
    const deleted = await new PlayerCharacterMapAdapter(db, c).delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(deleted).toBe(1);
    expect(db.select().from(playerCharacterMap).all()).toHaveLength(0);
  });

  it("decrypts the discord id + display name when exporting an encrypted row", async () => {
    const { db } = setup();
    const c = enabledCrypto();
    db.insert(playerCharacterMap)
      .values({
        tenantId: "default",
        campaignId: "c1",
        discordUserId: c.enc("discord:alice"),
        discordUserIdHash: c.hash("discord:alice"),
        displayName: c.enc("Alice"),
        foundryActorId: "actor-alice",
        source: "player",
        confirmedAt: Date.now(),
      })
      .run();
    const payload = await new PlayerCharacterMapAdapter(db, c).export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    const rows = payload.data as Array<{ discordUserId: string; displayName: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.discordUserId).toBe("discord:alice");
    expect(rows[0]?.displayName).toBe("Alice");
  });

  it("player erasure removes discord, foundry user, and actor ids (TDD 0036)", async () => {
    const { db } = setup();
    const t = new TenantDb(db, "default");
    t.playerCharacterMap.record({
      campaignId: "c1",
      discordUserId: "discord:alice",
      foundryUserId: "foundry-user-alice",
      foundryActorId: "actor-alice",
      displayName: "Alice",
      source: "player",
      confirmedAt: Date.now(),
    });
    const exported = await new PlayerCharacterMapAdapter(db).export({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    const before = exported.data as Array<{
      discordUserId: string;
      foundryUserId: string | null;
      foundryActorId: string;
    }>;
    expect(before).toHaveLength(1);
    expect(before[0]?.discordUserId).toBe("discord:alice");
    expect(before[0]?.foundryUserId).toBe("foundry-user-alice");
    expect(before[0]?.foundryActorId).toBe("actor-alice");

    const deleted = await new PlayerCharacterMapAdapter(db).delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:alice",
    });
    expect(deleted).toBe(1);
    const remaining = db.select().from(playerCharacterMap).all();
    expect(remaining).toHaveLength(0);
    expect(remaining.some((r) => r.discordUserId === "discord:alice")).toBe(false);
    expect(remaining.some((r) => r.foundryUserId === "foundry-user-alice")).toBe(false);
    expect(remaining.some((r) => r.foundryActorId === "actor-alice")).toBe(false);
  });
});
