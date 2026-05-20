// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { MemoryStore } from "@skeinkeeper/orchestrator";
import type { DeletionAdapter, ErasureScope } from "@skeinkeeper/server";

/**
 * Erasure adapter for the memory store (design doc 0019 §7, ADR-0014).
 * Campaign and tenant scopes delete the corresponding records; **player scope
 * is intentionally a no-op** — episodic memory is the campaign's shared,
 * jointly-authored record and is not individually erasable (ADR-0014). A
 * player's raw dialogue + identity mapping are erased by their own adapters.
 *
 * Tenant-store resolution is injected so the same adapter serves any tenant
 * (the operator app builds a per-tenant LanceMemoryStore).
 */
export class MemoryAdapter implements DeletionAdapter {
  readonly name = "memory";
  readonly supportedScopes = ["campaign", "tenant"] as const;

  constructor(private readonly storeForTenant: (tenantId: string) => MemoryStore) {}

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "campaign") {
      return this.storeForTenant(scope.tenantId).deleteByCampaign(scope.campaignId);
    }
    if (scope.kind === "tenant") {
      return this.storeForTenant(scope.tenantId).deleteByTenant();
    }
    // Player scope: episodic memory is shared campaign content, not per-player
    // erasable (ADR-0014). No-op by design.
    return 0;
  }
}
