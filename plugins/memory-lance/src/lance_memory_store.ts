// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import * as lancedb from "@lancedb/lancedb";
import type { MemoryQueryOptions, MemoryRecord, MemoryStore } from "@skeinkeeper/orchestrator";

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
    deltasJson: r.metadata.deltas ? JSON.stringify(r.metadata.deltas) : "",
  };
}

function fromRow(row: Row): MemoryRecord {
  const metadata: MemoryRecord["metadata"] = {
    campaignId: row.campaignId,
    createdAt: row.createdAt,
    embedModel: row.embedModel,
  };
  if (row.sessionId.length > 0) metadata.sessionId = row.sessionId;
  if (row.deltasJson.length > 0) {
    try {
      metadata.deltas = JSON.parse(row.deltasJson) as Record<string, unknown>;
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
    await existing
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  async query(vector: ReadonlyArray<number>, opts: MemoryQueryOptions): Promise<MemoryRecord[]> {
    const table = await this.existingTable();
    if (table === null) return [];
    let predicate = `campaignId = '${escapeLiteral(opts.campaignId)}'`;
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      const inList = opts.kinds.map((k) => `'${escapeLiteral(k)}'`).join(", ");
      predicate += ` AND kind IN (${inList})`;
    }
    const results = (await table
      .search([...vector])
      .where(predicate)
      .limit(opts.topK)
      .toArray()) as Row[];
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
}
