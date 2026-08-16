// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { Audience } from "@skeinkeeper/server";

/**
 * Cold/episodic memory store (design doc 0019, ADR-0002). A thin,
 * tenant-scoped seam over a vector store so the orchestrator's retrieval
 * logic is unit-testable without LanceDB (the FoundryClient/MockFoundryClient
 * pattern) and so the store stays swappable (LanceDB now; sqlite-vec/pgvector
 * later, per ADR-0002) and tenant-scoping is enforced (ADR-0008).
 *
 * One store instance is scoped to one tenant; the LanceDB driver realizes
 * that as one directory per tenant.
 */
export type MemoryKind = "cold" | "episodic" | "arc";

/** Cold-tier provenance (TDD 0021 compendium + TDD 0032 world index). */
export type MemorySource =
  | "compendium"
  | "world-journal"
  | "world-scene"
  | "world-creature"
  | "world-actor-item";

export interface MemoryMetadataFilter {
  location?: string;
  quest?: string;
  keywords?: string[];
  source?: MemorySource;
  foundry_id?: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  text: string;
  vector: number[];
  metadata: {
    campaignId: string;
    sessionId?: string;
    createdAt: number;
    /** Embedding model identity — vectors from different models aren't comparable. */
    embedModel: string;
    /** Who may see this record (design doc 0026, ADR-0017). Absent = "table"
     *  (shared, campaign-scoped). "player:<id>" records are private to one
     *  player and individually erasable; "gm" records never enter a player's
     *  side-channel context. */
    audience?: Audience;
    /** Structured deltas preserved separately from prose (ADR-0002). */
    deltas?: Record<string, unknown>;
    /** Cold-tier source. Absent on pre-0032 records; treated as `compendium`. */
    source?: MemorySource;
    foundry_id?: string;
    last_modified?: string;
    location?: string;
    quest?: string;
    keywords?: string[];
    /** Soft-delete for incremental index refresh (TDD 0032). */
    tombstoned?: boolean;
  };
}

export interface MemoryQueryOptions {
  campaignId: string;
  kinds?: ReadonlyArray<MemoryKind>;
  /** Restrict to these audiences (design doc 0026 §10). Absent = no audience
   *  filter. A record with no stored audience is treated as "table". */
  audiences?: ReadonlyArray<Audience | string>;
  topK: number;
  /** Scope a cold-tier query without falling back to vector-only search. */
  metadata?: MemoryMetadataFilter;
  includeTombstones?: boolean;
}

export interface ByMetadataOptions extends MemoryMetadataFilter {
  campaignId: string;
  includeTombstones?: boolean;
}

/** A record's effective audience — defaults to "table" when unset (legacy /
 *  shared content). The single place this default lives. */
export function effectiveAudience(r: MemoryRecord): string {
  return r.metadata.audience ?? "table";
}

export interface MemoryStore {
  upsert(records: ReadonlyArray<MemoryRecord>): Promise<void>;
  /** Top-K most similar records for a campaign, most similar first. */
  query(vector: ReadonlyArray<number>, opts: MemoryQueryOptions): Promise<MemoryRecord[]>;
  /** Filter cold-tier records by location / quest / keyword (TDD 0032). */
  byMetadata(opts: ByMetadataOptions): Promise<MemoryRecord[]>;
  /** Erasure: delete a campaign's records. Returns the count removed. */
  deleteByCampaign(campaignId: string): Promise<number>;
  /** Erasure: delete this tenant's records. Returns the count removed. */
  deleteByTenant(): Promise<number>;
  /** Erasure: delete records with this exact audience (e.g. a player's private
   *  side-channel memory, "player:<id>", per ADR-0017). Returns the count
   *  removed. Shared "table"/"gm" records are unaffected. */
  deleteByAudience(audience: string): Promise<number>;
}

export function matchesMetadataFilter(
  r: MemoryRecord,
  filter: MemoryMetadataFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (filter.location !== undefined) {
    if ((r.metadata.location ?? "").toLowerCase() !== filter.location.toLowerCase()) return false;
  }
  if (filter.quest !== undefined) {
    if ((r.metadata.quest ?? "").toLowerCase() !== filter.quest.toLowerCase()) return false;
  }
  if (filter.source !== undefined && (r.metadata.source ?? "compendium") !== filter.source) {
    return false;
  }
  if (filter.foundry_id !== undefined && r.metadata.foundry_id !== filter.foundry_id) {
    return false;
  }
  if (filter.keywords !== undefined && filter.keywords.length > 0) {
    const have = new Set((r.metadata.keywords ?? []).map((k) => k.toLowerCase()));
    const hit = filter.keywords.some((k) => have.has(k.toLowerCase()));
    if (!hit) return false;
  }
  return true;
}

export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** In-memory store for unit tests and the eval harness (cosine top-k). */
export class InMemoryMemoryStore implements MemoryStore {
  readonly name = "in-memory";
  private readonly records = new Map<string, MemoryRecord>();

  async upsert(records: ReadonlyArray<MemoryRecord>): Promise<void> {
    for (const r of records) this.records.set(r.id, r);
  }

  async query(vector: ReadonlyArray<number>, opts: MemoryQueryOptions): Promise<MemoryRecord[]> {
    const candidates = this.filterRecords(opts);
    return candidates
      .map((r) => ({ r, score: cosineSimilarity(vector, r.vector) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, opts.topK)
      .map((x) => x.r);
  }

  async byMetadata(opts: ByMetadataOptions): Promise<MemoryRecord[]> {
    return this.filterRecords({
      campaignId: opts.campaignId,
      topK: Number.MAX_SAFE_INTEGER,
      metadata: {
        ...(opts.location !== undefined ? { location: opts.location } : {}),
        ...(opts.quest !== undefined ? { quest: opts.quest } : {}),
        ...(opts.keywords !== undefined ? { keywords: opts.keywords } : {}),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.foundry_id !== undefined ? { foundry_id: opts.foundry_id } : {}),
      },
      ...(opts.includeTombstones === true ? { includeTombstones: true } : {}),
    });
  }

  private filterRecords(opts: MemoryQueryOptions): MemoryRecord[] {
    return [...this.records.values()].filter(
      (r) =>
        r.metadata.campaignId === opts.campaignId &&
        (opts.kinds === undefined || opts.kinds.includes(r.kind)) &&
        (opts.audiences === undefined || opts.audiences.includes(effectiveAudience(r))) &&
        (opts.includeTombstones === true || r.metadata.tombstoned !== true) &&
        matchesMetadataFilter(r, opts.metadata),
    );
  }

  async deleteByCampaign(campaignId: string): Promise<number> {
    let removed = 0;
    for (const [id, r] of this.records) {
      if (r.metadata.campaignId === campaignId) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async deleteByTenant(): Promise<number> {
    const n = this.records.size;
    this.records.clear();
    return n;
  }

  async deleteByAudience(audience: string): Promise<number> {
    let removed = 0;
    for (const [id, r] of this.records) {
      if (effectiveAudience(r) === audience) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
