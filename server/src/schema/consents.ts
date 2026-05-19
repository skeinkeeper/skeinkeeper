// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

/**
 * Per-player consent records. One row per (subject, purpose, action) event:
 * granting consent writes a row, withdrawing writes another. The current
 * state for a (subject, purpose) is the most recent row.
 *
 * `subject_id` is a Discord user ID and is PII at the application layer.
 * Per design doc 0002, this column is targeted for at-rest encryption when
 * the writer ships in Phase 0.7.
 */
export const consents = sqliteTable(
  "consents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    subjectId: text("subject_id").notNull(),
    purpose: text("purpose").notNull(),
    consentTextVersion: text("consent_text_version").notNull(),
    action: text("action").notNull(),
    timestamp: integer("timestamp").notNull(),
    metadata: text("metadata"),
  },
  (t) => ({
    bySubject: index("consents_tenant_subject").on(t.tenantId, t.subjectId),
  }),
);

export const PURPOSES = ["voice_processing"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const ACTIONS = ["granted", "withdrawn"] as const;
export type Action = (typeof ACTIONS)[number];

export type Consent = typeof consents.$inferSelect;
export type NewConsent = typeof consents.$inferInsert;
