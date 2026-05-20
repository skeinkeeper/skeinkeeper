// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { TenantDb } from "@skeinkeeper/server";
import { VOICE_CONSENT_TEXT_VERSION } from "@skeinkeeper/orchestrator";

/**
 * Voice-processing consent (design doc 0020 §3, ADR-0010). The operator app
 * delivers the consent prompt (Discord DM) and records grant/withdraw from the
 * slash command; the always-listening loop gates STT on `isGranted`. A thin
 * service over `TenantDb.consents` so the grant/withdraw/gate state machine is
 * unit-testable.
 */
const PURPOSE = "voice_processing";

export class ConsentService {
  constructor(private readonly tenantDb: TenantDb) {}

  /** Whether this speaker's audio may be transcribed right now. */
  isGranted(discordUserId: string): boolean {
    return this.tenantDb.consents.isGranted(discordUserId, PURPOSE);
  }

  /** True when a fresh consent prompt should be sent (never granted / withdrawn). */
  needsPrompt(discordUserId: string): boolean {
    return this.tenantDb.consents.currentState(discordUserId, PURPOSE) !== "granted";
  }

  grant(discordUserId: string, at: number = Date.now()): void {
    this.tenantDb.consents.record({
      subjectId: discordUserId,
      purpose: PURPOSE,
      action: "granted",
      consentTextVersion: VOICE_CONSENT_TEXT_VERSION,
      timestamp: at,
    });
  }

  withdraw(discordUserId: string, at: number = Date.now()): void {
    this.tenantDb.consents.record({
      subjectId: discordUserId,
      purpose: PURPOSE,
      action: "withdrawn",
      consentTextVersion: VOICE_CONSENT_TEXT_VERSION,
      timestamp: at,
    });
  }
}
