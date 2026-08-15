// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  FoundryActor,
  FoundryClient,
  FoundryCreatureRef,
  FoundrySearchHit,
  FoundryWorldInfo,
} from "../foundry/client.js";
import type {
  ActorId,
  ActorSummary,
  FoundryUserId,
  ModuleSummary,
  PackSummary,
  SceneSummary,
} from "./types.js";

/** Scene-name starter convention used by TDD 0032's chooseInitialScene. */
export function isStarterSceneName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("start") || n.includes("intro");
}

const KNOWN_SYSTEM_IDS = new Set([
  "dnd5e",
  "pf2e",
  "fate-core",
  "dungeon-world",
  "wfrp4e",
  "coc7",
  "gurps",
  "savage-worlds",
  "blades-in-the-dark",
  "starfinder",
  "sf2e",
  "sw5e",
  "dcc",
  "thirteenth-age",
]);

const KNOWN_CAMPAIGN_MODULE_RE =
  /lmop|phandelver|lost.?mine|ravenloft|strahd|dragon.?heist|witchlight|tomb.?of.?annihilation|curse.?of.?strahd|storm.?king|descent.?into.?avernus|wildemount|eberron|theros|strixhaven|multiverse/i;

export function isKnownFoundrySystem(systemId: string): boolean {
  return KNOWN_SYSTEM_IDS.has(systemId);
}

export function classifyModuleKind(
  id: string,
  title: string,
  hinted?: ModuleSummary["kind"],
): ModuleSummary["kind"] {
  if (hinted !== undefined) return hinted;
  if (KNOWN_SYSTEM_IDS.has(id) || /^(dnd5e|pf2e|fate|dungeon-world)/i.test(id)) return "system";
  if (KNOWN_CAMPAIGN_MODULE_RE.test(id) || KNOWN_CAMPAIGN_MODULE_RE.test(title)) return "campaign";
  if (/\badventure\b/i.test(title) || /\badventure\b/i.test(id)) return "campaign";
  return "utility";
}

export function extractRaceFromSheet(sheet: Readonly<Record<string, unknown>>): string | undefined {
  const details = asRecord(sheet["details"]);
  const race = details?.["race"] ?? sheet["race"];
  return namedValue(race);
}

export function extractBackgroundFromSheet(
  sheet: Readonly<Record<string, unknown>>,
): string | undefined {
  const details = asRecord(sheet["details"]);
  return namedValue(details?.["background"] ?? sheet["background"]);
}

export function extractClassFromSheet(
  sheet: Readonly<Record<string, unknown>>,
): string | undefined {
  const details = asRecord(sheet["details"]);
  const fromDetails = namedValue(details?.["class"]);
  if (fromDetails !== undefined) return fromDetails;
  const classes = asRecord(sheet["classes"]);
  if (classes !== null) {
    const keys = Object.keys(classes);
    if (keys[0] !== undefined) return titleCase(keys[0]);
  }
  return namedValue(sheet["class"]);
}

export function actorToSummary(actor: FoundryActor): ActorSummary {
  const race = extractRaceFromSheet(actor.sheet);
  const klass = extractClassFromSheet(actor.sheet);
  const summary: ActorSummary = { id: actor.id, name: actor.name, type: actor.type };
  if (race !== undefined) summary.race = race;
  if (klass !== undefined) summary.class = klass;
  return summary;
}

export async function readWorldInfo(foundry: FoundryClient): Promise<FoundryWorldInfo> {
  try {
    return await foundry.getWorldInfo();
  } catch {
    return { connected: false, system: null, modules: [] };
  }
}

export async function readPartyActorSummaries(foundry: FoundryClient): Promise<ActorSummary[]> {
  const actors = await foundry.listPartyActors();
  return actors.map(actorToSummary);
}

export async function readSceneSummaries(foundry: FoundryClient): Promise<SceneSummary[]> {
  const scenes = await foundry.listScenes();
  return scenes.map((s) => ({
    id: s.id,
    name: s.name,
    active: s.active,
    isStarter: isStarterSceneName(s.name),
  }));
}

export async function readModuleSummaries(foundry: FoundryClient): Promise<ModuleSummary[]> {
  const world = await readWorldInfo(foundry);
  return world.modules
    .filter((m) => m.active !== false)
    .map((m) => ({
      id: m.id,
      title: m.title,
      kind: classifyModuleKind(m.id, m.title, m.kind),
    }));
}

export async function readPackSummaries(foundry: FoundryClient): Promise<PackSummary[]> {
  const packs = await foundry.listCompendiumPacks();
  return packs.map((p) => {
    const pack: PackSummary = { id: p.id, label: p.label };
    if (p.type !== undefined) pack.type = p.type;
    return pack;
  });
}

export async function readOwnershipMap(
  foundry: FoundryClient,
): Promise<Record<ActorId, FoundryUserId>> {
  const users = await foundry.listUsers();
  const map: Record<ActorId, FoundryUserId> = {};
  for (const user of users) {
    for (const actorId of user.ownedActorIds ?? []) {
      map[actorId] = user.id;
    }
  }
  return map;
}

export async function searchCreaturesByName(
  foundry: FoundryClient,
  name: string,
): Promise<ReadonlyArray<FoundryCreatureRef>> {
  return foundry.listCreaturesByCriteria({ name });
}

export async function searchCompendiumHits(
  foundry: FoundryClient,
  query: string,
  opts?: { packType?: string },
): Promise<ReadonlyArray<FoundrySearchHit>> {
  return foundry.searchCompendium(query, opts);
}

export async function searchJournalHits(
  foundry: FoundryClient,
  query: string,
): Promise<ReadonlyArray<FoundrySearchHit>> {
  return foundry.searchJournals(query);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function namedValue(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  const rec = asRecord(v);
  if (rec === null) return undefined;
  const name = rec["name"] ?? rec["value"] ?? rec["label"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

function titleCase(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}
