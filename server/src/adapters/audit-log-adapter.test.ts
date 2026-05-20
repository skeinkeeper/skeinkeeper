// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db.js";
import { TenantDb } from "../tenant_db.js";
import { auditLog, tenants } from "../schema/index.js";
import { AuditLogAdapter } from "./audit-log-adapter.js";

function setup(): { db: Db } {
  const db = openDb({ path: ":memory:", runMigrations: true });
  db.insert(tenants).values({ id: "default", name: "T", createdAt: Date.now() }).run();
  db.insert(tenants).values({ id: "other", name: "O", createdAt: Date.now() }).run();
  return { db };
}

function seedEntry(db: Db, tenantId: string): void {
  new TenantDb(db, tenantId).auditLog.append({
    actor: "tool:roll",
    eventType: "tool_called",
    payloadJson: "{}",
    sessionId: "s1",
    turnId: "t1",
    timestamp: Date.now(),
  });
}

describe("AuditLogAdapter", () => {
  it("does NOT erase on player scope (audit trail is retained)", async () => {
    const { db } = setup();
    seedEntry(db, "default");
    const n = await new AuditLogAdapter(db).delete({
      kind: "player",
      tenantId: "default",
      subjectId: "discord:1",
    });
    expect(n).toBe(0);
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });

  it("does NOT erase on campaign scope (audit trail is retained)", async () => {
    const { db } = setup();
    seedEntry(db, "default");
    const n = await new AuditLogAdapter(db).delete({
      kind: "campaign",
      tenantId: "default",
      campaignId: "c1",
    });
    expect(n).toBe(0);
    expect(db.select().from(auditLog).all()).toHaveLength(1);
  });

  it("erases only the target tenant's rows on tenant scope", async () => {
    const { db } = setup();
    seedEntry(db, "default");
    seedEntry(db, "default");
    seedEntry(db, "other");
    const n = await new AuditLogAdapter(db).delete({ kind: "tenant", tenantId: "default" });
    expect(n).toBe(2);
    const remaining = db.select().from(auditLog).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tenantId).toBe("other");
  });
});
