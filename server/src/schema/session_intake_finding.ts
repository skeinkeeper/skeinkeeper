// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Operator-visible intake findings (TDD 0031). PII-free by construction —
 * codes + rubric summaries only. tenant_id is required (ADR-0008) even
 * though the TDD sketch omitted it. Cascade on campaign delete.
 */
export const sessionIntakeFindings = sqliteTable(
  "session_intake_finding",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    findingCode: text("finding_code").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail"),
    dmOnly: integer("dm_only").notNull(),
    resolutionId: text("resolution_id"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => ({
    bySession: index("sif_tenant_session").on(t.tenantId, t.sessionId),
    byCampaign: index("sif_tenant_campaign").on(t.tenantId, t.campaignId),
  }),
);

export type SessionIntakeFindingRow = typeof sessionIntakeFindings.$inferSelect;
export type NewSessionIntakeFindingRow = typeof sessionIntakeFindings.$inferInsert;
