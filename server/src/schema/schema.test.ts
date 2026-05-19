// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { consents, deletionLog, clocks, tenants, campaigns } from "./index.js";

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

  it("round-trips a clock row with FK to campaigns", () => {
    const db = openDb({ path: ":memory:", runMigrations: true });
    try {
      const now = Date.now();
      db.insert(tenants).values({ id: "default", name: "Test", createdAt: now }).run();
      db.insert(campaigns)
        .values({
          id: "c1",
          tenantId: "default",
          name: "Test",
          rulesetId: "dnd5e",
          behaviorSpecVersion: "v0.1",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(clocks)
        .values({
          id: "clk-1",
          tenantId: "default",
          campaignId: "c1",
          name: "Faction: Redbrands",
          category: "faction",
          segmentsTotal: 6,
          segmentsFilled: 2,
          visibleToPlayers: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const rows = db.select().from(clocks).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.segmentsFilled).toBe(2);
      expect(rows[0]?.segmentsTotal).toBe(6);
    } finally {
      db.close();
    }
  });
});
