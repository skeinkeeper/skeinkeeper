// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

export const factionReputation = sqliteTable(
  "faction_reputation",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    faction: text("faction").notNull(),
    reputation: integer("reputation").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byFaction: uniqueIndex("faction_rep_campaign_faction").on(
      t.tenantId,
      t.campaignId,
      t.faction,
    ),
  }),
);

export type FactionReputation = typeof factionReputation.$inferSelect;
export type NewFactionReputation = typeof factionReputation.$inferInsert;
