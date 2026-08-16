// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import { auditLog } from "../schema/index.js";

/**
 * Audit log is part of the audit trail and is NOT erased on per-player
 * or per-campaign scope. Only full tenant erasure drops it.
 */
export class AuditLogAdapter implements DeletionAdapter {
  readonly name = "audit_log";
  readonly supportedScopes = ["tenant"] as const;

  constructor(private readonly db: Db) {}

  async delete(scope: ErasureScope): Promise<{ recordsDeleted: number }> {
    if (scope.kind === "tenant") {
      const res = this.db.delete(auditLog).where(eq(auditLog.tenantId, scope.tenantId)).run();
      return { recordsDeleted: res.changes };
    }
    return { recordsDeleted: 0 };
  }
}
