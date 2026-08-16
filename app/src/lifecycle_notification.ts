// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import type { SessionLifecycleState } from "@skeinkeeper/orchestrator";

/**
 * Operator pause-notification DM decision (design doc 0039 §3 step 4).
 * `notify_operator` is deliberately NOT used for pause notification — it
 * writes to Foundry GM chat, exactly the surface that's down. The pause
 * notification goes to the web console's SSE bus AND, when the operator has
 * separately consented, ONE Discord DM per pause episode. Pure so the
 * rate-limit + consent gate is unit-testable apart from the Discord gateway.
 */

export type PauseDmDecision = { send: true; episode: string } | { send: false };

export function shouldSendPauseDm(args: {
  state: SessionLifecycleState;
  operatorUserId: string | undefined;
  /** Operator-side DM consent (OperatorService.dmConsentedAt() !== undefined). */
  dmConsented: boolean;
  /** The `since` of the last episode a DM was sent for, or null. */
  lastNotifiedEpisode: string | null;
}): PauseDmDecision {
  if (args.state.kind !== "paused-foundry-down") return { send: false };
  if (args.operatorUserId === undefined) return { send: false };
  if (!args.dmConsented) return { send: false };
  if (args.lastNotifiedEpisode === args.state.since) return { send: false };
  return { send: true, episode: args.state.since };
}

/** Operational status only — pause cause, no player content (ADR-0010). */
export function formatPauseDm(state: SessionLifecycleState): string {
  if (state.kind !== "paused-foundry-down") return "";
  return (
    `Skeinkeeper paused the session — Foundry became unreachable (cause: ${state.cause}). ` +
    "Voice stays up and player words are buffered. When Foundry is back, resume from the " +
    "web console or with `/skeinkeeper session action:resume` in Foundry chat."
  );
}
