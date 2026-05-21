// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Audience & conversation vocabulary for 1:1 side-channels (design doc 0026,
 * ADR-0017). A single source of truth for the string formats so the schema,
 * the erasure adapters, and the orchestrator all agree on them.
 *
 * `audience` — who may ever see a stored utterance / turn / memory record:
 *   - "table"        everyone at the table; shared, campaign-scoped, NOT
 *                    per-player erasable (ADR-0014).
 *   - "gm"           the AI/operator only — secret DCs, hidden room contents,
 *                    NPC true motives. Never enters a player's context.
 *   - "player:<id>"  one player + the operator (a private side-channel turn);
 *                    player-scoped and individually erasable (ADR-0017).
 *
 * `conversationId` — which thread a turn belongs to:
 *   - "table"        the shared table loop (conversation 0).
 *   - "player:<id>"  that player's 1:1 DM side-channel.
 *
 * Both default to "table", so all pre-side-channel data and the existing
 * single-table flow read back unchanged.
 */

export const TABLE_AUDIENCE = "table";
export const GM_AUDIENCE = "gm";

export type Audience = "table" | "gm" | `player:${string}`;

export const TABLE_CONVERSATION = "table";

export type ConversationId = "table" | `player:${string}`;

const PLAYER_PREFIX = "player:";

/** The private audience for one player's side-channel content. */
export function playerAudience(discordId: string): Audience {
  return `${PLAYER_PREFIX}${discordId}`;
}

/** The conversation id for one player's 1:1 DM thread. */
export function playerConversation(discordId: string): ConversationId {
  return `${PLAYER_PREFIX}${discordId}`;
}

/** True for a "player:<id>" audience or conversation id (non-empty id). */
export function isPlayerScoped(value: string): value is `player:${string}` {
  return value.startsWith(PLAYER_PREFIX) && value.length > PLAYER_PREFIX.length;
}

/** The Discord id embedded in a "player:<id>" audience/conversation, or null. */
export function playerIdOf(value: string): string | null {
  return isPlayerScoped(value) ? value.slice(PLAYER_PREFIX.length) : null;
}
