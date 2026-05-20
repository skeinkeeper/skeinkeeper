// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

/**
 * Eagerness — the operator-tunable calibration on the "should I respond?"
 * decider (design doc 0015 §2a). It biases how readily the DM speaks; it is
 * not a separate mechanism, just a dial on the existing decider, passed into
 * its prompt. Runtime-tunable (operator changes it mid-session); defaults to
 * Balanced.
 */
export type Eagerness = "reserved" | "balanced" | "eager";

export const DEFAULT_EAGERNESS: Eagerness = "balanced";

export function isEagerness(v: string): v is Eagerness {
  return v === "reserved" || v === "balanced" || v === "eager";
}

/** The instruction injected into the decider's prompt for a given level. */
export function eagernessInstruction(level: Eagerness): string {
  switch (level) {
    case "reserved":
      return (
        "Eagerness: RESERVED. Respond ONLY when a player directly addresses the DM, " +
        "or when a player is about to suffer imminent danger (e.g., stepping onto a trap). " +
        "Otherwise stay silent and let the players talk."
      );
    case "eager":
      return (
        "Eagerness: EAGER. Respond to direct address, consequential action declarations, " +
        "and rules questions; additionally offer color, give hints when the party seems " +
        "stuck, and move the scene along proactively during lulls."
      );
    case "balanced":
    default:
      return (
        "Eagerness: BALANCED. Respond to direct address, consequential action declarations " +
        "(opening a chest, drinking a potion, moving somewhere risky), rules questions, and " +
        "clear lulls where the table is waiting for the DM. Stay silent during pure " +
        "player-to-player deliberation."
      );
  }
}
