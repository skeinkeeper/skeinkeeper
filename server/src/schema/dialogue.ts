// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sessions } from "./sessions";

/**
 * Persisted dialogue history — one row per turn of player/operator/AI
 * speech. Lets a session resume across restarts (the in-memory
 * Session.dialogue is hydrated from here) and gives the audit/replay
 * surfaces the actual transcript.
 *
 * `speaker` is a Discord user ID for player turns (PII at the app layer);
 * `text` is what was said (PII-adjacent). Both are covered by the
 * DialogueAdapter erasure path (player + campaign + tenant scopes).
 */
export const dialogue = sqliteTable(
  "dialogue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Discord user ID, "operator", "system", or "narrator". */
    speaker: text("speaker").notNull(),
    displayName: text("display_name"),
    text: text("text").notNull(),
    timestamp: integer("timestamp").notNull(),
  },
  (t) => ({
    bySession: index("dialogue_session").on(t.tenantId, t.sessionId, t.timestamp),
    bySpeaker: index("dialogue_speaker").on(t.tenantId, t.speaker),
  }),
);

export type DialogueRow = typeof dialogue.$inferSelect;
export type NewDialogueRow = typeof dialogue.$inferInsert;
