// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { PresenceMember } from "../interfaces/voice.js";

/**
 * Session-start onboarding selection (design doc 0023 §2). Pure helpers the
 * always-listening loop uses to decide *who*, on a conversational lull, still
 * needs the welcome ritual — and to phrase the synthetic cue that drives the
 * onboarding turn. Kept side-effect-free so the ritual's targeting logic is
 * unit-testable without Discord or an LLM.
 */

export interface OnboardingSelectionInput {
  /** Everyone currently in the voice channel (from `presence` events). */
  present: ReadonlyArray<PresenceMember>;
  /** Discord user IDs that have granted voice consent. Onboarding only
   *  engages consented members — the AI can't hear an unconsented player's
   *  reply (audio is discarded before STT), so welcoming them is futile. The
   *  loop prompts unconsented members for consent separately. */
  consented: ReadonlySet<string>;
  /** Discord user IDs already mapped to a Foundry actor (player_character_map). */
  mapped: ReadonlySet<string>;
  /** Discord user IDs already welcomed this session (don't re-greet). */
  greeted: ReadonlySet<string>;
}

/**
 * Who is awaiting onboarding = consented & present − already-mapped −
 * already-greeted. An empty channel yields no targets (the loop then stays
 * silent). Order follows `present` so the welcome reads in join order.
 */
export function selectOnboardingTargets(
  input: OnboardingSelectionInput,
): ReadonlyArray<PresenceMember> {
  return input.present.filter(
    (m) => input.consented.has(m.id) && !input.mapped.has(m.id) && !input.greeted.has(m.id),
  );
}

const nameOf = (m: PresenceMember): string => m.displayName ?? m.id;

/**
 * The synthetic turn cue that triggers an onboarding turn (design doc 0023
 * §2). It names who is awaiting onboarding and frames the ritual; the
 * behavior spec governs the actual wording. A single newcomer gets a personal
 * welcome; several at once (e.g., a full room at Start) get a group greeting
 * with a "go around the room" cue.
 *
 * This is appended as an orchestrator note in the turn input — it is not a
 * player utterance. The loop may also pass along anything the targets just
 * said (so the AI can welcome *and* immediately confirm a character if they
 * already introduced one).
 */
export function buildOnboardingDirective(
  targets: ReadonlyArray<PresenceMember>,
): string {
  const names = targets.map(nameOf).join(", ");
  if (targets.length === 1) {
    return (
      `[Onboarding] ${names} is in the voice channel and has not yet been mapped to a ` +
      `character. There's a lull. Welcome them, introduce yourself as the Dungeon Master, ` +
      `and ask them to say who they are and which character is theirs. Use the table roster ` +
      `to record the mapping once they answer.`
    );
  }
  return (
    `[Onboarding] These players are in the voice channel and not yet mapped to characters: ` +
    `${names}. There's a lull. Greet the group, introduce yourself as the Dungeon Master, ` +
    `and tell them you'll go around so each can say who they are and which character is ` +
    `theirs. Use the table roster to record each mapping as they answer.`
  );
}
