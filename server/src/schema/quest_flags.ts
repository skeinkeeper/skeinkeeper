// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Free-form per-campaign flag store. Keys are dotted strings
 * (e.g., "phandelver.cragmaw.cleared"); values are stringified
 * scalars (the orchestrator parses to bool/number on read).
 */
export const questFlags = sqliteTable(
  "quest_flags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byKey: uniqueIndex("quest_flags_campaign_key").on(t.tenantId, t.campaignId, t.key),
  }),
);

export type QuestFlag = typeof questFlags.$inferSelect;
export type NewQuestFlag = typeof questFlags.$inferInsert;
