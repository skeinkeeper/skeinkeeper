// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

/**
 * Named NPCs. The three required attributes from behavior/default.md §3
 * (mannerism, motivation, secret) are first-class columns so the system
 * prompt assembler can surface them without parsing freeform text.
 */
export const npcs = sqliteTable(
  "npcs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    mannerism: text("mannerism"),
    motivation: text("motivation"),
    secret: text("secret"),
    voiceId: text("voice_id"),
    disposition: text("disposition").notNull().default("neutral"),
    alive: integer("alive", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byCampaign: index("npcs_campaign").on(t.tenantId, t.campaignId),
  }),
);

export const DISPOSITIONS = ["friendly", "neutral", "hostile"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export type Npc = typeof npcs.$inferSelect;
export type NewNpc = typeof npcs.$inferInsert;
