// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { defaultPiiCrypto, type PiiCrypto } from "../column_crypto.js";
import { decryptConsentRow } from "../pii_columns.js";
import { consents } from "../schema/index.js";

/**
 * Erasure + export for the consents table. Per-subject erasure matches the
 * key-free `subject_id_hash` companion (TDD 0030), with a plaintext fallback for
 * legacy rows written before the companion — never decrypting, so the deletion
 * path stays key-free (ADR-0010 #4). Export decrypts `subject_id` for the
 * operator's own data bundle.
 */
export class ConsentsAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "consents";
  readonly supportedScopes = ["player", "tenant"] as const;

  constructor(
    private readonly db: Db,
    private readonly crypto: PiiCrypto = defaultPiiCrypto(),
  ) {}

  /** Match a subject by hash companion, falling back to legacy plaintext. */
  private bySubject(subjectId: string) {
    return or(
      eq(consents.subjectIdHash, this.crypto.hash(subjectId)),
      eq(consents.subjectId, subjectId),
    );
  }

  async delete(scope: ErasureScope): Promise<{ recordsDeleted: number }> {
    if (scope.kind === "player") {
      const res = this.db
        .delete(consents)
        .where(and(eq(consents.tenantId, scope.tenantId), this.bySubject(scope.subjectId)))
        .run();
      return { recordsDeleted: res.changes };
    }
    if (scope.kind === "tenant") {
      const res = this.db.delete(consents).where(eq(consents.tenantId, scope.tenantId)).run();
      return { recordsDeleted: res.changes };
    }
    return { recordsDeleted: 0 };
  }

  async export(scope: ErasureScope): Promise<ExportPayload> {
    if (scope.kind === "player") {
      const rows = this.db
        .select()
        .from(consents)
        .where(and(eq(consents.tenantId, scope.tenantId), this.bySubject(scope.subjectId)))
        .all();
      return {
        data: rows.map((r) => decryptConsentRow(this.crypto, r)),
        summary: [`${rows.length} consent record(s)`],
      };
    }
    if (scope.kind === "tenant") {
      const rows = this.db
        .select()
        .from(consents)
        .where(eq(consents.tenantId, scope.tenantId))
        .all();
      return {
        data: rows.map((r) => decryptConsentRow(this.crypto, r)),
        summary: [`${rows.length} consent record(s) across all subjects`],
      };
    }
    return { data: [], summary: ["(scope not supported by consents adapter)"] };
  }
}
