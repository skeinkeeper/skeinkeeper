// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import type { FoundryClient } from "../foundry/client.js";
import type { MemoryStore } from "../memory/store.js";
import {
  classifyAmbiguities,
  classifyCriticalGaps,
  classifyRecommendations,
  type ExtendedClassifyInput,
  type MappedContentGap,
} from "./classify.js";
import {
  actorToSummary,
  readModuleSummaries,
  readOwnershipMap,
  readPackSummaries,
  readPartyActorSummaries,
  readSceneSummaries,
  readWorldInfo,
} from "./foundry_reads.js";
import type {
  ExtendedIntakeResult,
  IntakeContext,
  MinimumIntakeResult,
  PackSummary,
  WarmStateSummary,
} from "./types.js";

export async function runMinimumIntake(
  ctx: IntakeContext,
  foundry: FoundryClient,
  _memory: MemoryStore,
  tenantDb: TenantDb,
): Promise<MinimumIntakeResult> {
  const world = await readWorldInfo(foundry);
  if (!world.connected) {
    return {
      system: null,
      partyActorCandidates: [],
      criticalFindings: classifyCriticalGaps(
        { system: null, partyActorCandidates: [], connected: false },
        ctx,
      ),
    };
  }

  const partyActorCandidates = await readPartyActorSummaries(foundry);
  const modules = await readModuleSummaries(foundry);
  const mappedContent = await collectMappedContent(
    ctx,
    foundry,
    tenantDb,
    modules.map((m) => m.id),
  );

  return {
    system: world.system,
    partyActorCandidates,
    criticalFindings: classifyCriticalGaps(
      {
        system: world.system,
        partyActorCandidates,
        connected: true,
        mappedContent,
      },
      ctx,
    ),
  };
}

export async function runExtendedIntake(
  ctx: IntakeContext,
  foundry: FoundryClient,
  _memory: MemoryStore,
  _minimum: MinimumIntakeResult,
  tenantDb: TenantDb,
): Promise<ExtendedIntakeResult> {
  const loadedModules = await readModuleSummaries(foundry);
  const compendiumPacks = await readPackSummaries(foundry);
  const existingScenes = await readSceneSummaries(foundry);
  const currentOwnershipMap = await readOwnershipMap(foundry);
  const users = await foundry.listUsers();
  const warmStateSummary = readWarmState(tenantDb, ctx.campaignId);

  const creatures = await foundry.listCreaturesByCriteria({});
  const creatureSources: Record<string, PackSummary[]> = {};
  for (const c of creatures) {
    const list = creatureSources[c.name] ?? [];
    if (!list.some((p) => p.id === c.packId)) {
      const pack = compendiumPacks.find((p) => p.id === c.packId);
      list.push(pack ?? { id: c.packId, label: c.packId });
    }
    creatureSources[c.name] = list;
  }

  const raceSources: Record<string, PackSummary[]> = {};
  const party = await readPartyActorSummaries(foundry);
  const mapped = tenantDb.playerCharacterMap.listByCampaign(ctx.campaignId);
  const races = new Set<string>();
  for (const a of party) if (a.race !== undefined) races.add(a.race);
  for (const row of mapped) {
    const actor = await foundry.getActor(row.foundryActorId);
    if (actor) {
      const race = actorToSummary(actor).race;
      if (race !== undefined) races.add(race);
    }
  }
  for (const race of races) {
    const hits = await foundry.searchCompendium(race);
    raceSources[race] = uniquePacks(
      hits.map((h) => ({ id: h.packId ?? h.id, label: h.packId ?? h.name })),
    );
  }

  const input: ExtendedClassifyInput = {
    loadedModules,
    compendiumPacks,
    existingScenes,
    currentOwnershipMap,
    warmStateSummary,
    findings: [],
    creatureSources,
    raceSources,
    usersAvailable: users.length > 0,
  };

  const sceneCriticals = classifyCriticalGaps(
    {
      system: _minimum.system,
      partyActorCandidates: _minimum.partyActorCandidates,
      connected: true,
      scenes: existingScenes,
    },
    ctx,
  ).filter((f) => f.code === "NO_STARTING_SCENE");

  const findings = [
    ...sceneCriticals,
    ...classifyAmbiguities(input, ctx),
    ...classifyRecommendations(input, ctx),
  ];

  return {
    loadedModules,
    compendiumPacks,
    existingScenes,
    currentOwnershipMap,
    warmStateSummary,
    findings,
  };
}

async function collectMappedContent(
  ctx: IntakeContext,
  foundry: FoundryClient,
  tenantDb: TenantDb,
  loadedModuleIds: ReadonlyArray<string>,
): Promise<MappedContentGap[]> {
  const rows = tenantDb.playerCharacterMap.listByCampaign(ctx.campaignId);
  const out: MappedContentGap[] = [];
  for (const row of rows) {
    const actor = await foundry.getActor(row.foundryActorId);
    if (!actor) continue;
    const summary = actorToSummary(actor);
    const raceHits = summary.race !== undefined ? await foundry.searchCompendium(summary.race) : [];
    const classHits =
      summary.class !== undefined ? await foundry.searchCompendium(summary.class) : [];
    const gap: MappedContentGap = {
      actorId: actor.id,
      loadedModuleIds: [...loadedModuleIds],
      raceSourceCount: raceHits.length,
      classSourceCount: classHits.length,
    };
    if (summary.race !== undefined) gap.race = summary.race;
    if (summary.class !== undefined) gap.class = summary.class;
    out.push(gap);
  }
  return out;
}

function readWarmState(tenantDb: TenantDb, campaignId: string): WarmStateSummary {
  const sessions = tenantDb.sessions.listByCampaign(campaignId);
  const flags = tenantDb.questFlags.listByCampaign(campaignId);
  const mapped = tenantDb.playerCharacterMap.listByCampaign(campaignId);
  const uniquePlayers = new Set(mapped.map((r) => r.discordUserId));
  return {
    priorSessionCount: sessions.length,
    questFlagCount: flags.length,
    consentedPlayerCount: 0,
    mappedPlayerCount: uniquePlayers.size,
  };
}

function uniquePacks(packs: PackSummary[]): PackSummary[] {
  const seen = new Set<string>();
  const out: PackSummary[] = [];
  for (const p of packs) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
