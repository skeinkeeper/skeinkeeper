// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { isEagerness, type Eagerness } from "@skeinkeeper/orchestrator";

/**
 * Pure routing for Discord interactions (design doc 0025). Maps the raw
 * subcommand/option strings to a typed command the SessionManager executes —
 * so the routing + validation is unit-testable without a live gateway, and the
 * class is left with just the side effects (mutations + replies + the operator
 * permission check). The `usage` variants drive the "Use action: …" hints.
 */
export type SlashCommand =
  | { kind: "consent.grant" }
  | { kind: "consent.withdraw" }
  | { kind: "consent.usage" }
  | { kind: "operator"; action: string | null } // gating + sub-routing in the executor
  | { kind: "session.stop" }
  | { kind: "session.start_blocked" }
  | { kind: "eagerness.set"; level: Eagerness }
  | { kind: "eagerness.usage" }
  | { kind: "voice.list" }
  | { kind: "voice.set"; personaId: string }
  | { kind: "voice.set_missing" }
  | { kind: "voice.usage" };

export interface SlashInput {
  sub: string | null;
  action: string | null;
  level: string | null;
  persona: string | null;
}

export function parseSlashCommand(input: SlashInput): SlashCommand {
  const { sub, action } = input;

  if (sub === "operator") return { kind: "operator", action };

  if (sub === "session") {
    return action === "stop" ? { kind: "session.stop" } : { kind: "session.start_blocked" };
  }

  if (sub === "eagerness") {
    return input.level !== null && isEagerness(input.level)
      ? { kind: "eagerness.set", level: input.level }
      : { kind: "eagerness.usage" };
  }

  if (sub === "voice") {
    if (action === "list") return { kind: "voice.list" };
    if (action === "set") {
      return input.persona !== null
        ? { kind: "voice.set", personaId: input.persona }
        : { kind: "voice.set_missing" };
    }
    return { kind: "voice.usage" };
  }

  // Default / consent subcommand.
  if (action === "grant") return { kind: "consent.grant" };
  if (action === "withdraw") return { kind: "consent.withdraw" };
  return { kind: "consent.usage" };
}

/** Custom IDs for the consent-DM buttons. Single source for the button
 *  builders (session_manager) and the click handler (consentButtonIntent). */
export const CONSENT_CUSTOM_ID = {
  grant: "sk-consent-grant",
  withdraw: "sk-consent-withdraw",
} as const;

/** Map a consent DM button id to the consent action (or null if not ours). */
export function consentButtonIntent(customId: string): "grant" | "withdraw" | null {
  if (customId === CONSENT_CUSTOM_ID.grant) return "grant";
  if (customId === CONSENT_CUSTOM_ID.withdraw) return "withdraw";
  return null;
}
