// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  campaigns,
  questFlags,
  sessions,
  auditLog,
  type NewCampaign,
  type NewQuestFlag,
  type NewSession,
  type NewAuditLogEntry,
} from "./schema/index.js";

/**
 * Tenant-scoped access to the database. The orchestrator, plugins, and CLI
 * receive a TenantDb instance from the bootstrap layer and never see the
 * raw Db — every read and write goes through here and is implicitly
 * scoped by tenantId. Per ADR-0008.
 *
 * Per design doc 0007, mechanical state (characters, NPCs, locations,
 * faction relationships) lives in Foundry, accessed via FoundryClient.
 * This wrapper covers AI-DM-specific state only: campaigns, sessions,
 * audit log, consents (separate adapter), and quest flags.
 *
 * Application code that needs to break out (migrations, operator tools
 * that span tenants) uses unsafelyAcrossTenants() — grep-able, code-review
 * gated.
 */
export class TenantDb {
  constructor(
    private readonly db: Db,
    public readonly tenantId: string,
  ) {}

  // ---- campaigns ----
  readonly campaigns = {
    list: () =>
      this.db.select().from(campaigns).where(eq(campaigns.tenantId, this.tenantId)).all(),
    get: (id: string) =>
      this.db
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, this.tenantId), eq(campaigns.id, id)))
        .get(),
    create: (data: Omit<NewCampaign, "tenantId">) =>
      this.db.insert(campaigns).values({ ...data, tenantId: this.tenantId }).run(),
  };

  // ---- quest flags ----
  readonly questFlags = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(questFlags)
        .where(and(eq(questFlags.tenantId, this.tenantId), eq(questFlags.campaignId, campaignId)))
        .all(),
    set: (data: Omit<NewQuestFlag, "tenantId" | "id">) =>
      this.db
        .insert(questFlags)
        .values({ ...data, tenantId: this.tenantId })
        .onConflictDoUpdate({
          target: [questFlags.tenantId, questFlags.campaignId, questFlags.key],
          set: { value: data.value, updatedAt: data.updatedAt },
        })
        .run(),
  };

  // ---- sessions ----
  readonly sessions = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tenantId, this.tenantId), eq(sessions.campaignId, campaignId)))
        .all(),
    create: (data: Omit<NewSession, "tenantId">) =>
      this.db.insert(sessions).values({ ...data, tenantId: this.tenantId }).run(),
  };

  // ---- audit log (append-only) ----
  readonly auditLog = {
    append: (entry: Omit<NewAuditLogEntry, "tenantId" | "id">) =>
      this.db.insert(auditLog).values({ ...entry, tenantId: this.tenantId }).run(),
    listForSession: (sessionId: string) =>
      this.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, this.tenantId), eq(auditLog.sessionId, sessionId)))
        .all(),
  };

  /**
   * Escape hatch. Grep-able by name (`unsafelyAcrossTenants`). Use only
   * for migrations and operator-wide tooling; every callsite needs code
   * review per ADR-0008.
   */
  unsafelyAcrossTenants<T>(fn: (db: Db) => T): T {
    return fn(this.db);
  }
}
