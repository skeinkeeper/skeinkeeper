// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * The two-test allow/deny guardrail for a private in-scene action (design doc
 * 0026 §5). A private action is permitted only if it (1) resolves entirely
 * within the current shared scene — the single-scene invariant — and (2) does
 * not target another player's character unless the operator has enabled PvP.
 *
 * This is the *deterministic* half (0026 §Eval): given the model's
 * classification of the action plus the PvP setting, it returns a decision.
 * The model produces the classification (and phrases any in-fiction redirect);
 * that judgment is exercised by `eval:live`. This helper is the structural
 * backstop and the unit-tested combination logic.
 *
 * The PvP setting is read once, when the action begins (0026 §6
 * "read-at-initiation"): pass the value in effect at initiation; an in-flight
 * action completes under that value even if the operator toggles it mid-action.
 */

/** Per-campaign operator setting key for the PvP toggle (settings table). */
export const PVP_SETTING_KEY = "pvp.enabled";

/** Parse the stored PvP setting value. Default OFF (0026 §6). */
export function pvpEnabledFromSetting(value: string | undefined): boolean {
  return value === "true";
}

/** The model's classification of a proposed private action (0026 §5.1–§5.2). */
export interface PrivateActionClassification {
  /** Does the action resolve entirely within the current shared scene — no
   *  relocation, no committing/presuming the rest of the party? (§5.1) An
   *  in-scene action that is merely *consequential* for the group, e.g. "I bar
   *  the only exit", still passes — it's in-scene. */
  inCurrentScene: boolean;
  /** Does the action target another player's character (attack, theft,
   *  sabotage)? Surprise on an NPC is always fine. (§5.2, §6) */
  targetsAnotherPc: boolean;
}

export type GuardrailDecision =
  | { allow: true }
  | { allow: false; reason: "out_of_scene" | "pvp_disabled"; redirect: string };

const OUT_OF_SCENE_REDIRECT =
  "I don't run split parties — anything that leaves the current scene or commits the rest of the group needs to happen with everyone. Bring it to the table.";

const PVP_DISABLED_REDIRECT =
  "Player-vs-player isn't enabled for this campaign, so I won't resolve an action against another character in private. Settle it with the group, or ask your operator to turn PvP on.";

/**
 * Evaluate the two tests. Geographic first (the load-bearing invariant), then
 * social (the PvP gate). Returns `{ allow: true }` or a denial with a private
 * redirect message.
 */
export function evaluatePrivateAction(
  classification: PrivateActionClassification,
  opts: { pvpEnabled: boolean },
): GuardrailDecision {
  if (!classification.inCurrentScene) {
    return { allow: false, reason: "out_of_scene", redirect: OUT_OF_SCENE_REDIRECT };
  }
  if (classification.targetsAnotherPc && !opts.pvpEnabled) {
    return { allow: false, reason: "pvp_disabled", redirect: PVP_DISABLED_REDIRECT };
  }
  return { allow: true };
}
