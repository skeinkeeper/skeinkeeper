// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { and, eq } from "drizzle-orm";
import type { Db } from "../db.js";
import type { DeletionAdapter, ErasureScope } from "../erasure.js";
import { campaigns } from "../schema/index.js";

/**
 * Deleting a campaign cascades via FK to quest_flags and sessions.
 * Per design doc 0007, mechanical state (characters, NPCs, locations)
 * lives in Foundry, not Skeinkeeper — its erasure is the operator's
 * responsibility on the Foundry side, surfaced in docs/PRIVACY.md.
 */
export class CampaignAdapter implements DeletionAdapter {
  readonly name = "campaign";
  readonly supportedScopes = ["campaign", "tenant"] as const;

  constructor(private readonly db: Db) {}

  async delete(scope: ErasureScope): Promise<number> {
    if (scope.kind === "campaign") {
      const res = this.db
        .delete(campaigns)
        .where(and(eq(campaigns.tenantId, scope.tenantId), eq(campaigns.id, scope.campaignId)))
        .run();
      return res.changes;
    }
    if (scope.kind === "tenant") {
      const res = this.db.delete(campaigns).where(eq(campaigns.tenantId, scope.tenantId)).run();
      return res.changes;
    }
    return 0;
  }
}
