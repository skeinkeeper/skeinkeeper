// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Segmented progress bars. PbtA games use these heavily (harm clocks,
 * faction clocks, countdown clocks, mystery clocks); D&D and other
 * systems use them for travel timers, faction progress, and dramatic
 * countdowns. System-agnostic core primitive.
 *
 * Per design doc 0007, mechanical state (HP, conditions, sheet fields)
 * lives in Foundry. Clocks live here because (a) they're not universal
 * Foundry primitives and (b) the AI DM frequently creates/manipulates
 * them in response to fictional triggers.
 */
export const clocks = sqliteTable(
  "clocks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"), // free-form: "harm" | "countdown" | "faction" | "mystery" | "progress" | etc.
    segmentsFilled: integer("segments_filled").notNull().default(0),
    segmentsTotal: integer("segments_total").notNull(),
    visibleToPlayers: integer("visible_to_players", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byCampaign: index("clocks_campaign").on(t.tenantId, t.campaignId),
  }),
);

export type Clock = typeof clocks.$inferSelect;
export type NewClock = typeof clocks.$inferInsert;
