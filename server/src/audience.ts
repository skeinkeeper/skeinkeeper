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
 *   - "table"          the shared table loop (conversation 0).
 *   - "player:<hash>"  that player's 1:1 DM side-channel.
 *
 * Both default to "table", so all pre-side-channel data and the existing
 * single-table flow read back unchanged.
 *
 * Per TDD 0030 the player tokens embed the salted **hash** of the Discord id,
 * not the raw id, so the routing string stops carrying recoverable PII while
 * equality still works everywhere it is matched. The hash comes from the same
 * `PiiCrypto.hash` used for the column companions, so a token and a `speaker_hash`
 * for the same player agree.
 */

export const TABLE_AUDIENCE = "table";
export const GM_AUDIENCE = "gm";

export type Audience = "table" | "gm" | `player:${string}`;

export const TABLE_CONVERSATION = "table";

export type ConversationId = "table" | `player:${string}`;

const PLAYER_PREFIX = "player:";

/** The minimal hashing capability a player token needs (a `PiiCrypto` satisfies it). */
export interface AudienceHasher {
  hash(value: string): string;
}

/** The private audience for one player's side-channel content (hashed id). */
export function playerAudience(hasher: AudienceHasher, discordId: string): Audience {
  return `${PLAYER_PREFIX}${hasher.hash(discordId)}`;
}

/** The conversation id for one player's 1:1 DM thread (hashed id). */
export function playerConversation(hasher: AudienceHasher, discordId: string): ConversationId {
  return `${PLAYER_PREFIX}${hasher.hash(discordId)}`;
}

/** True for a "player:<hash>" audience or conversation id (non-empty suffix). */
export function isPlayerScoped(value: string): value is `player:${string}` {
  return value.startsWith(PLAYER_PREFIX) && value.length > PLAYER_PREFIX.length;
}

/**
 * The token embedded after "player:" — the hashed Discord id for tokens minted
 * post-TDD-0030, or null for non-player scopes. Callers that need the raw Discord
 * id take it from the Discord event, never by parsing the token.
 */
export function playerIdOf(value: string): string | null {
  return isPlayerScoped(value) ? value.slice(PLAYER_PREFIX.length) : null;
}
