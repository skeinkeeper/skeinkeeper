// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { MemoryStore } from "@skeinkeeper/orchestrator";
import { playerAudience, type DeletionAdapter, type ErasureScope } from "@skeinkeeper/server";

/**
 * Erasure adapter for the memory store (design doc 0019 §7, ADR-0014, ADR-0017).
 *
 * - Campaign / tenant scopes delete the corresponding records.
 * - Player scope deletes only that player's **private side-channel** memory
 *   (`audience = "player:<id>"`, per ADR-0017) — the campaign's shared
 *   `table`/`gm` episodic memory persists, because it is the jointly-authored
 *   record and is not individually erasable (ADR-0014). A player's raw dialogue
 *   + identity mapping are erased by their own adapters.
 *
 * Tenant-store resolution is injected so the same adapter serves any tenant
 * (the operator app builds a per-tenant LanceMemoryStore).
 */
export class MemoryAdapter implements DeletionAdapter {
  readonly name = "memory";
  readonly supportedScopes = ["player", "campaign", "tenant"] as const;

  constructor(private readonly storeForTenant: (tenantId: string) => MemoryStore) {}

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "campaign") {
      return this.storeForTenant(scope.tenantId).deleteByCampaign(scope.campaignId);
    }
    if (scope.kind === "tenant") {
      return this.storeForTenant(scope.tenantId).deleteByTenant();
    }
    // Player scope: erase only this player's private side-channel memory
    // (ADR-0017); shared campaign episodic memory persists (ADR-0014).
    return this.storeForTenant(scope.tenantId).deleteByAudience(playerAudience(scope.subjectId));
  }
}
