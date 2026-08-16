// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, desc, eq, or } from "drizzle-orm";
import type { Db } from "../db.js";
import { defaultPiiCrypto, type PiiCrypto } from "../column_crypto.js";
import { decryptPcmapRow } from "../pii_columns.js";
import type { DeletionAdapter, DeletionAdapterResult, ErasureScope } from "../erasure.js";
import { playerCharacterMap } from "../schema/index.js";

export interface DeleteChatMessagesArgs {
  scope: "by-author" | "by-recipient" | "by-time-range";
  authorFoundryUserId?: string;
  recipientFoundryUserId?: string;
  since?: string;
  until?: string;
}

/** Narrow Foundry seam used by this adapter — avoids a server→orchestrator cycle. */
export interface FoundryChatDeletionClient {
  deleteChatMessages(args: DeleteChatMessagesArgs): Promise<{ deletedCount: number }>;
}

export interface PlayerCharacterMapRowView {
  foundryUserId: string | null;
}

/** TDD 0036 3-way map, keyed the way TDD 0038's cascade reads it. */
export interface PlayerCharacterMapStore {
  currentForPlayer(args: {
    tenantId: string;
    discordUserId: string;
  }): PlayerCharacterMapRowView | undefined | Promise<PlayerCharacterMapRowView | undefined>;
}

/**
 * Latest identity-map row for a Discord user across the tenant (v0.5 is
 * current-only; remapped prior Foundry users are a documented remainder).
 */
export class DbPlayerCharacterMapStore implements PlayerCharacterMapStore {
  constructor(
    private readonly db: Db,
    private readonly crypto: PiiCrypto = defaultPiiCrypto(),
  ) {}

  currentForPlayer(args: {
    tenantId: string;
    discordUserId: string;
  }): PlayerCharacterMapRowView | undefined {
    const row = this.db
      .select()
      .from(playerCharacterMap)
      .where(
        and(
          eq(playerCharacterMap.tenantId, args.tenantId),
          or(
            eq(playerCharacterMap.discordUserIdHash, this.crypto.hash(args.discordUserId)),
            eq(playerCharacterMap.discordUserId, args.discordUserId),
          ),
        ),
      )
      .orderBy(desc(playerCharacterMap.confirmedAt), desc(playerCharacterMap.id))
      .limit(1)
      .get();
    if (row === undefined) return undefined;
    const decrypted = decryptPcmapRow(this.crypto, row);
    return { foundryUserId: decrypted.foundryUserId };
  }
}

/**
 * Cascades per-player erasure into Foundry whisper history (TDD 0038).
 * Snapshots the identity map in `snapshot()` so a later
 * PlayerCharacterMapAdapter delete cannot hide the Foundry user id.
 */
export class FoundryWhisperDeletionAdapter implements DeletionAdapter {
  readonly name = "foundry-whisper";
  readonly supportedScopes: ReadonlyArray<ErasureScope["kind"]> = ["player"];

  private snapshotted: { foundryUserId: string | null } | undefined | "unset" = "unset";

  constructor(
    private readonly foundry: FoundryChatDeletionClient,
    private readonly identityMap: PlayerCharacterMapStore,
    private readonly connected: boolean,
  ) {}

  async snapshot(scope: ErasureScope): Promise<void> {
    if (scope.kind !== "player") {
      this.snapshotted = undefined;
      return;
    }
    const row = await this.identityMap.currentForPlayer({
      tenantId: scope.tenantId,
      discordUserId: scope.subjectId,
    });
    this.snapshotted = row === undefined ? undefined : { foundryUserId: row.foundryUserId };
  }

  async delete(scope: ErasureScope): Promise<DeletionAdapterResult> {
    if (scope.kind !== "player") return { recordsDeleted: 0 };
    if (this.snapshotted === "unset") await this.snapshot(scope);
    const foundryUserId =
      this.snapshotted === "unset" || this.snapshotted === undefined
        ? undefined
        : this.snapshotted.foundryUserId;
    if (foundryUserId === undefined || foundryUserId === null || foundryUserId === "") {
      return {
        recordsDeleted: 0,
        manualRemainder: {
          reason: "no-foundry-user-mapped",
          message: `No Foundry user is mapped to Discord user ${scope.subjectId}; if this player had any Foundry whisper history, you must manually delete it via Foundry's GM chat-log UI.`,
        },
      };
    }

    if (!this.connected) {
      return {
        recordsDeleted: 0,
        manualRemainder: {
          reason: "addon-unavailable",
          foundryUserId,
          message: `The Skeinkeeper Foundry add-on is not connected. Whisper history for Foundry user ${foundryUserId} must be deleted via Foundry's GM chat-log UI, or retry player:delete when Foundry is back.`,
        },
      };
    }

    try {
      const recipientResult = await this.foundry.deleteChatMessages({
        scope: "by-recipient",
        recipientFoundryUserId: foundryUserId,
      });
      const authorResult = await this.foundry.deleteChatMessages({
        scope: "by-author",
        authorFoundryUserId: foundryUserId,
      });
      return { recordsDeleted: recipientResult.deletedCount + authorResult.deletedCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        recordsDeleted: 0,
        manualRemainder: {
          reason: "foundry-call-failed",
          foundryUserId,
          message: `Foundry whisper deletion failed: ${message}. Retry via \`skeinkeeper player:delete --subject ${scope.subjectId} --yes\` once Foundry/bridge connectivity is restored, OR manually delete via Foundry's GM chat-log UI.`,
        },
      };
    }
  }
}
