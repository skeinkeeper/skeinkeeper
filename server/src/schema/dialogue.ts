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
 * `text` and `displayName` are what was said / who said it (PII / PII-adjacent).
 * All three are AEAD-encrypted at rest when a passphrase is set (ADR-0022 / TDD
 * 0030); `speaker_hash` is the salted-hash companion for key-free equality +
 * erasure (nullable pre-companion; backfilled by `pii:encrypt`). All are covered
 * by the DialogueAdapter erasure path (player + campaign + tenant scopes).
 *
 * `audience` + `conversationId` carry the 1:1 side-channel model (design doc
 * 0026, ADR-0017). Both default to "table", so existing rows and the
 * single-table flow are unchanged. A private side-channel turn is
 * `audience = "player:<hash>"` / `conversationId = "player:<hash>"` — the hash of
 * the player's Discord id, not the raw id (TDD 0030), so the routing token stops
 * carrying recoverable PII while equality still works. The DM's own secrets are
 * `audience = "gm"`. Player-audience rows are player-scoped erasable
 * (DialogueAdapter), beyond erasure by `speaker`.
 */
export const dialogue = sqliteTable(
  "dialogue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Discord user ID, "operator", "system", or "narrator" (AEAD when sealed). */
    speaker: text("speaker").notNull(),
    speakerHash: text("speaker_hash"),
    displayName: text("display_name"),
    text: text("text").notNull(),
    timestamp: integer("timestamp").notNull(),
    /** Who may see this turn: "table" | "gm" | "player:<hash>" (design doc 0026, TDD 0030). */
    audience: text("audience").notNull().default("table"),
    /** Which thread this turn belongs to: "table" | "player:<hash>". */
    conversationId: text("conversation_id").notNull().default("table"),
  },
  (t) => ({
    bySession: index("dialogue_session").on(t.tenantId, t.sessionId, t.timestamp),
    bySpeaker: index("dialogue_speaker").on(t.tenantId, t.speaker),
    bySpeakerHash: index("dialogue_speaker_hash").on(t.tenantId, t.speakerHash),
    byConversation: index("dialogue_conversation").on(
      t.tenantId,
      t.sessionId,
      t.conversationId,
      t.timestamp,
    ),
    byAudience: index("dialogue_audience").on(t.tenantId, t.audience),
  }),
);

export type DialogueRow = typeof dialogue.$inferSelect;
export type NewDialogueRow = typeof dialogue.$inferInsert;
