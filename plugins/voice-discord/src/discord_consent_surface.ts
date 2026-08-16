// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { InboundSurface, SurfaceInputEvent } from "@skeinkeeper/orchestrator";
import { AsyncQueue } from "@skeinkeeper/orchestrator";

export const SIDE_CHANNEL_MOVED_TEXT = "Side-channels moved to Foundry — whisper the DM there.";
export const IDENTITY_COURTESY_TEXT = "Your Foundry user isn't set up yet — flag your DM.";

export interface DiscordConsentSurfaceOptions {
  sendDm: (discordId: string, text: string) => Promise<void>;
}

/**
 * Discord DM is consent-only (TDD 0034). The one exception is a one-time
 * courtesy redirect when a player DMs the bot after the surface narrowing.
 */
export class DiscordConsentSurface implements InboundSurface {
  readonly name = "discord-consent";
  private readonly inbound = new AsyncQueue<SurfaceInputEvent>();
  private readonly courtesySent = new Set<string>();
  private readonly identityCourtesySent = new Set<string>();

  constructor(private readonly opts: DiscordConsentSurfaceOptions) {}

  events(): AsyncIterable<SurfaceInputEvent> {
    return this.inbound;
  }

  pushConsentResponse(discordId: string, decision: "accept" | "decline"): void {
    this.inbound.push({
      kind: "consent.response",
      surface: "discord-consent",
      discordId,
      decision,
    });
  }

  /** One-time courtesy reply. Returns true when a DM was sent. */
  async handleNonConsentDm(discordId: string): Promise<boolean> {
    if (this.courtesySent.has(discordId)) return false;
    this.courtesySent.add(discordId);
    await this.opts.sendDm(discordId, SIDE_CHANNEL_MOVED_TEXT);
    return true;
  }

  /** One-time identity-gap courtesy (TDD 0036 voice-join). */
  async sendIdentityCourtesy(discordId: string): Promise<boolean> {
    if (this.identityCourtesySent.has(discordId)) return false;
    this.identityCourtesySent.add(discordId);
    await this.opts.sendDm(discordId, IDENTITY_COURTESY_TEXT);
    return true;
  }

  close(): void {
    this.inbound.close();
  }
}
