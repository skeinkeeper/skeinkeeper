// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { playerAudience } from "../audience.js";
import { dialogue } from "../schema/index.js";

/**
 * Erasure + export for the dialogue transcript table (per ADR-0010,
 * design doc 0011/2c). Player scope deletes a speaker's lines across all
 * sessions; tenant scope clears everything. Campaign scope is handled by
 * FK cascade (deleting a campaign cascades to its sessions and their
 * dialogue), so this adapter doesn't claim it.
 *
 * Player scope also removes the DM's *private side-channel turns* addressed to
 * that player (`audience = "player:<id>"`, typically `speaker = "narrator"`) —
 * not just the rows the player spoke. That private content is player-scoped and
 * individually erasable per ADR-0017; shared `table`/`gm` turns persist.
 */
export class DialogueAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "dialogue";
  readonly supportedScopes = ["player", "tenant"] as const;

  constructor(private readonly db: Db) {}

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "player") {
      const res = this.db
        .delete(dialogue)
        .where(
          and(
            eq(dialogue.tenantId, scope.tenantId),
            or(
              eq(dialogue.speaker, scope.subjectId),
              eq(dialogue.audience, playerAudience(scope.subjectId)),
            ),
          ),
        )
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
        .where(
          and(
            eq(dialogue.tenantId, scope.tenantId),
            or(
              eq(dialogue.speaker, scope.subjectId),
              eq(dialogue.audience, playerAudience(scope.subjectId)),
            ),
          ),
        )
        .all();
      return {
        data: rows,
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
        data: rows,
        summary: [`${rows.length} dialogue line(s) across all sessions`],
      };
    }
    return { data: [], summary: ["(scope not supported by dialogue adapter)"] };
  }
}
