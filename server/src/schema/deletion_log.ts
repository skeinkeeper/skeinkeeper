// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

/**
 * Anonymous record of erasure events. One row per deletion adapter per
 * erasure event, so a full per-player erasure across N storage systems
 * produces N rows.
 *
 * Carries no recoverable PII: `subject_id_hash` is a salted SHA-256 of
 * the subject ID. To answer "did we delete the records for {subject}?"
 * the operator re-hashes the queried subject and matches. The table can
 * be retained indefinitely as an audit trail without being itself a
 * privacy concern.
 */
export const deletionLog = sqliteTable(
  "deletion_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    scope: text("scope").notNull(),
    subjectIdHash: text("subject_id_hash").notNull(),
    adapterName: text("adapter_name").notNull(),
    recordsDeleted: integer("records_deleted").notNull(),
    timestamp: integer("timestamp").notNull(),
    reason: text("reason"),
  },
  (t) => ({
    byTime: index("deletion_log_tenant_time").on(t.tenantId, t.timestamp),
  }),
);

export const SCOPES = ["player", "campaign", "tenant"] as const;
export type Scope = (typeof SCOPES)[number];

export type DeletionLogEntry = typeof deletionLog.$inferSelect;
export type NewDeletionLogEntry = typeof deletionLog.$inferInsert;
