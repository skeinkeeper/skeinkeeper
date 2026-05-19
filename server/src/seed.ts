// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Db } from "./db.js";
import {
  tenants,
  campaigns,
  clocks,
  type NewCampaign,
  type NewClock,
  type NewTenant,
} from "./schema/index.js";

interface SeedFile {
  tenant: { id: string; name: string };
  campaigns?: ReadonlyArray<{
    id: string;
    name: string;
    rulesetId: string;
    behaviorSpecVersion: string;
    status?: "active" | "paused" | "archived";
    foundryWorldName?: string; // not stored; for operator reference only
    clocks?: ReadonlyArray<{
      id: string;
      name: string;
      description?: string;
      category?: string;
      segmentsTotal: number;
      segmentsFilled?: number;
      visibleToPlayers?: boolean;
    }>;
  }>;
}

/**
 * Idempotently seed from a YAML file. Inserts only rows that don't
 * already exist (matched by primary key).
 *
 * Per design doc 0007, mechanical state (characters, NPCs, locations)
 * lives in Foundry, not Skeinkeeper. The seed file therefore carries
 * only Skeinkeeper-owned state: the tenant, campaigns, and any starting
 * clocks the AI should be aware of.
 */
export function seedFromFile(db: Db, path: string): { inserted: number } {
  if (!existsSync(path)) {
    return { inserted: 0 };
  }
  const raw = readFileSync(path, "utf8");
  const file = parseYaml(raw) as SeedFile;
  if (!file?.tenant?.id) throw new Error(`${path}: missing tenant.id`);

  let inserted = 0;
  const now = Date.now();

  const existingTenant = db.select().from(tenants).all().find((t) => t.id === file.tenant.id);
  if (!existingTenant) {
    const newTenant: NewTenant = {
      id: file.tenant.id,
      name: file.tenant.name,
      createdAt: now,
    };
    db.insert(tenants).values(newTenant).run();
    inserted++;
  }

  for (const c of file.campaigns ?? []) {
    const existingCampaign = db.select().from(campaigns).all().find((x) => x.id === c.id);
    if (!existingCampaign) {
      const newCampaign: NewCampaign = {
        id: c.id,
        tenantId: file.tenant.id,
        name: c.name,
        rulesetId: c.rulesetId,
        behaviorSpecVersion: c.behaviorSpecVersion,
        status: c.status ?? "active",
        createdAt: now,
        updatedAt: now,
      };
      db.insert(campaigns).values(newCampaign).run();
      inserted++;
    }
    for (const clk of c.clocks ?? []) {
      const existingClock = db.select().from(clocks).all().find((x) => x.id === clk.id);
      if (!existingClock) {
        const newClock: NewClock = {
          id: clk.id,
          tenantId: file.tenant.id,
          campaignId: c.id,
          name: clk.name,
          ...(clk.description !== undefined ? { description: clk.description } : {}),
          ...(clk.category !== undefined ? { category: clk.category } : {}),
          segmentsTotal: clk.segmentsTotal,
          segmentsFilled: clk.segmentsFilled ?? 0,
          visibleToPlayers: clk.visibleToPlayers ?? true,
          createdAt: now,
          updatedAt: now,
        };
        db.insert(clocks).values(newClock).run();
        inserted++;
      }
    }
  }
  return { inserted };
}
