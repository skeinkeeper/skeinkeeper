// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import {
  campaigns,
  characters,
  npcs,
  locations,
  questFlags,
  factionReputation,
  sessions,
  auditLog,
  type NewCampaign,
  type NewCharacter,
  type NewNpc,
  type NewLocation,
  type NewQuestFlag,
  type NewFactionReputation,
  type NewSession,
  type NewAuditLogEntry,
} from "./schema/index.js";

/**
 * Tenant-scoped access to the database. The orchestrator, plugins, and CLI
 * receive a TenantDb instance from the bootstrap layer and never see the
 * raw Db — every read and write goes through here and is implicitly
 * scoped by tenantId. Per ADR-0008.
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

  // ---- characters ----
  readonly characters = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(characters)
        .where(and(eq(characters.tenantId, this.tenantId), eq(characters.campaignId, campaignId)))
        .all(),
    get: (id: string) =>
      this.db
        .select()
        .from(characters)
        .where(and(eq(characters.tenantId, this.tenantId), eq(characters.id, id)))
        .get(),
    create: (data: Omit<NewCharacter, "tenantId">) =>
      this.db.insert(characters).values({ ...data, tenantId: this.tenantId }).run(),
  };

  // ---- npcs ----
  readonly npcs = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(npcs)
        .where(and(eq(npcs.tenantId, this.tenantId), eq(npcs.campaignId, campaignId)))
        .all(),
    get: (id: string) =>
      this.db
        .select()
        .from(npcs)
        .where(and(eq(npcs.tenantId, this.tenantId), eq(npcs.id, id)))
        .get(),
    create: (data: Omit<NewNpc, "tenantId">) =>
      this.db.insert(npcs).values({ ...data, tenantId: this.tenantId }).run(),
  };

  // ---- locations ----
  readonly locations = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(locations)
        .where(and(eq(locations.tenantId, this.tenantId), eq(locations.campaignId, campaignId)))
        .all(),
    create: (data: Omit<NewLocation, "tenantId">) =>
      this.db.insert(locations).values({ ...data, tenantId: this.tenantId }).run(),
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

  // ---- faction reputation ----
  readonly factionReputation = {
    listByCampaign: (campaignId: string) =>
      this.db
        .select()
        .from(factionReputation)
        .where(
          and(
            eq(factionReputation.tenantId, this.tenantId),
            eq(factionReputation.campaignId, campaignId),
          ),
        )
        .all(),
    upsert: (data: Omit<NewFactionReputation, "tenantId" | "id"> & { reputation: number }) =>
      this.db
        .insert(factionReputation)
        .values({ ...data, tenantId: this.tenantId })
        .onConflictDoUpdate({
          target: [factionReputation.tenantId, factionReputation.campaignId, factionReputation.faction],
          set: { reputation: data.reputation, updatedAt: data.updatedAt },
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
