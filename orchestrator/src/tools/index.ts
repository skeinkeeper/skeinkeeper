// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Skeinkeeper Contributors

import { z } from "zod";
import { defineTool, ToolRegistry, type AnyToolDefinition } from "../registry.js";

/**
 * Core tools — system-agnostic, owned by Skeinkeeper. Per design doc
 * 0007, system-specific mutation tools (apply_damage, heal,
 * set_condition for D&D; apply_stress, take_consequence for Fate;
 * apply_harm, tick_harm_clock for PbtA) are registered by the
 * Foundry plugin at session start based on the active Foundry system.
 *
 * The tools here are universal:
 *  - Dice: thin wrapper that delegates to FoundryClient.rollDice() in
 *    Phase 3 so rolls land in Foundry's chat log. Until then, no-op.
 *  - World state: quest flags, party movement, in-game time.
 *  - Player whisper: Discord side, not VTT side.
 *  - Fudge: meta-mechanic, not system-specific.
 */

// ---- roll ----
const rollDef = defineTool({
  name: "roll",
  description:
    "Roll dice. The active Foundry system's roller handles formula interpretation and outcome — D&D 5e parses d20+modifier vs DC; Fate handles 4dF+skill; PbtA games handle 2d6+stat with 6-/7-9/10+ thresholds. Set secret=true for GM-only rolls.",
  inputSchema: z.object({
    formula: z.string(),
    speaker: z.string().optional(),
    secret: z.boolean().optional(),
  }),
  outputSchema: z.object({
    total: z.number(),
    rolls: z.array(z.number()),
    formula: z.string(),
    secret: z.boolean(),
  }),
  async handle(input) {
    // Phase 3 wires this through to FoundryClient.rollDice(). For now,
    // an interim no-op response so the tool dispatcher's audit log path
    // still works for orchestrator tests.
    return { total: 0, rolls: [], formula: input.formula, secret: input.secret ?? false };
  },
});

// ---- set_quest_flag ----
const setQuestFlagDef = defineTool({
  name: "set_quest_flag",
  description:
    "Set a Skeinkeeper-internal quest flag by string key. AI-DM-side state, distinct from Foundry's world state.",
  inputSchema: z.object({
    campaignId: z.string(),
    key: z.string().min(1),
    value: z.string(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    key: z.string(),
    value: z.string(),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: input.key,
      value: input.value,
      updatedAt: Date.now(),
    });
    return input;
  },
});

// ---- move_party ----
const movePartyDef = defineTool({
  name: "move_party",
  description:
    "Move the party to a new location (Foundry scene ID or symbolic name). Records as the 'party.location' quest flag; Phase 3 also activates the matching Foundry scene.",
  inputSchema: z.object({
    campaignId: z.string(),
    locationId: z.string(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    locationId: z.string(),
  }),
  async handle(input, ctx) {
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: "party.location",
      value: input.locationId,
      updatedAt: Date.now(),
    });
    return input;
  },
});

// ---- advance_time ----
const advanceTimeDef = defineTool({
  name: "advance_time",
  description:
    "Advance in-game time by the given number of minutes. Increments the 'time.minutes_elapsed' quest flag. The active Foundry system may have its own time-tracking; this is the Skeinkeeper-side counter for AI awareness.",
  inputSchema: z.object({
    campaignId: z.string(),
    minutes: z.number().int().nonnegative(),
  }),
  outputSchema: z.object({
    campaignId: z.string(),
    minutesElapsed: z.number(),
  }),
  async handle(input, ctx) {
    const existing = ctx.tenantDb.questFlags
      .listByCampaign(input.campaignId)
      .find((f) => f.key === "time.minutes_elapsed");
    const current = existing ? Number.parseInt(existing.value, 10) || 0 : 0;
    const next = current + input.minutes;
    ctx.tenantDb.questFlags.set({
      campaignId: input.campaignId,
      key: "time.minutes_elapsed",
      value: String(next),
      updatedAt: Date.now(),
    });
    return { campaignId: input.campaignId, minutesElapsed: next };
  },
});

// ---- whisper ----
const whisperDef = defineTool({
  name: "whisper",
  description:
    "Send a private message to one player via Discord. The voice plugin picks this up from the audit log.",
  inputSchema: z.object({
    targetPlayerDiscordId: z.string(),
    content: z.string().min(1),
  }),
  outputSchema: z.object({ delivered: z.boolean() }),
  async handle() {
    return { delivered: true };
  },
});

// ---- fudge_roll ----
const fudgeRollDef = defineTool({
  name: "fudge_roll",
  description:
    "Override the mechanical outcome of a previous secret roll. Operator-gated; the LLM may not call this unless the orchestrator has flipped the per-session fudge flag. See behavior/default.md §5.4.",
  inputSchema: z.object({
    originalTotal: z.number(),
    newTotal: z.number(),
    reason: z.string().min(10),
  }),
  outputSchema: z.object({ accepted: z.boolean() }),
  operatorGated: true,
  async handle() {
    return { accepted: true };
  },
});

export const BUILTIN_TOOLS: ReadonlyArray<AnyToolDefinition> = [
  rollDef,
  setQuestFlagDef,
  movePartyDef,
  advanceTimeDef,
  whisperDef,
  fudgeRollDef,
];

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r);
  return r;
}
