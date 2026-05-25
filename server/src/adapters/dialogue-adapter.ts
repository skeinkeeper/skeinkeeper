// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { playerAudience } from "../audience.js";
import { defaultPiiCrypto, type PiiCrypto } from "../column_crypto.js";
import { decryptDialogueRow } from "../pii_columns.js";
import { dialogue } from "../schema/index.js";

/**
 * Erasure + export for the dialogue transcript table (per ADR-0010,
 * design doc 0011/2c). Player scope deletes a speaker's lines across all
 * sessions; tenant scope clears everything. Campaign scope is handled by
 * FK cascade (deleting a campaign cascades to its sessions and their
 * dialogue), so this adapter doesn't claim it.
 *
 * Player scope also removes the DM's *private side-channel turns* addressed to
 * that player (`audience = "player:<hash>"`, typically `speaker = "narrator"`) —
 * not just the rows the player spoke. That private content is player-scoped and
 * individually erasable per ADR-0017; shared `table`/`gm` turns persist.
 *
 * `speaker`/`text` are AEAD-encrypted at rest (TDD 0030): matching is by the
 * key-free `speaker_hash` companion and the hashed audience token (with
 * plaintext/raw fallbacks for legacy rows), so erasure never needs the key;
 * export decrypts.
 */
export class DialogueAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "dialogue";
  readonly supportedScopes = ["player", "tenant"] as const;

  constructor(
    private readonly db: Db,
    private readonly crypto: PiiCrypto = defaultPiiCrypto(),
  ) {}

  /**
   * Match a subject's own lines (by speaker_hash, plaintext fallback) and the
   * DM's private replies addressed to them (by hashed audience token).
   */
  private bySubject(subjectId: string) {
    return or(
      eq(dialogue.speakerHash, this.crypto.hash(subjectId)),
      eq(dialogue.speaker, subjectId), // legacy plaintext speaker (pre-encryption)
      eq(dialogue.audience, playerAudience(this.crypto, subjectId)), // hashed audience token
      eq(dialogue.audience, `player:${subjectId}`), // legacy pre-0030 raw-id token
    );
  }

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "player") {
      const res = this.db
        .delete(dialogue)
        .where(and(eq(dialogue.tenantId, scope.tenantId), this.bySubject(scope.subjectId)))
        .run();
      return res.changes;
    }
    if (scope.kind === "tenant") {
      const res = this.db.delete(dialogue).where(eq(dialogue.tenantId, scope.tenantId)).run();
      return res.changes;
    }
    return 0;
  }

  async export(scope: ErasureScope): Promise<ExportPayload> {
    if (scope.kind === "player") {
      const rows = this.db
        .select()
        .from(dialogue)
        .where(and(eq(dialogue.tenantId, scope.tenantId), this.bySubject(scope.subjectId)))
        .all();
      return {
        data: rows.map((r) => decryptDialogueRow(this.crypto, r)),
        summary: [
          `${rows.length} dialogue line(s) spoken by or privately addressed to this subject`,
        ],
      };
    }
    if (scope.kind === "tenant") {
      const rows = this.db
        .select()
        .from(dialogue)
        .where(eq(dialogue.tenantId, scope.tenantId))
        .all();
      return {
        data: rows.map((r) => decryptDialogueRow(this.crypto, r)),
        summary: [`${rows.length} dialogue line(s) across all sessions`],
      };
    }
    return { data: [], summary: ["(scope not supported by dialogue adapter)"] };
  }
}
