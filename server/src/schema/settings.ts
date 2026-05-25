// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Per-campaign operator-settable configuration (design doc 0024). A free-form
 * key/value store mirroring `quest_flags`, but for *operator* config rather
 * than AI-DM plot state — e.g., `operator.discord_user_id`, the resolved
 * snowflake of the human the AI DMs for setup escalations.
 *
 * `value` may hold PII at the application layer (the operator's own Discord
 * user ID): AEAD-encrypted at rest when a passphrase is set (TDD 0030). Erased
 * by FK cascade when the campaign is deleted — the same path as quest_flags,
 * covering both campaign- and tenant-scope erasure via the CampaignAdapter (no
 * separate deletion adapter). See docs/PRIVACY.md.
 */
export const settings = sqliteTable(
  "settings",
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
    byKey: uniqueIndex("settings_campaign_key").on(t.tenantId, t.campaignId, t.key),
  }),
);

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
