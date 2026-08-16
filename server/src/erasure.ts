// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { deletionLog } from "./schema/index.js";

export type ErasureScope =
  | { kind: "player"; tenantId: string; subjectId: string }
  | { kind: "campaign"; tenantId: string; campaignId: string }
  | { kind: "tenant"; tenantId: string };

export interface ManualRemainder {
  reason: string;
  foundryUserId?: string;
  message: string;
}

export interface DeletionAdapterResult {
  recordsDeleted: number;
  manualRemainder?: ManualRemainder;
}

export interface DeletionAdapter {
  readonly name: string;
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>;
  /**
   * Optional pre-delete read. ErasureService calls this on every applicable
   * adapter before any `delete`, so lookups (identity map) see the pre-erase
   * snapshot rather than a store another adapter already cleared.
   */
  snapshot?(scope: ErasureScope): Promise<void> | void;
  delete(scope: ErasureScope): Promise<DeletionAdapterResult>;
}

export interface ErasureReport {
  scope: ErasureScope;
  perAdapter: ReadonlyArray<{
    adapter: string;
    recordsDeleted: number;
    manualRemainder?: ManualRemainder;
    error?: string;
  }>;
  totalRecords: number;
  /** Number of adapters that threw. Erasure is best-effort per adapter (SQLite
   *  and the LanceDB vector store can't share a transaction), so a non-zero
   *  count means the operator must investigate and re-run. */
  failures: number;
  /** True iff any adapter returned a manualRemainder. */
  partialSuccess: boolean;
  /** Aggregated remainders for CLI / HTML rendering. */
  manualRemainders: ReadonlyArray<ManualRemainder>;
}

export interface ErasureServiceOptions {
  db: Db;
  /** Per-installation salt for one-way hashing of subject identifiers. */
  salt: string;
}

export class ErasureService {
  private readonly adapters: DeletionAdapter[] = [];

  constructor(private readonly options: ErasureServiceOptions) {}

  register(adapter: DeletionAdapter): void {
    this.adapters.push(adapter);
  }

  async erase(scope: ErasureScope): Promise<ErasureReport> {
    const applicable = this.adapters.filter((a) => a.supportedScopes.includes(scope.kind));
    const perAdapter: Array<{
      adapter: string;
      recordsDeleted: number;
      manualRemainder?: ManualRemainder;
      error?: string;
    }> = [];

    // Snapshot lookups before any adapter mutates stores (TDD 0038: identity
    // map must be read before PlayerCharacterMapAdapter deletes the row).
    for (const adapter of applicable) {
      await adapter.snapshot?.(scope);
    }

    for (const adapter of applicable) {
      try {
        const result = await adapter.delete(scope);
        const row: (typeof perAdapter)[number] = {
          adapter: adapter.name,
          recordsDeleted: result.recordsDeleted,
        };
        if (result.manualRemainder !== undefined) {
          row.manualRemainder = result.manualRemainder;
        }
        perAdapter.push(row);

        this.options.db
          .insert(deletionLog)
          .values({
            tenantId: scope.tenantId,
            scope: scope.kind,
            subjectIdHash: this.hashSubject(scope),
            adapterName: adapter.name,
            recordsDeleted: result.recordsDeleted,
            timestamp: Date.now(),
          })
          .run();
      } catch (err) {
        // One adapter failing must not abort the rest — erasure spans SQLite and
        // the LanceDB vector store, which can't share a transaction, so it's
        // best-effort per adapter. Record the failure and keep clearing the
        // other stores; the operator gets a complete report and re-runs.
        perAdapter.push({
          adapter: adapter.name,
          recordsDeleted: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const totalRecords = perAdapter.reduce((sum, x) => sum + x.recordsDeleted, 0);
    const failures = perAdapter.filter((x) => x.error !== undefined).length;
    const manualRemainders = perAdapter
      .map((x) => x.manualRemainder)
      .filter((r): r is ManualRemainder => r !== undefined);
    return {
      scope,
      perAdapter,
      totalRecords,
      failures,
      partialSuccess: manualRemainders.length > 0,
      manualRemainders,
    };
  }

  private hashSubject(scope: ErasureScope): string {
    const subject =
      scope.kind === "player"
        ? scope.subjectId
        : scope.kind === "campaign"
          ? scope.campaignId
          : `tenant:${scope.tenantId}`;
    return createHash("sha256").update(this.options.salt).update("|").update(subject).digest("hex");
  }
}
