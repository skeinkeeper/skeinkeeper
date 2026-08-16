// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryClient } from "../foundry/client.js";
import { isStarterSceneName } from "../intake/foundry_reads.js";
import type {
  CreatureCriteria,
  SearchQuery,
  WorldContentReader,
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldSceneEntry,
} from "./world-types.js";

/** WorldContentReader over FoundryClient when no MCP caller is in hand. */
export function foundryWorldContentReader(
  foundry: FoundryClient,
  partyActorIds: ReadonlyArray<string> = [],
): WorldContentReader {
  return {
    readJournals: (q?: SearchQuery) => readJournals(foundry, q),
    readScenes: () => readScenes(foundry),
    readCreatures: (q?: CreatureCriteria) => readCreatures(foundry, q),
    readActorItems: (ids) => readItems(foundry, ids.length > 0 ? ids : partyActorIds),
  };
}

async function readJournals(foundry: FoundryClient, q?: SearchQuery): Promise<WorldJournalEntry[]> {
  const query = q?.query?.trim() || "the";
  const hits = await foundry.searchJournals(query);
  return hits.map((h) => ({ id: h.id, name: h.name, text: h.name }));
}

async function readScenes(foundry: FoundryClient): Promise<WorldSceneEntry[]> {
  const scenes = await foundry.listScenes();
  return scenes.map((s) => ({
    id: s.id,
    name: s.name,
    active: s.active,
    ...(isStarterSceneName(s.name) ? { tags: ["start"] } : {}),
  }));
}

async function readCreatures(
  foundry: FoundryClient,
  q?: CreatureCriteria,
): Promise<WorldCreatureEntry[]> {
  const list = await foundry.listCreaturesByCriteria({
    ...(q?.name !== undefined ? { name: q.name } : {}),
    ...(q?.type !== undefined ? { type: q.type } : {}),
  });
  return list.map((c) => ({
    id: c.id,
    name: c.name,
    text: c.name,
    ...(c.type !== undefined ? { type: c.type } : {}),
  }));
}

async function readItems(
  foundry: FoundryClient,
  actorIds: ReadonlyArray<string>,
): Promise<WorldItemEntry[]> {
  const out: WorldItemEntry[] = [];
  for (const id of actorIds) {
    const actor = await foundry.getActor(id);
    if (!actor) continue;
    const raw = actor.sheet["items"];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const itemId =
        typeof rec["id"] === "string"
          ? rec["id"]
          : typeof rec["_id"] === "string"
            ? rec["_id"]
            : undefined;
      const name = typeof rec["name"] === "string" ? rec["name"] : undefined;
      if (itemId === undefined || name === undefined) continue;
      const type = typeof rec["type"] === "string" ? rec["type"] : undefined;
      out.push({
        id: itemId,
        name,
        actorId: id,
        text: name,
        ...(type !== undefined ? { type } : {}),
      });
    }
  }
  return out;
}
