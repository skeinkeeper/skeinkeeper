// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import * as lancedb from "@lancedb/lancedb";
import {
  cosineSimilarity,
  matchesMetadataFilter,
  type ByMetadataOptions,
  type MemoryQueryOptions,
  type MemoryRecord,
  type MemorySource,
  type MemoryStore,
} from "@skeinkeeper/orchestrator";
import type { Audience } from "@skeinkeeper/server";

/**
 * LanceDB-backed MemoryStore (design doc 0019, ADR-0002). One store instance
 * is scoped to one tenant and realized as one LanceDB directory, so tenant
 * isolation and tenant-scoped erasure are filesystem-level (ADR-0008).
 *
 * Real adapter, LIVE-VALIDATION REQUIRED — exercised against a real LanceDB on
 * disk, not the unit suite. The orchestrator's retrieval logic is unit-tested
 * against InMemoryMemoryStore; the erasure adapter (MemoryAdapter) is unit-
 * tested against that same in-memory store, so the ADR-0014 erasure scoping is
 * covered without LanceDB.
 */
interface Row {
  // LanceDB's create/insert APIs accept Record<string, unknown>[]; the index
  // signature makes Row assignable to that while keeping the named columns typed.
  [key: string]: unknown;
  id: string;
  kind: string;
  text: string;
  vector: number[];
  campaignId: string;
  sessionId: string;
  createdAt: number;
  embedModel: string;
  /** Who may see this record (design doc 0026, ADR-0017); "table" by default. */
  audience: string;
  deltasJson: string;
}

export interface LanceMemoryStoreOptions {
  /** Per-tenant directory. */
  dir: string;
  /** Embedding dimensionality (must match the configured EmbeddingProvider). */
  dimensions: number;
  tableName?: string;
}

function escapeLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

const SK_META_KEY = "_sk";

interface SkMeta {
  source?: MemorySource;
  foundry_id?: string;
  last_modified?: string;
  location?: string;
  quest?: string;
  keywords?: string[];
  tombstoned?: boolean;
}

function packDeltas(r: MemoryRecord): string {
  const sk: SkMeta = {};
  if (r.metadata.source !== undefined) sk.source = r.metadata.source;
  if (r.metadata.foundry_id !== undefined) sk.foundry_id = r.metadata.foundry_id;
  if (r.metadata.last_modified !== undefined) sk.last_modified = r.metadata.last_modified;
  if (r.metadata.location !== undefined) sk.location = r.metadata.location;
  if (r.metadata.quest !== undefined) sk.quest = r.metadata.quest;
  if (r.metadata.keywords !== undefined) sk.keywords = r.metadata.keywords;
  if (r.metadata.tombstoned === true) sk.tombstoned = true;
  const hasSk = Object.keys(sk).length > 0;
  if (r.metadata.deltas === undefined && !hasSk) return "";
  return JSON.stringify({
    ...(r.metadata.deltas ?? {}),
    ...(hasSk ? { [SK_META_KEY]: sk } : {}),
  });
}

function toRow(r: MemoryRecord): Row {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    vector: r.vector,
    campaignId: r.metadata.campaignId,
    sessionId: r.metadata.sessionId ?? "",
    createdAt: r.metadata.createdAt,
    embedModel: r.metadata.embedModel,
    audience: r.metadata.audience ?? "table",
    deltasJson: packDeltas(r),
  };
}

function fromRow(row: Row): MemoryRecord {
  const metadata: MemoryRecord["metadata"] = {
    campaignId: row.campaignId,
    createdAt: row.createdAt,
    embedModel: row.embedModel,
  };
  if (row.audience.length > 0) {
    metadata.audience = row.audience as Audience;
  }
  if (row.sessionId.length > 0) metadata.sessionId = row.sessionId;
  if (row.deltasJson.length > 0) {
    try {
      const parsed = JSON.parse(row.deltasJson) as Record<string, unknown>;
      const sk = parsed[SK_META_KEY];
      if (sk !== undefined && typeof sk === "object" && sk !== null && !Array.isArray(sk)) {
        const extra = sk as SkMeta;
        if (extra.source !== undefined) metadata.source = extra.source;
        if (extra.foundry_id !== undefined) metadata.foundry_id = extra.foundry_id;
        if (extra.last_modified !== undefined) metadata.last_modified = extra.last_modified;
        if (extra.location !== undefined) metadata.location = extra.location;
        if (extra.quest !== undefined) metadata.quest = extra.quest;
        if (extra.keywords !== undefined) metadata.keywords = extra.keywords;
        if (extra.tombstoned === true) metadata.tombstoned = true;
        delete parsed[SK_META_KEY];
      }
      if (Object.keys(parsed).length > 0) metadata.deltas = parsed;
    } catch {
      // leave deltas unset on parse failure
    }
  }
  return {
    id: row.id,
    kind: row.kind as MemoryRecord["kind"],
    text: row.text,
    vector: Array.from(row.vector),
    metadata,
  };
}

