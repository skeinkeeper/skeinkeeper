// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { PII } from "@skeinkeeper/core";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * 3-way identity mapping (TDD 0036, superseding 0016). Links a Discord
 * user (the voice speaker) to a Foundry login and a Foundry actor so the
 * AI can attribute actions and route Foundry whispers. Created by the
 * session-start intro ritual; correctable by the operator.
 *
 * `discordUserId`, `foundryUserId`, and `displayName` are PII at the app
 * layer; covered by the PlayerCharacterMapAdapter erasure path (player +
 * tenant scopes). Per ADR-0022 / TDD 0030 they are AEAD-encrypted at rest
 * when a passphrase is set; `*_hash` companions are salted hashes for
 * key-free equality + erasure (nullable for pre-companion rows; backfilled
 * by `pii:encrypt`). `foundryUserId` is NULL-tolerant — pre-v0.5 rows and
 * unresolved host pre-flight bindings stay NULL. Append-ish: a player
 * remapping (character swap) writes a newer row; current state is the most
 * recent row per (tenant, campaign, player).
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
    discordUserIdHash: text("discord_user_id_hash"),
    foundryUserId: text("foundry_user_id"),
    foundryUserIdHash: text("foundry_user_id_hash"),
    foundryActorId: text("foundry_actor_id").notNull(),
    displayName: text("display_name"),
    /** "player" (set via the intro ritual) or "operator" (override). */
    source: text("source").notNull(),
    confirmedAt: integer("confirmed_at").notNull(),
  },
  (t) => ({
    byPlayer: index("pcmap_tenant_campaign_player").on(t.tenantId, t.campaignId, t.discordUserId),
    bySubject: index("pcmap_tenant_player").on(t.tenantId, t.discordUserId),
    byPlayerHash: index("pcmap_tenant_campaign_player_hash").on(
      t.tenantId,
      t.campaignId,
      t.discordUserIdHash,
    ),
    bySubjectHash: index("pcmap_tenant_player_hash").on(t.tenantId, t.discordUserIdHash),
    byFoundryUser: index("idx_pcm_tenant_campaign_foundry_user").on(
      t.tenantId,
      t.campaignId,
      t.foundryUserId,
    ),
    byFoundryUserHash: index("idx_pcm_tenant_campaign_foundry_user_hash").on(
      t.tenantId,
      t.campaignId,
      t.foundryUserIdHash,
    ),
  }),
);

export type PlayerCharacterMapRow = typeof playerCharacterMap.$inferSelect;
export type NewPlayerCharacterMapRow = typeof playerCharacterMap.$inferInsert;

/** App-layer PII brands for the 3-way map (ADR-0010 / TDD 0036). */
export type PlayerCharacterMapPii = {
  discordUserId: PII<string>;
  foundryUserId: PII<string> | null;
  displayName: PII<string> | null;
};
