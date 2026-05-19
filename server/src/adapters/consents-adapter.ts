// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { consents } from "../schema/index.js";

export class ConsentsAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "consents";
  readonly supportedScopes = ["player", "tenant"] as const;

  constructor(private readonly db: Db) {}

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "player") {
      const res = this.db
        .delete(consents)
        .where(and(eq(consents.tenantId, scope.tenantId), eq(consents.subjectId, scope.subjectId)))
        .run();
      return res.changes;
    }
    if (scope.kind === "tenant") {
      const res = this.db.delete(consents).where(eq(consents.tenantId, scope.tenantId)).run();
      return res.changes;
    }
    return 0;
  }

  async export(scope: ErasureScope): Promise<ExportPayload> {
    if (scope.kind === "player") {
      const rows = this.db
        .select()
        .from(consents)
        .where(and(eq(consents.tenantId, scope.tenantId), eq(consents.subjectId, scope.subjectId)))
        .all();
      return {
        data: rows,
        summary: [`${rows.length} consent record(s)`],
      };
    }
    if (scope.kind === "tenant") {
      const rows = this.db.select().from(consents).where(eq(consents.tenantId, scope.tenantId)).all();
      return {
        data: rows,
        summary: [`${rows.length} consent record(s) across all subjects`],
      };
    }
    return { data: [], summary: ["(scope not supported by consents adapter)"] };
  }
}
