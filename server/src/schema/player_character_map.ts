// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Player↔character identity mapping (design doc 0016). Links a Discord
 * user (the voice speaker) to a Foundry actor (their character) so the AI
 * can attribute actions to the right sheet. Created by the DM's session-
 * start intro ritual; correctable by the operator.
 *
 * `discordUserId` is PII at the app layer; covered by the
 * PlayerCharacterMapAdapter erasure path (player + tenant scopes).
 * Append-ish: a player remapping (character swap) writes a newer row;
 * current state is the most recent row per (tenant, campaign, player).
 */
export const playerCharacterMap = sqliteTable(
  "player_character_map",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    foundryActorId: text("foundry_actor_id").notNull(),
    displayName: text("display_name"),
    /** "player" (set via the intro ritual) or "operator" (override). */
    source: text("source").notNull(),
    confirmedAt: integer("confirmed_at").notNull(),
  },
  (t) => ({
    byPlayer: index("pcmap_tenant_campaign_player").on(
      t.tenantId,
      t.campaignId,
      t.discordUserId,
    ),
    bySubject: index("pcmap_tenant_player").on(t.tenantId, t.discordUserId),
  }),
);

export type PlayerCharacterMapRow = typeof playerCharacterMap.$inferSelect;
export type NewPlayerCharacterMapRow = typeof playerCharacterMap.$inferInsert;
