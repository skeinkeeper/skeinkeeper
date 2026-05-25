// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import type { ExportAdapter, ExportPayload } from "../export.js";
import { defaultPiiCrypto, type PiiCrypto } from "../column_crypto.js";
import { decryptPcmapRow } from "../pii_columns.js";
import { playerCharacterMap } from "../schema/index.js";

/**
 * Erasure + export for the player↔character map (design doc 0016). The rows
 * carry a Discord user ID + display name (PII), AEAD-encrypted at rest (TDD
 * 0030). Player-scoped erasure matches the key-free `discord_user_id_hash`
 * companion (plaintext fallback for legacy rows); export decrypts. Campaign
 * scope is handled by FK cascade.
 */
export class PlayerCharacterMapAdapter implements DeletionAdapter, ExportAdapter {
  readonly name = "player_character_map";
  readonly supportedScopes = ["player", "campaign", "tenant"] as const;

  constructor(
    private readonly db: Db,
    private readonly crypto: PiiCrypto = defaultPiiCrypto(),
  ) {}

  /** Match a subject by hash companion, falling back to legacy plaintext. */
  private bySubject(subjectId: string) {
    return or(
      eq(playerCharacterMap.discordUserIdHash, this.crypto.hash(subjectId)),
      eq(playerCharacterMap.discordUserId, subjectId),
    );
  }

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "player") {
      const res = this.db
        .delete(playerCharacterMap)
        .where(
          and(eq(playerCharacterMap.tenantId, scope.tenantId), this.bySubject(scope.subjectId)),
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
    const decrypt = (rows: Array<Parameters<typeof decryptPcmapRow>[1]>): ExportPayload => ({
      data: rows.map((r) => decryptPcmapRow(this.crypto, r)),
      summary: [`${rows.length} player↔character mapping(s)`],
    });
    if (scope.kind === "player") {
      return decrypt(
        this.db
          .select()
          .from(playerCharacterMap)
          .where(
            and(eq(playerCharacterMap.tenantId, scope.tenantId), this.bySubject(scope.subjectId)),
          )
          .all(),
      );
    }
    if (scope.kind === "campaign") {
      return decrypt(
        this.db
          .select()
          .from(playerCharacterMap)
          .where(
            and(
              eq(playerCharacterMap.tenantId, scope.tenantId),
              eq(playerCharacterMap.campaignId, scope.campaignId),
            ),
          )
          .all(),
      );
    }
    if (scope.kind === "tenant") {
      return decrypt(
        this.db
          .select()
          .from(playerCharacterMap)
          .where(eq(playerCharacterMap.tenantId, scope.tenantId))
          .all(),
      );
    }
    return { data: [], summary: ["(scope not supported by player-character-map adapter)"] };
  }
}
