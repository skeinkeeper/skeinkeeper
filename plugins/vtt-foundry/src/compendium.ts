// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { FoundryClient, FoundrySearchHit } from "@skeinkeeper/orchestrator";

/**
 * Reads game-system content from the connected Foundry world's compendia via the
 * first-party add-on's `FoundryClient.searchCompendium` (ADR-0029 / TDD 0041 —
 * replaces the withdrawn OSS MCP bridge of TDD 0021's original design). The
 * system module is the ruleset (ADR-0012), so this pulls whatever the installed
 * system ships — monsters, spells, items — with no per-system code. Search-driven
 * (there is no enumerate-pack tool, and ADR-0002 forbids dumping cold content en
 * masse). The reader is unit-tested with a fake FoundryClient; the live search is
 * operator-validated.
 *
 * NOTE on text richness: the add-on's `searchCompendium` returns pack-index
 * fields (id/name/type/packId), so the embed text is name+type today. Ingesting
 * the full entry description needs an add-on `getCompendiumEntry(packId, id)`
 * method (`pack.getDocument`), tracked as a TDD 0021 follow-up.
 */
export interface CompendiumEntry {
  id: string;
  name: string;
  type: string;
  packId: string;
  /** Ready to embed (name + type today; + description once the add-on exposes it). */
  text: string;
}

function toEntry(hit: FoundrySearchHit): CompendiumEntry | null {
  const id = hit.id?.trim();
  const name = hit.name?.trim();
  if (!id || !name) return null;
  const type = hit.type?.trim() ?? "unknown";
  const text = [name, type !== "unknown" ? `(${type})` : ""]
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();
  return { id, name, type, packId: hit.packId ?? "", text };
}

export async function readCompendiumEntries(
  foundry: FoundryClient,
  opts: { queries: ReadonlyArray<string>; packType?: string },
): Promise<CompendiumEntry[]> {
  const byId = new Map<string, CompendiumEntry>();
  for (const query of opts.queries) {
    if (query.trim().length < 2) continue; // very short queries match too much
    const hits = await foundry.searchCompendium(
      query,
      opts.packType !== undefined ? { packType: opts.packType } : undefined,
    );
    for (const hit of hits) {
      const entry = toEntry(hit);
      if (entry !== null && !byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}
