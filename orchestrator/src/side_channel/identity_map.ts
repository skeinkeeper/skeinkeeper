// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Ephemeral per-session foundryUserId ↔ discordUserId map (TDD 0035).
 * Loaded at session start from TDD 0036's persistent map when that
 * lands; re-bound on `/skeinkeeper map`. Not persisted here.
 */
export class SideChannelIdentityMap {
  private readonly toDiscord = new Map<string, string>();
  private readonly toFoundry = new Map<string, string>();

  bind(discordUserId: string, foundryUserId: string): void {
    const priorFoundry = this.toFoundry.get(discordUserId);
    if (priorFoundry !== undefined) this.toDiscord.delete(priorFoundry);
    const priorDiscord = this.toDiscord.get(foundryUserId);
    if (priorDiscord !== undefined) this.toFoundry.delete(priorDiscord);
    this.toDiscord.set(foundryUserId, discordUserId);
    this.toFoundry.set(discordUserId, foundryUserId);
  }

  discordIdForFoundryUser(foundryUserId: string): string | undefined {
    return this.toDiscord.get(foundryUserId);
  }

  foundryUserIdForDiscord(discordUserId: string): string | undefined {
    return this.toFoundry.get(discordUserId);
  }
}
