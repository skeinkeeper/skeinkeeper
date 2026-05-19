// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { campaigns } from "./campaigns";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    behaviorSpecVersion: text("behavior_spec_version").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    summaryJson: text("summary_json"),
  },
  (t) => ({
    byCampaign: index("sessions_campaign").on(t.tenantId, t.campaignId),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
