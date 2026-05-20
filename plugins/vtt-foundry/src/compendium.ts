// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { McpToolCaller } from "./mcp_tool_caller.js";
import { nonEmptyStr as str } from "./mcp_parse.js";

/**
 * Reads game-system content from the connected Foundry world's compendia via
 * the OSS bridge (design doc 0021). The system module is the ruleset
 * (ADR-0012), so this pulls whatever the installed system ships — monsters,
 * spells, items, rules journals — with no per-system code. Search-driven (the
 * bridge has no enumerate-pack tool, and ADR-0002 forbids dumping cold content
 * en masse). Parsing is unit-tested with FakeMcpToolCaller; the live search is
 * operator-validated.
 */
export interface CompendiumEntry {
  id: string;
  name: string;
  type: string;
  packId: string;
  packLabel?: string;
  system?: string;
  /** name + type + summary + description, ready to embed. */
  text: string;
}

interface SearchResultItem {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  pack?: { id?: unknown; label?: unknown };
  description?: unknown;
  summary?: unknown;
}
interface SearchResponse {
  results?: SearchResultItem[];
  gameSystem?: unknown;
}

function toEntry(item: SearchResultItem, system: string | undefined): CompendiumEntry | null {
  const id = str(item.id);
  const name = str(item.name);
  if (id === undefined || name === undefined) return null;
  const type = str(item.type) ?? "unknown";
  const summary = str(item.summary) ?? "";
  const description = str(item.description) ?? "";
  const text = [name, type !== "unknown" ? `(${type})` : "", summary, description]
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();
  const entry: CompendiumEntry = { id, name, type, packId: str(item.pack?.id) ?? "", text };
  const packLabel = str(item.pack?.label);
  if (packLabel !== undefined) entry.packLabel = packLabel;
  if (system !== undefined) entry.system = system;
  return entry;
}

export async function readCompendiumEntries(
  caller: McpToolCaller,
  opts: { queries: ReadonlyArray<string>; packType?: string },
): Promise<CompendiumEntry[]> {
  const byId = new Map<string, CompendiumEntry>();
  for (const query of opts.queries) {
    if (query.trim().length < 2) continue; // the bridge requires >= 2 chars
    const res = (await caller.callTool("search-compendium", {
      query,
      ...(opts.packType !== undefined ? { packType: opts.packType } : {}),
    })) as SearchResponse | null;
    const system = str(res?.gameSystem);
    for (const item of res?.results ?? []) {
      const entry = toEntry(item, system);
      if (entry !== null && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}
