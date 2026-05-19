// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Append-only audit log. Every tool call, state mutation, and AI
 * decision lands here. By convention there are no UPDATE or DELETE
 * paths against this table outside the erasure flow (`AuditLogAdapter`,
 * tenant-scope only).
 *
 * `payloadJson` may contain PII (e.g., a whispered player's Discord ID
 * surfaced via a tool call). Encryption-at-rest applies once the shim
 * lands per design doc 0002.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    actor: text("actor").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    timestamp: integer("timestamp").notNull(),
  },
  (t) => ({
    byTenantTime: index("audit_log_tenant_time").on(t.tenantId, t.timestamp),
    bySession: index("audit_log_session").on(t.tenantId, t.sessionId),
  }),
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
