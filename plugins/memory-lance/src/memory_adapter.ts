// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { MemoryStore } from "@skeinkeeper/orchestrator";
import {
  defaultPiiCrypto,
  playerAudience,
  type AudienceHasher,
  type DeletionAdapter,
  type ErasureScope,
} from "@skeinkeeper/server";

/**
 * Erasure adapter for the memory store (design doc 0019 §7, ADR-0014, ADR-0017).
 *
 * - Campaign / tenant scopes delete the corresponding records.
 * - Player scope deletes only that player's **private side-channel** memory
 *   (`audience = "player:<hash>"`, per ADR-0017 / TDD 0030) — the campaign's
 *   shared `table`/`gm` episodic memory persists, because it is the
 *   jointly-authored record and is not individually erasable (ADR-0014). A
 *   player's raw dialogue + identity mapping are erased by their own adapters.
 *
 * Player-scope erasure deletes both the hashed audience token (current) and the
 * legacy pre-0030 raw-id token, so it stays complete regardless of whether
 * `pii:encrypt` has rewritten old rows.
 *
 * Tenant-store resolution is injected so the same adapter serves any tenant
 * (the operator app builds a per-tenant LanceMemoryStore). The hasher is
 * injected to mint the hashed audience token.
 */
export class MemoryAdapter implements DeletionAdapter {
  readonly name = "memory";
  readonly supportedScopes = ["player", "campaign", "tenant"] as const;

  constructor(
    private readonly storeForTenant: (tenantId: string) => MemoryStore,
    private readonly hasher: AudienceHasher = defaultPiiCrypto(),
  ) {}

  async delete(scope: ErasureScope): Promise<{ recordsDeleted: number }> {
    if (scope.kind === "campaign") {
      return {
        recordsDeleted: await this.storeForTenant(scope.tenantId).deleteByCampaign(
          scope.campaignId,
        ),
      };
    }
    if (scope.kind === "tenant") {
      return { recordsDeleted: await this.storeForTenant(scope.tenantId).deleteByTenant() };
    }
    // Player scope: erase only this player's private side-channel memory
    // (ADR-0017); shared campaign episodic memory persists (ADR-0014).
    const store = this.storeForTenant(scope.tenantId);
    const hashed = await store.deleteByAudience(playerAudience(this.hasher, scope.subjectId));
    const legacy = await store.deleteByAudience(`player:${scope.subjectId}`);
    return { recordsDeleted: hashed + legacy };
  }
}
