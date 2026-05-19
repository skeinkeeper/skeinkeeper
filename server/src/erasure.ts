// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { deletionLog } from "./schema/index.js";

export type ErasureScope =
  | { kind: "player"; tenantId: string; subjectId: string }
  | { kind: "campaign"; tenantId: string; campaignId: string }
  | { kind: "tenant"; tenantId: string };

export interface DeletionAdapter {
  readonly name: string;
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]>;
  delete(scope: ErasureScope): Promise<number>;
}

export interface ErasureReport {
  scope: ErasureScope;
  perAdapter: ReadonlyArray<{ adapter: string; recordsDeleted: number }>;
  totalRecords: number;
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
    const perAdapter: Array<{ adapter: string; recordsDeleted: number }> = [];

    for (const adapter of applicable) {
      const recordsDeleted = await adapter.delete(scope);
      perAdapter.push({ adapter: adapter.name, recordsDeleted });

      this.options.db
        .insert(deletionLog)
        .values({
          tenantId: scope.tenantId,
          scope: scope.kind,
          subjectIdHash: this.hashSubject(scope),
          adapterName: adapter.name,
          recordsDeleted,
          timestamp: Date.now(),
        })
        .run();
    }

    const totalRecords = perAdapter.reduce((sum, x) => sum + x.recordsDeleted, 0);
    return { scope, perAdapter, totalRecords };
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
