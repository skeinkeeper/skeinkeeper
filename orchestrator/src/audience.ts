// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import {
  GM_AUDIENCE,
  TABLE_AUDIENCE,
  isPlayerScoped,
  type Audience,
  type ConversationId,
} from "@skeinkeeper/server";

/**
 * The visibility policy for side-channels (design doc 0026 §2, §10) — which
 * audiences a given conversation's context may include. This is the *structural*
 * anti-abuse control: a player's side-channel context can never contain another
 * player's private content or the DM's `gm` secrets, so even a cajoled or
 * jailbroken model cannot reveal what is not in its context.
 *
 *   - the table loop ("table")  → {table, gm}        the DM's full shared
 *                                                    knowledge; no player-private.
 *   - a player DM ("player:X")  → {table, player:X}  shared world + this player's
 *                                                    own; never `gm`, never player:Y.
 *
 * Pure function, unit-testable; used by hot-context assembly and memory
 * retrieval to filter what each conversation may see.
 */
export function allowedAudiencesFor(conversationId: ConversationId | string): Audience[] {
  if (isPlayerScoped(conversationId)) {
    return [TABLE_AUDIENCE, conversationId];
  }
  return [TABLE_AUDIENCE, GM_AUDIENCE];
}

/** Whether content of `audience` is visible inside `conversationId`. */
export function audienceVisibleInConversation(
  audience: Audience | string,
  conversationId: ConversationId | string,
): boolean {
  return (allowedAudiencesFor(conversationId) as string[]).includes(audience);
}
