// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryActor, FoundryClient, FoundrySearchHit } from "../foundry/client.js";
import {
  extractBackgroundFromSheet,
  extractClassFromSheet,
  extractRaceFromSheet,
} from "../intake/foundry_reads.js";
import type { ExtendedIntakeResult } from "../intake/types.js";

export interface PreloadReport {
  created: number;
  deferred: number;
  errors: Array<{ entry: string; error: string }>;
}

const ACTOR_TYPES = new Set(["npc", "character", "actor", "monster"]);

export async function preloadExpectedContent(
  foundry: FoundryClient,
  _intake: ExtendedIntakeResult,
  ctx: {
    campaignId: string;
    onTelemetry?: (name: string, props?: Record<string, unknown>) => void;
  },
): Promise<PreloadReport> {
  const report: PreloadReport = { created: 0, deferred: 0, errors: [] };
  const party = await foundry.listPartyActors();
  const needed = new Map<string, string>();
  for (const actor of party) {
    const race = extractRaceFromSheet(actor.sheet);
    const klass = extractClassFromSheet(actor.sheet);
    const background = extractBackgroundFromSheet(actor.sheet);
    if (race !== undefined) needed.set(race.toLowerCase(), race);
    if (klass !== undefined) needed.set(klass.toLowerCase(), klass);
    if (background !== undefined) needed.set(background.toLowerCase(), background);
  }

  const world = [...(await foundry.listWorldActors())];
  for (const name of needed.values()) {
    let hits: ReadonlyArray<FoundrySearchHit> = [];
    try {
      hits = await foundry.searchCompendium(name);
    } catch (err) {
      report.errors.push({
        entry: name,
        error: err instanceof Error ? err.message : String(err),
      });
      report.deferred += 1;
      continue;
    }
    const actorHits = hits.filter(
      (h) =>
        h.name.toLowerCase() === name.toLowerCase() &&
        (h.type === undefined || ACTOR_TYPES.has(h.type.toLowerCase())),
    );
    if (actorHits.length === 0) {
      report.deferred += 1;
      continue;
    }
    for (const hit of actorHits) {
      const packId = hit.packId ?? "";
      if (alreadyImported(world, hit.name, packId, hit.id)) continue;
      try {
        const created = await foundry.createActorFromCompendium({ packId, itemId: hit.id });
        world.push(created);
        report.created += 1;
      } catch (err) {
        report.errors.push({
          entry: hit.name,
          error: err instanceof Error ? err.message : String(err),
        });
        report.deferred += 1;
      }
    }
  }

  if (report.created > 0) {
    ctx.onTelemetry?.("autosetup.preload.created", {
      campaignId: ctx.campaignId,
      source: "compendium",
      count: report.created,
    });
  }
  if (report.deferred > 0) {
    ctx.onTelemetry?.("autosetup.preload.deferred", {
      campaignId: ctx.campaignId,
      count: report.deferred,
    });
  }
  return report;
}

function alreadyImported(
  world: ReadonlyArray<FoundryActor>,
  name: string,
  packId: string,
  itemId: string,
): boolean {
  const sourceId = `Compendium.${packId}.${itemId}`;
  return world.some((a) => {
    if (a.name.toLowerCase() !== name.toLowerCase()) return false;
    return actorSourceId(a) === sourceId;
  });
}

function actorSourceId(actor: FoundryActor): string | undefined {
  const flags = actor.flags;
  if (flags === undefined) return undefined;
  const core = flags["core"];
  if (core !== null && typeof core === "object" && !Array.isArray(core)) {
    const sid = (core as Record<string, unknown>)["sourceId"];
    if (typeof sid === "string") return sid;
  }
  const direct = flags["compendiumSource"];
  return typeof direct === "string" ? direct : undefined;
}
