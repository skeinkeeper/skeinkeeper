// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Per-campaign TTS voice assignments (design doc 0017). One row per
 * subject: the DM (subjectKind "dm", subjectKey "dm", carrying the chosen
 * curated persona) and each NPC (subjectKind "npc", subjectKey = the NPC's
 * stable key). Not PII — persona choices, NPC keys, and opaque provider
 * voice IDs. Erasure is by campaign FK cascade (handled by CampaignAdapter);
 * no dedicated erasure adapter.
 */
export const voiceAssignments = sqliteTable(
  "voice_assignment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    subjectKind: text("subject_kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    providerVoiceId: text("provider_voice_id").notNull(),
    personaId: text("persona_id"),
    source: text("source").notNull(),
    assignedAt: integer("assigned_at").notNull(),
  },
  (t) => ({
    bySubject: uniqueIndex("voice_assignment_subject").on(
      t.tenantId,
      t.campaignId,
      t.subjectKind,
      t.subjectKey,
    ),
  }),
);

export type VoiceAssignmentRow = typeof voiceAssignments.$inferSelect;
export type NewVoiceAssignmentRow = typeof voiceAssignments.$inferInsert;
