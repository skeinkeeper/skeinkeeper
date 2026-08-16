// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { sessionIntakeFindings } from "../schema/index.js";

/**
 * Campaign- and tenant-scope erasure for session_intake_finding (TDD 0031).
 * PII-free; campaign delete also cascades via FK. Player scope is a no-op.
 */
export class SessionIntakeFindingAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "session_intake_finding";
  readonly supportedScopes = ["campaign", "tenant"] as const;

  constructor(private readonly db: Db) {}

  async delete(scope: ErasureScope): Promise<{ recordsDeleted: number }> {
    if (scope.kind === "campaign") {
      const res = this.db
        .delete(sessionIntakeFindings)
        .where(
          and(
            eq(sessionIntakeFindings.tenantId, scope.tenantId),
            eq(sessionIntakeFindings.campaignId, scope.campaignId),
          ),
        )
        .run();
      return { recordsDeleted: res.changes };
    }
    if (scope.kind === "tenant") {
      const res = this.db
        .delete(sessionIntakeFindings)
        .where(eq(sessionIntakeFindings.tenantId, scope.tenantId))
        .run();
      return { recordsDeleted: res.changes };
    }
    return { recordsDeleted: 0 };
  }

  async export(scope: ErasureScope): Promise<ExportPayload> {
    if (scope.kind === "campaign") {
      const rows = this.db
        .select()
        .from(sessionIntakeFindings)
        .where(
          and(
            eq(sessionIntakeFindings.tenantId, scope.tenantId),
            eq(sessionIntakeFindings.campaignId, scope.campaignId),
          ),
        )
        .all();
      return { data: rows, summary: [`${rows.length} intake finding(s)`] };
    }
    if (scope.kind === "tenant") {
      const rows = this.db
        .select()
        .from(sessionIntakeFindings)
        .where(eq(sessionIntakeFindings.tenantId, scope.tenantId))
        .all();
      return { data: rows, summary: [`${rows.length} intake finding(s)`] };
    }
    return { data: [], summary: ["(scope not supported by intake-finding adapter)"] };
  }
}
