// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { campaigns, sessionIntakeFindings, tenants } from "./index.js";

describe("session_intake_finding", () => {
  it("round-trips a tenant-scoped finding", () => {
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
      const t = new TenantDb(db, "default");
      const row = t.sessionIntakeFindings.insert({
        campaignId: "c1",
        sessionId: "sess-1",
        findingCode: "NO_PARTY_ACTORS",
        kind: "critical-gap",
        summary: "No party-actor candidates",
        dmOnly: false,
        createdAt: Date.now(),
      });
      expect(row.id).toBeGreaterThan(0);
      expect(row.tenantId).toBe("default");
      expect(t.sessionIntakeFindings.listBySession("sess-1")).toHaveLength(1);

      t.sessionIntakeFindings.markResolved(row.id, "proceed-anyway", Date.now());
      expect(t.sessionIntakeFindings.get(row.id)?.resolutionId).toBe("proceed-anyway");

      const other = new TenantDb(db, "other");
      expect(other.sessionIntakeFindings.listBySession("sess-1")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("declares tenant_id on the table", () => {
    expect(sessionIntakeFindings.tenantId.name).toBe("tenant_id");
  });
});
