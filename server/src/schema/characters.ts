// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Player characters. `playerDiscordId` carries PII. Ruleset-specific
 * mechanical state (class, abilities, slots, inventory, conditions)
 * lives in `rulesetDataJson` as a flexible blob until a second ruleset
 * exists and the per-system normalization decision becomes worthwhile.
 */
export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    playerDiscordId: text("player_discord_id").notNull(), // PII
    hp: integer("hp").notNull(),
    maxHp: integer("max_hp").notNull(),
    rulesetDataJson: text("ruleset_data_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byCampaign: index("characters_campaign").on(t.tenantId, t.campaignId),
    byPlayer: index("characters_player").on(t.tenantId, t.playerDiscordId),
  }),
);

export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
