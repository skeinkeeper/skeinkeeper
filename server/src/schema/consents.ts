// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

/**
 * Per-player consent records. One row per (subject, purpose, action) event:
 * granting consent writes a row, withdrawing writes another. The current
 * state for a (subject, purpose) is the most recent row.
 *
 * `subject_id` is a Discord user ID and is PII at the application layer.
 * Per ADR-0022 / TDD 0030 it is AEAD-encrypted at rest when a passphrase is set;
 * `subject_id_hash` is its salted-hash companion (HMAC over the per-install salt)
 * so equality lookup and per-subject erasure stay key-free. The hash is set on
 * every write and backfilled by `pii:encrypt`; it is nullable for rows written
 * before the companion existed.
 */
export const consents = sqliteTable(
  "consents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    subjectId: text("subject_id").notNull(),
    subjectIdHash: text("subject_id_hash"),
    purpose: text("purpose").notNull(),
    consentTextVersion: text("consent_text_version").notNull(),
    action: text("action").notNull(),
    timestamp: integer("timestamp").notNull(),
    metadata: text("metadata"),
  },
  (t) => ({
    bySubject: index("consents_tenant_subject").on(t.tenantId, t.subjectId),
    bySubjectHash: index("consents_tenant_subject_hash").on(t.tenantId, t.subjectIdHash),
  }),
);

export const PURPOSES = ["voice_processing"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const ACTIONS = ["granted", "withdrawn"] as const;
export type Action = (typeof ACTIONS)[number];

export type Consent = typeof consents.$inferSelect;
export type NewConsent = typeof consents.$inferInsert;
