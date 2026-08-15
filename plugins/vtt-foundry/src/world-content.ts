// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type {
  CreatureCriteria,
  SearchQuery,
  WorldContentReader,
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldJournalPage,
  WorldSceneEntry,
} from "@skeinkeeper/orchestrator";
import type { McpToolCaller } from "./mcp_tool_caller.js";
import { asRecord, nonEmptyStr as str, toArray } from "./mcp_parse.js";

export type {
  CreatureCriteria,
  SearchQuery,
  WorldCreatureEntry,
  WorldItemEntry,
  WorldJournalEntry,
  WorldSceneEntry,
};

function modifiedAt(rec: Record<string, unknown>): string | undefined {
  return (
    str(rec["_modifiedAt"]) ??
    str(rec["modifiedAt"]) ??
    str(rec["lastModified"]) ??
    str(rec["_stats"] && asRecord(rec["_stats"])?.["modifiedTime"])
  );
}

function tagsOf(rec: Record<string, unknown>): string[] | undefined {
  const raw = rec["tags"];
  if (!Array.isArray(raw)) return undefined;
  const tags = raw.filter((t): t is string => typeof t === "string" && t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

function parseJournal(item: unknown): WorldJournalEntry | null {
  const rec = asRecord(item);
  if (!rec) return null;
  const id = str(rec["id"]) ?? str(rec["_id"]);
  const name = str(rec["name"]);
  if (id === undefined || name === undefined) return null;
  const body = str(rec["text"]) ?? str(rec["content"]) ?? str(rec["description"]) ?? "";
  const pagesRaw = toArray(rec["pages"], []);
  const pages: WorldJournalPage[] = [];
  for (const p of pagesRaw) {
    const pr = asRecord(p);
    if (!pr) continue;
    const pname = str(pr["name"]);
    if (pname === undefined) continue;
    const page: WorldJournalPage = { name: pname };
    const ptext = str(pr["text"]) ?? str(pr["content"]);
    if (ptext !== undefined) page.text = ptext;
    const flags = asRecord(pr["flags"]);
    if (flags) page.flags = flags;
    pages.push(page);
  }
  const pageText = pages
    .map((p) => p.text ?? "")
    .filter((t) => t.length > 0)
    .join("\n");
  const text = [body, pageText].filter((t) => t.length > 0).join("\n");
  const entry: WorldJournalEntry = { id, name, text };
  const folder = str(rec["folder"]);
  if (folder !== undefined) entry.folder = folder;
  const mod = modifiedAt(rec);
  if (mod !== undefined) entry.modifiedAt = mod;
  if (pages.length > 0) entry.pages = pages;
  return entry;
}

export async function readWorldJournals(
  caller: McpToolCaller,
  q?: SearchQuery,
): Promise<WorldJournalEntry[]> {
  const byId = new Map<string, WorldJournalEntry>();
  const listed = await caller.callTool("list-journals", {});
  for (const item of toArray(listed, ["journals", "results", "data"])) {
    const entry = parseJournal(item);
    if (entry !== null && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const query = q?.query?.trim();
  if (query !== undefined && query.length >= 2) {
    const searched = await caller.callTool("search-journals", { query });
    for (const item of toArray(searched, ["results", "journals", "data"])) {
      const entry = parseJournal(item);
      if (entry !== null && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}

export async function readWorldScenes(caller: McpToolCaller): Promise<WorldSceneEntry[]> {
  const res = await caller.callTool("list-scenes", {});
  const out: WorldSceneEntry[] = [];
  for (const item of toArray(res, ["scenes", "data", "results"])) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = str(rec["id"]) ?? str(rec["_id"]);
    const name = str(rec["name"]);
    if (id === undefined || name === undefined) continue;
    const entry: WorldSceneEntry = { id, name, active: rec["active"] === true };
    const folder = str(rec["folder"]);
    if (folder !== undefined) entry.folder = folder;
    const tags = tagsOf(rec);
    if (tags !== undefined) entry.tags = tags;
    const flags = asRecord(rec["flags"]);
    if (flags) entry.flags = flags;
    const mod = modifiedAt(rec);
    if (mod !== undefined) entry.modifiedAt = mod;
    out.push(entry);
  }
  return out;
}

export async function readWorldCreatures(
  caller: McpToolCaller,
  q?: CreatureCriteria,
): Promise<WorldCreatureEntry[]> {
  const res = await caller.callTool("list-creatures-by-criteria", {
    ...(q?.name !== undefined ? { name: q.name } : {}),
    ...(q?.type !== undefined ? { type: q.type } : {}),
  });
  const out: WorldCreatureEntry[] = [];
  for (const item of toArray(res, ["creatures", "results", "data"])) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = str(rec["id"]) ?? str(rec["_id"]);
    const name = str(rec["name"]);
    if (id === undefined || name === undefined) continue;
    const type = str(rec["type"]);
    const desc = str(rec["description"]) ?? str(rec["text"]) ?? "";
    const text = [name, type !== undefined ? `(${type})` : "", desc]
      .filter((s) => s.length > 0)
      .join("\n")
      .trim();
    const entry: WorldCreatureEntry = { id, name, text };
    if (type !== undefined) entry.type = type;
    const folder = str(rec["folder"]);
    if (folder !== undefined) entry.folder = folder;
    const tags = tagsOf(rec);
    if (tags !== undefined) entry.tags = tags;
    const mod = modifiedAt(rec);
    if (mod !== undefined) entry.modifiedAt = mod;
    out.push(entry);
  }
  return out;
}

function parseItems(res: unknown, actorId: string): WorldItemEntry[] {
  const rec = asRecord(res);
  const actor =
    asRecord(rec?.["character"]) ?? asRecord(rec?.["actor"]) ?? asRecord(rec?.["data"]) ?? rec;
  if (!actor) return [];
  const out: WorldItemEntry[] = [];
  for (const item of toArray(actor["items"], [])) {
    const ir = asRecord(item);
    if (!ir) continue;
    const id = str(ir["id"]) ?? str(ir["_id"]);
    const name = str(ir["name"]);
    if (id === undefined || name === undefined) continue;
    const type = str(ir["type"]);
    const sys = asRecord(ir["system"]);
    const desc =
      str(ir["description"]) ??
      str(ir["text"]) ??
      (typeof sys?.["description"] === "string" ? sys["description"] : undefined) ??
      "";
    const text = [name, type !== undefined ? `(${type})` : "", desc]
      .filter((s) => s.length > 0)
      .join("\n")
      .trim();
    const entry: WorldItemEntry = { id, name, actorId, text };
    if (type !== undefined) entry.type = type;
    const mod = modifiedAt(ir);
    if (mod !== undefined) entry.modifiedAt = mod;
    out.push(entry);
  }
  return out;
}

export async function readWorldActorItems(
  caller: McpToolCaller,
  actorIds: string[],
): Promise<WorldItemEntry[]> {
  const out: WorldItemEntry[] = [];
  for (const actorId of actorIds) {
    try {
      const res = await caller.callTool("get-character-entity", { id: actorId });
      out.push(...parseItems(res, actorId));
    } catch {
      // Per-actor isolation — a missing sheet does not abort the batch.
    }
  }
  return out;
}

export function mcpWorldContentReader(caller: McpToolCaller): WorldContentReader {
  return {
    readJournals: (q) => readWorldJournals(caller, q),
    readScenes: () => readWorldScenes(caller),
    readCreatures: (q) => readWorldCreatures(caller, q),
    readActorItems: (ids) => readWorldActorItems(caller, [...ids]),
  };
}