export class LanceMemoryStore implements MemoryStore {
  readonly name = "lancedb";
  private readonly tableName: string;
  private connPromise: Promise<lancedb.Connection> | null = null;

  constructor(private readonly options: LanceMemoryStoreOptions) {
    this.tableName = options.tableName ?? "memory";
  }

  private conn(): Promise<lancedb.Connection> {
    if (this.connPromise === null) this.connPromise = lancedb.connect(this.options.dir);
    return this.connPromise;
  }

  private async existingTable(): Promise<lancedb.Table | null> {
    const db = await this.conn();
    const names = await db.tableNames();
    return names.includes(this.tableName) ? db.openTable(this.tableName) : null;
  }

  async upsert(records: ReadonlyArray<MemoryRecord>): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map(toRow);
    const existing = await this.existingTable();
    if (existing === null) {
      const db = await this.conn();
      await db.createTable(this.tableName, rows);
      return;
    }
    await existing.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }

  async query(vector: ReadonlyArray<number>, opts: MemoryQueryOptions): Promise<MemoryRecord[]> {
    // Metadata filters live in JSON (no Lance column); scan + rank so top-K
    // is computed inside the filter, not after a vector-only search.
    if (opts.metadata !== undefined) {
      const candidates = (await this.scanCampaign(opts.campaignId)).filter((r) =>
        this.matchesQuery(r, opts),
      );
      return candidates
        .map((r) => ({ r, score: cosineSimilarity(vector, r.vector) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, opts.topK)
        .map((x) => x.r);
    }
    const table = await this.existingTable();
    if (table === null) return [];
    const fetch = opts.includeTombstones === true ? opts.topK : Math.max(opts.topK * 4, opts.topK);
    const results = (await table
      .search([...vector])
      .where(this.basePredicate(opts))
      .limit(fetch)
      .toArray()) as Row[];
    return results
      .map(fromRow)
      .filter((r) => opts.includeTombstones === true || r.metadata.tombstoned !== true)
      .slice(0, opts.topK);
  }

  async byMetadata(opts: ByMetadataOptions): Promise<MemoryRecord[]> {
    return (await this.scanCampaign(opts.campaignId)).filter((r) =>
      this.matchesQuery(r, {
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
      }),
    );
  }

  private basePredicate(opts: MemoryQueryOptions): string {
    let predicate = `campaignId = '${escapeLiteral(opts.campaignId)}'`;
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      const inList = opts.kinds.map((k) => `'${escapeLiteral(k)}'`).join(", ");
      predicate += ` AND kind IN (${inList})`;
    }
    if (opts.audiences !== undefined && opts.audiences.length > 0) {
      const inList = opts.audiences.map((a) => `'${escapeLiteral(a)}'`).join(", ");
      predicate += ` AND audience IN (${inList})`;
    }
    return predicate;
  }

  private matchesQuery(r: MemoryRecord, opts: MemoryQueryOptions): boolean {
    if (opts.kinds !== undefined && !opts.kinds.includes(r.kind)) return false;
    if (opts.audiences !== undefined && !opts.audiences.includes(r.metadata.audience ?? "table")) {
      return false;
    }
    if (opts.includeTombstones !== true && r.metadata.tombstoned === true) return false;
    return matchesMetadataFilter(r, opts.metadata);
  }

  private async scanCampaign(campaignId: string): Promise<MemoryRecord[]> {
    const table = await this.existingTable();
    if (table === null) return [];
    const predicate = `campaignId = '${escapeLiteral(campaignId)}'`;
    const results = (await table.query().where(predicate).toArray()) as Row[];
    return results.map(fromRow);
  }

  async deleteByCampaign(campaignId: string): Promise<number> {
    const table = await this.existingTable();
    if (table === null) return 0;
    const predicate = `campaignId = '${escapeLiteral(campaignId)}'`;
    const count = await table.countRows(predicate);
    await table.delete(predicate);
    return count;
  }

  async deleteByTenant(): Promise<number> {
    const table = await this.existingTable();
    if (table === null) return 0;
    const count = await table.countRows();
    const db = await this.conn();
    await db.dropTable(this.tableName);
    return count;
  }

  async deleteByAudience(audience: string): Promise<number> {
    const table = await this.existingTable();
    if (table === null) return 0;
    const predicate = `audience = '${escapeLiteral(audience)}'`;
    const count = await table.countRows(predicate);
    await table.delete(predicate);
    return count;
  }
}
