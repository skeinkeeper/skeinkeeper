// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { playerCharacterMap } from "../schema/index.js";

/**
 * Erasure + export for the player↔character map (design doc 0016). The
 * rows carry a Discord user ID (PII), so player-scoped erasure removes a
 * subject's mappings. Campaign scope is handled by FK cascade.
 */
export class PlayerCharacterMapAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "player_character_map";
  readonly supportedScopes = ["player", "campaign", "tenant"] as const;

  constructor(private readonly db: Db) {}

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "player") {
      const res = this.db
        .delete(playerCharacterMap)
        .where(
          and(
            eq(playerCharacterMap.tenantId, scope.tenantId),
            eq(playerCharacterMap.discordUserId, scope.subjectId),
          ),
        )
        .run();
      return res.changes;
    }
    if (scope.kind === "campaign") {
      // Redundant with the campaigns→pcmap FK cascade, but explicit so the
      // erasure report counts the rows and campaign deletion isn't cascade-only.
      const res = this.db
        .delete(playerCharacterMap)
        .where(
          and(
            eq(playerCharacterMap.tenantId, scope.tenantId),
            eq(playerCharacterMap.campaignId, scope.campaignId),
          ),
        )
        .run();
      return res.changes;
    }
    if (scope.kind === "tenant") {
      const res = this.db
        .delete(playerCharacterMap)
        .where(eq(playerCharacterMap.tenantId, scope.tenantId))
        .run();
      return res.changes;
    }
    return 0;
  }

  async export(scope: ErasureScope): Promise<ExportPayload> {
    if (scope.kind === "player") {
      const rows = this.db
        .select()
        .from(playerCharacterMap)
        .where(
          and(
            eq(playerCharacterMap.tenantId, scope.tenantId),
            eq(playerCharacterMap.discordUserId, scope.subjectId),
          ),
        )
        .all();
      return { data: rows, summary: [`${rows.length} player↔character mapping(s)`] };
    }
    if (scope.kind === "campaign") {
      const rows = this.db
        .select()
        .from(playerCharacterMap)
        .where(
          and(
            eq(playerCharacterMap.tenantId, scope.tenantId),
            eq(playerCharacterMap.campaignId, scope.campaignId),
          ),
        )
        .all();
      return { data: rows, summary: [`${rows.length} player↔character mapping(s)`] };
    }
    if (scope.kind === "tenant") {
      const rows = this.db
        .select()
        .from(playerCharacterMap)
        .where(eq(playerCharacterMap.tenantId, scope.tenantId))
        .all();
      return { data: rows, summary: [`${rows.length} player↔character mapping(s)`] };
    }
    return { data: [], summary: ["(scope not supported by player-character-map adapter)"] };
  }
}
