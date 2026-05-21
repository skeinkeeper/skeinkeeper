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
  };
}

export interface MemoryQueryOptions {
  campaignId: string;
  kinds?: ReadonlyArray<MemoryKind>;
  /** Restrict to these audiences (design doc 0026 §10). Absent = no audience
   *  filter. A record with no stored audience is treated as "table". */
  audiences?: ReadonlyArray<Audience | string>;
  topK: number;
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
  /** Erasure: delete a campaign's records. Returns the count removed. */
  deleteByCampaign(campaignId: string): Promise<number>;
  /** Erasure: delete this tenant's records. Returns the count removed. */
  deleteByTenant(): Promise<number>;
  /** Erasure: delete records with this exact audience (e.g. a player's private
   *  side-channel memory, "player:<id>", per ADR-0017). Returns the count
   *  removed. Shared "table"/"gm" records are unaffected. */
  deleteByAudience(audience: string): Promise<number>;
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
    const candidates = [...this.records.values()].filter(
      (r) =>
        r.metadata.campaignId === opts.campaignId &&
        (opts.kinds === undefined || opts.kinds.includes(r.kind)) &&
        (opts.audiences === undefined || opts.audiences.includes(effectiveAudience(r))),
    );
    return candidates
      .map((r) => ({ r, score: cosineSimilarity(vector, r.vector) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, opts.topK)
      .map((x) => x.r);
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
