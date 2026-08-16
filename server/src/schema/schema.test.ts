// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import {
  campaigns,
  consents,
  deletionLog,
  dialogue,
  playerCharacterMap,
  sessions,
  tenants,
} from "./index.js";

describe("schema", () => {
  it("creates an in-memory db and round-trips a consent row", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
      const now = Date.now();
      db.insert(consents)
        .values({
          tenantId: "default",
          subjectId: "discord:123456789",
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "granted",
          timestamp: now,
        })
        .run();

      const rows = db.select().from(consents).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: "default",
        subjectId: "discord:123456789",
        purpose: "voice_processing",
        action: "granted",
      });
    } finally {
      db.close();
    }
  });

  it("round-trips a deletion log entry with a hashed subject id", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
      db.insert(deletionLog)
        .values({
          tenantId: "default",
          scope: "player",
          subjectIdHash: "a".repeat(64),
          adapterName: "consents",
          recordsDeleted: 3,
          timestamp: Date.now(),
        })
        .run();
      const rows = db.select().from(deletionLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.subjectIdHash).toHaveLength(64);
      expect(rows[0]?.recordsDeleted).toBe(3);
    } finally {
      db.close();
    }
  });

  // TDD 0030: identity-lookup columns gain a salted-hash companion for
  // key-free equality + erasure once the value is AEAD-encrypted.
  it("stores a subject_id_hash companion on consents", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
      db.insert(consents)
        .values({
          tenantId: "default",
          subjectId: "gcm:ciphertext",
          subjectIdHash: "b".repeat(64),
          purpose: "voice_processing",
          consentTextVersion: "v1",
          action: "granted",
          timestamp: Date.now(),
        })
        .run();
      expect(db.select().from(consents).get()?.subjectIdHash).toBe("b".repeat(64));
    } finally {
      db.close();
    }
  });

  it("stores a discord_user_id_hash companion on player_character_map", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
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
      db.insert(playerCharacterMap)
        .values({
          tenantId: "default",
          campaignId: "c1",
          discordUserId: "gcm:ciphertext",
          discordUserIdHash: "c".repeat(64),
          foundryActorId: "actor-1",
          source: "player",
          confirmedAt: Date.now(),
        })
        .run();
      expect(db.select().from(playerCharacterMap).get()?.discordUserIdHash).toBe("c".repeat(64));
    } finally {
      db.close();
    }
  });

  it("stores a nullable foundry_user_id on player_character_map (TDD 0036)", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
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
      db.insert(playerCharacterMap)
        .values({
          tenantId: "default",
          campaignId: "c1",
          discordUserId: "discord:alice",
          foundryActorId: "actor-1",
          source: "player",
          confirmedAt: Date.now(),
        })
        .run();
      expect(db.select().from(playerCharacterMap).get()?.foundryUserId).toBeNull();
      db.insert(playerCharacterMap)
        .values({
          tenantId: "default",
          campaignId: "c1",
          discordUserId: "discord:bob",
          foundryUserId: "foundry-user-bob",
          foundryActorId: "actor-2",
          source: "player",
          confirmedAt: Date.now(),
        })
        .run();
      const bob = db
        .select()
        .from(playerCharacterMap)
        .all()
        .find((r) => r.discordUserId === "discord:bob");
      expect(bob?.foundryUserId).toBe("foundry-user-bob");
    } finally {
      db.close();
    }
  });

  it("stores a speaker_hash companion on dialogue", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
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
      db.insert(sessions)
        .values({
          id: "s1",
          tenantId: "default",
          campaignId: "c1",
          behaviorSpecVersion: "v0.1",
          startedAt: Date.now(),
        })
        .run();
      db.insert(dialogue)
        .values({
          tenantId: "default",
          sessionId: "s1",
          speaker: "gcm:ciphertext",
          speakerHash: "d".repeat(64),
          text: "gcm:ciphertext",
          timestamp: Date.now(),
        })
        .run();
      expect(db.select().from(dialogue).get()?.speakerHash).toBe("d".repeat(64));
    } finally {
      db.close();
    }
  });
});
