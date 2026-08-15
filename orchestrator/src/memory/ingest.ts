// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { EmbeddingProvider } from "../interfaces/embedding.js";
import type { MemoryRecord, MemoryStore } from "./store.js";

/**
 * Generic cold-tier ingestion (design doc 0019 §6, 0021): embed a batch of
 * text entries and upsert them as `cold` MemoryRecords. Reused for both
 * Foundry compendium content (0021) and operator-imported lore. Deterministic
 * record ids (`cold-<id>`) so re-ingesting updates rather than duplicates.
 */
export interface ColdEntry {
  /** Stable source id (e.g., a compendium item id). */
  id: string;
  text: string;
  /** Structured fields preserved alongside the prose (pack, type, system, …). */
  deltas?: Record<string, unknown>;
  source?: MemoryRecord["metadata"]["source"];
  foundry_id?: string;
  last_modified?: string;
  location?: string;
  quest?: string;
  keywords?: string[];
}

export async function ingestColdEntries(
  embed: EmbeddingProvider,
  store: MemoryStore,
  args: { campaignId: string; entries: ReadonlyArray<ColdEntry>; batchSize?: number },
): Promise<number> {
  const usable = args.entries.filter((e) => e.text.trim().length > 0);
  if (usable.length === 0) return 0;

  const batchSize = args.batchSize ?? 64;
  const now = Date.now();
  let count = 0;

  for (let i = 0; i < usable.length; i += batchSize) {
    const batch = usable.slice(i, i + batchSize);
    const vectors = await embed.embed(batch.map((e) => e.text));
    const records: MemoryRecord[] = [];
    for (let j = 0; j < batch.length; j++) {
      const vector = vectors[j];
      const entry = batch[j];
      if (vector === undefined || entry === undefined) continue;
      records.push({
        id: `cold-${entry.id}`,
        kind: "cold",
        text: entry.text,
        vector,
        metadata: {
          campaignId: args.campaignId,
          createdAt: now,
          embedModel: embed.name,
          ...(entry.deltas !== undefined ? { deltas: entry.deltas } : {}),
          ...(entry.source !== undefined ? { source: entry.source } : {}),
          ...(entry.foundry_id !== undefined ? { foundry_id: entry.foundry_id } : {}),
          ...(entry.last_modified !== undefined ? { last_modified: entry.last_modified } : {}),
          ...(entry.location !== undefined ? { location: entry.location } : {}),
          ...(entry.quest !== undefined ? { quest: entry.quest } : {}),
          ...(entry.keywords !== undefined ? { keywords: entry.keywords } : {}),
        },
      });
    }
    await store.upsert(records);
    count += records.length;
  }
  return count;
}
