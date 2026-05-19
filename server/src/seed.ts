// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Db } from "./db.js";
import {
  tenants,
  campaigns,
  characters,
  type NewCampaign,
  type NewCharacter,
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
    characters?: ReadonlyArray<{
      id: string;
      name: string;
      playerDiscordId: string;
      hp: number;
      maxHp: number;
    }>;
  }>;
}

/**
 * Idempotently seed from a YAML file. Inserts only rows that don't
 * already exist (matched by primary key).
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
    const existing = db.select().from(campaigns).all().find((x) => x.id === c.id);
    if (!existing) {
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
    for (const ch of c.characters ?? []) {
      const existing = db.select().from(characters).all().find((x) => x.id === ch.id);
      if (!existing) {
        const newCharacter: NewCharacter = {
          id: ch.id,
          tenantId: file.tenant.id,
          campaignId: c.id,
          name: ch.name,
          playerDiscordId: ch.playerDiscordId,
          hp: ch.hp,
          maxHp: ch.maxHp,
          rulesetDataJson: "{}",
          createdAt: now,
          updatedAt: now,
        };
        db.insert(characters).values(newCharacter).run();
        inserted++;
      }
    }
  }
  return { inserted };
}
